/**
 * Prueft den Zusatz zum Status aus @ohrganize/shared (absences.ts,
 * longAbsenceFor): Sonderabwesenheiten ab sechs Wochen, die heute andauern
 * (aneinandergereihte Antraege derselben Art zusammen), und eigene AU-Ketten,
 * die laenger als sechs Wochen laufen (sickPayDaysUsed, wie sick_pay_exceeded
 * der Krankmeldungen), dazu die Kettenbildung (sickChainSpans) und den Text.
 *
 * Aufruf: tsx src/test/longAbsenceTest.ts (Teil von npm test)
 */
import { longAbsenceFor, longAbsenceText, sickChainSpans, sickPayDaysUsed } from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const today = '2026-10-13';
// Art-ID aus dem Namen, damit gleiche Namen dieselbe Art sind.
const typeIds = new Map<string, number>();
const leave = (type_name: string, date_from: string, date_to: string) => {
  if (!typeIds.has(type_name)) typeIds.set(type_name, typeIds.size + 1);
  return { type_id: typeIds.get(type_name)!, type_name, date_from, date_to };
};
const note = (id: number, date_from: string, date_to: string, follow_up_of_id: number | null = null, child_sick = 0) => ({
  id,
  date_from,
  date_to,
  follow_up_of_id,
  child_sick,
});

check('ohne Abwesenheit kein Zusatz', longAbsenceFor(today, [], []) === null);

const parental = longAbsenceFor(today, [leave('Elternzeit', '2026-09-01', '2027-03-31')], []);
check(
  'Elternzeit, die heute andauert',
  parental?.kind === 'sonder' && parental.label === 'Elternzeit' && parental.since === '2026-09-01' && parental.until === '2027-03-31',
  parental,
);
check('Text der Sonderabwesenheit nennt das Ende', parental !== null && longAbsenceText(parental) === 'Elternzeit bis 31.03.2027');

check('kurze Sonderabwesenheit (Umzug) ist kein Zusatz', longAbsenceFor(today, [leave('Sonderurlaub Umzug', today, today)], []) === null);
// Mutterschutz vor der Entbindung: genau sechs Wochen, 42 Kalendertage.
check(
  'Sonderabwesenheit von genau 42 Kalendertagen zaehlt',
  longAbsenceFor(today, [leave('Mutterschutz', '2026-09-20', '2026-10-31')], [])?.label === 'Mutterschutz',
);
check(
  'Sonderabwesenheit von 41 Kalendertagen zaehlt nicht',
  longAbsenceFor(today, [leave('Unbezahlter Urlaub', '2026-09-21', '2026-10-31')], []) === null,
);
check(
  'beendete und kuenftige Sonderabwesenheit zaehlen nicht',
  longAbsenceFor(today, [leave('Sabbatical', '2026-06-01', '2026-10-12'), leave('Elternzeit', '2026-10-14', '2027-06-30')], []) === null,
);
const twoLeaves = longAbsenceFor(
  today,
  [leave('Mutterschutz', '2026-08-01', '2026-11-06'), leave('Elternzeit', '2026-09-01', '2027-08-31')],
  [],
);
check('mehrere: die am laengsten reicht', twoLeaves?.label === 'Elternzeit', twoLeaves);
// Elternzeit in Bloecken: Ein Folgeantrag ab dem Tag nach dem Ende gehoert
// zum selben Zeitraum, auch wenn jeder Block allein unter sechs Wochen bleibt.
const blocks = longAbsenceFor(
  '2026-11-16',
  [leave('Elternzeit', '2026-11-01', '2026-12-10'), leave('Elternzeit', '2026-10-01', '2026-10-31')],
  [],
);
check(
  'aneinandergereihte Antraege derselben Art zaehlen zusammen',
  blocks?.label === 'Elternzeit' && blocks.since === '2026-10-01' && blocks.until === '2026-12-10',
  blocks,
);
check(
  'eine Luecke trennt die Antraege',
  longAbsenceFor('2026-11-16', [leave('Elternzeit', '2026-10-01', '2026-10-30'), leave('Elternzeit', '2026-11-01', '2026-12-10')], []) ===
    null,
);
check(
  'verschiedene Arten werden nicht zusammengezaehlt',
  longAbsenceFor('2026-11-16', [leave('Sabbatical', '2026-10-01', '2026-10-31'), leave('Elternzeit', '2026-11-01', '2026-12-10')], []) ===
    null,
);

// AU-Kette: Erstbescheinigung ab 01.09., Folgebescheinigung ab 01.10.
// 01.09. bis 13.10. sind 43 Kalendertage, die Entgeltfortzahlung (42) ist vorbei.
const chain = [note(1, '2026-09-01', '2026-09-30'), note(2, '2026-10-01', '2026-10-31', 1)];
const sick = longAbsenceFor(today, [], chain);
check(
  'AU-Kette seit mehr als sechs Wochen ist langzeitkrank',
  sick?.kind === 'krankheit' && sick.since === '2026-09-01' && sick.until === '2026-10-31',
  sick,
);
check('Text der Krankheit nennt den Beginn', sick !== null && longAbsenceText(sick) === 'Langzeitkrank seit 01.09.2026');
check('am 42. Tag noch nicht langzeitkrank', longAbsenceFor('2026-10-12', [], chain) === null);
check(
  'Kind krank ist nie langzeitkrank',
  longAbsenceFor(today, [], [note(1, '2026-09-01', '2026-09-30', null, 1), note(2, '2026-10-01', '2026-10-31', 1, 1)]) === null,
);
check(
  'ohne Verkettung beginnt die Zaehlung neu',
  longAbsenceFor(today, [], [note(1, '2026-09-01', '2026-09-30'), note(2, '2026-10-01', '2026-10-31')]) === null,
);
check('eine beendete AU-Kette zaehlt nicht', longAbsenceFor('2026-11-01', [], chain) === null);
check(
  'Sonderabwesenheit geht vor Krankheit',
  longAbsenceFor(today, [leave('Elternzeit', '2026-09-01', '2027-03-31')], chain)?.kind === 'sonder',
);

check(
  'Entgeltfortzahlung zaehlt bis heute, hoechstens bis zum Ende der Kette',
  sickPayDaysUsed({ from: '2026-09-01', to: '2026-10-31' }, today) === 43 &&
    sickPayDaysUsed({ from: '2026-09-01', to: '2026-09-10' }, today) === 10 &&
    sickPayDaysUsed({ from: '2026-11-01', to: '2026-11-05' }, today) === 0,
);

const spans = sickChainSpans([...chain, note(3, '2026-11-02', '2026-11-05', 99), note(4, '2026-12-01', '2026-12-02', 5), note(5, '2026-12-03', '2026-12-04', 4)]);
check(
  'Kettenumfang gilt fuer jedes Glied',
  JSON.stringify(spans.get(1)) === '{"from":"2026-09-01","to":"2026-10-31"}' && spans.get(2) === spans.get(1),
  Object.fromEntries(spans),
);
check('Verweis auf fehlende Bescheinigung beendet die Kette', JSON.stringify(spans.get(3)) === '{"from":"2026-11-02","to":"2026-11-05"}');
check('ein Ring bricht ab', spans.has(4) && spans.has(5));

if (failures > 0) {
  console.log(`longAbsenceTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('longAbsenceTest: alle Pruefungen bestanden');
