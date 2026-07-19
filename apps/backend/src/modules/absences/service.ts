/**
 * Fachlogik des Abwesenheitsmanagements: Zählung von Abwesenheitstagen
 * (Arbeitstage Mo–Fr minus Feiertage des Mitarbeiter-Bundeslands minus
 * Betriebsruhe, halbe Tage an Randtagen) und Urlaubssaldo-Berechnung.
 */
import { getDb } from '../../db/db.js';
import { eachDay, isWeekend, todayIso } from '../../core/dates.js';
import { isHoliday, type Bundesland } from '../../core/holidays.js';
import { getSetting } from '../../core/settings.js';

export interface EmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  status: string;
  hire_date: string | null;
  exit_date: string | null;
  annual_leave_days: number | null;
  location_id: number | null;
  department_id: number | null;
  team_id: number | null;
}

/** Bundesland eines Mitarbeitenden: Standort, sonst Firmenstandard. */
export function bundeslandForEmployee(employeeId: number): Bundesland {
  const row = getDb()
    .prepare(
      `SELECT l.bundesland FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.id = ?`,
    )
    .get(employeeId) as { bundesland: string | null } | undefined;
  return (row?.bundesland ?? getSetting('defaultBundesland')) as Bundesland;
}

/** Alle Betriebsruhetage (als ISO-Datums-Set) im Zeitraum from..to. */
export function closureDates(from: string, to: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT date_from, date_to FROM company_closures WHERE date_from <= ? AND date_to >= ?')
    .all(to, from) as { date_from: string; date_to: string }[];
  const set = new Set<string>();
  for (const r of rows) {
    const start = r.date_from > from ? r.date_from : from;
    const end = r.date_to < to ? r.date_to : to;
    for (const d of eachDay(start, end)) set.add(d);
  }
  return set;
}

export interface CountOptions {
  land: Bundesland;
  dateFrom: string;
  dateTo: string;
  halfDayStart?: boolean;
  halfDayEnd?: boolean;
  /** Optionaler Ausschnitt (z. B. Kalenderjahr) für die Zählung. */
  clipFrom?: string;
  clipTo?: string;
  /** Vorberechnete Betriebsruhetage; sonst wird selbst geladen. */
  closures?: Set<string>;
}

/**
 * Zählt Abwesenheitstage: Mo–Fr, ohne Feiertage des Bundeslands, ohne
 * Betriebsruhe. Halbe Tage gelten nur, wenn der jeweilige Randtag zählt
 * und innerhalb des Ausschnitts liegt.
 */
export function countAbsenceDays(opts: CountOptions): number {
  const from = opts.clipFrom && opts.clipFrom > opts.dateFrom ? opts.clipFrom : opts.dateFrom;
  const to = opts.clipTo && opts.clipTo < opts.dateTo ? opts.clipTo : opts.dateTo;
  if (from > to) return 0;
  const closures = opts.closures ?? closureDates(from, to);
  const counted = new Set<string>();
  for (const d of eachDay(from, to)) {
    if (isWeekend(d)) continue;
    if (closures.has(d)) continue;
    if (isHoliday(d, opts.land)) continue;
    counted.add(d);
  }
  let total = counted.size;
  if (opts.halfDayStart && counted.has(opts.dateFrom)) total -= 0.5;
  if (opts.halfDayEnd && opts.dateTo !== opts.dateFrom && counted.has(opts.dateTo)) total -= 0.5;
  return total;
}

/** Kaufmännisch auf halbe Tage runden. */
export function roundHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

interface BalanceRequestRow {
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  status: string;
}

export interface BalanceResult {
  employee_id: number;
  year: number;
  entitlement: number;
  carryover: number;
  carryover_expired: boolean;
  taken: number;
  planned: number;
  remaining: number;
}

/**
 * Urlaubssaldo eines Mitarbeitenden für ein Jahr.
 *
 * - entitlement: annual_leave_days, bei Ein-/Austritt im Jahr anteilig
 *   gezwölftelt (nur volle Beschäftigungsmonate zählen), kaufmännisch auf
 *   halbe Tage gerundet.
 * - carryover: Rest des Vorjahres. Nach dem Stichtag (getSetting
 *   'carryoverDeadline', MM-TT) wird nur noch angerechnet, was bis zum
 *   Stichtag tatsächlich genommen wurde. Die Kette wird ab dem
 *   Eintrittsjahr (max. 5 Jahre zurück) iterativ aufgebaut.
 * - taken: genehmigte, saldowirksame Tage bis heute (einschließlich).
 * - planned: genehmigte zukünftige Tage + alle beantragten Tage des Jahres.
 *
 * Jahresübergreifende Anträge werden tagesgenau auf die Jahre aufgeteilt.
 */
