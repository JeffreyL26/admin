/**
 * Prueft die DOM-freien Regeln des Dashboards aus @ohrganize/shared
 * (dashboard.ts): Datumstexte im Fliesstext, naechster Werktag,
 * Benachrichtigungs-Quadrat und die Reihenfolge beim Umsortieren.
 *
 * Aufruf: tsx src/test/dashboardLogicTest.ts (Teil von npm test)
 */
import {
  dashboardNotice, daysInText, filledSlots, formatDateInText, formatRangeInText, mergeVisibleOrder, moveItem,
  nextWorkdayIso, comparePlanRows, birthdayMonthDays, dashboardSourceStatus, isOwnPersonDecision, isOwnRequestDecision,
  rangesOverlap, uncoveredBreakdown,
} from '@ohrganize/shared';

let failures = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.log(`FEHLER ${label}: ${JSON.stringify(actual)} statt ${JSON.stringify(expected)}`);
  }
}

const today = '2026-10-09';

// Datum im Satz: Monat ausgeschrieben, Jahr nur ausserhalb des laufenden.
eq('Datum im laufenden Jahr', formatDateInText('2026-09-01', today), '1. September');
eq('Datum im Folgejahr', formatDateInText('2027-01-05', today), '5. Januar 2027');
eq('Zeitstempel wird gekuerzt', formatDateInText('2026-07-18 10:00:00', today), '18. Juli');
eq('kein doppelter Punkt am Satzende', `Wirksam ab ${formatDateInText('2026-09-01', today)}.`, 'Wirksam ab 1. September.');

// Zeitraeume.
eq('ein Tag', formatRangeInText('2026-07-16', '2026-07-16', today), '16. Juli');
eq('gleicher Monat', formatRangeInText('2026-07-16', '2026-07-22', today), '16. bis 22. Juli');
eq('Monatswechsel', formatRangeInText('2026-09-28', '2026-10-02', today), '28. September bis 2. Oktober');
eq('Jahreswechsel', formatRangeInText('2026-12-28', '2027-01-04', today), '28. Dezember 2026 bis 4. Januar 2027');
eq('ganz im Folgejahr', formatRangeInText('2027-03-01', '2027-03-05', today), '1. bis 5. März 2027');

// Wieder da: naechster Werktag.
eq('Freitag -> Montag', nextWorkdayIso('2026-10-16'), '2026-10-19');
eq('Samstag -> Montag', nextWorkdayIso('2026-10-17'), '2026-10-19');
eq('Mittwoch -> Donnerstag', nextWorkdayIso('2026-10-14'), '2026-10-15');
eq('Monatsende', nextWorkdayIso('2026-10-30'), '2026-11-02');
eq('Jahresende ohne Feiertage', nextWorkdayIso('2026-12-31'), '2027-01-01');
const holidays = new Set(['2027-01-01', '2026-12-25', '2026-12-26']);
eq('Neujahr uebersprungen', nextWorkdayIso('2026-12-31', (d) => holidays.has(d)), '2027-01-04');
eq('Weihnachten uebersprungen', nextWorkdayIso('2026-12-24', (d) => holidays.has(d)), '2026-12-28');

// Plan: offen, heute, kommend (naechster zuerst), vergangen (juengstes Ende zuerst).
const planRows = [
  { id: 'vorbei-alt', status: 'genehmigt', from: '2026-09-01', to: '2026-09-05' },
  { id: 'kommend-spaet', status: 'genehmigt', from: '2026-10-20', to: '2026-10-22' },
  { id: 'offen', status: 'beantragt', from: '2026-11-01', to: '2026-11-02' },
  { id: 'heute', status: 'genehmigt', from: '2026-10-05', to: '2026-10-12' },
  { id: 'vorbei-jung', status: 'genehmigt', from: '2026-10-01', to: '2026-10-02' },
  { id: 'kommend-bald', status: 'genehmigt', from: '2026-10-12', to: '2026-10-13' },
];
const ranked = [...planRows].sort((a, b) => comparePlanRows(a, b, today));
eq('Planreihenfolge', ranked.map((r) => r.id), ['offen', 'heute', 'kommend-bald', 'kommend-spaet', 'vorbei-jung', 'vorbei-alt']);

// Kaestchen im Verhaeltnis, Tage im Text.
eq('Kaestchen unter 40', filledSlots(3, 10, 10), 3);
eq('Kaestchen ueber 40', filledSlots(45, 120, 40), 15);
eq('Kaestchen ohne Empfaenger', filledSlots(0, 0, 0), 0);
eq('Kaestchen: einer fehlt, nicht voll', filledSlots(119, 120, 40), 39);
eq('Kaestchen: einer hat, nicht leer', filledSlots(1, 120, 40), 1);
eq('Kaestchen: alle', filledSlots(120, 120, 40), 40);

