#!/usr/bin/env node
/**
 * Kundenbranch dronivo: prueft, was die Ausgabe von main trennt. Laeuft als
 * `posttest` nach `npm test` und vor jedem Release (release.mjs,
 * release-server.mjs ueber scripts/dronivo-guard.mjs). Gedacht vor allem fuer
 * die Zeit nach einem `git merge main`: Ein Konflikt, der zugunsten von main
 * aufgeloest wird, oder ein neuer Einstieg aus main faellt hier auf, bevor ein
 * Release entsteht.
 *
 *   1. Ausgabe: Das Register kennt NUR CUSTOMER_VARIANT, die erzeugte
 *      Verdrahtung passt dazu, und die Windows-Skripte tragen die Ausgabe in
 *      env-Datei und Dienstumgebung ein.
 *   2. Version: Alle package.json und das Lockfile tragen dieselbe Version
 *      <x.y.z>-dronivo; die Mindestversionen tragen die Kennung, liegen nicht
 *      ueber der Version und nicht unter denen von main (Merge-Basis);
 *      CHANGELOG.md hat einen Abschnitt. Mit `--version <v>` gelten Version,
 *      Mindestversionen und CHANGELOG gegen die Zielversion eines Releases.
 *   3. Backend: Schalter aus, createRequest sperrt jede Neuanlage einer
 *      /api/me-Route, der globale Hook jede schreibende Portalroute ausser
 *      PORTAL_OPEN_WRITES; jede schreibende /api/me-Route ist offen oder als
 *      Abwesenheitserfassung eingeordnet, und keine offene schreibt
 *      Abwesenheiten direkt per SQL.
 *   4. Portal: jede abweichende Stelle fragt den Schalter ab, jeder Pfad des
 *      Portals ist entweder gesperrt oder ausdruecklich offen, und kein anderer
 *      Teil des Portals verweist auf die gesperrten Seiten oder nutzt die
 *      schreibenden Hooks der Abwesenheitserfassung.
 *
 * Aufruf: node scripts/check-dronivo.mjs [--version <x.y.z>-dronivo]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, customerEdition, customerTagOf, customerVersionProblem, parseVersion } from './dronivo-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const targetVersion = argv.includes('--version') ? argv[argv.indexOf('--version') + 1] : null;
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const readJson = (rel) => JSON.parse(read(rel));
/** Text woertlich in einen regulaeren Ausdruck einsetzen. */
const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walk(dir, visit) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, visit);
    else visit(rel);
  }
}

const { tag, variant } = customerEdition(root);

// --- 1. Ausgabe ------------------------------------------------------------
const registry = readJson('packages/shared/src/variants/registry.json');
const ids = registry.variants.map((v) => v.id);
if (ids.length !== 1 || ids[0] !== variant || registry.default !== variant) {
  fail(
    `Register: erwartet genau die Variante "${variant}" als Vorgabe, gefunden ${JSON.stringify(ids)} ` +
      `(Vorgabe "${registry.default}"). Eine zweite Variante auf diesem Branch baute deren Kunden die Dronivo-Sperre ein.`,
  );
}
const wiring = spawnSync(process.execPath, [path.join(root, 'scripts/variant-wiring.mjs'), '--check'], {
  cwd: root,
  encoding: 'utf8',
});
if (wiring.status !== 0) {
  fail(`Verdrahtung passt nicht zum Register (npm run variants:gen):\n${(wiring.stdout + wiring.stderr).trim()}`);
}

// --- 2. Version ------------------------------------------------------------
const pkgVersion = readJson('package.json').version;
const version = targetVersion ?? pkgVersion;
const versionProblem = customerVersionProblem(root, version);
if (versionProblem) fail(versionProblem);
if (targetVersion) {
  const pkgProblem = customerVersionProblem(root, pkgVersion);
  if (pkgProblem) fail(`package.json: ${pkgProblem}`);
}
for (const base of ['apps', 'packages', 'tools']) {
  for (const e of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = `${base}/${e.name}/package.json`;
    if (!e.isDirectory() || !fs.existsSync(path.join(root, rel))) continue;
    const v = readJson(rel).version;
    if (v !== pkgVersion) {
      fail(`${rel}: Version ${v}, das Projekt steht auf ${pkgVersion} (npm version <v> --workspaces --include-workspace-root --no-git-tag-version).`);
    }
  }
}
const lock = readJson('package-lock.json');
if (lock.version !== pkgVersion || lock.packages?.['']?.version !== pkgVersion) {
  fail(`package-lock.json: Version ${lock.version}, das Projekt steht auf ${pkgVersion}.`);
}
// Auch die Eintraege der Workspaces: Ein Merge-Konflikt im Lockfile, zugunsten
// von main aufgeloest, liesse sie sonst auf dessen Nummer stehen.
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (!/^(?:apps|packages|tools)\/[^/]+$/.test(key) || entry.link) continue;
  if (entry.version !== pkgVersion) {
    fail(`package-lock.json: Eintrag "${key}" steht auf ${entry.version}, das Projekt auf ${pkgVersion}.`);
  }
}

