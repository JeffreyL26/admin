import fs from 'node:fs';
import type { BuiltInServer } from '@ohrganize/shared';
import { StartupError } from './startupError';
import { readEnvPins, readFilePins, type ConfiguredPins } from './serverPinning';

// ---------------------------------------------------------------------------
// Woher die Desktop-App ihren Server nimmt
// ---------------------------------------------------------------------------
// Eigene Datei ohne Electron, damit src/test/desktopConfigTest.ts die Regeln
// unter tsx pruefen kann (main.ts laedt Electron und laesst sich dort nicht
// importieren). main.ts uebergibt nur den Pfad von config.json und den
// eingebauten Server (BUILT_IN_SERVER, packages/shared/src/builtInServer.ts).
//
// Reihenfolge der Adresse: Umgebungsvariable OHRGANIZE_API_BASE, dann
// config.json, dann der eingebaute Server; ohne alle drei das eingebettete
// Backend mit Datenbank auf dem Rechner (Einzelplatz). Pins: Variable
// OHRGANIZE_SERVER_KEY_PINS, dann config.json, dann die Pins des eingebauten
// Servers (nur fuer dessen Herkunft), sonst Trust on first use.

/** Woher die Serveradresse stammt; 'build' heisst eingebaut (BUILT_IN_SERVER). */
export type ApiBaseSource = 'env' | 'file' | 'build';

export interface DesktopConfig {
  /** null = keine Adresse, die App startet das eingebettete Backend. */
  apiBaseUrl: string | null;
  apiBaseSource: ApiBaseSource | null;
  /** null = nichts konfiguriert (Trust on first use); sonst Pins samt wirksamer Quelle. */
  serverKeyPins: ConfiguredPins | null;
  /**
   * Gesetzt, wenn eine nicht verwendbare config.json (unlesbar, defekt oder falsch befuellt)
   * zugunsten des eingebauten Servers übersprungen wurde: Text für einen
   * sichtbaren Hinweis und für die Fehlermeldung, falls danach die
   * Verbindungsprüfung scheitert (main.ts). Sonst
   * verbände sich die App unbemerkt mit dem eingebauten Server, auch wenn die
   * Datei auf einen neuen Server zeigen sollte.
   */
  skippedConfigNotice: string | null;
}

/** Fehlercodes einer vermutlich nur kurz gesperrten Datei (OneDrive, Virenscanner, Editor beim Speichern). */
const TRANSIENT_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Liest mit bis zu vier Wiederholungen im Abstand von 250 ms, solange der
 * Fehler nach einer Sperre aussieht (TRANSIENT_READ_CODES); hoechstens rund
 * eine Sekunde, nur beim Start. Eine kurz gesperrte config.json soll weder den
 * Start abbrechen (mit OHRGANIZE_API_BASE oder als einzige Quelle) noch zum
 * eingebauten Server fuehren. Lesen und Warten sind fuer den Test einsetzbar.
 */
export function readWithRetry(
  read: () => string,
  wait: (ms: number) => void = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
): string {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return read();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !code || !TRANSIENT_READ_CODES.has(code)) throw err;
      wait(250);
    }
  }
}

/** Was eine verwendbare config.json beitraegt; beides null, wenn dort nichts steht. */
interface FileConfig {
  apiBaseUrl: string | null;
  serverKeyPins: ConfiguredPins | null;
}

/**
 * config.json einlesen und pruefen. Alle Fehler sind StartupError: Eine
 * unlesbare, fehlerhafte oder inhaltlich falsche Datei ist ein
 * Konfigurationszustand, den der Satz mit Dateipfad erklaeren muss, kein
 * Absturz, vor dem ein Stacktrace stuende. Lesbar, aber falsch befuellt
 * (Adresse keine Zeichenkette, ungueltige Pins) ist ebenso unbrauchbar wie
 * kaputt; readDesktopConfig behandelt beides gleich.
 *
 * Geprueft wird nur, was die Datei beitraegt: `use.address` false heisst,
 * OHRGANIZE_API_BASE gibt die Adresse vor, `use.pins` false, die
 * Umgebungsvariable gibt die Pins vor; der jeweilige Eintrag der Datei bleibt
 * dann ungeprueft wie unberuecksichtigt (eine alte, unbenutzte Adresse macht
 * die Datei nicht unbrauchbar).
 */
