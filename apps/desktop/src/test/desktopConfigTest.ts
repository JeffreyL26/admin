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
import { BUILT_IN_SERVER, VARIANT_IDS, backendLabel, type BuiltInServer } from '@ohrganize/shared';
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

  r = run({ file: { apiBaseUrl: 42 }, builtIn: BUILT });
  check('Adresse keine Zeichenkette: Abbruch', r.error instanceof StartupError, String(r.error));

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
  // Das Hauptprodukt (Register mit der Vollversion, Branch main) verbindet
  // sich nie von selbst mit einem Kundenserver; das setzt nur eine
  // Kundenausgabe auf ihrem Branch. Beides getrennt geprueft: Ein
  // versehentlicher Merge eines Kundenbranches nach main braechte dessen
  // Register mit. Dieselbe Sperre steht im Desktop-Build (scripts/build.mjs).
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const onMain = branch.status === 0 && branch.stdout.trim() === 'main';
  if (VARIANT_IDS.includes('de-vollversion') || onMain) {
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