// Quellen: Spinner nur beim ersten Aufbau, Fehler nur ohne Daten, pausiert ohne Netz fehlt.
const st = (loading: boolean, error: boolean, paused: boolean, hasData: boolean) => ({ loading, error, paused, hasData });
const first = dashboardSourceStatus({ a: st(true, false, false, false), b: st(false, false, false, true) }, false);
eq('erster Aufbau laedt', [first.initialLoading, first.pending], [true, []]);
const later = dashboardSourceStatus({ a: st(true, false, false, false), b: st(false, false, false, true) }, true);
eq('spaeter: nur die neue Quelle wartet', [later.initialLoading, later.pending], [false, ['a']]);
const broken = dashboardSourceStatus(
  { ohne: st(false, true, false, false), mit: st(false, true, false, true), offline: st(false, false, true, false) },
  true,
);
eq('Fehler nur ohne Daten, pausiert ohne Daten fehlt', broken.failed, ['ohne', 'offline']);
eq('ohne Netz eigens markiert', broken.offline, ['offline']);

// Vier-Augen (gemeinsam mit dem Backend): unbekannte IDs sperren nie.
eq('eigene Person', isOwnPersonDecision(5, 5), true);
eq('andere Person', isOwnPersonDecision(5, 6), false);
eq('Konto ohne Profil', isOwnPersonDecision(null, 5), false);
eq('eigener Antrag', isOwnRequestDecision(3, 3), true);
eq('Antrag ohne Antragsteller', isOwnRequestDecision(3, null), false);
// Elternzeit in zwei Jahresabschnitten: wieder da erst nach dem zweiten.
eq('lange Folgeabwesenheit', nextWorkdayIso('2026-10-09', (d) => d <= '2028-10-09'), '2028-10-10');
eq('ein Tag', daysInText(1, 'de-DE'), '1 Tag');
eq('halber Tag', daysInText(0.5, 'de-DE'), '0,5 Tage');
eq('Betriebsruhe', daysInText(0, 'de-DE', true), 'Betriebsruhe');

// Geburtstag heute: 29. Februar ausserhalb von Schaltjahren am 28.
eq('normaler Tag', birthdayMonthDays('2026-10-09'), ['10-09']);
eq('28.2. ohne Schaltjahr', birthdayMonthDays('2027-02-28'), ['02-28', '02-29']);
eq('28.2. im Schaltjahr', birthdayMonthDays('2028-02-28'), ['02-28']);
eq('29.2. im Schaltjahr', birthdayMonthDays('2028-02-29'), ['02-29']);
eq('2100 ist kein Schaltjahr', birthdayMonthDays('2100-02-28'), ['02-28', '02-29']);
eq('2000 ist ein Schaltjahr', birthdayMonthDays('2000-02-28'), ['02-28']);

// Quadrat: offen schlaegt laufend, ohne beides keins.
eq('offen', dashboardNotice(3, 2), { count: 3, waiting: false });
eq('nur laufend', dashboardNotice(0, 2), { count: 0, waiting: true });
eq('nichts', dashboardNotice(0, 0), null);

// Reihenfolge.
eq('nach hinten', moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
eq('nach vorn', moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
eq('ausserhalb unveraendert', moveItem(['a', 'b'], 0, 5), ['a', 'b']);
eq('gefilterte Ansicht', mergeVisibleOrder(['a', 'x', 'b', 'y', 'c'], ['c', 'a', 'b']), ['c', 'x', 'a', 'y', 'b']);
eq('ungefiltert', mergeVisibleOrder(['a', 'b', 'c'], ['b', 'c', 'a']), ['b', 'c', 'a']);

// Quadrat am „Anpassen“-Knopf: nur, was kein sichtbares Widget zeigt, jeder Punkt einmal.
eq('nichts ausgeblendet', uncoveredBreakdown([['a', 'b']], []), { total: 0, each: [], sharedWith: [] });
eq('sichtbar deckt ab', uncoveredBreakdown([['a', 'b']], [['a'], ['b']]), { total: 0, each: [0, 0], sharedWith: [[], []] });
eq('Ueberschneidung einmal', uncoveredBreakdown([['x']], [['a', 'b'], ['b', 'c']]), { total: 3, each: [2, 2], sharedWith: [[1], [0]] });
eq('teilweise abgedeckt', uncoveredBreakdown([['a']], [['a', 'b']]), { total: 1, each: [1], sharedWith: [[]] });
eq('nur abgedeckte geteilt', uncoveredBreakdown([['a']], [['a', 'b'], ['a', 'c']]), { total: 2, each: [1, 1], sharedWith: [[], []] });
eq('doppelter Schluessel je Widget', uncoveredBreakdown([], [['a', 'a']]), { total: 1, each: [1], sharedWith: [[]] });

// Zeitraum im Fenster (Plan, heute).
eq('innen', rangesOverlap('2026-10-05', '2026-10-07', '2026-10-01', '2026-10-31'), true);
eq('ragt hinein', rangesOverlap('2026-09-28', '2026-10-01', '2026-10-01', '2026-10-31'), true);
eq('davor', rangesOverlap('2026-09-01', '2026-09-30', '2026-10-01', '2026-10-31'), false);
eq('danach', rangesOverlap('2026-11-01', '2026-11-02', '2026-10-01', '2026-10-31'), false);

if (failures > 0) {
  console.log(`dashboardLogicTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('dashboardLogicTest: ok');
