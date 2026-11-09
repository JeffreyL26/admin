/**
 * Prueft, woher die Desktop-App ihren Server nimmt (desktopConfig.ts):
 * Reihenfolge Umgebungsvariable, config.json, eingebauter Server, sonst das
 * eingebettete Backend; dieselbe Reihenfolge fuer die Pins, die eingebauten
 * nur fuer die Herkunft des eingebauten Servers; eine nicht verwendbare
 * config.json wird nur zugunsten des eingebauten Servers uebersprungen und
 * bricht sonst ab. Dazu die
 * Zeile der Anmeldeseite (backendLabel) und dass ein eingebauter Server
 * brauchbar ist (ob er stehen darf: scripts/builtInServerGuardTest.mjs).
 *
 * Laeuft ohne Electron unter tsx. Aufruf: npm test -w apps/desktop (Teil von
 * npm test).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILT_IN_SERVER, backendLabel, type BuiltInServer } from '@ohrganize/shared';
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

/** Steht fuer "config.json ist nicht lesbar" (ein Verzeichnis an ihrer Stelle, EISDIR). */
const UNREADABLE = Symbol('unlesbar');

/**
 * Ein Fall: Umgebung und Datei setzen, lesen, alles wieder aufraeumen. Jeder
 * Fall laeuft hierueber, damit Variablen aus der Shell des Entwicklers
 * (OHRGANIZE_API_BASE beim Testen gegen einen Server) kein Ergebnis aendern.
 */
