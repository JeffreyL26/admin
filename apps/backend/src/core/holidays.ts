/**
 * Gesetzliche Feiertage als Regeltabelle in Datenform, rein rechnerisch
 * (kein API-Zugriff).
 *
 * Aufbau: Je Land eine Liste von Regeln. Eine Regel nennt den Namen, wie der
 * Tag entsteht (fester Tag, Abstand zum Ostersonntag oder eigene Rechnung)
 * und in welchen Regionen sie gilt. Regeln, die sich im Lauf der Jahre
 * geaendert haben, stehen mehrfach mit einem Jahresfenster (`from`/`to`);
 * die Fenster ueberschneiden sich nicht, es gilt also je Jahr genau eine.
 *
 * Regionen kommen aus packages/shared/src/country.ts (REGIONS) und sind fuer
 * DE die 16 Bundeslaender. AT und CH haben heute keine Regeln: Die Struktur
 * steht, die Inhalte legt der Anbieter fest, wenn ein Land verkauft wird.
 * Eine leere Regelliste ergibt ein Jahr ohne Feiertage; die Tageszaehlung
 * rechnet dann nur Wochenenden und Betriebsruhe heraus.
 *
 * Bewusste Vereinfachungen (dokumentiert, da rechtlich Graubereiche existieren):
 * - Mariae Himmelfahrt (15.08.) nur fuer SL. In Bayern gilt er nur in
 *   ueberwiegend katholischen Gemeinden, was ohne Gemeindedaten nicht
 *   abbildbar ist.
 * - Fronleichnam nur fuer BW/BY/HE/NW/RP/SL. Die kommunalen Ausnahmen in
 *   SN/TH sind ebenfalls gemeindeabhaengig.
 * - Augsburger Friedensfest (nur Stadt Augsburg) ist nicht enthalten.
 */
import {
  DE_REGION_CODES,
  REGIONS,
  type CountryCode,
  type RegionCode,
} from '@ohrganize/shared';

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

/**
 * Eine Feiertagsregel. Genau eines von `date`, `easter` und `compute` ist
 * gesetzt. `regions` fehlt oder ist null: gilt im ganzen Land. `from`/`to`
 * grenzen das Jahresfenster ein (einschliesslich).
 */
export interface HolidayRule {
  name: string;
  /** Fester Tag im Jahr als 'MM-TT'. */
  date?: string;
  /** Abstand in Tagen zum Ostersonntag (negativ: davor). */
  easter?: number;
  /** Eigene Rechnung, wenn weder fest noch osterbezogen. */
  compute?: (year: number) => string;
  /** Regionscodes; fehlt oder null = landesweit. */
  regions?: readonly RegionCode[] | null;
  from?: number;
  to?: number;
}

