/**
 * Regressionstest der Feiertagsberechnung gegen die Fixture
 * fixtures/holidays-de.json (erzeugt mit writeHolidayFixture.ts). Jede
 * (Jahr, Region)-Kombination muss exakt die gespeicherte Liste liefern:
 * gleiche Tage, gleiche Namen, gleiche Reihenfolge.
 *
 * Aufruf: npm run test:holidays (Root) oder tsx src/test/holidaysTest.ts
 */
import fs from 'node:fs';
import { HOLIDAY_RULES_DE, holidaysForYear, isHoliday } from '../core/holidays.js';
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
    const actual = holidaysForYear(year, 'DE', region).map((h) => ({ date: h.date, name: h.name }));
    check(`${year} ${region}`, JSON.stringify(actual) === JSON.stringify(expected), {
      expected: expected.length,
      actual: actual.length,
    });
    // isHoliday muss dieselbe Sicht haben wie die Jahresliste.
    for (const h of expected) {
      check(`${year} ${region} isHoliday(${h.date})`, isHoliday(h.date, 'DE', region)?.name === h.name);
    }
  }
}
check('Fixture umfasst 16 Regionen', fixture.regions.length === 16, fixture.regions.length);
check('Fixture umfasst 8 Jahre', fixture.years.length === 8, fixture.years.length);

// Cache-Trennung: zwei Regionen hintereinander duerfen sich nicht vermischen.
const bw = holidaysForYear(2026, 'DE', 'BW').map((h) => h.name);
const be = holidaysForYear(2026, 'DE', 'BE').map((h) => h.name);
check('BW hat Heilige Drei Koenige, BE nicht', bw.includes('Heilige Drei Könige') && !be.includes('Heilige Drei Könige'));
check('BE hat Frauentag, BW nicht', be.includes('Internationaler Frauentag') && !bw.includes('Internationaler Frauentag'));

// Cache-Schluessel traegt das Land: derselbe Regionscode in einem anderen
// Land darf die deutsche Liste weder liefern noch ueberschreiben. AT und CH
// haben heute keine Regeln, also ist die Antwort leer.
const deByBefore = holidaysForYear(2026, 'DE', 'BY').length;
const atBy = holidaysForYear(2026, 'AT', 'BY');
check('AT ohne Regeln liefert keine Feiertage', atBy.length === 0, atBy.length);
check(
  'DE bleibt nach dem AT-Aufruf unveraendert',
  holidaysForYear(2026, 'DE', 'BY').length === deByBefore && deByBefore > 0,
  { deByBefore, danach: holidaysForYear(2026, 'DE', 'BY').length },
);
check(
  'isHoliday trennt die Laender',
  isHoliday('2026-01-01', 'DE', 'BY') !== undefined && isHoliday('2026-01-01', 'AT', 'BY') === undefined,
);

// Regeln in Datenform: jede Regel nennt genau einen Weg zum Datum.
for (const rule of HOLIDAY_RULES_DE) {
  const ways = [rule.date, rule.easter, rule.compute].filter((v) => v !== undefined).length;
  check(`Regel "${rule.name}" nennt genau einen Weg zum Datum`, ways === 1, ways);
}

if (failures > 0) {
  console.error(`${failures} Feiertags-Checks fehlgeschlagen (${combinations} Kombinationen).`);
  process.exit(1);
}
console.log(`Alle Feiertags-Checks bestanden (${combinations} Kombinationen).`);
