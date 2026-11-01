/**
 * Arbeitswoche einer Person: feste Wochentage (Mo, Di, Do) oder eine Zahl
 * Tage pro Woche ohne feste Tage ("flexibel"). Davon hängen der gesetzliche
 * Mindesturlaub (leaveEntitlement.ts) und die Zählung von Anträgen ab
 * (countAbsenceDays im Backend). DOM-frei, Test
 * apps/backend/src/test/workScheduleTest.ts.
 *
 * Gespeichert in `employees.work_weekdays` (Text "1,2,4", Mo = 1 bis So = 7;
 * NULL = keine festen Tage) und `employees.work_days_per_week` (Zahl, bei
 * festen Tagen deren Anzahl). Beides NULL heißt "nicht hinterlegt": gezählt
 * wird dann wie früher Mo bis Fr.
 */

export interface WorkSchedule {
  /** Arbeitstage je Woche, 0,5 bis 7. */
  daysPerWeek: number;
  /** Feste Wochentage (1 = Mo … 7 = So), aufsteigend; null = flexibel. */
  weekdays: number[] | null;
}

/** Vorgabe ohne Angabe: Mo bis Fr, wie die Zählung vor der Arbeitswoche. */
export const DEFAULT_WORK_SCHEDULE: WorkSchedule = { daysPerWeek: 5, weekdays: [1, 2, 3, 4, 5] };

export const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;

/** "1,2,4" aus der Datenbank; ungültige Einträge fallen weg, null bei leer. */
export function parseWeekdays(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const days = [...new Set(value.split(',').map((s) => Number(s.trim())))]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  return days.length ? days : null;
}

export function formatWeekdays(days: readonly number[]): string {
  return [...new Set(days)].sort((a, b) => a - b).join(',');
}

/** Kurzform für die Anzeige: "Mo, Di, Do". */
export function weekdaysLabel(days: readonly number[]): string {
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d - 1]).join(', ');
}

/** Spalten einer Person (employees.*). */
export interface WorkScheduleColumns {
  work_days_per_week?: number | null;
  work_weekdays?: string | null;
}

/** Ist die Arbeitswoche hinterlegt (feste Tage oder Zahl)? */
export function hasWorkSchedule(row: WorkScheduleColumns): boolean {
  return parseWeekdays(row.work_weekdays) !== null || (row.work_days_per_week ?? null) !== null;
}

/** Arbeitswoche aus den Spalten; ohne Angabe die Vorgabe Mo bis Fr. */
export function workScheduleOf(row: WorkScheduleColumns): WorkSchedule {
  const weekdays = parseWeekdays(row.work_weekdays);
  if (weekdays) return { daysPerWeek: weekdays.length, weekdays };
  const days = row.work_days_per_week ?? null;
  if (days !== null && days > 0) return { daysPerWeek: days, weekdays: null };
  return DEFAULT_WORK_SCHEDULE;
}

/** Wochentag eines ISO-Datums, 1 = Mo … 7 = So (ohne Zeitzoneneffekt). */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Kann an diesem Tag Urlaub anfallen? Feste Tage: nur an ihnen. Flexibel:
 * Mo bis Fr (welche Tage es tatsächlich sind, weiß nur die Person; die Zahl
 * gleicht `flexibleDays` an).
 */
export function isScheduledDay(schedule: WorkSchedule, date: string): boolean {
  const day = isoWeekday(date);
  return schedule.weekdays ? schedule.weekdays.includes(day) : day <= 5;
}

const roundHalf = (n: number) => Math.round(n * 2) / 2;

/**
 * Vorschlag der Arbeitstage eines Antrags bei flexibler Woche: von den
 * Werktagen Mo bis Fr im Zeitraum (`weekdays`, schon ohne Feiertage und
 * Betriebsruhe, halbe Tage eingerechnet) der Anteil der Arbeitswoche, auf
 * halbe Tage gerundet. Ein einzelner (oder halber) Tag zählt voll: Wer ihn
 * beantragt, hätte an ihm gearbeitet. Mindestens ein Tag, höchstens die
 * Werktage. Die Person oder die HR korrigiert die Zahl im Antrag, wenn sie
 * nicht passt (`days_override`).
 */
export function flexibleDays(weekdays: number, daysPerWeek: number): number {
  if (weekdays <= 1) return weekdays;
  return Math.min(weekdays, Math.max(1, roundHalf((weekdays * daysPerWeek) / 5)));
}
