#!/usr/bin/env node
/**
 * Release-Archiv fuer den Serverbetrieb:
 * release/ohrganize-server-<variante>-<version>.zip
 *
 * Aufruf: npm run release:server [-- --variant <id>] [--out <verz>] [--no-build]
 *
 * Eine Variante ist Land x Edition (packages/shared/src/variants/registry.json).
 * Der Archivname traegt sie, das Archiv enthaelt VARIANTE.txt und ein
 * unsigniertes release.json; die Signatur legt scripts/release.mjs daneben.
 * Ohne --variant gilt OHRGANIZE_VARIANT, sonst die Vorgabe des Registers.
 *
 * Das Archiv enthält NUR gebaute Artefakte, keinen Quelltext: die minifizierten
 * Bundles cli.cjs und backup.cjs (ohne server.cjs — das ist das Embedding-Bundle
 * der Desktop-App — und ohne *.map, die den Quelltext wieder lesbar machten),
 * den statischen Portal-Build, das komplette deploy/-Verzeichnis, die
 * Betriebsdokumente und eine LIESMICH.txt. Die Verzeichnisstruktur spiegelt
 * das Repository (apps/backend/dist/…, apps/web/dist/…, deploy/…), damit
 * install-service.ps1, install-backup-task.ps1 und die systemd-Units
 * unverändert funktionieren: Sie kennen den Pfad apps/backend/dist/cli.cjs.
 *
 * Abhängigkeiten auf dem Kundenserver: better-sqlite3 ist die einzige, die
 * nicht im Bundle steckt (native Bibliothek). Das Archiv bringt dafür eine
 * GEKÜRZTE package.json + package-lock.json mit — nur better-sqlite3 und seine
 * Abhängigkeiten, abgeleitet aus dem Lockfile des Repos (dieselben Versionen,
 * dieselben Prüfsummen), plus der passende allowScripts-Eintrag. `npm ci
 * --omit=dev` installiert damit rund 20 Pakete statt der 113 Produktiv-
 * abhängigkeiten aller Workspaces (die stecken ohnehin im Bundle) und braucht
 * weder esbuild noch typescript noch die Workspace-Verzeichnisse.
 *
 * Zeilenenden: Auf Windows liegen wegen core.autocrlf viele Dateien mit CRLF
 * in der Arbeitskopie, obwohl .gitattributes für Units, Shell-Skripte und
 * env-Vorlagen LF verlangt (ein CR am Zeilenende bricht ExecStart und Bash).
 * Das Archiv normalisiert deshalb alle Textdateien unter deploy/ und docs/
 * auf LF; nur *.ps1 bekommen CRLF.
 *
 * Zip-Schreiber: absichtlich selbst gebaut (rund 80 Zeilen, nur node:zlib) —
 * Compress-Archive aus Windows PowerShell 5.1 schreibt Backslashes in die
 * Pfadnamen, die ein Linux-unzip als Dateinamen mit Backslash anlegt, und
 * eine neue npm-Abhängigkeit nur fürs Zippen wollen wir nicht.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const skipBuild = argv.includes('--no-build');

function fail(message) {
  console.error(`Abbruch: ${message}`);
  process.exit(1);
}

function argValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

// ---------------------------------------------------------------------------
// 0. Variante
// ---------------------------------------------------------------------------
const registry = JSON.parse(
  fs.readFileSync(path.join(root, 'packages/shared/src/variants/registry.json'), 'utf8'),
);
const variantId = (argValue('--variant') ?? process.env.OHRGANIZE_VARIANT ?? '').trim() || registry.default;
const variant = registry.variants.find((v) => v.id === variantId);
if (!variant) {
  fail(`Unbekannte Variante "${variantId}". Bekannt: ${registry.variants.map((v) => v.id).join(', ')}.`);
}
// Alle Bauschritte sehen dieselbe Variante, auch wenn sie ueber --variant kam.
process.env.OHRGANIZE_VARIANT = variantId;

/**
 * npm-Aufruf ohne Shell: Unter Windows ist `npm` eine .cmd-Datei, die Node
 * seit 20.12 nur noch über eine Shell startet — und `shell: true` mit
 * Argumenten wirft DEP0190. Läuft dieses Skript selbst über `npm run`, kennt
 * `npm_execpath` die npm-cli.js; die wird direkt mit node gestartet.
 */
