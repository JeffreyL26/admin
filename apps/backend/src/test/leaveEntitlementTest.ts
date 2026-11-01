/**
 * Prueft Arbeitswoche (workSchedule.ts) und Urlaubsanspruch nach BUrlG
 * (leaveEntitlement.ts) aus @ohrganize/shared: Mindesturlaub je Arbeitstage,
 * Wartezeit und Zwoelftelung nach § 5 BUrlG samt Rundung, vertraglicher
 * Mehrurlaub, Zusatzurlaub bei Schwerbehinderung, flexible Woche.
 *
 * Aufruf: tsx src/test/leaveEntitlementTest.ts (Teil von npm test)
 */
import {
  entitlementDaysPerWeek,
  homeOfficeExceptionFor,
  homeOfficeOn,
  entitlementPartLabels,
  entitlementProrationNote,
  flexibleDays,
  fullMonthsBetween,
  isScheduledDay,
  leaveEntitlementFor,
  parseWeekdays,
  statutoryLeaveDays,
  workScheduleOf,
  type EntitlementInput,
} from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

// --- Arbeitswoche ---------------------------------------------------------
check('Wochentage gelesen und sortiert', JSON.stringify(parseWeekdays('4,1,2,2,9')) === '[1,2,4]');
check('leer ist keine feste Woche', parseWeekdays('') === null && parseWeekdays(null) === null);
check('feste Tage bestimmen die Zahl', workScheduleOf({ work_weekdays: '1,3,5', work_days_per_week: 2 }).daysPerWeek === 3);
check('flexibel', JSON.stringify(workScheduleOf({ work_days_per_week: 3 })) === '{"daysPerWeek":3,"weekdays":null}');
check('ohne Angabe Mo bis Fr', workScheduleOf({}).weekdays?.join() === '1,2,3,4,5');
check('Samstag als fester Arbeitstag', isScheduledDay({ daysPerWeek: 1, weekdays: [6] }, '2026-11-07'));
check('Montag nicht bei Di bis Do', !isScheduledDay({ daysPerWeek: 3, weekdays: [2, 3, 4] }, '2026-11-02'));
check('flexibel: Woche bei drei Tagen', flexibleDays(5, 3) === 3);
check('flexibel: zwei Wochen', flexibleDays(10, 3) === 6);
check('flexibel: einzelner Tag zaehlt voll', flexibleDays(1, 3) === 1);
check('flexibel: halber Tag bleibt halb', flexibleDays(0.5, 3) === 0.5);
check('flexibel: zwei Werktage mindestens einer', flexibleDays(2, 2) === 1);
check('flexibel: nie mehr als Werktage', flexibleDays(3, 7) === 3);

// --- Mindesturlaub --------------------------------------------------------
check('§ 3: fuenf Tage = 20', statutoryLeaveDays(5) === 20);
check('§ 3: drei Tage = 12', statutoryLeaveDays(3) === 12);
check('§ 3: sechs Tage = 24', statutoryLeaveDays(6) === 24);
check('§ 3: zweieinhalb Tage = 10', statutoryLeaveDays(2.5) === 10);

check('volle Monate ganzes Jahr', fullMonthsBetween('2026-01-01', '2026-12-31') === 12);
check('volle Monate ab 15.07.', fullMonthsBetween('2026-07-15', '2026-12-31') === 5);
check('volle Monate ab 01.07.', fullMonthsBetween('2026-07-01', '2026-12-31') === 6);
check('volle Monate bis 15.10.', fullMonthsBetween('2026-01-01', '2026-10-15') === 9);

const base: EntitlementInput = { hire_date: '2020-01-01', exit_date: null, annual_leave_days: 30, days_per_week: 5 };
const full = leaveEntitlementFor(base, 2026);
check('ganzes Jahr: 20 + 10', full.statutory === 20 && full.contractual === 10 && full.total === 30 && !full.prorated, full);

