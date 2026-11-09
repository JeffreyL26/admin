// Prueft die Sperre gegen einen eingebauten Server ausserhalb einer
// Kundenausgabe (builtInServerGuard.mjs): die Regel ohne git, dieses
// Repository wie im Desktop-Build, dazu den git-Teil (Branch, Geschichte von
// main, fehlende Refs) in einem Wegwerf-Repository unter os.tmpdir().
// Aufruf: node scripts/builtInServerGuardTest.mjs (Teil von npm test -w apps/desktop).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVariantId, variantById } from '../../../scripts/variant-alias.mjs';
import { builtInServerIsNull, builtInServerProblem, checkBuiltInServer, headOnMainHistory } from './builtInServerGuard.mjs';

let failures = 0;
function check(label, ok, extra) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const NULL_LINE = 'export const BUILT_IN_SERVER: BuiltInServer | null = null;';
const SET_LINE = "export const BUILT_IN_SERVER: BuiltInServer | null = { url: CUSTOMER_SERVER, pins: CUSTOMER_SERVER_KEY_PINS };";
const main = { variantId: 'de-vollversion', edition: 'vollversion', version: '1.1.0', branchName: 'main', onMainHistory: true };
const kunde = { variantId: 'de-kunde', edition: 'kunde', version: '1.1.0-kunde', branchName: 'kunde', onMainHistory: false };

// --- Erkennen der null-Zeile ---------------------------------------------------
check('null erkannt', builtInServerIsNull(NULL_LINE));
check('null mit Kommentar dahinter', builtInServerIsNull(`${NULL_LINE} // Einzelplatz`));
check('null ohne Typangabe und mit Leerraum', builtInServerIsNull('export const BUILT_IN_SERVER =  null ;'));
check('null ueber zwei Zeilen', builtInServerIsNull('export const BUILT_IN_SERVER: BuiltInServer | null =\n  null;'));
check('gesetzter Server ist nicht null', !builtInServerIsNull(SET_LINE));
check('null nur im Zeilenkommentar zaehlt nicht', !builtInServerIsNull(`// ${NULL_LINE}\n${SET_LINE}`));
check('null nur im Blockkommentar zaehlt nicht', !builtInServerIsNull(`/*\n${NULL_LINE}\n*/\n${SET_LINE}`));
check('null nach einem Blockkommentar', builtInServerIsNull(`/** Server. */\n${NULL_LINE}`));

// --- Regel -------------------------------------------------------------------------
check('main mit null: in Ordnung', builtInServerProblem({ ...main, source: NULL_LINE }) === null);
check(
  'Hauptprodukt mit Server (Version ohne Kennung): Abbruch',
  (builtInServerProblem({ ...main, source: SET_LINE, branchName: 'feature', onMainHistory: false }) ?? '').includes('Kennung'),
);
check(
  'Version mit fremder Kennung: Abbruch',
  (builtInServerProblem({ ...kunde, source: SET_LINE, version: '1.1.0-anders' }) ?? '').includes('Kennung'),
);
check(
  'Vorabversion ist keine Kundenkennung: Abbruch',
  (builtInServerProblem({ ...kunde, source: SET_LINE, version: '1.1.0-beta.1' }) ?? '').includes('Kennung'),
);
check(
  'Branch main mit Server (Register und Version einer Kundenausgabe): Abbruch',
  (builtInServerProblem({ ...kunde, source: SET_LINE, branchName: 'main' }) ?? '').includes('Branch main'),
);
check(
  'Commit aus der Geschichte von main: Abbruch',
  (builtInServerProblem({ ...kunde, source: SET_LINE, branchName: 'HEAD', onMainHistory: true }) ?? '').includes('Geschichte von main'),
);
check(
  'Herkunft nicht pruefbar: Abbruch',
  (builtInServerProblem({ ...kunde, source: SET_LINE, onMainHistory: null }) ?? '').includes('git fetch origin main'),
);
check('Kundenausgabe auf ihrem Branch: in Ordnung', builtInServerProblem({ ...kunde, source: SET_LINE }) === null);
check(
  'Edition mit Bindestrich (EDITION_PATTERN): in Ordnung',
  builtInServerProblem({ ...kunde, source: SET_LINE, edition: 'kunde-nord', version: '2.0.0-kunde-nord' }) === null,
);
check(
  'Kundenausgabe von einem Tag ihres Branches: in Ordnung',
  builtInServerProblem({ ...kunde, source: SET_LINE, branchName: 'HEAD' }) === null,
);

