#!/usr/bin/env node
/**
 * Release bauen: eine Version, alle gewuenschten Varianten, ein signiertes
 * Manifest je Variante.
 *
 *   node scripts/release.mjs --version 1.1.0-beta.1 \
 *     [--variants de-vollversion,at-vollversion] [--no-desktop] \
 *     [--sign-key <pfad>] [--no-commit] [--no-tag]
 *
 * Reihenfolge (jeder Schritt bricht bei Fehler ab):
 *   1. Arbeitsbaum sauber, Version gueltig, CHANGELOG hat einen Abschnitt.
 *   2. npm version <v> ueber alle Workspaces (kein Tag, kein Commit).
 *   3. Commit "release: Version <v>" und Tag "v<v>".
 *   4. Je Variante: Build (Renderer, Backend, Desktop), Bundle-Pruefung
 *      (check-variant), Server-Archiv, optional Installer.
 *   5. Je Variante ein release.json mit Pruefsummen aller Artefakte,
 *      signiert mit ssh-keygen -Y sign.
 *   6. npm rebuild better-sqlite3 (dist:win baut die ABI auf Electron um).
 *
 * Ablage: release/<version>/<kanal>/<variante>/. Der Kanal ist eine Funktion
 * der Version (1.1.0 = stable, 1.1.0-beta.1 = beta), damit ein Release nicht
 * im falschen Kanal landen kann.
 *
 * Signatur: ssh-keygen -Y sign mit einem eigenen Ed25519-SSH-Schluessel
 * (Namensraum ohrganize-release). Bewusst NICHT das Lizenzschluesselpaar:
 * getrennte Vertrauensdomaenen, getrennte Rotation. ssh-keygen liegt auf
 * jedem Linux-Server und seit Windows 10 auch dort bei (OpenSSH-Client).
 * Die Gegenstelle prueft mit deploy/ohrganize-release.allowed_signers.
 *
 * Ohne --sign-key (und ohne OHRGANIZE_RELEASE_KEY) entsteht das Manifest
 * unsigniert; der Lauf sagt es deutlich und endet mit Status 0, damit ein
 * Probelauf ohne Schluessel moeglich bleibt.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function fail(message) {
  console.error(`\nAbbruch: ${message}`);
  process.exit(1);
}
function argValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function step(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Version und Kanal
// ---------------------------------------------------------------------------
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function channelOf(version) {
  const m = SEMVER.exec(version);
  if (!m) fail(`Version "${version}" ist keine Semver-Nummer (1.2.3 oder 1.2.3-beta.1).`);
  return m[4] ? 'beta' : 'stable';
}

const rootPkg = readJson(path.join(root, 'package.json'));
const version = (argValue('--version') ?? rootPkg.version).trim();
const channel = channelOf(version);
const bumpVersion = version !== rootPkg.version;

const registry = readJson(path.join(root, 'packages/shared/src/variants/registry.json'));
const requested = (argValue('--variants') ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const variantIds = requested.length > 0 ? requested : [registry.default];
for (const id of variantIds) {
  if (!registry.variants.some((v) => v.id === id)) {
    fail(`Unbekannte Variante "${id}". Bekannt: ${registry.variants.map((v) => v.id).join(', ')}.`);
  }
}
const withDesktop = !argv.includes('--no-desktop');
const doCommit = !argv.includes('--no-commit');
const doTag = !argv.includes('--no-tag');
const signKey = argValue('--sign-key') ?? process.env.OHRGANIZE_RELEASE_KEY ?? null;

// ---------------------------------------------------------------------------
// Prozesse
// ---------------------------------------------------------------------------
function run(cmd, args, { env = {}, cwd = root, capture = false } = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (res.error) fail(`${cmd} liess sich nicht starten: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} endete mit Status ${res.status}`);
  return capture ? res.stdout : '';
}

/**
 * npm ohne Shell: Unter Windows ist `npm` eine .cmd-Datei, die Node seit
 * 20.12 nur ueber eine Shell startet, und `shell: true` mit Argumenten wirft
 * DEP0190. Laeuft dieses Skript ueber `npm run`, kennt npm_execpath die
 * npm-cli.js; die wird direkt mit node gestartet.
 */