// Beispiel des Kunden: Eintritt im Juli, 32 Tage vertraglich.
const julyFirst = leaveEntitlementFor({ ...base, hire_date: '2026-07-01', annual_leave_days: 32 }, 2026);
check(
  'Eintritt 01.07.: Wartezeit am 31.12. erfuellt, gesetzlich voll, vertraglich 6/12',
  julyFirst.statutory === 20 && julyFirst.contractual === 6 && julyFirst.total === 26,
  julyFirst,
);
const julySecond = leaveEntitlementFor({ ...base, hire_date: '2026-07-02', annual_leave_days: 32 }, 2026);
check(
  'Eintritt 02.07.: Teilurlaub 5/12 von 20 = 8,33, vertraglich 5/12 von 12 = 5',
  julySecond.statutory === 8.33 && julySecond.contractual === 5 && julySecond.total === 13.33,
  julySecond,
);
const augFirst = leaveEntitlementFor({ ...base, hire_date: '2026-08-01', annual_leave_days: 20 }, 2026);
check('Eintritt 01.08.: 5/12 von 20 = 8,33 bleibt stehen', augFirst.statutory === 8.33 && augFirst.total === 8.33, augFirst);
const septFirst = leaveEntitlementFor({ ...base, hire_date: '2026-09-01', annual_leave_days: 20 }, 2026);
check('Eintritt 01.09.: 4/12 von 20 = 6,67 wird 7', septFirst.statutory === 7, septFirst);
const followYear = leaveEntitlementFor({ ...base, hire_date: '2026-09-01' }, 2027);
check('Folgejahr nach spaetem Eintritt: voll', followYear.total === 30 && !followYear.prorated, followYear);

const exitMarch = leaveEntitlementFor({ ...base, exit_date: '2026-03-31' }, 2026);
check('Austritt 31.03. nach Wartezeit: erste Jahreshaelfte, 3/12', exitMarch.statutory === 5 && exitMarch.contractual === 2.5, exitMarch);
const exitAugust = leaveEntitlementFor({ ...base, exit_date: '2026-08-31' }, 2026);
check(
  'Austritt 31.08. nach Wartezeit: gesetzlich voll, vertraglich 8/12',
  exitAugust.statutory === 20 && exitAugust.contractual === 6.5,
  exitAugust,
);
const shortStay = leaveEntitlementFor({ ...base, hire_date: '2026-02-01', exit_date: '2026-05-31' }, 2026);
check('vor erfuellter Wartezeit ausgeschieden: 4/12', shortStay.statutory === 7 && shortStay.months === 4, shortStay);

const threeDays = leaveEntitlementFor({ ...base, days_per_week: 3, annual_leave_days: 18 }, 2026);
check('drei Tage: 12 gesetzlich + 6 vertraglich', threeDays.statutory === 12 && threeDays.contractual === 6, threeDays);
const belowMinimum = leaveEntitlementFor({ ...base, annual_leave_days: 15 }, 2026);
check('Eintrag unter dem Minimum: Minimum gilt', belowMinimum.total === 20 && belowMinimum.contractual === 0, belowMinimum);
const noValue = leaveEntitlementFor({ ...base, annual_leave_days: null }, 2026);
check('ohne Eintrag: Minimum', noValue.total === 20, noValue);

const unknown = leaveEntitlementFor({ ...base, days_per_week: null, hire_date: '2026-07-02' }, 2026);
check(
  'Arbeitswoche unbekannt: alles vertraglich, gezwoelftelt wie frueher (5/12 von 30 = 12,5)',
  !unknown.statutory_known && unknown.statutory === 0 && unknown.total === 12.5,
  unknown,
);

