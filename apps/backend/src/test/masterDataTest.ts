/**
 * Prueft die DOM-freien Regeln der Stammdaten aus @ohrganize/shared:
 * Monatsrechnung (addMonthsIso), Probezeit (Ende, Laenge, Text), die Saetze
 * des Dashboard-Widgets "Fristen der Personalakte" und wann ein
 * Aufenthaltstitel gebraucht wird.
 *
 * Aufruf: tsx src/test/masterDataTest.ts (Teil von npm test)
 */
import {
  addMonthsIso,
  formatDate,
  needsResidencePermit,
  personnelDeadlineText,
  probationEndFor,
  probationMonths,
  probationText,
} from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

check('Monat weiter', addMonthsIso('2026-07-15', 1) === '2026-08-15');
check('Jahreswechsel', addMonthsIso('2026-11-30', 3) === '2027-02-28');
check('fehlender Tag: letzter des Monats', addMonthsIso('2026-01-31', 1) === '2026-02-28');
check('Schaltjahr', addMonthsIso('2028-01-31', 1) === '2028-02-29');
check('rueckwaerts', addMonthsIso('2026-03-31', -1) === '2026-02-28');

check('Probezeit 6 Monate ab 01.07.', probationEndFor('2026-07-01', 6) === '2026-12-31');
check('Probezeit 6 Monate ab 15.04.', probationEndFor('2026-04-15', 6) === '2026-10-14');
check('Probezeit 1 Monat ab 31.01. (§ 188 Abs. 3 BGB)', probationEndFor('2026-01-31', 1) === '2026-02-28');
check('Probezeit 1 Monat ab 29.01. im Schaltjahr', probationEndFor('2028-01-29', 1) === '2028-02-28');
check('Probezeit 1 Monat ab 30.01.', probationEndFor('2026-01-30', 1) === '2026-02-28');
check('Laenge erkannt', probationMonths('2026-04-15', '2026-10-14') === 6);
check('freies Datum: keine Laenge', probationMonths('2026-04-15', '2026-10-20') === null);
check('Text mit Laenge', probationText('2026-07-01', '2026-12-31', formatDate) === '6 Monate, bis 31.12.2026');
check('Text Einzahl', probationText('2026-07-01', '2026-07-31', formatDate) === '1 Monat, bis 31.07.2026');
check('Text ohne Laenge', probationText('2026-07-01', '2026-12-20', formatDate) === 'bis 20.12.2026');

const person = { id: 1, first_name: 'Anna', last_name: 'Berg' };
check(
  'Probezeit in Wochen',
  personnelDeadlineText({ ...person, kind: 'probezeit', date: '2026-11-29' }, '2026-11-01') ===
    'Für Anna Berg endet die Probezeit in 4 Wochen.',
);
check(
  'Probezeit in Tagen',
  personnelDeadlineText({ ...person, kind: 'probezeit', date: '2026-11-06' }, '2026-11-01') ===
    'Für Anna Berg endet die Probezeit in 5 Tagen.',
);
check(
  'Probezeit morgen',
  personnelDeadlineText({ ...person, kind: 'probezeit', date: '2026-11-02' }, '2026-11-01') ===
    'Für Anna Berg endet die Probezeit morgen.',
);
check(
  'Titel abgelaufen',
  personnelDeadlineText({ ...person, kind: 'aufenthaltstitel', date: '2026-10-01' }, '2026-11-01') ===
    'Der Aufenthaltstitel von Anna Berg ist abgelaufen.',
);
check(
  'Titel heute',
  personnelDeadlineText({ ...person, kind: 'aufenthaltstitel', date: '2026-11-01' }, '2026-11-01') ===
    'Der Aufenthaltstitel von Anna Berg läuft heute ab.',
);

check('ohne Angabe kein Titel', !needsResidencePermit(null) && !needsResidencePermit(''));
check('EU kein Titel', !needsResidencePermit('PL') && !needsResidencePermit('DE'));
check('EWR und Schweiz kein Titel', !needsResidencePermit('NO') && !needsResidencePermit('CH'));
check('Drittstaat braucht Titel', needsResidencePermit('TR') && needsResidencePermit('GB'));

if (failures > 0) {
  console.log(`masterDataTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('masterDataTest: alle Pruefungen bestanden');