function run(opts: {
  env?: string;
  envPins?: string;
  file?: string | object | typeof UNREADABLE;
  builtIn: BuiltInServer | null;
}): {
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
  fs.rmSync(cfg, { recursive: true, force: true });
  if (opts.file === UNREADABLE) fs.mkdirSync(cfg);
  else if (opts.file !== undefined) {
    fs.writeFileSync(cfg, typeof opts.file === 'string' ? opts.file : JSON.stringify(opts.file));
  }
  try {
    return { config: readDesktopConfig(cfg, opts.builtIn), warned };
  } catch (error) {
    return { error, warned };
  } finally {
    console.warn = warn;
    fs.rmSync(cfg, { recursive: true, force: true });
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
    'Variable mit derselben Herkunft: eingebaute Pins gelten, Schraegstrich am Ende entfernt',
    r.config?.apiBaseSource === 'env' &&
      r.config.apiBaseUrl === 'https://musterfirma.ohrganize.com' &&
      r.config.serverKeyPins?.from === 'build',
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

  // Gibt die Variable die Adresse vor, ist die der Datei unbenutzt und wird
  // nicht geprueft: Eine alte Adresse darf die Pins der Datei nicht kosten.
  r = run({ env: 'https://variable.ohrganize.com', file: { apiBaseUrl: 'http://alt.firma.local', serverKeyPins: [PIN_B] }, builtIn: null });
  check(
    'unbenutzte Adresse der Datei mit Variable: ungeprueft, Pins der Datei gelten',
    r.config?.apiBaseSource === 'env' &&
      r.config.serverKeyPins?.from === 'file' &&
      r.config.serverKeyPins.pins.join() === PIN_B &&
      r.config.skippedConfigNotice === null,
    r.error ? String(r.error) : r.config,
  );

  // Eine Zeichenkette, die keine gueltige Adresse ist, ist ebenso falsch
  // befuellt (haeufigster Tippfehler: ohne https://).
  r = run({ file: { apiBaseUrl: 'dronivo.ohrganize.com' }, builtIn: BUILT });
  check(
    'Adresse ohne https:// mit eingebautem Server: Datei uebersprungen, Hinweis nennt Adresse und Datei',
    r.config?.apiBaseSource === 'build' &&
      (r.config.skippedConfigNotice ?? '').includes('dronivo.ohrganize.com') &&
      (r.config.skippedConfigNotice ?? '').includes(cfg),
    r.error ? String(r.error) : r.config,
  );

  r = run({ file: { apiBaseUrl: 'dronivo.ohrganize.com' }, builtIn: null });
  check('Adresse ohne https:// als einzige Quelle: Abbruch', r.error instanceof StartupError, String(r.error));

  r = run({ file: { apiBaseUrl: 'http://datei.ohrganize.com' }, builtIn: BUILT });
  check(
    'Klartext zu fremdem Host in der Datei mit eingebautem Server: Datei uebersprungen',
    r.config?.apiBaseSource === 'build' && (r.config.skippedConfigNotice ?? '').includes('http://'),
    r.error ? String(r.error) : r.config,
  );

  r = run({ file: { apiBaseUrl: 'http://127.0.0.1:3001/' }, builtIn: BUILT });
  check(
    'lokale Testadresse ueber http bleibt erlaubt',
    r.config?.apiBaseSource === 'file' && r.config.apiBaseUrl === 'http://127.0.0.1:3001',
    r.error ? String(r.error) : r.config,
  );

  r = run({ env: 'dronivo.ohrganize.com', builtIn: BUILT });
  check('ungueltige Adresse in der Variable: Abbruch', r.error instanceof StartupError, String(r.error));

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

  // Mit Variable wird nie uebersprungen, auch nicht mit eingebautem Server:
  // Die App verbaende sich sonst ohne die Pins der Datei.
  r = run({ env: 'https://variable.ohrganize.com', file: '[1, 2]', builtIn: BUILT });
  check('defekte Datei mit Variable: Abbruch', r.error instanceof StartupError, String(r.error));

  r = run({ env: 'https://variable.ohrganize.com', file: { serverKeyPins: ['kaputt'] }, builtIn: BUILT });
  check(
    'ungueltige Pins der Datei mit Variable: Abbruch statt Verbindung ohne Pins',
    r.error instanceof StartupError && r.error.message.includes('serverKeyPins'),
    String(r.error),
  );

  r = run({ env: 'https://variable.ohrganize.com', envPins: PIN_C, file: '{ kaputt', builtIn: null });
  check(
    'beide Variablen gesetzt: config.json wird nicht gelesen',
    r.config?.apiBaseSource === 'env' && r.config.serverKeyPins?.from === 'env' && r.config.skippedConfigNotice === null,
    r.error ? String(r.error) : r.config,
  );

  r = run({ file: { apiBaseUrl: 'https://datei.ohrganize.com' }, builtIn: BUILT });
  check('intakte Datei: kein Hinweis', r.config?.skippedConfigNotice === null, r.config);

  // Nicht lesbar (hier: ein Verzeichnis an der Stelle der Datei, EISDIR);
  // gesperrte Dateien unter Windows enden im selben Zweig.
  r = run({ file: UNREADABLE, builtIn: BUILT });
  check(
    'unlesbare Datei mit eingebautem Server: Hinweis mit Grund',
    r.config?.apiBaseSource === 'build' && (r.config.skippedConfigNotice ?? '').includes('nicht gelesen'),
    r.error ? String(r.error) : r.config,
  );

  r = run({ file: UNREADABLE, builtIn: null });
  check('unlesbare Datei als einzige Quelle: Abbruch', r.error instanceof StartupError, String(r.error));

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
  // Ob er hier ueberhaupt stehen darf (nur Kundenausgabe auf ihrem Branch),
  // prueft scripts/builtInServerGuardTest.mjs mit derselben Regel wie der
  // Desktop-Build. Die Sperre liest dafuer den Quelltext von
  // builtInServer.ts; hier, dass er zum Wert passt, den die App tatsaechlich
  // bekommt (sonst kaeme ein anderswo gesetzter Server an ihr vorbei).
  {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const guard = require('../../scripts/builtInServerGuard.mjs') as { builtInServerIsNull: (source: string) => boolean };
    const source = fs.readFileSync(path.join(__dirname, '../../../../packages/shared/src/builtInServer.ts'), 'utf8');
    check(
      'Bausperre liest denselben Wert wie die App',
      guard.builtInServerIsNull(source) === (BUILT_IN_SERVER === null),
      { quelltextNull: guard.builtInServerIsNull(source), laufzeit: BUILT_IN_SERVER },
    );
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