function runNpm(npmArgs) {
  console.log(`> npm ${npmArgs.join(' ')}`);
  const cli = process.env.npm_execpath;
  const env = { ...process.env, OHRGANIZE_VARIANT: variantId };
  const r = cli
    ? spawnSync(process.execPath, [cli, ...npmArgs], { cwd: root, stdio: 'inherit', env })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env,
      });
  if (r.status !== 0) fail(`npm ${npmArgs.join(' ')} endete mit Status ${r.status}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Version und Build
// ---------------------------------------------------------------------------
const backendPkg = readJson(path.join(root, 'apps/backend/package.json'));
const version = backendPkg.version;
if (!version) fail('apps/backend/package.json hat keine version.');

if (!skipBuild) {
  runNpm(['run', 'build', '-w', 'apps/backend']);
  runNpm(['run', 'build:web']);
}

const inputs = {
  cli: path.join(root, 'apps/backend/dist/cli.cjs'),
  backup: path.join(root, 'apps/backend/dist/backup.cjs'),
  // Betreiberwerkzeuge (Phase 7). Sie wandern mit, sobald der Build sie
  // erzeugt; ein aelterer Stand ohne sie bleibt baubar.
  tools: ['status.cjs', 'admin-reset.cjs', 'migrate-check.cjs']
    .map((f) => path.join(root, 'apps/backend/dist', f))
    .filter((f) => fs.existsSync(f)),
  webDist: path.join(root, 'apps/web/dist'),
  deploy: path.join(root, 'deploy'),
  docs: [
    'docs/inbetriebnahme.md',
    'docs/lizenzierung.md',
    'docs/kunden-subdomain.md',
    'docs/web-portal.md',
    'docs/entscheidungen.md',
  ].map((d) =>
    path.join(root, d),
  ),
};
for (const p of [inputs.cli, inputs.backup, path.join(inputs.webDist, 'index.html'), inputs.deploy, ...inputs.docs]) {
  if (!fs.existsSync(p)) fail(`${path.relative(root, p)} fehlt${skipBuild ? ' (--no-build ohne vorherigen Build?)' : ''}.`);
}

// ---------------------------------------------------------------------------
// 2. Gekürztes Manifest: better-sqlite3 und seine Abhängigkeiten aus dem Lockfile
// ---------------------------------------------------------------------------
const rootPkg = readJson(path.join(root, 'package.json'));
const lock = readJson(path.join(root, 'package-lock.json'));
if (lock.lockfileVersion !== 3) fail(`package-lock.json hat lockfileVersion ${lock.lockfileVersion}, erwartet 3.`);
const packages = lock.packages;

/** Node-Auflösung im Lockfile: erst verschachtelt unter `from`, dann aufwärts. */
function resolveDep(from, name) {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const idx = base.lastIndexOf('/node_modules/');
    base = idx === -1 ? '' : base.slice(0, idx);
  }
}

const RUNTIME_DEPS = { 'better-sqlite3': null }; // Version kommt aus dem Lockfile
const collected = new Map();
const queue = [];
for (const name of Object.keys(RUNTIME_DEPS)) {
  const key = resolveDep('', name);
  if (!key) fail(`${name} steht nicht im Lockfile.`);
  queue.push(key);
}
while (queue.length) {
  const key = queue.shift();
  if (collected.has(key)) continue;
  const entry = packages[key];
  collected.set(key, entry);
  for (const dep of Object.keys({ ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) })) {
    const depKey = resolveDep(key, dep);
    if (!depKey) {
      if (entry.optionalDependencies?.[dep]) continue; // optional und nicht installiert
      fail(`Abhängigkeit ${dep} von ${key} fehlt im Lockfile.`);
    }
    queue.push(depKey);
  }
}

const trimmedDeps = {};
for (const name of Object.keys(RUNTIME_DEPS)) {
  trimmedDeps[name] = packages[resolveDep('', name)].version;
}

// Installationsskripte: nur, was die Root-package.json bereits freigibt UND
// im Archiv landet. Nichts wird hier neu freigegeben.
const allowScripts = {};
for (const [key, entry] of collected) {
  if (!entry.hasInstallScript) continue;
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const spec = `${name}@${entry.version}`;
  if (rootPkg.allowScripts?.[spec] === true) {
    allowScripts[spec] = true;
  } else {
    fail(`${spec} hat ein Installationsskript, steht aber nicht in allowScripts der Root-package.json.`);
  }
}

const trimmedPkg = {
  name: 'ohrganize-server',
  version,
  private: true,
  // ASCII, damit Windows PowerShell 5.1 (Get-Content ohne BOM = ANSI) nichts verstümmelt.
  description: 'oHRganize Backend - Laufzeitabhaengigkeiten des Serverbetriebs (Release-Archiv)',
  engines: rootPkg.engines ?? { node: '>=20' },
  dependencies: trimmedDeps,
  allowScripts,
};

const trimmedLockPackages = { '': { name: trimmedPkg.name, version, dependencies: trimmedDeps, engines: trimmedPkg.engines } };
for (const key of [...collected.keys()].sort()) {
  const { dev, devOptional, ...entry } = collected.get(key); // eslint-disable-line no-unused-vars
  trimmedLockPackages[key] = entry;
}
const trimmedLock = {
  name: trimmedPkg.name,
  version,
  lockfileVersion: 3,
  requires: true,
  packages: trimmedLockPackages,
};

// ---------------------------------------------------------------------------
// 3. Bau-Ausweis und Dateiliste
// ---------------------------------------------------------------------------

/** Commit des gebauten Standes; leer, wenn ausserhalb eines Arbeitsbaums gebaut wird. */
function gitCommit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * Mindestversionen aus packages/shared/src/version.ts. Dieses Skript ist
 * reines JavaScript und kann die TypeScript-Quelle nicht importieren; gelesen
 * wird sie trotzdem, damit die Zahlen nur an EINER Stelle stehen. Fehlen sie,
 * bricht der Lauf ab statt still eine Vorgabe zu erfinden.
 */
function minVersions() {
  const src = fs.readFileSync(path.join(root, 'packages/shared/src/version.ts'), 'utf8');
  const pick = (name) => {
    const m = new RegExp(`export const ${name} = '([^']+)'`).exec(src);
    if (!m) fail(`${name} steht nicht in packages/shared/src/version.ts.`);
    return m[1];
  };
  return { client: pick('MIN_CLIENT_VERSION'), server: pick('MIN_SERVER_VERSION') };
}
const MIN_VERSIONS = minVersions();

