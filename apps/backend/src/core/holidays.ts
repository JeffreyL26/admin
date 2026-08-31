/**
 * Gesetzliche Feiertage aller 16 Bundesländer, rein rechnerisch (kein API-Zugriff).
 *
 * Bewusste Vereinfachungen (dokumentiert, da rechtlich Graubereiche existieren):
 * - Mariä Himmelfahrt (15.08.) nur für SL — in Bayern gilt er nur in überwiegend
 *   katholischen Gemeinden, was ohne Gemeindedaten nicht abbildbar ist.
 * - Fronleichnam nur für BW/BY/HE/NW/RP/SL — die kommunalen Ausnahmen in SN/TH
 *   sind ebenfalls gemeindeabhängig.
 * - Augsburger Friedensfest (nur Stadt Augsburg) ist nicht enthalten.
 */

export type Bundesland =
  | 'BW' | 'BY' | 'BE' | 'BB' | 'HB' | 'HH' | 'HE' | 'MV'
  | 'NI' | 'NW' | 'RP' | 'SL' | 'SN' | 'ST' | 'SH' | 'TH';

export const BUNDESLAENDER: Record<Bundesland, string> = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg',
  HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz',
  SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
};

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

/** Gauß'sche Osterformel → Ostersonntag des Jahres (UTC-Datum). */
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

/** Buß- und Bettag: Mittwoch vor dem 23. November. */
function bussUndBettag(year: number): string {
  const d = new Date(Date.UTC(year, 10, 22));
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

const ALL: Bundesland[] = Object.keys(BUNDESLAENDER) as Bundesland[];

// Feiertage sind rein (Jahr, Land)-deterministisch — es gibt keine Settings-
// Abhängigkeit, der Cache braucht also nie eine Invalidierung und bleibt winzig
// (16 Länder × genutzte Jahre × ≤19 Einträge). Ohne ihn baute jede Tagesprüfung
// der Saldo-Rechnung die komplette Jahresliste inkl. Osterformel neu auf.
// Aufrufer behandeln das zurückgegebene Array als unveränderlich.
const yearCache = new Map<string, Holiday[]>();
const byDateCache = new Map<string, Map<string, Holiday>>();

// Jahreszahlen kommen teils aus Nutzereingaben (Kalender-Range, Vorschau) —
// ohne Fenster ließe sich der Prozess-Cache mit beliebigen 4-stelligen Jahren
// unbegrenzt aufblähen. Außerhalb wird ungecacht gerechnet.
const MEMO_YEAR_MIN = 1950;
const MEMO_YEAR_MAX = 2150;

export function holidaysForYear(year: number, land: Bundesland): Holiday[] {
  if (year < MEMO_YEAR_MIN || year > MEMO_YEAR_MAX) return buildHolidays(year, land);
  const key = `${year}|${land}`;
  let cached = yearCache.get(key);
  if (!cached) {
    cached = buildHolidays(year, land);
    yearCache.set(key, cached);
  }
  return cached;
}

function buildHolidays(year: number, land: Bundesland): Holiday[] {
  const easter = easterSunday(year);
  const list: { date: string; name: string; laender: Bundesland[] }[] = [
    { date: `${year}-01-01`, name: 'Neujahr', laender: ALL },
    { date: `${year}-01-06`, name: 'Heilige Drei Könige', laender: ['BW', 'BY', 'ST'] },
    // Berlin führte den Frauentag 2019 ein, MV folgte 2023.
    {
      date: `${year}-03-08`,
      name: 'Internationaler Frauentag',
      laender: year >= 2023 ? ['BE', 'MV'] : year >= 2019 ? ['BE'] : [],
    },
    { date: shift(easter, -2), name: 'Karfreitag', laender: ALL },
    { date: shift(easter, 0), name: 'Ostersonntag', laender: ['BB'] },
    { date: shift(easter, 1), name: 'Ostermontag', laender: ALL },
    { date: `${year}-05-01`, name: 'Tag der Arbeit', laender: ALL },
    { date: shift(easter, 39), name: 'Christi Himmelfahrt', laender: ALL },
    { date: shift(easter, 49), name: 'Pfingstsonntag', laender: ['BB'] },
    { date: shift(easter, 50), name: 'Pfingstmontag', laender: ALL },
    { date: shift(easter, 60), name: 'Fronleichnam', laender: ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'] },
    { date: `${year}-08-15`, name: 'Mariä Himmelfahrt', laender: ['SL'] },
    { date: `${year}-09-20`, name: 'Weltkindertag', laender: year >= 2019 ? ['TH'] : [] },
    { date: `${year}-10-03`, name: 'Tag der Deutschen Einheit', laender: ALL },
    // 2017 war der Reformationstag zum 500. Jubiläum einmalig bundesweit
    // Feiertag; die Nordländer und HB machten ihn erst ab 2018 dauerhaft.
    {
      date: `${year}-10-31`,
      name: 'Reformationstag',
      laender:
        year === 2017
          ? ALL
          : year >= 2018
            ? ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']
            : ['BB', 'MV', 'SN', 'ST', 'TH'],
    },
    { date: `${year}-11-01`, name: 'Allerheiligen', laender: ['BW', 'BY', 'NW', 'RP', 'SL'] },
    { date: bussUndBettag(year), name: 'Buß- und Bettag', laender: ['SN'] },
    { date: `${year}-12-25`, name: '1. Weihnachtstag', laender: ALL },
    { date: `${year}-12-26`, name: '2. Weihnachtstag', laender: ALL },
  ];
  return list
    .filter((h) => h.laender.includes(land))
    .map(({ date, name }) => ({ date, name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function isHoliday(date: string, land: Bundesland): Holiday | undefined {
  const year = Number(date.slice(0, 4));
  if (year < MEMO_YEAR_MIN || year > MEMO_YEAR_MAX) {
    return holidaysForYear(year, land).find((h) => h.date === date);
  }
  const key = `${year}|${land}`;
  let byDate = byDateCache.get(key);
  if (!byDate) {
    byDate = new Map(holidaysForYear(year, land).map((h) => [h.date, h]));
    byDateCache.set(key, byDate);
  }
  return byDate.get(date);
}
