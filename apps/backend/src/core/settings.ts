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
  datevBeraterNr: string;
  datevMandantenNr: string;
}

const defaults: CompanySettings = {
  companyName: 'oHRganize GmbH',
  defaultBundesland: 'BY',
  carryoverDeadline: '03-31',
  surveyMinParticipants: 5,
  portalShowOthersSickness: true,
  datevBeraterNr: '1000001',
  datevMandantenNr: '10001',
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
