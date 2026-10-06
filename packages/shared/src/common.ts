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
  return moneyFormatter(locale, currency).format(cents / 100);
}

/**
 * Ein Formatierer je Sprache und Währung. `toLocaleString` mit Optionen baut
 * bei JEDEM Aufruf einen neuen `Intl.NumberFormat` (gemessen 85 bis 100 µs
 * statt 2 µs); eine Gehaltsliste mit 2000 Zeilen und sechs Geldspalten
 * kostete so rund eine Sekunde je Neuzeichnen. Der Cache hält nur
 * Formatierer, keine Beträge; die Schlüssel kommen aus der Variante
 * (`localeFor`/`currencyFor`). Die Obergrenze hält ihn trotzdem klein, falls
 * je ein Aufrufer freie Werte übergibt.
 */
const MONEY_FORMATTERS = new Map<string, Intl.NumberFormat>();
const MONEY_FORMATTER_LIMIT = 16;

function moneyFormatter(locale: string, currency: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let formatter = MONEY_FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
    if (MONEY_FORMATTERS.size >= MONEY_FORMATTER_LIMIT) MONEY_FORMATTERS.clear();
    MONEY_FORMATTERS.set(key, formatter);
  }
  return formatter;
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

/**
 * Initialen eines Anzeigenamens: erster Buchstabe des ersten und des LETZTEN
 * Wortes. "Bianka Marthina Simon" ergibt "BS", nicht "BM": Mittlere Vornamen
 * zaehlen nicht. Ein einzelnes Wort ergibt einen Buchstaben.
 */
export function nameInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
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

/**
 * Schwarz oder Weiß als Textfarbe auf einer Hex-Fläche — je nachdem, was die
 * WCAG-Mindestkontraste einhält. Beide Kalender (Desktop und Portal) setzen
 * damit die Artbezeichnung in die Balken; die Palette reicht von kräftigem
 * Blau bis zu hellem Gold, ein pauschal weißer Schriftzug wäre auf den
 * helleren Tönen kaum lesbar.
 */
export function readableTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#fff';
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => toLinear(parseInt(h!, 16))) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithWhite >= 3.4 ? '#fff' : 'rgba(0, 0, 0, 0.82)';
}
