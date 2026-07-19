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

/** ISO-Datum (YYYY-MM-DD) → deutsche Anzeige (TT.MM.JJJJ). */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}.${m}.${y.slice(0, 4)}`;
}