const disabled = leaveEntitlementFor({ ...base, disability_degree: 50 }, 2026);
check('GdB 50: fuenf Tage Zusatzurlaub', disabled.disability === 5 && disabled.total === 35, disabled);
const disabledThree = leaveEntitlementFor({ ...base, days_per_week: 3, annual_leave_days: 12, disability_degree: 80 }, 2026);
check('GdB 80 bei drei Tagen: drei Tage', disabledThree.disability === 3, disabledThree);
const equal = leaveEntitlementFor({ ...base, disability_degree: 40, disability_equal: true }, 2026);
check('Gleichstellung: kein Zusatzurlaub', equal.disability === 0, equal);
const disabledLate = leaveEntitlementFor({ ...base, hire_date: '2026-10-01', disability_degree: 60 }, 2026);
check('Zusatzurlaub unterjaehrig: 3/12 von 5 = 1,25', disabledLate.disability === 1.25, disabledLate);
const disabledUnknown = leaveEntitlementFor({ ...base, days_per_week: null, annual_leave_days: 0, disability_degree: 50 }, 2026);
check(
  'Zusatzurlaub ohne bekannte Woche (freie Mitarbeit, Teilzeit ohne Angabe): keiner',
  disabledUnknown.disability === 0 && disabledUnknown.total === 0,
  disabledUnknown,
);

check('vor dem Eintritt: nichts', leaveEntitlementFor({ ...base, hire_date: '2027-03-01' }, 2026).total === 0);
check('nach dem Austritt: nichts', leaveEntitlementFor({ ...base, exit_date: '2025-12-31' }, 2026).total === 0);

check('Vollzeit ohne Angabe: fuenf Tage', entitlementDaysPerWeek({ employee_type: 'vollzeit' }) === 5);
check('Teilzeit ohne Angabe: unbekannt', entitlementDaysPerWeek({ employee_type: 'teilzeit' }) === null);
check('Teilzeit mit festen Tagen', entitlementDaysPerWeek({ employee_type: 'teilzeit', work_weekdays: '1,2' }) === 2);
check('Freie Mitarbeit: kein Anspruch', entitlementDaysPerWeek({ employee_type: 'freiberufler', work_days_per_week: 5 }) === null);

// --- Home Office (homeOffice.ts) ------------------------------------------
// 02.11.2026 ist ein Montag, 03.11. ein Dienstag.
const noExceptions = new Map<string, 'buero' | 'homeoffice'>();
check('Muster Mo: Home Office', homeOfficeOn('1,3', noExceptions, '2026-11-02'));
check('Muster Mo: Dienstag nicht', !homeOfficeOn('1,3', noExceptions, '2026-11-03'));
check('Buerotag schlaegt Muster', !homeOfficeOn('1,3', new Map([['2026-11-02', 'buero' as const]]), '2026-11-02'));
check('Zusatztag schlaegt Muster', homeOfficeOn('1,3', new Map([['2026-11-03', 'homeoffice' as const]]), '2026-11-03'));
check('ohne Muster kein Home Office', !homeOfficeOn(null, noExceptions, '2026-11-02'));
check('Klick auf Muster-Tag legt Buerotag an', homeOfficeExceptionFor('1', '2026-11-02', false) === 'buero');
check('Rueckkehr zum Muster entfernt die Ausnahme', homeOfficeExceptionFor('1', '2026-11-02', true) === null);
check('Zusaetzlicher Tag', homeOfficeExceptionFor('1', '2026-11-03', true) === 'homeoffice');

const fmt = (n: number) => n.toLocaleString('de-DE');
check('Teile benannt', entitlementPartLabels(julyFirst, fmt).join(' + ') === 'gesetzlich 20 + vertraglich 6', entitlementPartLabels(julyFirst, fmt));
check('anteilig benannt', entitlementProrationNote(julyFirst, fmt) === 'anteilig, 6 von 12 Monaten (ganzes Jahr 32)', entitlementProrationNote(julyFirst, fmt));
check('ganzes Jahr ohne Hinweis', entitlementProrationNote(full, fmt) === null);
check('Zusatzurlaub benannt', entitlementPartLabels(disabled, fmt).join(' + ') === 'gesetzlich 20 + vertraglich 10 + Zusatzurlaub 5');
check('Zusatzurlaub ohne Recht im vertraglichen Teil', entitlementPartLabels(disabled, fmt, false).join(' + ') === 'gesetzlich 20 + vertraglich 15');
check('unbekannte Woche nur vertraglich', entitlementPartLabels(unknown, fmt).join() === 'vertraglich 12,5', entitlementPartLabels(unknown, fmt));

if (failures > 0) {
  console.log(`leaveEntitlementTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('leaveEntitlementTest: alle Pruefungen bestanden');
