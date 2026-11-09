import { CUSTOMER_SERVER, CUSTOMER_SERVER_KEY_PINS } from './dronivo.js';

/**
 * Server, den die Desktop-App nimmt, wenn weder die Umgebungsvariable
 * OHRGANIZE_API_BASE noch config.json eine Adresse nennen
 * (apps/desktop/src/desktopConfig.ts).
 *
 * Auf main ist er `null`: Ohne Konfiguration startet das eingebettete Backend
 * mit Datenbank auf dem Rechner (Einzelplatz-Betrieb). Eine Kundenausgabe, die
 * nur mit ihrem Server arbeitet (Branch dronivo), setzt ihn; dann startet das
 * eingebettete Backend dort nie. Hintergrund: Ohne Adresse lief eine solche
 * App still mit leerer eigener Datenbank, und die HR-Konten hiessen
 * "E-Mail oder Passwort ist falsch", obwohl sie im Portal galten.
 *
 * `pins` sind SPKI-Pins wie in apps/desktop/src/serverPinning.ts; sie gelten
 * nur fuer die Herkunft von `url` und nur, wenn weder
 * OHRGANIZE_SERVER_KEY_PINS noch "serverKeyPins" in config.json gesetzt ist.
 * Variable und Datei gehen dem eingebauten Server immer vor.
 */
export interface BuiltInServer {
  url: string;
  pins: readonly string[];
}

// Kundenbranch dronivo (Abweichung von main wie PORTAL_ABSENCE_CAPTURE): Die
// Ausgabe arbeitet nur mit ihrem Server (CUSTOMER_SERVER in dronivo.ts). Auf
// main steht hier null; ein Merge von main behaelt diese Zeile
// (scripts/check-dronivo.mjs prueft sie).
export const BUILT_IN_SERVER: BuiltInServer | null = { url: CUSTOMER_SERVER, pins: CUSTOMER_SERVER_KEY_PINS };

/**
 * Zeile fuer die Anmeldeseite der Desktop-App: mit welchem Backend die App
 * spricht. So sieht man vor der Anmeldung, ob sie am Server haengt oder mit
 * einer Datenbank auf diesem Rechner arbeitet (dort gelten die Konten des
 * Servers nicht). `embedded` meldet der Main-Prozess (Preload
 * `embeddedBackend`): Die Adresse allein verriete es nicht, ein Testserver
 * auf 127.0.0.1 ist kein Einzelplatz.
 */
export function backendLabel(apiBase: string, embedded: boolean): string {
  if (embedded) return 'Daten auf diesem Rechner (Einzelplatz)';
  try {
    return `Verbunden mit ${new URL(apiBase).host}`;
  } catch {
    return `Verbunden mit ${apiBase}`;
  }
}