/**
 * Prueft, woher die Desktop-App ihren Server nimmt (desktopConfig.ts):
 * Reihenfolge Umgebungsvariable, config.json, eingebauter Server, sonst das
 * eingebettete Backend; dieselbe Reihenfolge fuer die Pins, die eingebauten
 * nur fuer die Herkunft des eingebauten Servers; eine defekte config.json
 * bricht nur ab, wenn sie die einzige Quelle der Adresse waere. Dazu die
 * Zeile der Anmeldeseite (backendLabel) und dass das Hauptprodukt keinen
 * eingebauten Server traegt.
 *
 * Laeuft ohne Electron unter tsx. Aufruf: npm test -w apps/desktop (Teil von
 * npm test).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILT_IN_SERVER, VARIANTS, backendLabel, type BuiltInServer } from '@ohrganize/shared';
import { readDesktopConfig, type DesktopConfig } from '../desktopConfig';
import { PIN_PATTERN } from '../serverPinning';
import { StartupError } from '../startupError';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const PIN_A = `sha256/${'A'.repeat(43)}=`;
const PIN_B = `sha256/${'B'.repeat(43)}=`;
const PIN_C = `sha256/${'C'.repeat(43)}=`;
const BUILT: BuiltInServer = { url: 'https://musterfirma.ohrganize.com', pins: [PIN_A] };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-desktop-config-'));
const cfg = path.join(dir, 'config.json');

/** Ein Fall: Umgebung und Datei setzen, lesen, alles wieder aufraeumen. */
function run(opts: { env?: string; envPins?: string; file?: string | object; builtIn: BuiltInServer | null }): {
  config?: DesktopConfig;
  error?: unknown;
  warned: string[];
} {
  const saved = { base: process.env.OHRGANIZE_API_BASE, pins: process.env.OHRGANIZE_SERVER_KEY_PINS };
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args.join(' '));
  if (opts.env === undefined) delete process.env.OHRGANIZE_API_BASE;
  else process.env.OHRGANIZE_API_BASE = opts.env;
  if (opts.envPins === undefined) delete process.env.OHRGANIZE_SERVER_KEY_PINS;
  else process.env.OHRGANIZE_SERVER_KEY_PINS = opts.envPins;
  if (opts.file === undefined) fs.rmSync(cfg, { force: true });
  else fs.writeFileSync(cfg, typeof opts.file === 'string' ? opts.file : JSON.stringify(opts.file));
  try {
    return { config: readDesktopConfig(cfg, opts.builtIn), warned };
  } catch (error) {
    return { error, warned };
  } finally {
    console.warn = warn;
    if (saved.base === undefined) delete process.env.OHRGANIZE_API_BASE;
    else process.env.OHRGANIZE_API_BASE = saved.base;
    if (saved.pins === undefined) delete process.env.OHRGANIZE_SERVER_KEY_PINS;
    else process.env.OHRGANIZE_SERVER_KEY_PINS = saved.pins;
  }
}

