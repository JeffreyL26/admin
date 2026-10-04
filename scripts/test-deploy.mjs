#!/usr/bin/env node
/**
 * Prueft die Release-Auswahl der Betriebsskripte (neuestes_release in
 * deploy/ohrganize-lib.sh) gegen Wegwerf-Ordner in os.tmpdir().
 *
 * Laeuft mit bash; unter Windows mit der Git-Bash, weil
 * C:\Windows\System32\bash.exe (WSL) Windows-Pfade nicht versteht. Ein
 * anderer Ort laesst sich mit OHRGANIZE_BASH angeben.
 *
 *   node scripts/test-deploy.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(repo, 'deploy', 'ohrganize-lib.sh').replace(/\\/g, '/');

function findBash() {
  if (process.env.OHRGANIZE_BASH) return process.env.OHRGANIZE_BASH;
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  try {
    // <git>/<mingw64|ucrt64>/libexec/git-core -> <git>/bin/bash.exe
    const gitCore = execFileSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(path.resolve(gitCore, '..', '..', '..', 'bin', 'bash.exe'));
  } catch {
    // git nicht im PATH: Standardort versuchen.
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const bash = findBash();
if (!bash) {
  console.error('Git-Bash nicht gefunden. Git for Windows installieren oder OHRGANIZE_BASH=<pfad zu bash.exe> setzen.');
  process.exit(1);
}
let failures = 0;

function writeRelease(root, folder, variant, version) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'VARIANTE.txt'), `${variant}\n`);
  if (version !== null) {
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ product: 'ohrganize', version, channel: 'x' }, null, 2));
  }
}

function expectPick(label, folders, variant, expected) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-releases-'));
  try {
    for (const [folder, v, version] of folders) writeRelease(root, folder, v, version);
    const res = spawnSync(bash, ['-c', `set -euo pipefail; . "${lib}"; neuestes_release "$1"`, 'test', variant], {
      encoding: 'utf8',
      env: { ...process.env, OHRGANIZE_RELEASE_VERZ: root.replace(/\\/g, '/') },
    });
    if (res.error) {
      console.error(`${bash} liess sich nicht starten: ${res.error.message}. OHRGANIZE_BASH setzen.`);
      process.exit(1);
    }
    const actual = (res.stdout ?? '').trim();
    const ok = res.status === 0 && actual === expected;
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `: erwartet "${expected}", erhalten "${actual}" (Status ${res.status}) ${res.stderr ?? ''}`}`);
    if (!ok) failures++;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const DE = 'de-vollversion';
expectPick(
  '1.10.0 ist neuer als 1.9.0, Betas und fremde Ausgaben zaehlen nicht',
  [
    [`${DE}-1.9.0`, DE, '1.9.0'],
    [`${DE}-1.10.0`, DE, '1.10.0'],
    [`${DE}-1.10.1-beta.2`, DE, '1.10.1-beta.2'],
    ['at-basis-2.0.0', 'at-basis', '2.0.0'],
  ],
  DE,
  `${DE}-1.10.0`,
);
expectPick('Zweistellige Hauptversion', [[`${DE}-2.0.0`, DE, '2.0.0'], [`${DE}-10.0.0`, DE, '10.0.0']], DE, `${DE}-10.0.0`);
expectPick('Nur Betas: keine Auswahl', [[`${DE}-1.1.0-beta.1`, DE, '1.1.0-beta.1']], DE, '');
expectPick(
  'Version aus release.json, nicht aus dem Ordnernamen',
  [
    [`${DE}-1.10.0`, DE, '1.10.0'],
    [`${DE}-1.20.0`, DE, '1.0.0'],
    ['umbenannt', DE, '1.11.0'],
  ],
  DE,
  'umbenannt',
);
expectPick('Ordner ohne release.json zaehlt nicht', [[`${DE}-1.9.0`, DE, '1.9.0'], [`${DE}-1.10.0`, DE, null]], DE, `${DE}-1.9.0`);

/** Fuehrt ein Bash-Skript mit geladener ohrganize-lib.sh aus; Argumente als $1, $2, ... */
function runWithLib(script, args = []) {
  const res = spawnSync(bash, ['-c', `set -uo pipefail; . "${lib}"; ${script}`, 'test', ...args], { encoding: 'utf8' });
  if (res.error) {
    console.error(`${bash} liess sich nicht starten: ${res.error.message}. OHRGANIZE_BASH setzen.`);
    process.exit(1);
  }
  return res;
}

