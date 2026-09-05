/** Einheitliches Fehlerschema aller API-Antworten. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type BundeslandCode =
  | 'BW' | 'BY' | 'BE' | 'BB' | 'HB' | 'HH' | 'HE' | 'MV'
  | 'NI' | 'NW' | 'RP' | 'SL' | 'SN' | 'ST' | 'SH' | 'TH';

export const BUNDESLAND_LABELS: Record<BundeslandCode, string> = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg',
  HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz',
  SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
};

/** Geldbeträge sind überall Integer-Cent; Formatierung ist Client-Sache. */
export function formatEuro(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

/**
 * Heutiges Datum als ISO-String in der LOKALEN Zeitzone.
 * `new Date().toISOString()` liefert UTC — in Deutschland ist das zwischen
 * 0 und 1/2 Uhr nachts noch der Vortag; Vorgabedaten und Fristenvergleiche
 * müssen deshalb hierüber laufen.
 */
export function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO-Datum (YYYY-MM-DD) → deutsche Anzeige (TT.MM.JJJJ). */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}.${m}.${y.slice(0, 4)}`;
}

/**
 * SQLite-Zeitstempel (UTC, "YYYY-MM-DD HH:MM:SS", wie `datetime('now')` ihn
 * schreibt) → lokale Anzeige "TT.MM.JJJJ, HH:MM". Für Protokolle, bei denen
 * die Uhrzeit zählt (Bewertungsprotokoll). Ein bereits zeitzonenbehafteter
 * ISO-String wird unverändert interpretiert.
 */
export function formatDateTime(sqliteUtc: string | null | undefined): string {
  if (sqliteUtc === null || sqliteUtc === undefined || sqliteUtc === '') return '—';
  const raw = String(sqliteUtc);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const zoned = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(zoned);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
