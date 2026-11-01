/**
 * Prueft die Tabellensortierung aus @ohrganize/shared (tableSort.ts), die
 * alle sortierbaren Listen der Desktop-App teilen: deutsche Reihenfolge,
 * Ziffern als Zahl, leere Werte am Ende in beiden Richtungen, stabiler
 * Gleichstand, Klickfolge und das Pruefen gespeicherter Staende.
 *
 * Aufruf: tsx src/test/tableSortTest.ts (Teil von npm test)
 */
import { nextSort, parseSortState, sortRows } from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const names = ['Zander', 'Özdemir', 'adler', 'Becker', 'Ärger'];
const asc = sortRows(names, (n) => n, 'asc');
check('deutsche Reihenfolge, Umlaute bei ihrem Grundbuchstaben', asc.join() === 'adler,Ärger,Becker,Özdemir,Zander', asc);

const numbers = ['P10', 'P2', 'P1'];
check('Ziffernfolgen als Zahl', sortRows(numbers, (n) => n, 'asc').join() === 'P1,P2,P10');

const withEmpty = [{ v: 3 }, { v: null }, { v: 1 }, { v: '' as unknown as number }, { v: 2 }];
const up = sortRows(withEmpty, (r) => r.v, 'asc').map((r) => r.v);
const down = sortRows(withEmpty, (r) => r.v, 'desc').map((r) => r.v);
check('leere Werte aufsteigend am Ende', JSON.stringify(up) === JSON.stringify([1, 2, 3, null, '']), up);
check('leere Werte absteigend am Ende', JSON.stringify(down) === JSON.stringify([3, 2, 1, null, '']), down);

const people = [
  { dept: 'Technik', name: 'Weber' },
  { dept: 'Vertrieb', name: 'Adam' },
  { dept: 'Technik', name: 'Albers' },
];
const byDept = sortRows(people, (p) => p.dept, 'desc', (p) => p.name).map((p) => p.name);
check('Gleichstand aufsteigend nach tieBreak, auch bei absteigender Spalte', byDept.join() === 'Adam,Albers,Weber', byDept);

const same = [{ id: 1, v: 'x' }, { id: 2, v: 'x' }, { id: 3, v: 'x' }];
check('ohne tieBreak bleibt die Reihenfolge stabil', sortRows(same, (r) => r.v, 'desc').map((r) => r.id).join() === '1,2,3');

check('Original bleibt unveraendert', names[0] === 'Zander');

check('gleiche Spalte kehrt um', JSON.stringify(nextSort({ key: 'a', dir: 'asc' }, 'a')) === '{"key":"a","dir":"desc"}');
check('gleiche Spalte kehrt zurueck', JSON.stringify(nextSort({ key: 'a', dir: 'desc' }, 'a')) === '{"key":"a","dir":"asc"}');
check('neue Spalte beginnt aufsteigend', JSON.stringify(nextSort({ key: 'a', dir: 'desc' }, 'b')) === '{"key":"b","dir":"asc"}');

const fallback = { key: 'name' as const, dir: 'asc' as const };
const keys = ['name', 'date'] as const;
check('gespeicherter Stand wird uebernommen', JSON.stringify(parseSortState({ key: 'date', dir: 'desc' }, keys, fallback)) === '{"key":"date","dir":"desc"}');
check('unbekannte Spalte faellt zurueck', parseSortState({ key: 'weg', dir: 'desc' }, keys, fallback) === fallback);
check('kaputter Eintrag faellt zurueck', parseSortState('x', keys, fallback) === fallback && parseSortState(null, keys, fallback) === fallback);
check('unbekannte Richtung wird aufsteigend', parseSortState({ key: 'date', dir: 'quer' }, keys, fallback).dir === 'asc');

if (failures > 0) {
  console.log(`tableSortTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('tableSortTest: alle Pruefungen bestanden');