function expectLine(label, res, expected) {
  const actual = (res.stdout ?? '').trim();
  const ok = actual === expected;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `: erwartet "${expected}", erhalten "${actual}" (Status ${res.status}) ${res.stderr ?? ''}`}`);
  if (!ok) failures++;
}

// warte_auf_start: Ein Absturz (NRestarts steigt, failed/inactive) bricht das
// Warten sofort ab; eine leere Antwort von systemctl (D-Bus unter Last) ist
// keine Auskunft und darf einen gesunden, langen Start nicht zuruecknehmen.
// Attrappen fuer curl (nie gesund), sleep und systemctl; die Antworten fuer
// NRestarts kommen der Reihe nach aus $1 ("-" steht fuer eine leere Antwort).
const warteSkript = String.raw`
zaehler="$(mktemp)"; echo 0 > "$zaehler"
read -r -a antworten <<<"$1"
curl() { return 7; }
sleep() { :; }
systemctl() {
  if [[ "$1" == is-active ]]; then echo active; return 0; fi
  local i; i=$(cat "$zaehler"); echo $((i + 1)) > "$zaehler"
  ((i >= ${'$'}{#antworten[@]})) && i=$((${'$'}{#antworten[@]} - 1))
  local a="${'$'}{antworten[$i]}"; [[ "$a" == - ]] && a=''
  printf '%s\n' "$a"
}
start=$SECONDS
warte_auf_start ohrganize-backend 3001 2
code=$?
rm -f "$zaehler"
if ((SECONDS - start < 2)); then echo "$code sofort"; else echo "$code Frist"; fi
`;
for (const [label, answers, expected] of [
  ['warte_auf_start: einzelne leere Antwort bricht nicht ab', '0 0 - 0 0', '1 Frist'],
  ['warte_auf_start: leerer Ausgangswert, danach gleichbleibend', '- 0 0 0', '1 Frist'],
  ['warte_auf_start: echter Neustart bricht sofort ab', '0 0 1', '1 sofort'],
  ['warte_auf_start: leerer Ausgangswert, dann Neustart erkannt', '- 0 1', '1 sofort'],
  ['warte_auf_start: durchgehend leer, die Frist laeuft ab', '- - -', '1 Frist'],
]) {
  expectLine(label, runWithLib(warteSkript, [answers]), expected);
}

// provision.sh check liest den Vermerk der Umstellung mit json_zahl aus der
// Ausgabe von status.cjs --json (mehrzeilig, encryption flach).
const statusJson = JSON.stringify(
  {
    license: { state: 'valid' },
    encryption: {
      database: 'encrypted',
      key: 'internal',
      storage: 'encrypted',
      storage_plaintext_files: 0,
      storage_damaged_files: 2,
      storage_unreadable_files: 0,
      conversion_marker: 1,
    },
  },
  null,
  2,
);
expectLine(
  'json_zahl liest encryption.conversion_marker und storage_damaged_files',
  runWithLib('echo "$(json_zahl "$1" encryption conversion_marker) $(json_zahl "$1" encryption storage_damaged_files)"', [statusJson]),
  '1 2',
);

if (failures > 0) {
  console.error(`\n${failures} Pruefung(en) fehlgeschlagen.`);
  process.exit(1);
}
console.log('\nAlle Deploy-Pruefungen bestanden.');