function readConfigFile(cfgPath: string, use: { address: boolean; pins: boolean }): FileConfig {
  let text: string;
  try {
    text = readWithRetry(() => fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} konnte nicht gelesen werden (${code}).`);
  }
  let raw: unknown;
  try {
    // Windows-Editoren und Windows PowerShell 5.1 (`Set-Content -Encoding utf8`)
    // stellen eine UTF-8-BOM voran; JSON.parse lehnt sie als ungueltiges
    // Zeichen ab. Sie ist kein Inhalt, also weg damit. Als Escape geschrieben,
    // nicht als Zeichen: Das waere unsichtbar und ginge beim Bearbeiten verloren.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} enthält kein gültiges JSON.`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} muss ein JSON-Objekt enthalten.`);
  }
  const { apiBaseUrl, serverKeyPins } = raw as { apiBaseUrl?: unknown; serverKeyPins?: unknown };
  return {
    apiBaseUrl: use.address ? readFileAddress(apiBaseUrl, cfgPath) : null,
    serverKeyPins: use.pins ? readFilePins(serverKeyPins, cfgPath) : null,
  };
}

/**
 * "apiBaseUrl" der Datei. Eine Adresse, die keine ist (etwa ohne https://),
 * ist falsch befuellt wie eine Zahl an dieser Stelle; die Meldung nennt die
 * Datei, damit die IT weiss, wo die Adresse steht.
 */
function readFileAddress(value: unknown, cfgPath: string): string | null {
  if (value != null && typeof value !== 'string') {
    throw new StartupError(`"apiBaseUrl" in ${cfgPath} muss eine Zeichenkette sein.`);
  }
  const address = value?.trim();
  return address ? normalizeApiBase(address, `"apiBaseUrl" in ${cfgPath}`) : null;
}

/**
 * Adressen, die den eigenen Rechner meinen. Nur für sie bleibt Klartext-HTTP
 * erlaubt: Dort verlässt der Verkehr die Maschine nicht, und genau so ist der
 * lokale Testbetrieb dokumentiert (docs/web-portal.md). `new URL()` liefert
 * IPv6-Hostnamen in eckigen Klammern zurück, deshalb stehen beide Schreibweisen
 * in der Liste.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // Nicht nur 127.0.0.1: Das gesamte Netz 127.0.0.0/8 zeigt auf den eigenen
  // Rechner, und manche Testaufbauten nutzen z. B. 127.0.0.2.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Prueft eine Backend-Adresse und entfernt den Schraegstrich am Ende (der
 * Renderer haengt Pfade wie "/api/..." direkt an). Hier statt in main.ts, damit
 * readDesktopConfig eine falsche Adresse in config.json wie jeden anderen
 * Fehler der Datei behandeln kann (Rueckfall auf den eingebauten Server).
 * `where` nennt die Herkunft der Adresse (Datei, Umgebungsvariable oder
 * eingebaut), damit jede Meldung sagt, wo sie zu korrigieren ist. Fuer alle
 * drei Quellen, auch den eingebauten Server: Klartext ins Netz waere dort
 * genauso falsch, und `npm test` ist fuer ein Release keine Pflicht.
 */
export function normalizeApiBase(raw: string, where: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StartupError(
      `"${raw}" (${where}) ist keine gültige Backend-Adresse (erwartet z. B. https://musterfirma.ohrganize.com).`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StartupError(`"${raw}" (${where}) muss mit http:// oder https:// beginnen.`);
  }
  // Klartext gegen einen fremden Host wird abgelehnt, nicht nur bemängelt:
  // Über diese Verbindung laufen Anmeldedaten, das Sitzungstoken und sämtliche
  // Personaldaten. Ein einmal falsch ausgerollter http://-Eintrag würde das
  // dauerhaft und unbemerkt offen durch das Firmennetz schicken, mitlesbar für
  // jeden im selben Netzsegment. StartupError statt Error (wie bei den beiden
  // Prüfungen davor): Eine falsch eingetragene Adresse ist ein
  // Konfigurationszustand, den der Satz erklären muss, kein Absturz; ein
  // Stacktrace davor würde die Meldung nur verdecken.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new StartupError(
      `Die Backend-Adresse "${raw}" (${where}) verwendet unverschlüsseltes http://.\n\n` +
        `Über diese Verbindung laufen Anmeldedaten, Zugangstoken und Personaldaten. ` +
        `Im Netzbetrieb ist deshalb https:// vorgeschrieben; http:// bleibt allein ` +
        `lokalen Testadressen (localhost, 127.0.0.1, ::1) vorbehalten.\n\n` +
        `Bitte die Adresse dort mit https:// eintragen (z. B. https://musterfirma.ohrganize.com).`,
    );
  }
  return raw.replace(/\/+$/, '');
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * config.json wird hoechstens EINMAL gelesen: Auch wenn OHRGANIZE_API_BASE die
 * Adresse vorgibt, koennen die Pins in der Datei stehen. Geben beide
 * Umgebungsvariablen alles vor, traegt die Datei nichts bei und wird nicht
 * gelesen.
 *
 * Eine nicht verwendbare Datei (unlesbar, kein JSON, falsch befuellt) wird nur
 * zugunsten des eingebauten Servers uebersprungen, und das sichtbar
 * (skippedConfigNotice): Die Datei koennte auf einen anderen Server zeigen.
 * Sonst bricht sie den Start ab. Ohne eingebauten Server hiesse Ueberspringen,
 * den Arbeitsplatz unbemerkt mit eingebettetem Backend und leerer Datenbank zu
 * starten; gibt OHRGANIZE_API_BASE die Adresse vor, braechte es eine
 * Verbindung ohne die in der Datei hinterlegten Serverschluessel (die App
 * lernte den Schluessel des Servers dann neu). Die Umgebungsvariablen werden
 * VOR der Datei gelesen und brechen bei Fehlern immer ab.
 */