/** Kanal ist eine Funktion der Version, wie channelOf in shared/version.ts. */
function channelOf(v) {
  const m = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) fail(`Version "${v}" ist keine Semver-Nummer.`);
  return m[1] ? 'beta' : 'stable';
}
const channel = channelOf(version);
const releaseInfo = {
  product: 'ohrganize-server',
  version,
  channel,
  variant: { id: variant.id, country: variant.country, edition: variant.edition, label: variant.label },
  min_client_version: MIN_VERSIONS.client,
  min_server_version: MIN_VERSIONS.server,
  built_at: new Date().toISOString(),
  commit: gitCommit(),
};
/** @type {{ name: string; data: Buffer; mtime: Date; mode: number }[]} */
const entries = [];

function normalizeText(buf, name) {
  const crlf = name.toLowerCase().endsWith('.ps1');
  const lf = buf.toString('utf8').replace(/\r\n/g, '\n');
  return Buffer.from(crlf ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
}

function addFile(name, source, { text = false } = {}) {
  const st = fs.statSync(source);
  let data = fs.readFileSync(source);
  if (text) data = normalizeText(data, name);
  const mode = name.endsWith('.sh') ? 0o755 : 0o644;
  entries.push({ name, data, mtime: st.mtime, mode });
}

function addTree(name, dir, opts) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, d.name);
    const rel = `${name}/${d.name}`;
    if (d.isDirectory()) addTree(rel, full, opts);
    else if (d.isFile()) addFile(rel, full, opts);
  }
}

