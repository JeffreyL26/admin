import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  REGIONS,
  type DeRegionCode,
} from './country.js';

/** Einheitliches Fehlerschema aller API-Antworten. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Bundesländer sind die Regionen des Landes DE. Die eine Quelle ist
 * `REGIONS.DE` in country.ts; die beiden Namen hier bleiben als Aliasse
 * erhalten, weil Datenbankspalte (`locations.bundesland`), API-Feld und
 * mehrere Oberflächen sie so kennen.
 */
export type BundeslandCode = DeRegionCode;
export const BUNDESLAND_LABELS: Record<BundeslandCode, string> = REGIONS.DE;

/**
 * Geldbeträge sind überall Integer-Cent; Formatierung ist Client-Sache.
 * Sprachkennung und Währung kommen aus dem Land der Variante
 * (`localeFor`/`currencyFor`); ohne Angabe gilt die Vorgabe DE.
 */
export function formatMoney(
  cents: number,
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
): string {
  return (cents / 100).toLocaleString(locale, { style: 'currency', currency });
}

/** Kurzform für Euro-Beträge in deutscher Schreibweise. */
export function formatEuro(cents: number): string {
  return formatMoney(cents);
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

/** ISO-Kalendertag plus/minus Tage, ohne Zeitzoneneffekt (Rechnung in UTC-Mitternacht). */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
