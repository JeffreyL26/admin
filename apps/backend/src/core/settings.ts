import { getDb } from '../db/db.js';

export interface CompanySettings {
  companyName: string;
  defaultBundesland: string;
  /** Verfallsdatum für Resturlaub aus dem Vorjahr, Format "MM-TT". */
  carryoverDeadline: string;
  /** Mindestteilnehmerzahl, bevor Umfrageergebnisse angezeigt werden. */
  surveyMinParticipants: number;
  datevBeraterNr: string;
  datevMandantenNr: string;
}

const defaults: CompanySettings = {
  companyName: 'oHRganize GmbH',
  defaultBundesland: 'BY',
  carryoverDeadline: '03-31',
  surveyMinParticipants: 5,
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
