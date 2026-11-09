import fs from 'node:fs';
import type { BuiltInServer } from '@ohrganize/shared';
import { StartupError } from './startupError';
import { readConfiguredPins, type ConfiguredPins } from './serverPinning';

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
   * Gesetzt, wenn eine defekte config.json zugunsten des eingebauten Servers
   * übersprungen wurde: Text für einen sichtbaren Hinweis (main.ts). Sonst
   * verbände sich die App unbemerkt mit dem eingebauten Server, auch wenn die
   * Datei auf einen neuen Server zeigen sollte.
   */
  skippedConfigNotice: string | null;
}

type RawDesktopConfig = { apiBaseUrl?: unknown; serverKeyPins?: unknown };

/**
 * config.json einlesen. Alle Fehler sind StartupError: Eine unlesbare oder
 * fehlerhafte Datei ist ein Konfigurationszustand, den der Satz mit Dateipfad
 * erklären muss, kein Absturz, vor dem ein Stacktrace stünde.
 */
function parseConfigFile(cfgPath: string): RawDesktopConfig {
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
    // stellen eine UTF-8-BOM voran; JSON.parse lehnt sie als ungültiges
    // Zeichen ab. Sie ist kein Inhalt, also weg damit.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} enthält kein gültiges JSON.`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StartupError(`Die Konfigurationsdatei ${cfgPath} muss ein JSON-Objekt enthalten.`);
  }
  return raw as RawDesktopConfig;
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
 * Adresse vorgibt, können die Pins in der Datei stehen.
 *
 * Eine defekte Datei ist nur dann tödlich, wenn sie die einzige Quelle der
 * Adresse wäre: Sie still zu übergehen hieße, den Arbeitsplatz unbemerkt mit
 * eingebettetem Backend und leerer Datenbank zu starten. Gibt
 * OHRGANIZE_API_BASE die Adresse vor oder gibt es einen eingebauten Server,
 * droht das nicht; dann Warnung statt Abbruch, und Pins kommen aus der
 * Variable, vom eingebauten Server oder per Trust on first use.
 */
export function readDesktopConfig(cfgPath: string, builtIn: BuiltInServer | null): DesktopConfig {
  const fromEnv = process.env.OHRGANIZE_API_BASE?.trim() || null;
  let parsed: RawDesktopConfig = {};
  let skippedConfigNotice: string | null = null;
  if (fs.existsSync(cfgPath)) {
    try {
      parsed = parseConfigFile(cfgPath);
    } catch (err) {
      if (!(err instanceof StartupError) || (!fromEnv && !builtIn)) throw err;
      const instead = fromEnv
        ? 'weil OHRGANIZE_API_BASE die Adresse vorgibt'
        : `zugunsten des eingebauten Servers ${builtIn?.url}`;
      console.warn(
        `[oHRganize] ${err.message} Die Datei wird übersprungen, ${instead}; ` +
          `dort hinterlegte serverKeyPins bleiben unberücksichtigt.`,
      );
      // Mit Variable ist die Adresse ausdrücklich gesetzt; nur der Rückfall auf
      // den eingebauten Server braucht einen Hinweis, den man auch sieht.
      if (!fromEnv && builtIn) {
        skippedConfigNotice =
          `${err.message}\n\nDie App arbeitet deshalb mit dem eingebauten Server ${builtIn.url}. ` +
          `Sollte die Datei auf einen anderen Server zeigen, bitte die IT verständigen.`;
      }
    }
  }

  let apiBaseUrl: string | null = null;
  let apiBaseSource: ApiBaseSource | null = null;
  if (fromEnv) {
    apiBaseUrl = fromEnv;
    apiBaseSource = 'env';
  } else {
    const value = parsed.apiBaseUrl;
    if (typeof value === 'string' && value.trim() !== '') {
      apiBaseUrl = value.trim();
      apiBaseSource = 'file';
    } else if (value != null && typeof value !== 'string') {
      throw new StartupError(`"apiBaseUrl" in ${cfgPath} muss eine Zeichenkette sein.`);
    }
  }
  if (!apiBaseUrl && builtIn) {
    apiBaseUrl = builtIn.url;
    apiBaseSource = 'build';
  }

  let serverKeyPins = readConfiguredPins(parsed.serverKeyPins, cfgPath);
  if (!serverKeyPins && apiBaseUrl && builtIn && builtIn.pins.length > 0 && sameOrigin(apiBaseUrl, builtIn.url)) {
    serverKeyPins = { pins: [...builtIn.pins], from: 'build' };
  }

  return { apiBaseUrl, apiBaseSource, serverKeyPins, skippedConfigNotice };
}