try {
  // --- Adresse ---------------------------------------------------------------
  let r = run({ builtIn: null });
  check(
    'ohne alles und ohne eingebauten Server: eingebettetes Backend',
    r.config?.apiBaseUrl === null && r.config.apiBaseSource === null && r.config.serverKeyPins === null,
    r.config,
  );

  r = run({ builtIn: BUILT });
  check(
    'ohne Variable und Datei: eingebauter Server samt Pins',
    r.config?.apiBaseUrl === BUILT.url &&
      r.config.apiBaseSource === 'build' &&
      r.config.serverKeyPins?.from === 'build' &&
      r.config.serverKeyPins.pins.join() === PIN_A,
    r.config,
  );

  r = run({ env: '  https://anders.ohrganize.com  ', builtIn: BUILT });
  check(
    'Variable schlaegt den eingebauten Server; fremde Herkunft bekommt dessen Pins nicht',
    r.config?.apiBaseUrl === 'https://anders.ohrganize.com' && r.config.apiBaseSource === 'env' && r.config.serverKeyPins === null,
    r.config,
  );

  r = run({ env: 'https://musterfirma.ohrganize.com/', builtIn: BUILT });
  check(
    'Variable mit derselben Herkunft: eingebaute Pins gelten',
    r.config?.apiBaseSource === 'env' && r.config.serverKeyPins?.from === 'build',
    r.config,
  );

  r = run({ file: { apiBaseUrl: 'https://datei.ohrganize.com' }, builtIn: BUILT });
  check(
    'config.json schlaegt den eingebauten Server',
    r.config?.apiBaseUrl === 'https://datei.ohrganize.com' && r.config.apiBaseSource === 'file' && r.config.serverKeyPins === null,
    r.config,
  );

  r = run({ env: 'https://variable.ohrganize.com', file: { apiBaseUrl: 'https://datei.ohrganize.com' }, builtIn: null });
  check('Variable schlaegt config.json', r.config?.apiBaseUrl === 'https://variable.ohrganize.com' && r.config.apiBaseSource === 'env', r.config);

  r = run({ file: { apiBaseUrl: '   ' }, builtIn: BUILT });
  check('leere Adresse in config.json zaehlt als keine', r.config?.apiBaseSource === 'build', r.config);

  r = run({ file: { apiBaseUrl: '   ' }, builtIn: null });
  check('leere Adresse ohne eingebauten Server: eingebettetes Backend', r.config?.apiBaseUrl === null, r.config);

  // UTF-8-BOM (Windows PowerShell 5.1, Editor). Das Zeichen per Code, nicht
  // im Quelltext: unsichtbar ginge es beim Bearbeiten unbemerkt verloren.
  r = run({ file: `${String.fromCharCode(0xfeff)}${JSON.stringify({ apiBaseUrl: 'https://bom.ohrganize.com' })}`, builtIn: BUILT });
  check(
    'config.json mit BOM wird gelesen',
    r.config?.apiBaseUrl === 'https://bom.ohrganize.com' && r.config.apiBaseSource === 'file' && r.config.skippedConfigNotice === null,
    r.error ? String(r.error) : r.config,
  );

  r = run({ file: { apiBaseUrl: 42 }, builtIn: null });
  check('Adresse keine Zeichenkette als einzige Quelle: Abbruch', r.error instanceof StartupError, String(r.error));

  r = run({ file: { apiBaseUrl: 42 }, builtIn: BUILT });
  check(
    'Adresse keine Zeichenkette mit eingebautem Server: Datei uebersprungen, Hinweis',
    r.config?.apiBaseSource === 'build' && (r.config.skippedConfigNotice ?? '').includes('Zeichenkette'),
    r.error ? String(r.error) : r.config,
  );

  r = run({ env: 'https://variable.ohrganize.com', file: { apiBaseUrl: 42 }, builtIn: null });
  check(
    'Adresse keine Zeichenkette mit Variable: Variable, Warnung, kein Hinweis',
    r.config?.apiBaseSource === 'env' && r.config.skippedConfigNotice === null && r.warned.length > 0,
    r.error ? String(r.error) : r.config,
  );

  // --- Pins ------------------------------------------------------------------
  r = run({ file: { serverKeyPins: [PIN_B] }, builtIn: BUILT });
  check(
    'Pins aus config.json schlagen die eingebauten',
    r.config?.apiBaseSource === 'build' && r.config.serverKeyPins?.from === 'file' && r.config.serverKeyPins.pins.join() === PIN_B,
    r.config,
  );

  r = run({ envPins: `${PIN_C}, ${PIN_B}`, file: { serverKeyPins: [PIN_B] }, builtIn: BUILT });
  check(
    'Pins aus der Variable schlagen Datei und eingebaute',
    r.config?.serverKeyPins?.from === 'env' && r.config.serverKeyPins.pins.join() === `${PIN_C},${PIN_B}`,
    r.config,
  );

  r = run({ builtIn: { url: BUILT.url, pins: [] } });
  check('eingebauter Server ohne Pins: Trust on first use', r.config?.apiBaseSource === 'build' && r.config.serverKeyPins === null, r.config);

  r = run({ file: { apiBaseUrl: 'https://datei.ohrganize.com', serverKeyPins: ['kaputt'] }, builtIn: null });
  check('ungueltige Pins in der Datei als einzige Quelle: Abbruch', r.error instanceof StartupError, String(r.error));

  r = run({ file: { apiBaseUrl: 'https://datei.ohrganize.com', serverKeyPins: ['kaputt'] }, builtIn: BUILT });
  check(
    'ungueltige Pins in der Datei mit eingebautem Server: ganze Datei uebersprungen, eingebaute Pins',
    r.config?.apiBaseSource === 'build' &&
      r.config.serverKeyPins?.from === 'build' &&
      (r.config.skippedConfigNotice ?? '').includes('serverKeyPins'),
    r.error ? String(r.error) : r.config,
  );

  r = run({ envPins: PIN_C, file: { serverKeyPins: ['kaputt'] }, builtIn: null });
  check(
    'Variable gibt die Pins vor: serverKeyPins der Datei ungeprueft',
    r.config?.serverKeyPins?.from === 'env' && r.config.serverKeyPins.pins.join() === PIN_C,
    r.error ? String(r.error) : r.config,
  );

  r = run({ envPins: 'kaputt', file: '{ kaputt', builtIn: BUILT });
  check(
    'ungueltige Variable bricht ab, auch neben einer uebersprungenen Datei',
    r.error instanceof StartupError && r.error.message.includes('OHRGANIZE_SERVER_KEY_PINS'),
    String(r.error),
  );

  // --- Defekte config.json -----------------------------------------------------
  r = run({ file: '{ kaputt', builtIn: null });
  check('defekte Datei als einzige Quelle: Abbruch', r.error instanceof StartupError, String(r.error));

  r = run({ file: '{ kaputt', builtIn: BUILT });
  check(
    'defekte Datei mit eingebautem Server: Warnung, eingebauter Server, sichtbarer Hinweis',
    r.config?.apiBaseSource === 'build' &&
      r.config.serverKeyPins?.from === 'build' &&
      r.warned.some((w) => w.includes(BUILT.url)) &&
      (r.config.skippedConfigNotice ?? '').includes(BUILT.url) &&
      (r.config.skippedConfigNotice ?? '').includes(cfg),
    { config: r.config, warned: r.warned },
  );

  r = run({ env: 'https://variable.ohrganize.com', file: '[1, 2]', builtIn: BUILT });
  check(
    'defekte Datei mit Variable: Warnung, Variable, kein Hinweis (Adresse ausdruecklich gesetzt)',
    r.config?.apiBaseSource === 'env' && r.warned.some((w) => w.includes('OHRGANIZE_API_BASE')) && r.config.skippedConfigNotice === null,
    { config: r.config, warned: r.warned },
  );

  r = run({ file: { apiBaseUrl: 'https://datei.ohrganize.com' }, builtIn: BUILT });
  check('intakte Datei: kein Hinweis', r.config?.skippedConfigNotice === null, r.config);

  // Nicht lesbar (hier: ein Verzeichnis an der Stelle der Datei, EISDIR);
  // gesperrte Dateien unter Windows enden im selben Zweig.
  fs.rmSync(cfg, { force: true });
  fs.mkdirSync(cfg);
  try {
    let unreadable: DesktopConfig | undefined;
    try {
      unreadable = readDesktopConfig(cfg, BUILT);
    } catch (error) {
      check('unlesbare Datei mit eingebautem Server: kein Abbruch', false, String(error));
    }
    check(
      'unlesbare Datei mit eingebautem Server: Hinweis mit Grund',
      unreadable?.apiBaseSource === 'build' && (unreadable.skippedConfigNotice ?? '').includes('nicht gelesen'),
      unreadable,
    );
    let error: unknown;
    try {
      readDesktopConfig(cfg, null);
    } catch (err) {
      error = err;
    }
    check('unlesbare Datei als einzige Quelle: Abbruch', error instanceof StartupError, String(error));
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }

  // --- Zeile der Anmeldeseite --------------------------------------------------
  check('Anmeldeseite: eingebettetes Backend', backendLabel('http://127.0.0.1:51234', true) === 'Daten auf diesem Rechner (Einzelplatz)');
  check(
    'Anmeldeseite: Testserver auf 127.0.0.1 ist kein Einzelplatz',
    backendLabel('http://127.0.0.1:3001', false) === 'Verbunden mit 127.0.0.1:3001',
    backendLabel('http://127.0.0.1:3001', false),
  );
  check(
    'Anmeldeseite: Server',
    backendLabel('https://musterfirma.ohrganize.com', false) === 'Verbunden mit musterfirma.ohrganize.com',
    backendLabel('https://musterfirma.ohrganize.com', false),
  );
  check(
    'Anmeldeseite: Port bleibt sichtbar',
    backendLabel('https://musterfirma.ohrganize.com:8443', false) === 'Verbunden mit musterfirma.ohrganize.com:8443',
  );

  // --- Eingebauter Server dieses Builds ----------------------------------------
  // Das Hauptprodukt verbindet sich nie von selbst mit einem Kundenserver; das
  // setzt nur eine Kundenausgabe auf ihrem Branch. Kundenausgabe heisst: Die
  // Version traegt die Edition jeder Variante im Register als Kennung
  // (<x.y.z>-<edition>). Dazu getrennt der Branch: Ein versehentlicher Merge
  // eines Kundenbranches nach main braechte Register und Version mit.
  // Dieselbe Regel, dazu Builds aus der Geschichte von main, steht im
  // Desktop-Build (scripts/builtInServerGuard.mjs).
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const onMain = branch.status === 0 && branch.stdout.trim() === 'main';
  const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { version: string };
  const tag = /^\d+\.\d+\.\d+-([a-z][a-z0-9]*)$/.exec(version)?.[1] ?? null;
  const customerBuild = tag !== null && VARIANTS.every((v) => v.edition === tag);
  if (!customerBuild || onMain) {
    check('Hauptprodukt ohne eingebauten Server', BUILT_IN_SERVER === null, BUILT_IN_SERVER);
  }
  if (BUILT_IN_SERVER) {
    check('eingebauter Server ueber https', BUILT_IN_SERVER.url.startsWith('https://'), BUILT_IN_SERVER.url);
    check(
      'eingebauter Server mit gueltigen Pins',
      BUILT_IN_SERVER.pins.length > 0 && BUILT_IN_SERVER.pins.every((p) => PIN_PATTERN.test(p)),
      BUILT_IN_SERVER.pins,
    );
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`desktopConfigTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('desktopConfigTest: ok');