// --- Dieses Repository ------------------------------------------------------------
// Dieselbe Pruefung wie der Desktop-Build, fuer den Stand, der gerade getestet
// wird: Auf main und fuer das Hauptprodukt muss BUILT_IN_SERVER null sein,
// auf einem Kundenbranch passt er zu Version und Edition. Ersetzt eine
// eigene Fassung der Regel im Test der Serverwahl. Ohne pruefbare Herkunft
// (Klon nur des Kundenbranches, flacher Klon) prueft der Test Version und
// Branch und sagt das; der Desktop-Build bricht dort weiterhin ab.
{
  const root = path.join(import.meta.dirname, '../../..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  const problem = checkBuiltInServer(root, variantById(resolveVariantId({})), version, { requireHistory: false });
  check('dieser Stand: eingebauter Server zulaessig', problem === null, problem ?? undefined);
  if (headOnMainHistory(root) === null) {
    console.log(
      'builtInServerGuardTest: Herkunft dieses Stands nicht pruefbar (kein main, flacher Klon); ' +
        'geprueft nur Version und Branch. Der Desktop-Build verlangt sie.',
    );
  }
}

// --- git-Teil im Wegwerf-Repository -----------------------------------------------
// Abgeschottet vom umgebenden Repository: Variablen wie GIT_DIR oder
// GIT_INDEX_FILE (gesetzt in git-Hooks) lenkten init, add und commit sonst in
// das echte Repository um, und ohne Obergrenze faende git fuer das Verzeichnis
// ohne Repository ein umgebendes (TMP innerhalb einer Arbeitskopie). Die
// Prozesse des Wächters erben diese Umgebung.
for (const name of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]) {
  delete process.env[name];
}
// Das Verzeichnis ohne Repository liegt absichtlich IN einem Repository auf
// main (`outer`): Wirkt die Obergrenze nicht, saehe die Sperre dessen Branch
// main, und der Fall unten schluege fehl. So ist die Abschottung selbst
// geprueft, auch das Format der Pfadliste unter Windows.
const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ohrganize-guard-'));
const repo = path.join(base, 'repo');
const outer = path.join(base, 'outer');
const plain = path.join(outer, 'ohne-git');
fs.mkdirSync(repo);
fs.mkdirSync(plain, { recursive: true });
process.env.GIT_CEILING_DIRECTORIES = [base, outer].join(path.delimiter);
function gitIn(cwd, ...args) {
  // Eigene Identitaet, keine Signatur: nur diese Wegwerf-Repositories.
  const res = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@musterfirma.ohrganize.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}
const git = (...args) => gitIn(repo, ...args);
function writeSource(text) {
  const file = path.join(repo, 'packages/shared/src/builtInServer.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
}
const variant = { id: 'de-kunde', edition: 'kunde' };
try {
  git('init', '-q', '-b', 'main');
  writeSource(NULL_LINE);
  git('add', '.');
  git('commit', '-q', '-m', 'main');
  const mainCommit = git('rev-parse', 'HEAD');

  check('git: null auf main: in Ordnung', checkBuiltInServer(repo, variant, '1.1.0-kunde') === null);

  writeSource(SET_LINE);
  check(
    'git: Server auf main: Abbruch',
    (checkBuiltInServer(repo, variant, '1.1.0-kunde') ?? '').includes('Branch main'),
  );

  git('checkout', '-q', '-b', 'kunde');
  check(
    'git: neuer Kundenbranch ohne eigenen Commit: Abbruch mit Hinweis aufs Committen',
    (checkBuiltInServer(repo, variant, '1.1.0-kunde') ?? '').includes('zuerst committen'),
  );

  git('commit', '-q', '-am', 'kunde');
  const kundeCommit = git('rev-parse', 'HEAD');
  check('git: Kundenbranch mit eigenem Commit: in Ordnung', checkBuiltInServer(repo, variant, '1.1.0-kunde') === null);
  check(
    'git: Kundenbranch mit Version ohne Kennung: Abbruch',
    (checkBuiltInServer(repo, variant, '1.1.0') ?? '').includes('Kennung'),
  );

  git('checkout', '-q', '--detach', kundeCommit);
  check('git: Tag des Kundenbranches: in Ordnung', checkBuiltInServer(repo, variant, '1.1.0-kunde') === null);

  git('checkout', '-q', '--detach', mainCommit);
  writeSource(SET_LINE);
  check(
    'git: Tag aus der Geschichte von main: Abbruch',
    (checkBuiltInServer(repo, variant, '1.1.0-kunde') ?? '').includes('Geschichte von main'),
  );

  git('checkout', '-q', '-f', 'kunde');
  git('branch', '-q', '-m', 'main', 'alt');
  check(
    'git: ohne main und origin/main: Abbruch statt still offen',
    (checkBuiltInServer(repo, variant, '1.1.0-kunde') ?? '').includes('git fetch origin main'),
  );

  fs.writeFileSync(path.join(outer, 'README'), 'umgebendes Repository\n');
  gitIn(outer, 'init', '-q', '-b', 'main');
  gitIn(outer, 'add', 'README');
  gitIn(outer, 'commit', '-q', '-m', 'outer');
  fs.mkdirSync(path.join(plain, 'packages/shared/src'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'packages/shared/src/builtInServer.ts'), `${SET_LINE}\n`);
  check(
    'ohne git-Repository (in einem umgebenden auf main): Abbruch statt still offen',
    (checkBuiltInServer(plain, variant, '1.1.0-kunde') ?? '').includes('git fetch origin main'),
  );
} catch (err) {
  check('git-Teil lief durch', false, String(err));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`builtInServerGuardTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('builtInServerGuardTest: ok');
