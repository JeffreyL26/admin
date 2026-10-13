import type { DatevFestbezuegeMode, DatevProgram } from '@ohrganize/shared';
import { getDb } from '../db/db.js';

// Das LAND der Installation steht bewusst NICHT hier: Es kommt aus der
// Variante (VARIANT.country), weil Kataloge, Feiertagsrecht und Exporte am
// Build haengen und ein Umschalten zur Laufzeit halbfertige Daten erzeugte.
export interface CompanySettings {
  companyName: string;
  /**
   * Regionscode des Firmensitzes (in DE ein Bundesland), Rueckfall fuer
   * Personen ohne Standort. Geprueft gegen den Katalog des Variantenlandes
   * (core/settingsRoutes.ts, isRegionOf).
   */
  defaultBundesland: string;
  /** Verfallsdatum für Resturlaub aus dem Vorjahr, Format "MM-TT". */
  carryoverDeadline: string;
  /** Mindestteilnehmerzahl, bevor Umfrageergebnisse angezeigt werden. */
  surveyMinParticipants: number;
  /**
   * Zeigt der Portal-Kalender Krankheiten ANDERER Mitarbeitender (Kategorie
   * `krankheit`)? Sie erscheinen dort ohnehin nur maskiert als „Abwesend“
   * (portal_visibility, Migration 202); aus bleibt ein Krankheitszeitraum
   * anderer ganz weg. Eigene Krankmeldungen sieht die Person immer.
   */
  portalShowOthersSickness: boolean;
  /**
   * DATEV-Lohnexport (modules/compensation/payrollExport, docs/datev-lohnexport.md).
   * Berater- und Mandantennummer sind ab Werk LEER: Ohne sie ist der Export
   * gesperrt, statt mit einer Demonummer beim falschen Mandanten zu landen.
   */
  datevBeraterNr: string;
  datevMandantenNr: string;
  /** Lohnprogramm des Lohnbueros: LODAS (Stamm- und Bewegungsdaten) oder Lohn und Gehalt (nur Bewegungsdaten). */
  datevProgramm: DatevProgram;
  /** LODAS: betriebliche Personalnummer (bis 20 Zeichen) statt der 5-stelligen Mitarbeiternummer als Schluessel. */
  datevBetrieblichePnr: boolean;
  /** Wiederkehrende Bezuege als Festbezuege (Stammdaten) oder monatliche Buchung. */
  datevFestbezuege: DatevFestbezuegeMode;
  /** Stundenloehner: Vertragsstunden (Wochenstunden mal 4,33) als Stunden uebergeben; ohne Zeiterfassung sonst nichts. */
  datevVertragsstunden: boolean;
  /**
   * Lohnartennummer je DatevLohnartKey, nur was gespeichert ist. Die
   * Vorschlaege (DATEV_LOHNART_DEFAULTS) belegen nur die Einstellungsseite
   * vor; ein Schluessel ohne gespeicherte Nummer sperrt den Export.
   */
  datevLohnarten: Record<string, string>;
  /** Ausfallschluessel je Abwesenheitsart (Schluessel: id als Text); ohne Eintrag wird die Art nicht uebergeben. */
  datevAusfallschluessel: Record<string, string>;
}

const defaults: CompanySettings = {
  companyName: 'oHRganize GmbH',
  defaultBundesland: 'BY',
  carryoverDeadline: '03-31',
  surveyMinParticipants: 5,
  portalShowOthersSickness: true,
  datevBeraterNr: '',
  datevMandantenNr: '',
  datevProgramm: 'lodas',
  datevBetrieblichePnr: false,
  datevFestbezuege: 'stammdaten',
  datevVertragsstunden: false,
  datevLohnarten: {},
  datevAusfallschluessel: {},
};

export function getSetting<K extends keyof CompanySettings>(key: K): CompanySettings[K] {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? JSON.parse(row.value) : defaults[key];
}

export function getAllSettings(): CompanySettings {
  const rows = getDb().prepare('SELECT key, value FROM app_settings').all() as {
    key: string;
    value: string;
  }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...defaults, ...stored };
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, JSON.stringify(value));
}