/** Gauss'sche Osterformel, Ostersonntag des Jahres (UTC-Datum). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shift(base: Date, days: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** Buss- und Bettag: Mittwoch vor dem 23. November. */
function bussUndBettag(year: number): string {
  const d = new Date(Date.UTC(year, 10, 22));
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

const DE_CATHOLIC = ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'] as const;

/**
 * Regeltabelle Deutschland. Jahresfenster stehen an den Regeln, die sich
 * geaendert haben: Frauentag (BE ab 2019, MV ab 2023), Weltkindertag (TH ab
 * 2019) und Reformationstag (2017 einmalig bundesweit zum 500. Jubilaeum,
 * die Nordlaender und HB dauerhaft ab 2018).
 */
export const HOLIDAY_RULES_DE: readonly HolidayRule[] = [
  { name: 'Neujahr', date: '01-01' },
  { name: 'Heilige Drei Könige', date: '01-06', regions: ['BW', 'BY', 'ST'] },
  { name: 'Internationaler Frauentag', date: '03-08', regions: ['BE'], from: 2019, to: 2022 },
  { name: 'Internationaler Frauentag', date: '03-08', regions: ['BE', 'MV'], from: 2023 },
  { name: 'Karfreitag', easter: -2 },
  { name: 'Ostersonntag', easter: 0, regions: ['BB'] },
  { name: 'Ostermontag', easter: 1 },
  { name: 'Tag der Arbeit', date: '05-01' },
  { name: 'Christi Himmelfahrt', easter: 39 },
  { name: 'Pfingstsonntag', easter: 49, regions: ['BB'] },
  { name: 'Pfingstmontag', easter: 50 },
  { name: 'Fronleichnam', easter: 60, regions: DE_CATHOLIC },
  { name: 'Mariä Himmelfahrt', date: '08-15', regions: ['SL'] },
  { name: 'Weltkindertag', date: '09-20', regions: ['TH'], from: 2019 },
  { name: 'Tag der Deutschen Einheit', date: '10-03' },
  { name: 'Reformationstag', date: '10-31', regions: ['BB', 'MV', 'SN', 'ST', 'TH'], to: 2016 },
  { name: 'Reformationstag', date: '10-31', from: 2017, to: 2017 },
  {
    name: 'Reformationstag',
    date: '10-31',
    regions: ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'],
    from: 2018,
  },
  { name: 'Allerheiligen', date: '11-01', regions: ['BW', 'BY', 'NW', 'RP', 'SL'] },
  { name: 'Buß- und Bettag', compute: bussUndBettag, regions: ['SN'] },
  { name: '1. Weihnachtstag', date: '12-25' },
  { name: '2. Weihnachtstag', date: '12-26' },
];

/** Regeltabellen je Land. AT und CH: Struktur ohne Inhalt (siehe Kopf). */
export const HOLIDAY_RULES: Record<CountryCode, readonly HolidayRule[]> = {
  DE: HOLIDAY_RULES_DE,
  AT: [],
  CH: [],
};

/** Regionen eines Landes (Feiertags-Fixture, Auswahllisten im Backend). */
export function holidayRegionsFor(country: CountryCode): RegionCode[] {
  return Object.keys(REGIONS[country]);
}

/** Alle Regionscodes Deutschlands, in Katalogreihenfolge. */
export const DE_REGIONS: readonly RegionCode[] = DE_REGION_CODES;

// Feiertage sind rein (Land, Jahr, Region)-deterministisch. Es gibt keine
// Settings-Abhaengigkeit, der Cache braucht also nie eine Invalidierung und
// bleibt winzig (Regionen x genutzte Jahre x hoechstens 19 Eintraege). Ohne
// ihn baute jede Tagespruefung der Saldo-Rechnung die komplette Jahresliste
// inklusive Osterformel neu auf. Aufrufer behandeln das zurueckgegebene
// Array als unveraenderlich.
const yearCache = new Map<string, Holiday[]>();
const byDateCache = new Map<string, Map<string, Holiday>>();

// Jahreszahlen kommen teils aus Nutzereingaben (Kalender-Range, Vorschau).
// Ohne Fenster liesse sich der Prozess-Cache mit beliebigen 4-stelligen
// Jahren unbegrenzt aufblaehen. Ausserhalb wird ungecacht gerechnet.
const MEMO_YEAR_MIN = 1950;
const MEMO_YEAR_MAX = 2150;

function ruleApplies(rule: HolidayRule, year: number, region: RegionCode): boolean {
  if (rule.from !== undefined && year < rule.from) return false;
  if (rule.to !== undefined && year > rule.to) return false;
  const regions = rule.regions;
  if (regions === undefined || regions === null) return true;
  return regions.includes(region);
}

function ruleDate(rule: HolidayRule, year: number, easter: Date): string {
  if (rule.date !== undefined) return `${year}-${rule.date}`;
  if (rule.easter !== undefined) return shift(easter, rule.easter);
  if (rule.compute !== undefined) return rule.compute(year);
  throw new Error(`Feiertagsregel "${rule.name}" nennt weder date noch easter noch compute.`);
}

function buildHolidays(year: number, country: CountryCode, region: RegionCode): Holiday[] {
  const rules = HOLIDAY_RULES[country];
  if (rules.length === 0) return [];
  const easter = easterSunday(year);
  return rules
    .filter((rule) => ruleApplies(rule, year, region))
    .map((rule) => ({ date: ruleDate(rule, year, easter), name: rule.name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Feiertage eines Jahres in einer Region. Der Cache-Schluessel traegt das
 * Land: Sonst lieferte ein deutscher Regionscode nach einem AT-Aufruf
 * desselben Jahres die falsche Liste.
 */
export function holidaysForYear(
  year: number,
  country: CountryCode,
  region: RegionCode,
): Holiday[] {
  if (year < MEMO_YEAR_MIN || year > MEMO_YEAR_MAX) return buildHolidays(year, country, region);
  const key = `${country}|${year}|${region}`;
  let cached = yearCache.get(key);
  if (!cached) {
    cached = buildHolidays(year, country, region);
    yearCache.set(key, cached);
  }
  return cached;
}

/**
 * Feiertage mehrerer Regionen, auf einen Zeitraum beschnitten. Schluessel ist
 * der Regionscode, weil die Kalender-APIs je Person das Feld `bundesland`
 * liefern und die Clients die Liste damit nachschlagen.
 */
export function holidaysByRegion(
  year: number,
  from: string,
  to: string,
  places: readonly { country: CountryCode; region: RegionCode }[],
): Record<RegionCode, Holiday[]> {
  const out: Record<RegionCode, Holiday[]> = {};
  for (const place of places) {
    if (out[place.region] !== undefined) continue;
    out[place.region] = holidaysForYear(year, place.country, place.region).filter(
      (h) => h.date >= from && h.date <= to,
    );
  }
  return out;
}

export function isHoliday(
  date: string,
  country: CountryCode,
  region: RegionCode,
): Holiday | undefined {
  const year = Number(date.slice(0, 4));
  if (year < MEMO_YEAR_MIN || year > MEMO_YEAR_MAX) {
    return holidaysForYear(year, country, region).find((h) => h.date === date);
  }
  const key = `${country}|${year}|${region}`;
  let byDate = byDateCache.get(key);
  if (!byDate) {
    byDate = new Map(holidaysForYear(year, country, region).map((h) => [h.date, h]));
    byDateCache.set(key, byDate);
  }
  return byDate.get(date);
}