function addGenerated(name, content, mtime = new Date(), { bom = false } = {}) {
  // BOM nur für die LIESMICH: Windows PowerShell 5.1 (Get-Content) und Notepad
  // lesen UTF-8 ohne BOM als ANSI und zeigen Umlaute als Zeichensalat.
  const data = Buffer.from((bom ? '\uFEFF' : '') + content, 'utf8');
  entries.push({ name, data, mtime, mode: 0o644 });
}

// Sicherheitskontrolle: Der Test-Override der Lizenzprüfung darf im Bundle
// nicht mehr gelesen werden (esbuild --define in apps/backend/package.json).
// Die Zeichenkette kommt nur noch in der einkompilierten package.json vor —
// ein tatsächlicher Lesezugriff auf process.env würde hier auffallen.
for (const bundle of [inputs.cli, inputs.backup, ...inputs.tools]) {
  if (/env\.OHRGANIZE_LICENSE_PUBLIC_KEY\s*\?\?/.test(fs.readFileSync(bundle, 'utf8'))) {
    fail(`${path.relative(root, bundle)} liest OHRGANIZE_LICENSE_PUBLIC_KEY — Build ohne --define? Nicht ausliefern.`);
  }
}

// Variantenkontrolle vor dem Packen: Ein Bundle aus einem frueheren Lauf mit
// anderer Variante wuerde sonst unbemerkt mitwandern (scripts/check-variant.mjs
// prueft dasselbe umfassender, aber erst nach dem Build).
const marker = `OHRGANIZE_VARIANT:${variantId}`;
for (const bundle of [inputs.cli, inputs.backup, ...inputs.tools]) {
  if (!fs.readFileSync(bundle, 'utf8').includes(marker)) {
    fail(`${path.relative(root, bundle)} traegt nicht den Marker der Variante ${variantId}. Bundle neu bauen.`);
  }
}

addFile('apps/backend/dist/cli.cjs', inputs.cli);
addFile('apps/backend/dist/backup.cjs', inputs.backup);
for (const tool of inputs.tools) addFile(`apps/backend/dist/${path.basename(tool)}`, tool);
addFile('apps/backend/package.json', path.join(root, 'apps/backend/package.json'), { text: true });
addTree('apps/web/dist', inputs.webDist);
addTree('deploy', inputs.deploy, { text: true });
for (const doc of inputs.docs) addFile(`docs/${path.basename(doc)}`, doc, { text: true });
addGenerated('package.json', `${JSON.stringify(trimmedPkg, null, 2)}\n`);
addGenerated('package-lock.json', `${JSON.stringify(trimmedLock, null, 2)}\n`);

