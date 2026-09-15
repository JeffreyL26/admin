/**
 * Einmalskript: schreibt die Feiertags-Fixture fixtures/holidays-de.json aus
 * dem aktuellen Rechenmodell (core/holidays.ts). Die Fixture ist der
 * Regressionsanker fuer den Umbau der Feiertagsregeln in Datenform: Der Test
 * holidaysTest.ts vergleicht jede (Jahr, Land)-Kombination gegen diese Datei.
 *
 * Jahre decken alle Weichen der Regeltabelle ab: 2016 (vor allen Aenderungen),
 * 2017 (Reformationstag bundesweit), 2018 (Reformationstag Nordlaender),
 * 2019 (Frauentag BE, Weltkindertag TH), 2022, 2023 (Frauentag MV), 2026,
 * 2030 (Osterformel weit vorn).
 *
 * Aufruf (nur bewusst, wenn sich das Modell absichtlich aendert):
 *   npx tsx apps/backend/src/test/writeHolidayFixture.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holidayRegionsFor, holidaysForYear } from '../core/holidays.js';

export const HOLIDAY_FIXTURE_YEARS = [2016, 2017, 2018, 2019, 2022, 2023, 2026, 2030] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
export const HOLIDAY_FIXTURE_PATH = path.join(here, 'fixtures', 'holidays-de.json');

export interface HolidayFixture {
  country: 'DE';
  years: number[];
  regions: string[];
  /** holidays[jahr][region] = sortierte Liste { date, name } */
  holidays: Record<string, Record<string, { date: string; name: string }[]>>;
}

function build(): HolidayFixture {
  const regions = holidayRegionsFor('DE');
  const holidays: HolidayFixture['holidays'] = {};
  for (const year of HOLIDAY_FIXTURE_YEARS) {
    const perRegion: Record<string, { date: string; name: string }[]> = {};
    for (const region of regions) {
      perRegion[region] = holidaysForYear(year, 'DE', region).map((h) => ({ date: h.date, name: h.name }));
    }
    holidays[String(year)] = perRegion;
  }
  return { country: 'DE', years: [...HOLIDAY_FIXTURE_YEARS], regions, holidays };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fixture = build();
  fs.mkdirSync(path.dirname(HOLIDAY_FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(HOLIDAY_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  const entries = fixture.years.length * fixture.regions.length;
  console.log(`Fixture geschrieben: ${HOLIDAY_FIXTURE_PATH} (${entries} Eintraege)`);
}