function npm(args, env = {}) {
  const cli = process.env.npm_execpath;
  if (cli) return run(process.execPath, [cli, ...args], { env });
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { env });
}

function node(script, args, env = {}) {
  return run(process.execPath, [path.join(root, script), ...args], { env });
}

function git(args, { capture = true, allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) fail(`git ${args.join(' ')} endete mit Status ${res.status}\n${res.stderr}`);
  return capture ? (res.stdout ?? '').trim() : '';
}

// ---------------------------------------------------------------------------
// 1. Vorbedingungen
// ---------------------------------------------------------------------------
step(`Release ${version} (Kanal ${channel}), Varianten: ${variantIds.join(', ')}`);

if (git(['status', '--porcelain'])) {
  fail('Der Arbeitsbaum ist nicht sauber. Bitte alles committen oder wegraeumen.');
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
if (!new RegExp(`^## ${version.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&')}\\b`, 'm').test(changelog)) {
  fail(
    `CHANGELOG.md hat keinen Abschnitt "## ${version}". ` +
      'Jede gebaute Version braucht einen eigenen Abschnitt (Abschnitt "Unveroeffentlicht" umbenennen).',
  );
}

if (doTag && git(['tag', '--list', `v${version}`])) {
  fail(`Tag v${version} existiert bereits.`);
}

// ---------------------------------------------------------------------------
// 2./3. Version setzen, committen, taggen
// ---------------------------------------------------------------------------
if (bumpVersion) {
  step(`Version auf ${version} setzen`);
  npm(['version', version, '--workspaces', '--include-workspace-root', '--no-git-tag-version']);
  if (doCommit) {
    git(['add', '-A'], { capture: false });
    git(['commit', '-m', `release: Version ${version}`], { capture: false });
  }
} else {
  console.log(`Version steht bereits auf ${version}; kein npm version noetig.`);
}

if (doTag) {
  git(['tag', '-a', `v${version}`, '-m', `oHRganize ${version}`], { capture: false });
  console.log(`Tag v${version} gesetzt.`);
}
const commit = git(['rev-parse', 'HEAD']);

// ---------------------------------------------------------------------------
// 4. Je Variante bauen
// ---------------------------------------------------------------------------
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const outRoot = path.join(root, 'release', version, channel);
const summary = [];

for (const variantId of variantIds) {
  const variant = registry.variants.find((v) => v.id === variantId);
  step(`Variante ${variantId} (${variant.label})`);
  const env = { OHRGANIZE_VARIANT: variantId };
  const outDir = path.join(outRoot, variantId);
  fs.mkdirSync(outDir, { recursive: true });

  // Renderer, Backend und Desktop-Bundle in der Variante bauen.
  npm(['run', 'build'], env);
  node('scripts/check-variant.mjs', ['--variant', variantId, ...(withDesktop ? [] : ['--no-desktop']), '--no-web'], env);

  // Server-Archiv (baut Backend und Portal erneut, deshalb --no-build nicht
  // moeglich: das Portal steckt nicht in npm run build).
  npm(['run', 'build:web'], env);
  node('scripts/check-variant.mjs', ['--variant', variantId, ...(withDesktop ? [] : ['--no-desktop'])], env);
  node('scripts/release-server.mjs', ['--variant', variantId, '--out', outDir, '--no-build'], env);

  const artifacts = [];
  const archive = path.join(outDir, `ohrganize-server-${variantId}-${version}.zip`);
  if (!fs.existsSync(archive)) fail(`Server-Archiv fehlt: ${archive}`);
  artifacts.push(archive);

  if (withDesktop) {
    npm(['run', 'dist:win', '-w', 'apps/desktop'], env);
    const installer = path.join(root, 'apps/desktop/release', `oHRganize-Setup-${version}-${variantId}.exe`);
    if (!fs.existsSync(installer)) fail(`Installer fehlt: ${installer}`);
    const target = path.join(outDir, path.basename(installer));
    fs.copyFileSync(installer, target);
    artifacts.push(target);
    const workstation = path.join(root, 'apps/desktop/release/setup-workstation.ps1');
    if (fs.existsSync(workstation)) {
      const wsTarget = path.join(outDir, 'setup-workstation.ps1');
      fs.copyFileSync(workstation, wsTarget);
      artifacts.push(wsTarget);
    }
  }

  // ---------------------------------------------------------------------
  // 5. Manifest und Signatur
  // ---------------------------------------------------------------------
  const minSrc = fs.readFileSync(path.join(root, 'packages/shared/src/version.ts'), 'utf8');
  const pickMin = (name) => {
    const m = new RegExp(`export const ${name} = '([^']+)'`).exec(minSrc);
    if (!m) fail(`${name} steht nicht in packages/shared/src/version.ts.`);
    return m[1];
  };
  const manifest = {
    product: 'ohrganize',
    version,
    channel,
    variant: {
      id: variant.id,
      country: variant.country,
      edition: variant.edition,
      label: variant.label,
    },
    artifacts: artifacts.map((f) => ({
      file: path.basename(f),
      sha256: sha256(f),
      bytes: fs.statSync(f).size,
    })),
    min_client_version: pickMin('MIN_CLIENT_VERSION'),
    min_server_version: pickMin('MIN_SERVER_VERSION'),
    built_at: new Date().toISOString(),
    commit,
  };
  const manifestFile = path.join(outDir, 'release.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  if (signKey) {
    if (!fs.existsSync(signKey)) fail(`Signaturschluessel nicht gefunden: ${signKey}`);
    run('ssh-keygen', ['-Y', 'sign', '-f', signKey, '-n', 'ohrganize-release', manifestFile]);
    if (!fs.existsSync(`${manifestFile}.sig`)) fail('ssh-keygen hat keine Signatur geschrieben.');
    console.log(`Signatur: ${path.relative(root, `${manifestFile}.sig`)}`);
  } else {
    console.log('Kein Signaturschluessel (--sign-key bzw. OHRGANIZE_RELEASE_KEY): release.json bleibt UNSIGNIERT.');
  }

  summary.push({ variantId, outDir, manifest });
}

// ---------------------------------------------------------------------------
// 6. Native Bibliothek zurueckstellen
// ---------------------------------------------------------------------------
if (withDesktop) {
  step('better-sqlite3 auf die Node-ABI zurueckbauen');
  // electron-builder baut das Modul in-place auf die Electron-ABI um; ohne
  // diesen Schritt scheitern tsx und die Smoke-Tests danach mit ABI-Fehlern.
  npm(['rebuild', 'better-sqlite3']);
}

// ---------------------------------------------------------------------------
// Zusammenfassung
// ---------------------------------------------------------------------------
step('Zusammenfassung');
console.log(`Version ${version}, Kanal ${channel}, Commit ${commit.slice(0, 8)}`);
for (const s of summary) {
  console.log(`\n${s.variantId}  ->  ${path.relative(root, s.outDir)}`);
  for (const a of s.manifest.artifacts) {
    console.log(`  ${a.file}  ${(a.bytes / 1024 / 1024).toFixed(1)} MB  ${a.sha256.slice(0, 16)}...`);
  }
}
console.log(`\nSignatur pruefen:`);
console.log(
  '  ssh-keygen -Y verify -f deploy/ohrganize-release.allowed_signers ' +
    '-I release@ohrganize -n ohrganize-release -s release.json.sig < release.json',
);
if (doTag) console.log(`\nNoch zu tun: git push && git push origin v${version}`);