export function computeBalance(emp: EmployeeRow, year: number, today = todayIso()): BalanceResult {
  const db = getDb();
  const annual = emp.annual_leave_days ?? 0;
  const land = bundeslandForEmployee(emp.id);
  const deadlineMmDd = getSetting('carryoverDeadline');

  const hireYear = emp.hire_date ? Number(emp.hire_date.slice(0, 4)) : null;
  const startYear = Math.max(hireYear ?? year - 1, year - 5);

  const spanFrom = `${startYear}-01-01`;
  const spanTo = `${year}-12-31`;
  const closures = closureDates(spanFrom, spanTo);

  const rows = db
    .prepare(
      `SELECT r.date_from, r.date_to, r.half_day_start, r.half_day_end, r.status
       FROM absence_requests r
       JOIN absence_types t ON t.id = r.type_id
       WHERE r.employee_id = ? AND t.affects_balance = 1
         AND r.status IN ('genehmigt', 'beantragt')
         AND r.date_from <= ? AND r.date_to >= ?`,
    )
    .all(emp.id, spanTo, spanFrom) as BalanceRequestRow[];

  const days = (r: BalanceRequestRow, clipFrom: string, clipTo: string) =>
    countAbsenceDays({
      land,
      dateFrom: r.date_from,
      dateTo: r.date_to,
      halfDayStart: r.half_day_start === 1,
      halfDayEnd: r.half_day_end === 1,
      clipFrom,
      clipTo,
      closures,
    });

  const entitlementFor = (y: number): number => {
    if (annual <= 0) return 0;
    let months = 0;
    for (let m = 1; m <= 12; m++) {
      const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const hired = !emp.hire_date || emp.hire_date <= monthStart;
      const notExited = !emp.exit_date || emp.exit_date >= monthEnd;
      if (hired && notExited) months++;
    }
    return roundHalf((annual * months) / 12);
  };

  const approved = rows.filter((r) => r.status === 'genehmigt');
  const takenAllIn = (y: number) =>
    approved.reduce((sum, r) => sum + days(r, `${y}-01-01`, `${y}-12-31`), 0);
  const takenUntil = (y: number, until: string) =>
    approved.reduce((sum, r) => sum + days(r, `${y}-01-01`, until), 0);

  // Übertrags-Kette vom Startjahr bis zum Zieljahr aufbauen.
  let carry = 0; // Übertrag NACH Verfallsregel, der im Jahr y nutzbar ist
  let carryoverExpired = false;
  for (let y = startYear + 1; y <= year; y++) {
    const prevRemaining = entitlementFor(y - 1) + carry - takenAllIn(y - 1);
    const raw = Math.max(0, prevRemaining);
    const deadline = `${y}-${deadlineMmDd}`;
    if (today > deadline) {
      // Stichtag vorbei: nur der bis dahin tatsächlich genommene Teil zählt.
      carry = Math.min(raw, takenUntil(y, deadline));
      if (y === year) carryoverExpired = raw > carry;
    } else {
      carry = raw;
    }
  }

  const entitlement = entitlementFor(year);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const takenClipTo = today < yearEnd ? (today < yearStart ? null : today) : yearEnd;
  const taken = takenClipTo === null ? 0 : takenUntil(year, takenClipTo);
  const approvedFuture = approved.reduce((sum, r) => {
    const clipFrom = takenClipTo === null ? yearStart : nextDay(takenClipTo);
    return sum + days(r, clipFrom, yearEnd);
  }, 0);
  const requested = rows
    .filter((r) => r.status === 'beantragt')
    .reduce((sum, r) => sum + days(r, yearStart, yearEnd), 0);
  const planned = approvedFuture + requested;

  return {
    employee_id: emp.id,
    year,
    entitlement,
    carryover: roundHalf(carry),
    carryover_expired: carryoverExpired,
    taken: roundHalf(taken),
    planned: roundHalf(planned),
    remaining: roundHalf(entitlement + carry - taken - planned),
  };
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