// Bau-Ausweis IM Archiv: Was ist das hier, aus welchem Stand, fuer welche
// Variante und welchen Kanal? Die Pruefsumme des Archivs kann darin nicht
// stehen (sie aenderte sich dadurch selbst); die Liste der Artefakte samt
// Pruefsummen und die Signatur legt scripts/release.mjs daneben.
addGenerated('VARIANTE.txt', `${variantId}\n`);
addGenerated('release.json', `${JSON.stringify(releaseInfo, null, 2)}\n`);
addGenerated(
  'LIESMICH.txt',
  `oHRganize Server ${version} (${variant.label}) - Release-Archiv
=============================================

Variante: ${variant.id}   Kanal: ${channel}

SCHRITT 1 - Variante pruefen, BEVOR entpackt wird
-------------------------------------------------
Jede Ausgabe ist ein eigener Build. Wird ein Archiv der falschen Ausgabe ueber
eine laufende Instanz entpackt, startet der Dienst nicht (das Backend prueft
OHRGANIZE_VARIANT gegen die einkompilierte Variante) oder die Arbeitsplaetze
brechen beim Start ab. Vor dem Entpacken:

  Linux:    unzip -p ohrganize-server-${variantId}-${version}.zip VARIANTE.txt
  Windows:  (Get-Content .\\VARIANTE.txt) nach dem Entpacken in ein leeres Verzeichnis

Der Wert muss zu OHRGANIZE_VARIANT der Instanz passen (env-Datei bzw.
Dienstumgebung) und zu dem, was die laufende Instanz unter /api/health als
variant.id meldet.

SCHRITT 2 - Pruefsumme
----------------------
  Linux:    sha256sum -c ohrganize-server-${variantId}-${version}.zip.sha256
  Windows:  Get-FileHash .\\ohrganize-server-${variantId}-${version}.zip -Algorithm SHA256

Liegt neben dem Archiv ein release.json samt release.json.sig, laesst sich die
Signatur des Anbieters pruefen (Details in deploy/README.md, Abschnitt 9.6):

  ssh-keygen -Y verify -f ohrganize-release.allowed_signers \\
    -I release@ohrganize -n ohrganize-release -s release.json.sig < release.json

SCHRITT 3 - Entpacken
---------------------
Dieses Archiv wird OHNE Zwischenverzeichnis direkt in das Programmverzeichnis
entpackt (Linux: /opt/ohrganize, Windows: C:\\Program Files\\oHRganize):

  Linux:    unzip -o ohrganize-server-${variantId}-${version}.zip -d /opt/ohrganize
  Windows:  Expand-Archive ohrganize-server-${variantId}-${version}.zip -DestinationPath 'C:\\Program Files\\oHRganize' -Force

Inhalt:

  apps/backend/dist/cli.cjs      Backend, Diensteinstieg (node apps/backend/dist/cli.cjs)
  apps/backend/dist/backup.cjs   Sicherungsskript (wird von Timer bzw. geplanter Aufgabe aufgerufen)
${inputs.tools.length ? `  apps/backend/dist/*.cjs        Betreiberwerkzeuge: ${inputs.tools.map((t) => path.basename(t)).join(', ')}\n` : ''}  apps/backend/package.json      Versionsangabe des Backends (nur zur Information)
  apps/web/dist/                 Mitarbeitenden-Portal, statisch - wird in das Web-Verzeichnis
                                 des Reverse-Proxys kopiert
  deploy/                        Dienstdefinitionen, Proxy-Konfigurationen, Vorlagen der
                                 Umgebungsvariablen, Einrichtungsskripte (Linux und Windows)
  docs/inbetriebnahme.md         Checkliste der Erstinbetriebnahme
  docs/lizenzierung.md           Lizenzmodell: Testphase, Lizenzdatei, Nur-Lese-Betrieb
  docs/kunden-subdomain.md       Betrieb unter <kunde>.ohrganize.com
  VARIANTE.txt, release.json     Ausgabe, Kanal und Bauzeitpunkt dieses Archivs
  package.json, package-lock.json
                                 Laufzeitabhaengigkeit better-sqlite3 (einzige native
                                 Abhaengigkeit) - Installation mit: npm ci --omit=dev

Einrichtung Schritt fuer Schritt:
  Linux ............ deploy/README.md
  Windows Server ... deploy/windows/README.md
  danach ........... docs/inbetriebnahme.md

Voraussetzungen auf dem Server: Node.js >= 20 und - fuer better-sqlite3, die
einzige native Abhaengigkeit - die Build-Werkzeuge der jeweiligen Plattform,
falls npm kein Fertigpaket findet (Linux: build-essential python3; Windows:
siehe deploy/windows/README.md, Abschnitt 1). esbuild, typescript und git
werden nicht gebraucht; der Quelltext ist nicht enthalten.

Lizenz: Eine frische Installation laeuft 30 Tage als Testphase, danach im
Nur-Lese-Betrieb. Die Lizenzdatei (lizenz.ohrganize) wird in der Desktop-App
unter Einstellungen -> Lizenz eingespielt - Einzelheiten in docs/lizenzierung.md.
Eine Lizenz ab Fassung 2 nennt Land und Ausgabe und wird nur von der passenden
Variante angenommen.
`,
  new Date(),
  { bom: true },
);

entries.sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// 4. Zip schreiben (Deflate, UTF-8-Namen, Unix-Rechte im externen Attribut)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const parts = [];
const central = [];
let offset = 0;
for (const e of entries) {
  const nameBuf = Buffer.from(e.name, 'utf8');
  const deflated = zlib.deflateRawSync(e.data, { level: 9 });
  const store = deflated.length >= e.data.length;
  const body = store ? e.data : deflated;
  const method = store ? 0 : 8;
  const crc = crc32(e.data);
  const { time, date } = dosDateTime(e.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8-Namen
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(e.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(e.data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); // extra
  cd.writeUInt16LE(0, 32); // comment
  cd.writeUInt16LE(0, 34); // disk
  cd.writeUInt16LE(0, 36); // internal attrs
  cd.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); // external attrs: reguläre Datei + Modus
  cd.writeUInt32LE(offset, 42);

  parts.push(local, nameBuf, body);
  central.push(cd, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}
const cdStart = offset;
const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);
if (entries.length > 0xffff || offset + cdBuf.length > 0xffffffff) fail('Archiv zu groß für Zip ohne Zip64.');

const zip = Buffer.concat([...parts, cdBuf, eocd]);
const outDir = path.resolve(root, argValue('--out') ?? 'release');
fs.mkdirSync(outDir, { recursive: true });
// Der Archivname traegt Land und Edition: Zwei Ausgaben derselben Version
// duerfen sich im Downloadverzeichnis nicht ueberschreiben, und wer eine
// Datei in der Hand hat, sieht am Namen, wohin sie gehoert.
const baseName = `ohrganize-server-${variantId}-${version}`;
const outFile = path.join(outDir, `${baseName}.zip`);
fs.writeFileSync(outFile, zip);
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(`${outFile}.sha256`, `${sha256}  ${path.basename(outFile)}\n`);
// Sourcemaps bleiben beim Anbieter (nicht im Archiv, sie machten den Quelltext
// lesbar), aber neben dem Archiv: Eine Fehlerposition aus einem Kundenlog
// (cli.cjs:Zeile:Spalte) lässt sich damit auf diesen exakten Build abbilden.
for (const src of [inputs.cli, inputs.backup, ...inputs.tools]) {
  const map = `${src}.map`;
  if (fs.existsSync(map)) fs.copyFileSync(map, path.join(outDir, `${baseName}.${path.basename(src)}.map`));
}

// ---------------------------------------------------------------------------
// 5. Zusammenfassung
// ---------------------------------------------------------------------------
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log('');
console.log(`Release-Archiv: ${path.relative(root, outFile)} (${mb(zip.length)}, ${entries.length} Dateien)`);
console.log(`SHA-256:        ${sha256}`);
console.log(`Variante:       ${variant.id} (${variant.label}), Kanal ${channel}`);
console.log(`Sourcemaps:     ${path.relative(root, outDir)}/${baseName}.*.cjs.map (nur Anbieter, nicht im Archiv)`);
console.log(`Backend:        cli.cjs ${mb(fs.statSync(inputs.cli).size)}, backup.cjs ${mb(fs.statSync(inputs.backup).size)}${inputs.tools.length ? `, Werkzeuge: ${inputs.tools.map((t) => path.basename(t)).join(', ')}` : ''}`);
console.log(`npm-Manifest:   ${Object.keys(trimmedLockPackages).length - 1} Pakete (${Object.entries(trimmedDeps).map(([n, v]) => `${n}@${v}`).join(', ')} samt Abhängigkeiten)`);
console.log(`allowScripts:   ${Object.keys(allowScripts).join(', ') || '—'}`);
