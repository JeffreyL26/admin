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
   * sichtbaren Hinweis und für die Fehlermeldung eines gescheiterten Starts
   * (main.ts). Sonst
   * verbände sich die App unbemerkt mit dem eingebauten Server, auch wenn die
   * Datei auf einen neuen Server zeigen sollte.
   */
  skippedConfigNotice: string | null;
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
 * `withPins` false: Die Umgebungsvariable gibt die Pins vor, "serverKeyPins"
 * der Datei bleibt ungeprueft wie unberuecksichtigt.
 */
function readConfigFile(cfgPath: string, withPins: boolean): FileConfig {
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, 'utf8');
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
  if (apiBaseUrl != null && typeof apiBaseUrl !== 'string') {
    throw new StartupError(`"apiBaseUrl" in ${cfgPath} muss eine Zeichenkette sein.`);
  }
  return {
    apiBaseUrl: apiBaseUrl?.trim() || null,
    serverKeyPins: withPins ? readFilePins(serverKeyPins, cfgPath) : null,
  };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * config.json wird genau EINMAL gelesen: Auch wenn OHRGANIZE_API_BASE die
 * Adresse vorgibt, koennen die Pins in der Datei stehen.
 *
 * Eine nicht verwendbare Datei (unlesbar, kein JSON, falsch befuellt) ist nur
 * dann toedlich, wenn sie die einzige Quelle der Adresse waere: Sie still zu
 * uebergehen hiesse, den Arbeitsplatz unbemerkt mit eingebettetem Backend und
 * leerer Datenbank zu starten. Gibt OHRGANIZE_API_BASE die Adresse vor oder
 * gibt es einen eingebauten Server, droht das nicht; dann Warnung statt
 * Abbruch, und Pins kommen aus der Variable, vom eingebauten Server oder per
 * Trust on first use. Die Umgebungsvariablen werden VOR der Datei gelesen und
 * brechen immer ab: Nach dem Ueberspringen der Datei wirft nichts mehr, ein
 * Hinweis darauf ginge sonst mit dem Fehler verloren.
 */
export function readDesktopConfig(cfgPath: string, builtIn: BuiltInServer | null): DesktopConfig {
  const fromEnv = process.env.OHRGANIZE_API_BASE?.trim() || null;
  const envPins = readEnvPins();
  let file: FileConfig = { apiBaseUrl: null, serverKeyPins: null };
  let skippedConfigNotice: string | null = null;
  if (fs.existsSync(cfgPath)) {
    try {
      file = readConfigFile(cfgPath, !envPins);
    } catch (err) {
      if (!(err instanceof StartupError) || (!fromEnv && !builtIn)) throw err;
      const instead = fromEnv
        ? 'weil OHRGANIZE_API_BASE die Adresse vorgibt'
        : `zugunsten des eingebauten Servers ${builtIn?.url}`;
      console.warn(
        `[oHRganize] ${err.message} Die Datei wird übersprungen, ${instead}; ` +
          `dort hinterlegte serverKeyPins bleiben unberücksichtigt.`,
      );
      // Mit Variable ist die Adresse ausdruecklich gesetzt; nur der Rueckfall auf
      // den eingebauten Server braucht einen Hinweis, den man auch sieht.
      if (!fromEnv && builtIn) {
        skippedConfigNotice =
          `${err.message}\n\nDie App hat deshalb den eingebauten Server ${builtIn.url} genommen. ` +
          `Sollte die Datei auf einen anderen Server zeigen, bitte die IT verständigen.`;
      }
    }
  }

  let apiBaseUrl: string | null = fromEnv ?? file.apiBaseUrl;
  let apiBaseSource: ApiBaseSource | null = fromEnv ? 'env' : file.apiBaseUrl ? 'file' : null;
  if (!apiBaseUrl && builtIn) {
    apiBaseUrl = builtIn.url;
    apiBaseSource = 'build';
  }

  let serverKeyPins = envPins ?? file.serverKeyPins;
  if (!serverKeyPins && apiBaseUrl && builtIn && builtIn.pins.length > 0 && sameOrigin(apiBaseUrl, builtIn.url)) {
    serverKeyPins = { pins: [...builtIn.pins], from: 'build' };
  }

  return { apiBaseUrl, apiBaseSource, serverKeyPins, skippedConfigNotice };
}