const pickMin = (src, name) => new RegExp(`export const ${name} = '([^']+)'`).exec(src)?.[1] ?? null;
const versionSrc = read('packages/shared/src/version.ts');
// Mindestversionen von main: Ein Konflikt, der zugunsten des Branches
// aufgeloest wird, darf ein Anheben aus main nicht still verwerfen. Waehrend
// eines laufenden Merges zaehlt der Stand, der gerade hereinkommt (MERGE_HEAD),
// sonst die Merge-Basis mit main (ein noch nicht gemergter Stand von main soll
// den Branch nicht blockieren).
let mainVersionSrc = null;
{
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const merging = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
  let ref = null;
  if (merging) {
    ref = 'MERGE_HEAD';
  } else {
    const base = git(['merge-base', 'HEAD', 'main']);
    if (base.status === 0) ref = base.stdout.trim();
  }
  const show = ref ? git(['show', `${ref}:packages/shared/src/version.ts`]) : null;
  if (show && show.status === 0) mainVersionSrc = show.stdout.replace(/\r\n/g, '\n');
  else notes.push('Mindestversionen von main nicht verglichen (git oder Branch main nicht erreichbar).');
}
for (const name of ['MIN_CLIENT_VERSION', 'MIN_SERVER_VERSION']) {
  const min = pickMin(versionSrc, name);
  if (!min) {
    fail(`${name} steht nicht in packages/shared/src/version.ts.`);
    continue;
  }
  if (customerTagOf(min) !== tag) {
    fail(`${name} = '${min}' traegt nicht die Kennung ${tag}. Nach Semver ist x.y.z neuer als x.y.z-${tag}: App und Server dieser Ausgabe sperrten sich aus.`);
  } else if (compareVersions(min, version) > 0) {
    fail(`${name} = '${min}' liegt ueber der Version ${version}: Die Ausgabe erfuellte ihre eigene Mindestversion nicht.`);
  }
  const mainMin = mainVersionSrc ? pickMin(mainVersionSrc, name) : null;
  const mainCore = mainMin ? parseVersion(mainMin)?.core : null;
  const ownCore = parseVersion(min)?.core;
  if (mainCore && ownCore && compareVersions(ownCore.join('.'), mainCore.join('.')) < 0) {
    fail(`${name} = '${min}' liegt unter main ('${mainMin}'). Ein Anheben aus main gehoert mit Kennung uebernommen: '${mainCore.join('.')}-${tag}'.`);
  }
}
if (!new RegExp(`^## ${escapeRe(version)}(?![0-9A-Za-z.-])`, 'm').test(read('CHANGELOG.md'))) {
  fail(`CHANGELOG.md hat keinen Abschnitt "## ${version}".`);
}

// --- 3. Backend --------------------------------------------------------------
if (!/export const PORTAL_ABSENCE_CAPTURE: boolean = false;/.test(read('packages/shared/src/dronivo.ts'))) {
  fail('PORTAL_ABSENCE_CAPTURE steht nicht auf false (packages/shared/src/dronivo.ts).');
}