export function readDesktopConfig(cfgPath: string, builtIn: BuiltInServer | null): DesktopConfig {
  const envBase = process.env.OHRGANIZE_API_BASE?.trim();
  const fromEnv = envBase ? normalizeApiBase(envBase, 'Umgebungsvariable OHRGANIZE_API_BASE') : null;
  const envPins = readEnvPins();
  let file: FileConfig = { apiBaseUrl: null, serverKeyPins: null };
  let skippedConfigNotice: string | null = null;
  if (!(fromEnv && envPins) && fs.existsSync(cfgPath)) {
    try {
      file = readConfigFile(cfgPath, { address: !fromEnv, pins: !envPins });
    } catch (err) {
      if (!(err instanceof StartupError) || fromEnv || !builtIn) throw err;
      console.warn(
        `[oHRganize] ${err.message} Die Datei wird übersprungen zugunsten des eingebauten Servers ${builtIn.url}; ` +
          `dort hinterlegte serverKeyPins bleiben unberücksichtigt.`,
      );
      skippedConfigNotice =
        `${err.message}\n\nDie App hat deshalb den eingebauten Server ${builtIn.url} genommen. ` +
        `Sollte die Datei auf einen anderen Server zeigen, bitte die IT verständigen.`;
    }
  }

  let apiBaseUrl: string | null = fromEnv ?? file.apiBaseUrl;
  let apiBaseSource: ApiBaseSource | null = fromEnv ? 'env' : file.apiBaseUrl ? 'file' : null;
  if (!apiBaseUrl && builtIn) {
    // Geprueft wie jede andere Adresse; ein Fehler hier ist einer der Ausgabe
    // selbst, die Meldung sagt das statt auf config.json zu verweisen.
    apiBaseUrl = normalizeApiBase(builtIn.url, 'in diese Ausgabe eingebaut, BUILT_IN_SERVER; nur ein neuer Build behebt das');
    apiBaseSource = 'build';
  }

  let serverKeyPins = envPins ?? file.serverKeyPins;
  if (!serverKeyPins && apiBaseUrl && builtIn && builtIn.pins.length > 0 && sameOrigin(apiBaseUrl, builtIn.url)) {
    serverKeyPins = { pins: [...builtIn.pins], from: 'build' };
  }

  return { apiBaseUrl, apiBaseSource, serverKeyPins, skippedConfigNotice };
}
