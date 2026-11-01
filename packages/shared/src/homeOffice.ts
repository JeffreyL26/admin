/**
 * Home Office als Arbeitsort, nicht als Abwesenheit: Eine Person hat ein
 * Muster von Wochentagen im Home Office (`employees.home_office_weekdays`,
 * "1,3,5", Mo = 1), einzelne Tage weichen davon ab
 * (`home_office_exceptions`: 'buero' an einem Home-Office-Tag,
 * 'homeoffice' an einem Bürotag). Der Kalender zeigt das als Markierung,
 * Abwesenheiten liegen darüber. DOM-frei, Test
 * apps/backend/src/test/workScheduleTest.ts (Abschnitt Home Office).
 */
import { isoWeekday, parseWeekdays } from './workSchedule.js';

export type HomeOfficeExceptionKind = 'buero' | 'homeoffice';

export interface HomeOfficeException {
  date: string;
  kind: HomeOfficeExceptionKind;
}

export const HOME_OFFICE_EXCEPTION_LABELS: Record<HomeOfficeExceptionKind, string> = {
  buero: 'Bürotag',
  homeoffice: 'Home-Office-Tag',
};

/** Laut Muster (ohne Ausnahmen) ein Home-Office-Tag? */
export function homeOfficeByPattern(pattern: string | null | undefined, date: string): boolean {
  const days = parseWeekdays(pattern);
  return days !== null && days.includes(isoWeekday(date));
}

/**
 * Ist die Person an diesem Tag im Home Office? Eine Ausnahme schlägt das
 * Muster. Ob der Tag überhaupt ein Arbeitstag ist, entscheidet der Aufrufer
 * (Wochenende, Feiertag, Arbeitswoche).
 */
export function homeOfficeOn(
  pattern: string | null | undefined,
  exceptions: ReadonlyMap<string, HomeOfficeExceptionKind>,
  date: string,
): boolean {
  const exception = exceptions.get(date);
  if (exception) return exception === 'homeoffice';
  return homeOfficeByPattern(pattern, date);
}

/**
 * Welche Ausnahme ein Klick im Kalender anlegt: an einem Home-Office-Tag des
 * Musters ein Bürotag, sonst ein zusätzlicher Home-Office-Tag. Gleicht die
 * gewünschte Art dem Muster, braucht es keine Ausnahme (null: entfernen).
 */
export function homeOfficeExceptionFor(
  pattern: string | null | undefined,
  date: string,
  wantHomeOffice: boolean,
): HomeOfficeExceptionKind | null {
  const byPattern = homeOfficeByPattern(pattern, date);
  if (wantHomeOffice === byPattern) return null;
  return wantHomeOffice ? 'homeoffice' : 'buero';
}