// Schreibende Portalrouten: Der globale Hook laesst nur PORTAL_OPEN_WRITES
// durch und sperrt alles andere. Hier wird jede Route im Quelltext
// eingeordnet, damit eine neue Route aus main nicht unbemerkt gesperrt bleibt;
// src/test/smoke.ts prueft dasselbe an den registrierten Routen (auch Plugins
// mit Praefix, die diese Suche nicht sieht).
const dronivoSrc = read('packages/shared/src/dronivo.ts');
function listOf(name) {
  const body = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`).exec(dronivoSrc)?.[1];
  if (body === undefined) {
    fail(`packages/shared/src/dronivo.ts: ${name} nicht gefunden.`);
    return [];
  }
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const OPEN_WRITES = listOf('PORTAL_OPEN_WRITES');
const ABSENCE_WRITES = listOf('PORTAL_ABSENCE_WRITES');
// Regel statt zweiter Liste: Unter den Pfaden der Abwesenheitserfassung ist
// keine schreibende Route offen, auch keine, die main dort neu anlegt. Die
// Pfade (der Abschnitt nach /api/me/, heute leave-requests und sick-notes)
// stammen aus PORTAL_ABSENCE_WRITES selbst, ziehen also mit, wenn main die
// Erfassung verlegt und die neuen Routen dort eingeordnet werden. Dass die
// heutigen drei tatsaechlich 403 antworten, prueft src/test/smoke.ts im Lauf.
const resourceOf = (k) => /^[A-Z]+ \/api\/me\/([^/]+)/.exec(k)?.[1] ?? null;
const ABSENCE_RESOURCES = new Set(ABSENCE_WRITES.map(resourceOf).filter(Boolean));
if (ABSENCE_RESOURCES.size === 0) fail('packages/shared/src/dronivo.ts: PORTAL_ABSENCE_WRITES nennt keine Route unter /api/me.');
for (const k of OPEN_WRITES) {
  if (ABSENCE_WRITES.includes(k) || ABSENCE_RESOURCES.has(resourceOf(k))) {
    fail(`packages/shared/src/dronivo.ts: "${k}" steht in PORTAL_OPEN_WRITES, gehoert aber zur Abwesenheitserfassung.`);
  }
}
/** Direkter Schreibzugriff auf Abwesenheiten (Neuanlagen ueber createRequest sperrt createRequest selbst). */
const DIRECT_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?:absence_requests|sick_notes)\b/i;
/** URL in beliebigen Anfuehrungszeichen; benannte Gruppen, weil die Nummern je Ausdruck wechseln. */
const QUOTED = `(?<q>['"\`])(?<url>\\/api\\/me\\/[^'"\`]*)\\k<q>`;

/** Alle Routen unter /api/me einer Datei: Kurzform .post('/api/me/...') und .route({ method, url }). */
function meRoutes(src) {
  const found = [];
  for (const m of src.matchAll(new RegExp(`\\.(?<method>get|head|post|put|patch|delete)\\(\\s*${QUOTED}`, 'g'))) {
    found.push({ index: m.index, method: m.groups.method.toUpperCase(), url: m.groups.url });
  }
  for (const m of src.matchAll(/\.route\(\s*\{/g)) {
    const head = src.slice(m.index, m.index + 800);
    const url = new RegExp(`url:\\s*${QUOTED}`).exec(head)?.groups.url;
    if (!url) continue;
    const methods = /method:\s*(\[[^\]]*\]|['"`][A-Za-z]+['"`])/.exec(head)?.[1] ?? "'GET'";
    for (const mm of methods.matchAll(/['"`]([A-Za-z]+)['"`]/g)) found.push({ index: m.index, method: mm[1].toUpperCase(), url });
  }
  return found.sort((a, b) => a.index - b.index);
}

const seenWrites = new Set();
walk('apps/backend/src', (rel) => {
  if (!rel.endsWith('.ts') || rel.includes('/test/') || rel.endsWith('/smoke.ts')) return;
  const src = read(rel);
  const routes = meRoutes(src);
  routes.forEach((r, i) => {
    if (r.method === 'GET' || r.method === 'HEAD') return;
    const key = `${r.method} ${r.url}`;
    seenWrites.add(key);
    if (ABSENCE_WRITES.includes(key)) return;
    if (!OPEN_WRITES.includes(key)) {
      fail(
        `${rel}: ${key} ist eine schreibende Portalroute ohne Einordnung und antwortet deshalb 403. Erfasst sie ` +
          'Abwesenheiten, gehoert sie in PORTAL_ABSENCE_WRITES, sonst nach Pruefung in PORTAL_OPEN_WRITES (packages/shared/src/dronivo.ts).',
      );
      return;
    }
    // Eine offene Route darf Abwesenheiten nicht selbst schreiben (Hilfsfunktionen
    // sieht diese Suche nicht; deshalb ist die Einordnung eine Pruefung von Hand).
    const next = routes.slice(i + 1).find((x) => x.index > r.index);
    if (DIRECT_WRITE.test(src.slice(r.index, next?.index ?? src.length))) {
      fail(`${rel}: ${key} steht in PORTAL_OPEN_WRITES, schreibt aber Abwesenheiten oder Krankmeldungen direkt.`);
    }
  });
});
for (const k of [...OPEN_WRITES, ...ABSENCE_WRITES]) {
  if (!seenWrites.has(k)) notes.push(`${k} steht in packages/shared/src/dronivo.ts, im Quelltext aber nicht als Route (umbenannt, oder ueber ein Plugin mit Praefix; src/test/smoke.ts prueft die registrierten Routen).`);
}

// --- 4. Schalterstellen ------------------------------------------------------
const SITES = [
  ['apps/backend/src/server.ts', /if \(selfService && portalWriteBlocked\(req\.method, req\.routeOptions\.url \?\? ''\)\) \{\s*throw forbidden\(/],
  ['packages/shared/src/dronivo.ts', /if \(PORTAL_ABSENCE_CAPTURE\) return false;\s*const m = method\.toUpperCase\(\);\s*if \(m === 'GET' \|\| m === 'HEAD' \|\| !route\.startsWith\('\/api\/me\/'\)\) return false;\s*return !PORTAL_OPEN_WRITES\.includes\(`\$\{m\} \$\{route\}`\);/],
  ['apps/backend/src/modules/absences/service.ts', /if \(!PORTAL_ABSENCE_CAPTURE && route\.startsWith\('\/api\/me\/'\)\) \{\s*throw forbidden\(/],
  ['apps/backend/src/modules/absences/service.ts', /export function createRequest\([^)]*\)[^{]*\{\s*assertNoPortalCapture\(req\);/],
  ['apps/web/src/App.tsx', /portalRoutes\.filter\(\(route\) => portalPathOpen\(route\.path/],
  ['apps/web/src/layout/PortalShell.tsx', /if \(!portalPathOpen\(item\.to\)\) return false;/],
  ['apps/web/src/pages/OverviewPage.tsx', /PORTAL_ABSENCE_CAPTURE \? <BalanceCard \/> : <StammdatenCard \/>/],
  ['apps/web/src/pages/OverviewPage.tsx', /\{PORTAL_ABSENCE_CAPTURE && \(\s*<Card title="Offene Antr/],
  ['apps/web/src/pages/LoginPage.tsx', /\{PORTAL_ABSENCE_CAPTURE && 'Urlaub beantragen, krankmelden, '\}/],
  ['apps/web/src/pages/LoginPage.tsx', /\{PORTAL_ABSENCE_CAPTURE && ' Den Stand sehen Sie jederzeit unter "Antr/],
  ['apps/renderer/src/features/setup/copy.ts', /'step7\.why': PORTAL_ABSENCE_CAPTURE\s*\?/],
  ['apps/renderer/src/features/setup/copy.ts', /'step7\.result': PORTAL_ABSENCE_CAPTURE\s*\?/],
  ['apps/renderer/src/features/setup/copy.ts', /'step7\.result\.many': PORTAL_ABSENCE_CAPTURE\s*\?/],
  ['apps/renderer/src/features/setup/copy.ts', /'account\.hint\.profile\.2': PORTAL_ABSENCE_CAPTURE\s*\?/],
  ['apps/renderer/src/features/setup/SetupAssistant.tsx', /\{all && PORTAL_ABSENCE_CAPTURE && \(/],
  ['apps/renderer/src/features/dashboard/dashboardModel.ts', /: PORTAL_ABSENCE_CAPTURE \? ' Aus dem Portal beantragt\.' : '';/],
  ['deploy/windows/setup-server.ps1', /function Set-EnvVariant/],
  ['deploy/windows/setup-server.ps1', /\$zip\.GetEntry\('VARIANTE\.txt'\)/],
  ['deploy/windows/update-server.ps1', /function Sync-ServiceVariant/],
  ['deploy/windows/update-server.ps1', /\$serviceEnvBefore = Sync-ServiceVariant \$archiveVariant/],
  ['deploy/windows/ohrganize.env.example', /^OHRGANIZE_VARIANT=$/m],
  ['scripts/release.mjs', /branchCheckProblem\(root, version\)/],
  ['scripts/release-server.mjs', /apps\/web\/dist gehoert nicht \(nur\) zur Variante/],
  ['apps/desktop/scripts/dist.mjs', /customerVariantProblem\(repo, variantId\)/],
  ['package.json', /"posttest": "node scripts\/check-dronivo\.mjs"/],
  // Dateinamen der Release-Dateien (releaseLabel: de-1.0.0-dronivo statt Variante plus Version).
  ['apps/desktop/scripts/dist.mjs', /-c\.artifactName=oHRganize-Setup-\$\{label\}\./],
  ['scripts/release.mjs', /ohrganize-server-\$\{releaseLabel\(root, version\)\}\.zip/],
  ['scripts/release.mjs', /oHRganize-Setup-\$\{releaseLabel\(root, version\)\}\.exe/],
  ['scripts/release-server.mjs', /const baseName = `ohrganize-server-\$\{releaseLabel\(root, version\)\}`;/],
];
for (const [rel, pattern] of SITES) {
  if (!pattern.test(read(rel))) fail(`${rel}: Stelle fehlt oder wurde umgeschrieben (${pattern.source.slice(0, 70)}). Schalter oder Absicherung wirken dort nicht mehr.`);
}

// --- 5. Pfade des Portals ------------------------------------------------------
const CLOSED = ['/antraege', '/krankmeldung'];
const closed = (p) => CLOSED.some((c) => p === c || p.startsWith(`${c}/`));
/** Pfade, die auch bei Dronivo offen sind. Eine neue Seite aus main muss hier oder in CLOSED stehen. */
const OPEN_PORTAL_PATHS = new Set([
  '/', '*', '/anmelden', '/kalender', '/gehalt', '/entwicklung', '/gespraeche', '/kollegen',
  '/stammdaten', '/dokumente', '/organigramm', '/profil',
]);
/**
 * Pfade aus Objekten `{ <key>: ... }` einer Datei (Routen, Navigationseintraege).
 * Ein Wert, der kein fester Text ist (Konstante, Ausdruck), laesst sich nicht
 * einordnen und ist selbst ein Befund.
 */
function objectPaths(rel, key) {
  const out = [];
  for (const m of read(rel).matchAll(new RegExp(`\\{[ \\t]*${key}:[ \\t]*([^,}\\n]+)`, 'g'))) {
    const literal = /^(['"`])([^'"`$]*)\1$/.exec(m[1].trim());
    if (literal) out.push([rel, literal[2]]);
    else fail(`${rel}: ${key}: ${m[1].trim()} ist kein fester Pfad und laesst sich nicht als gesperrt oder offen einordnen.`);
  }
  return out;
}
const portalPaths = [
  ...objectPaths(`apps/web/src/variants/${variant}.tsx`, 'path'),
  ...objectPaths('apps/web/src/App.tsx', 'path'),
  ...objectPaths('apps/web/src/layout/PortalShell.tsx', 'to'),
];
for (const [rel, p] of portalPaths) {
  if (!closed(p) && !OPEN_PORTAL_PATHS.has(p)) {
    fail(`${rel}: Portalpfad "${p}" ist weder gesperrt noch als offen bekannt. Erfasst die Seite Abwesenheiten, gehoert sie in PORTAL_ABSENCE_PATHS; sonst in OPEN_PORTAL_PATHS (check-dronivo.mjs).`);
  }
}
const sharedPaths = /PORTAL_ABSENCE_PATHS: readonly string\[\] = \[([^\]]*)\]/.exec(read('packages/shared/src/dronivo.ts'))?.[1] ?? '';
for (const c of CLOSED) {
  if (!sharedPaths.includes(`'${c}'`)) fail(`packages/shared/src/dronivo.ts: PORTAL_ABSENCE_PATHS nennt "${c}" nicht mehr.`);
}

// --- 6. Verweise und Hooks im Portal -----------------------------------------
/** Dateien, die nur mit Portalerfassung erreichbar sind oder die Hooks definieren. */
const CAPTURE_FILES = new Set([
  'apps/web/src/pages/RequestsPage.tsx',
  'apps/web/src/pages/NewRequestPage.tsx',
  'apps/web/src/pages/SickNotePage.tsx',
  'apps/web/src/api/hooks.ts',
]);
/** Text ohne Kommentarzeilen und ohne die Teile, die nur mit Portalerfassung gezeigt werden. */
function scannable(rel, raw) {
  const src = raw
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  if (rel === 'apps/web/src/pages/OverviewPage.tsx') {
    const a = src.indexOf('function BalanceCard(');
    const b = src.indexOf('\nfunction ', a + 1);
    return a >= 0 && b > a ? src.slice(0, a) + src.slice(b) : src;
  }
  if (rel === 'apps/web/src/layout/PortalShell.tsx') {
    return src.split('\n').filter((l) => !/^\s*\{ to: '\/(antraege|krankmeldung)'/.test(l)).join('\n');
  }
  return src;
}
// Schreibende Aufrufe der Erfassungspfade; die Pfade stammen aus PORTAL_ABSENCE_WRITES (Abschnitt 3).
const ABSENCE_API_CALL = ABSENCE_RESOURCES.size
  ? new RegExp(`\\.(?:post|put|patch|delete)\\b[^(\\n]*\\(\\s*['"\`]\\/api\\/me\\/(?:${[...ABSENCE_RESOURCES].map(escapeRe).join('|')})\\b`)
  : /$^/;
walk('apps/web/src', (rel) => {
  if (!/\.(ts|tsx)$/.test(rel) || rel.startsWith('apps/web/src/variants/') || CAPTURE_FILES.has(rel)) return;
  const src = scannable(rel, read(rel));
  if (/['"`]\/(antraege|krankmeldung)\b/.test(src)) {
    fail(`${rel}: verweist auf /antraege oder /krankmeldung. Neuer Einstieg in die Abwesenheitserfassung? Mit PORTAL_ABSENCE_CAPTURE absichern und hier freigeben.`);
  }
  // Lesen bleibt offen (GET /api/me/leave-requests, /api/me/sick-notes), gemeldet wird nur Schreiben.
  if (
    /\buse(CreateRequest|CancelRequest|CreateSickNote)\b/.test(src) ||
    ABSENCE_API_CALL.test(src)
  ) {
    fail(`${rel}: nutzt die schreibende Abwesenheitserfassung des Portals (Hook oder API-Pfad). Mit PORTAL_ABSENCE_CAPTURE absichern und hier freigeben.`);
  }
});

// --- 7. Dateinamen in Doku und Skripten ------------------------------------------
// Installer und Server-Archiv heissen auf diesem Branch nach releaseLabel
// (oHRganize-Setup-de-1.0.0-dronivo.exe, ohrganize-server-de-1.0.0-dronivo.zip).
// Betreiber und Kunde lesen die Namen in Betriebsdoku, setup-workstation.ps1,
// update-server.ps1 und im LIESMICH des Archivs (release-server.mjs). Ein Merge
// von main braechte dort die Schreibweise mit Variante zurueck. Gemeldet werden
// Platzhalter und Vorlagen dieser Schreibweise (die man abschreibt), beim
// Installer auch konkrete Namen; konkrete Archivnamen des Hauptprodukts
// (ohrganize-server-de-vollversion-1.1.0.zip) bleiben als Beispiele der
// Mehrmandanten-Doku stehen. Ausgenommen: CLAUDE.md (allgemeiner Teil mit
// Hinweis auf den Branch), CHANGELOG.md und der Umsetzungsplan (Geschichte).
const MAIN_FILE_NAMES = [
  ['den Installer', 'oHRganize-Setup-de-<version>.exe', /oHRganize-Setup-(?:<version>-<variante>|\d+\.\d+\.\d+(?:-[0-9a-z.]+)?-[a-z]{2}-[a-z]+)\.exe/i],
  // Kennung aus dronivo.ts (CUSTOMER_TAG): Variante plus Version naennte sie doppelt (de-<tag>-1.0.0-<tag>).
  [
    'das Server-Archiv',
    'ohrganize-server-de-<version>.zip',
    new RegExp(`ohrganize-server-(?:<variante>-<version>|\\$\\{variantId\\}-\\$\\{version\\}|[a-z]{2}-${escapeRe(tag)}-\\d)`, 'i'),
  ],
];
const NAME_EXEMPT = new Set(['docs/umsetzungsplan-varianten-lizenz.md']);
function checkFileNames(rel) {
  const src = read(rel);
  for (const [what, ours, pattern] of MAIN_FILE_NAMES) {
    if (pattern.test(src)) {
      fail(`${rel}: nennt ${what} in der Schreibweise von main (mit Variante). Auf diesem Branch: ${ours} (releaseLabel in scripts/dronivo-guard.mjs).`);
    }
  }
}
for (const dir of ['deploy', 'docs', 'apps/desktop/scripts']) {
  walk(dir, (rel) => {
    if (!NAME_EXEMPT.has(rel) && /\.(md|ps1|sh|mjs|txt|example)$/.test(rel)) checkFileNames(rel);
  });
}
for (const rel of ['README.md', 'scripts/release.mjs', 'scripts/release-server.mjs']) checkFileNames(rel);

if (problems.length > 0) {
  console.error(`check-dronivo: ${problems.length} Befund(e)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const n of notes) console.log(`check-dronivo: Hinweis: ${n}`);
console.log(`check-dronivo: ok (Ausgabe ${variant}, Version ${version}, Portal ohne Abwesenheitserfassung).`);
