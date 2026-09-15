/**
 * Regressionstest der Feiertagsberechnung gegen die Fixture
 * fixtures/holidays-de.json (erzeugt mit writeHolidayFixture.ts). Jede
 * (Jahr, Region)-Kombination muss exakt die gespeicherte Liste liefern:
 * gleiche Tage, gleiche Namen, gleiche Reihenfolge.
 *
 * Aufruf: npm run test:holidays (Root) oder tsx src/test/holidaysTest.ts
 */
import fs from 'node:fs';
import { holidaysForYear, isHoliday, type Bundesland } from '../core/holidays.js';
import { HOLIDAY_FIXTURE_PATH, type HolidayFixture } from './writeHolidayFixture.js';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const fixture = JSON.parse(fs.readFileSync(HOLIDAY_FIXTURE_PATH, 'utf8')) as HolidayFixture;
let combinations = 0;
for (const year of fixture.years) {
  for (const region of fixture.regions) {
    combinations++;
    const expected = fixture.holidays[String(year)][region];
    const actual = holidaysForYear(year, region as Bundesland).map((h) => ({ date: h.date, name: h.name }));
    check(`${year} ${region}`, JSON.stringify(actual) === JSON.stringify(expected), {
      expected: expected.length,
      actual: actual.length,
    });
    // isHoliday muss dieselbe Sicht haben wie die Jahresliste.
    for (const h of expected) {
      check(`${year} ${region} isHoliday(${h.date})`, isHoliday(h.date, region as Bundesland)?.name === h.name);
    }
  }
}
check('Fixture umfasst 16 Regionen', fixture.regions.length === 16, fixture.regions.length);
check('Fixture umfasst 8 Jahre', fixture.years.length === 8, fixture.years.length);

// Cache-Trennung: zwei Regionen hintereinander duerfen sich nicht vermischen.
const bw = holidaysForYear(2026, 'BW').map((h) => h.name);
const be = holidaysForYear(2026, 'BE').map((h) => h.name);
check('BW hat Heilige Drei Koenige, BE nicht', bw.includes('Heilige Drei Könige') && !be.includes('Heilige Drei Könige'));
check('BE hat Frauentag, BW nicht', be.includes('Internationaler Frauentag') && !bw.includes('Internationaler Frauentag'));

if (failures > 0) {
  console.error(`${failures} Feiertags-Checks fehlgeschlagen (${combinations} Kombinationen).`);
  process.exit(1);
}
console.log(`Alle Feiertags-Checks bestanden (${combinations} Kombinationen).`);
