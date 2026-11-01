/**
 * Prueft die DOM-freien Regeln der Stammdaten aus @ohrganize/shared:
 * Monatsrechnung (addMonthsIso), Probezeit (Ende, Laenge, Text), die Saetze
 * des Dashboard-Widgets "Fristen der Personalakte" und wann ein
 * Aufenthaltstitel gebraucht wird; dazu der Zustand einer Vertragsversion
 * (contractState, Server und Oberflaeche gleich) und welcher Hinweis zu den
 * Versionen in den Stammdaten steht (contractNoteFor).
 *
 * Aufruf: tsx src/test/masterDataTest.ts (Teil von npm test)
 */
import {
  addMonthsIso,
  changedMirroredFields,
  contractCorrectable,
  contractMirroredFields,
  entitlementFieldsLabel,
  contractNoteFor,
  contractState,
  entitlementFrozenNote,
  formatEntitlementFrozen,
  parseEntitlementFrozen,
  withEntitlementFrozen,
  withoutEntitlementFrozen,
  withoutEntitlementFrozenColumns,
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

// Vertragszustand: heute 01.11.2026, geplante Versionen ab 01.12. und 01.01.
{
  const today = '2026-11-01';
  const running = { valid_from: '2026-02-01', valid_to: '2026-11-30' };
  const december = { valid_from: '2026-12-01', valid_to: '2026-12-31' };
  const january = { valid_from: '2027-01-01', valid_to: null };
  check('Vertrag: geltende vor geplanter Version gilt noch', contractState(running, false, today) === 'gilt');
  check('Vertrag: fruehere geplante Version ist geplant, nicht abgeloest', contractState(december, false, today) === 'geplant');
  check('Vertrag: juengste geplante Version ist geplant', contractState(january, true, today) === 'geplant');
  check('Vertrag: juengste geltende Version ist aktuell', contractState({ valid_from: '2026-02-01', valid_to: null }, true, today) === 'aktuell');
  check('Vertrag: nach dem Ende abgelaufen', contractState({ valid_from: '2025-01-01', valid_to: '2026-10-31' }, false, today) === 'abgelaufen');
  check('Vertrag: Befristung allein ist keine Historie', contractState({ valid_from: '2026-02-01', valid_to: '2027-06-30' }, true, today) === 'aktuell');
  check(
    'Vertrag: korrigierbar nur die juengste, nicht abgelaufene',
    contractCorrectable('geplant', true) && !contractCorrectable('geplant', false) && !contractCorrectable('abgelaufen', true),
  );
}

// Hinweis in den Stammdaten: geltende Version, nur abgelaufene oder geplante, keine.
{
  const today = '2026-11-01';
  const ended = { valid_from: '2024-01-01', valid_to: '2025-06-30' };
  const current = { valid_from: '2025-07-01', valid_to: null };
  const planned = { valid_from: '2026-12-01', valid_to: null };
  const endsToday = { valid_from: '2025-07-01', valid_to: '2026-11-01' };
  check('Hinweis: keine Version', contractNoteFor([], today) === 'none');
  check('Hinweis: geltende Version', contractNoteFor([ended, current], today) === 'versioned');
  check('Hinweis: endet heute, gilt noch', contractNoteFor([endsToday], today) === 'versioned');
  check('Hinweis: nur abgelaufen', contractNoteFor([ended], today) === 'uncovered');
  check('Hinweis: abgelaufen und geplant', contractNoteFor([ended, planned], today) === 'uncovered');
  check('Hinweis: beginnt heute', contractNoteFor([{ valid_from: today, valid_to: null }], today) === 'versioned');
}

// Festgehaltene Felder einer Version: Liste in fester Reihenfolge, Hinweis im Tab Vertrag.
check('Festgehalten: ohne Felder kein Hinweis', entitlementFrozenNote(null) === null && formatEntitlementFrozen([]) === null);
check(
  'Festgehalten: Reihenfolge fest, Doppel und Unbekanntes fallen weg',
  formatEntitlementFrozen(parseEntitlementFrozen('work_week,annual_leave_days,work_week,foo')) === 'annual_leave_days,work_week',
);
check(
  'Festgehalten: Hinweis nennt die Felder',
  entitlementFrozenNote('work_week,employee_type,annual_leave_days') ===
    'Beschäftigungsart, Urlaubstage und Arbeitswoche aus der Personalakte übernommen, weil die Version sie nicht nannte; so bleibt dieser Zeitraum gleich, auch wenn sich die Akte ändert.' &&
    entitlementFrozenNote('weekly_hours')?.startsWith('Wochenstunden aus der Personalakte') === true &&
    entitlementFrozenNote('unbekannt') === null,
  entitlementFrozenNote('work_week,employee_type,annual_leave_days'),
);

// Vermerk ergaenzen und entfernen: je Feld und je gesetzter Spalte (die Woche
// besteht aus zwei Spalten, eine genuegt).
check('Vermerk: ergaenzen ohne Doppel', withEntitlementFrozen('work_week', ['employee_type', 'work_week']) === 'employee_type,work_week');
check('Vermerk: Felder entfernen, leer wird NULL', withoutEntitlementFrozen('annual_leave_days', ['annual_leave_days']) === null);
check(
  'Vermerk: eine Wochenspalte entfernt die Woche, auch die abgeleitete',
  withoutEntitlementFrozenColumns('employee_type,work_week', ['work_days_per_week']) === 'employee_type' &&
    withoutEntitlementFrozenColumns('work_week_default', ['work_weekdays']) === null &&
    withoutEntitlementFrozenColumns('weekly_hours,annual_leave_days', ['note', 'valid_from']) === 'weekly_hours,annual_leave_days',
);
check('Vermerk: abgeleitete Woche heisst im Hinweis Arbeitswoche', entitlementFrozenNote('work_week_default')?.startsWith('Arbeitswoche aus') === true);
const versionFields = { employee_type: null, weekly_hours: 20, annual_leave_days: null, work_weekdays: null, work_days_per_week: 3 };
check(
  'Uebernahme: Felder, die eine Version nennt, und die, die sich aendern',
  JSON.stringify(contractMirroredFields(versionFields)) === JSON.stringify(['weekly_hours', 'work_week']) &&
    JSON.stringify(
      changedMirroredFields(
        { employee_type: 'vollzeit', weekly_hours: 40, annual_leave_days: 30, work_weekdays: '1,2,3,4,5', work_days_per_week: 5 },
        { employee_type: 'vollzeit', weekly_hours: 40, annual_leave_days: 30, work_weekdays: null, work_days_per_week: 5 },
      ),
    ) === JSON.stringify(['work_week']) &&
    changedMirroredFields({ weekly_hours: 40, annual_leave_days: null }, { weekly_hours: 40 }).length === 0 &&
    entitlementFieldsLabel(['employee_type', 'weekly_hours', 'work_week']) === 'Beschäftigungsart, Wochenstunden und Arbeitswoche',
  { versionFields: contractMirroredFields(versionFields) },
);

if (failures > 0) {
  console.log(`masterDataTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('masterDataTest: alle Pruefungen bestanden');
