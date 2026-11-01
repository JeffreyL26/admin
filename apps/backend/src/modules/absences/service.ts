/**
 * Fachlogik des Abwesenheitsmanagements: Zählung von Abwesenheitstagen
 * (Arbeitstage der Arbeitswoche, ohne Angabe Mo bis Fr, minus Feiertage des
 * Mitarbeiter-Bundeslands minus Betriebsruhe, halbe Tage an Randtagen) und
 * Urlaubssaldo-Berechnung (Anspruch nach BUrlG: shared/leaveEntitlement.ts).
 */
import { createHash } from 'node:crypto';
import { getDb, inTransaction } from '../../db/db.js';
import { addDaysIso, eachDay, isWeekend, todayIso } from '../../core/dates.js';
import { holidaysForYear, isHoliday } from '../../core/holidays.js';
import { VARIANT } from '@variant-manifest';
import {
  COUNTRY_CODES,
  DEFAULT_WORK_SCHEDULE,
  PORTAL_ABSENCE_CAPTURE,
  entitlementDaysPerWeek,
  flexibleDays,
  formatEntitlementFrozen,
  parseEntitlementFrozen,
  isOwnPersonDecision,
  isScheduledDay,
  leaveEntitlementForPeriods,
  regionCodesFor,
  workScheduleOf,
  type CountryCode,
  type EntitlementDetail,
  type EntitlementFrozenField,
  type EntitlementPeriod,
  type RegionCode,
  type WorkSchedule,
} from '@ohrganize/shared';
import { getSetting } from '../../core/settings.js';
import { AppError, badRequest, conflict, forbidden } from '../../core/errors.js';
import { audit, auditSystem } from '../../core/audit.js';

export interface EmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  status: string;
  employee_type: string;
  hire_date: string | null;
  exit_date: string | null;
  annual_leave_days: number | null;
  work_days_per_week?: number | null;
  work_weekdays?: string | null;
  disability_degree?: number | null;
  disability_equal?: number | null;
  location_id: number | null;
  department_id: number | null;
  team_id: number | null;
}

/**
 * Land und Region, nach denen die Feiertage einer Person gerechnet werden.
 * Land und Region kommen aus dem Standort; ohne Standort gelten die
 * Firmenvorgaben (Land der Variante, `defaultBundesland`).
 */
export interface EmployeeRegion {
  country: CountryCode;
  region: RegionCode;
  /**
   * Arbeitswoche der Person (shared/workSchedule.ts). Reist mit dem Ort, weil
   * jede Zählung beides braucht; ohne Angabe gilt Mo bis Fr wie früher.
   */
  schedule?: WorkSchedule;
}

/**
 * Firmenvorgabe: Das Land ist der Build (VARIANT), keine Kundeneinstellung;
 * die Region kommt aus den Einstellungen.
 */
export function companyRegionDefaults(): EmployeeRegion {
  return { country: VARIANT.country, region: getSetting('defaultBundesland') };
}

/**
 * Spaltenausdruck fuer Sammelabfragen, die Land und Region je Person
 * mitladen (Kalender, Saldo-Uebersicht). Er verlangt den Join
 * REGION_JOIN_SQL und die beiden Bind-Parameter aus regionSelectParams()
 * AN ERSTER STELLE der Parameterliste.
 *
 * Der Spaltenalias heisst weiterhin `bundesland`, weil die Kalender-APIs ihn
 * so ausliefern und Desktop wie Portal ihn so lesen; die Antworten tragen
 * `region` zusaetzlich.
 */
export const REGION_SELECT_SQL =
  'COALESCE(l.country, ?) AS country, COALESCE(l.bundesland, ?) AS bundesland, ' +
  'e.work_days_per_week AS work_days_per_week, e.work_weekdays AS work_weekdays';
export const REGION_JOIN_SQL = 'LEFT JOIN locations l ON l.id = e.location_id';

export function regionSelectParams(defaults = companyRegionDefaults()): [string, string] {
  return [defaults.country, defaults.region];
}

/** Zeile aus einer Abfrage mit REGION_SELECT_SQL. */
export interface RegionRow {
  country: string;
  bundesland: string;
  work_days_per_week?: number | null;
  work_weekdays?: string | null;
}

/** Ort und Arbeitswoche aus einer Zeile mit REGION_SELECT_SQL. */
export function placeFromRow(row: RegionRow): EmployeeRegion {
  return { country: row.country as CountryCode, region: row.bundesland, schedule: workScheduleOf(row) };
}

/** Land, Region und Arbeitswoche eines Mitarbeitenden: Standort, sonst Firmenvorgabe. */
export function regionForEmployee(employeeId: number): EmployeeRegion {
  const row = getDb()
    .prepare(
      `SELECT ${REGION_SELECT_SQL} FROM employees e
       ${REGION_JOIN_SQL}
       WHERE e.id = ?`,
    )
    .get([...regionSelectParams(), employeeId]) as RegionRow | undefined;
  if (!row) return companyRegionDefaults();
  return placeFromRow(row);
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
  /** Land und Region der Person (regionForEmployee). */
  place: EmployeeRegion;
  dateFrom: string;
  dateTo: string;
  halfDayStart?: boolean;
  halfDayEnd?: boolean;
  /** Optionaler Ausschnitt (z. B. Kalenderjahr) für die Zählung. */
  clipFrom?: string;
  clipTo?: string;
  /**
   * Vorberechnete Betriebsruhetage; sonst wird selbst geladen. Sie müssen den
   * GANZEN Zeitraum dateFrom bis dateTo abdecken, nicht nur den Ausschnitt:
   * Bei flexibler Woche und bei gespeicherten Tagen ist ein Ausschnitt ein
   * Anteil am ganzen Zeitraum (`closuresCovering`).
   */
  closures?: Set<string>;
}

/**
 * DIE Zählregel eines Tages: Tag der Arbeitswoche (feste Tage, flexibel Mo
 * bis Fr), kein Feiertag, keine Betriebsruhe; halbe Randtage des Zeitraums
 * zählen halb. Ganze Zeiträume (scheduledDays) und Anteile (dayProfile)
 * rechnen beide hiermit.
 */
function dayWeight(opts: CountOptions, schedule: WorkSchedule, closures: Set<string>, d: string): number {
  if (!isScheduledDay(schedule, d) || closures.has(d) || isHoliday(d, opts.place.country, opts.place.region)) return 0;
  const half =
    (opts.halfDayStart && d === opts.dateFrom) || (opts.halfDayEnd && d === opts.dateTo && opts.dateTo !== opts.dateFrom);
  return half ? 0.5 : 1;
}

/** Tage nach `dayWeight` zwischen from und to. */
function scheduledDays(opts: CountOptions, schedule: WorkSchedule, closures: Set<string>, from: string, to: string): number {
  let total = 0;
  for (const d of eachDay(from, to)) total += dayWeight(opts, schedule, closures, d);
  return total;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tage der Arbeitswoche eines ganzen Zeitraums, aufgelaufen je Tag (ein Durchlauf). */
interface DayProfile {
  /** Im ganzen Zeitraum (wie scheduledDays über dateFrom bis dateTo). */
  all: number;
  /**
   * Anteil bis einschließlich `end` (innerhalb des Zeitraums) am Ganzen;
   * ohne Tage der Arbeitswoche nach Kalendertagen.
   */
  fractionUpTo(end: string): number;
}

function dayProfile(opts: CountOptions, schedule: WorkSchedule, closures: Set<string>): DayProfile {
  const days = eachDay(opts.dateFrom, opts.dateTo);
  const cumulative = new Map<string, number>();
  let sum = 0;
  for (const d of days) {
    sum += dayWeight(opts, schedule, closures, d);
    cumulative.set(d, sum);
  }
  const all = sum;
  if (all > 0) return { all, fractionUpTo: (end) => (cumulative.get(end) ?? 0) / all };
  const position = new Map(days.map((d, i) => [d, i + 1]));
  return { all, fractionUpTo: (end) => (position.get(end) ?? 0) / days.length };
}

/**
 * Anteil des Ausschnitts from bis to an `whole` Tagen des ganzen Zeitraums,
 * verteilt nach den Tagen der Arbeitswoche (gibt es dort keine, nach
 * Kalendertagen). Gerechnet als Differenz des bis zum Ende aufgelaufenen
 * Anteils: Die Ausschnitte eines Antrags (bis heute und ab morgen, je
 * Kalenderjahr) ergeben so zusammen genau `whole`, statt dass jeder für sich
 * rundet. Das Profil entsteht erst, wenn der Ausschnitt den Zeitraum schneidet.
 */
function shareOf(whole: number, opts: CountOptions, profile: () => DayProfile, from: string, to: string): number {
  if (from > to) return 0;
  if (from <= opts.dateFrom && to >= opts.dateTo) return whole;
  const upTo = (end: string) =>
    end < opts.dateFrom ? 0 : end >= opts.dateTo ? whole : round2(whole * profile().fractionUpTo(end));
  return round2(upTo(to) - upTo(addDaysIso(from, -1)));
}

/**
 * Profile gespeicherter Anträge, je Zeilenobjekt: computeBalance fragt
 * dieselbe Zeile für jedes Jahr der Übertragskette, für genommen, geplant und
 * die Aufschlüsselung. Gültig nur für denselben Ort und dieselbe
 * Betriebsruhe (Objektgleichheit), sonst neu gerechnet.
 */
const profileCache = new WeakMap<object, { place: EmployeeRegion; closures: Set<string>; profile: DayProfile }>();

/**
 * Zählt Abwesenheitstage: die Tage der Arbeitswoche (feste Tage, sonst Mo bis Fr),
 * ohne Feiertage des Bundeslands, ohne Betriebsruhe. Halbe Tage gelten nur,
 * wenn der jeweilige Randtag zählt und innerhalb des Ausschnitts liegt. Bei
 * flexibler Woche (eine Zahl Tage ohne feste Tage) ist das Ergebnis der
 * anteilige Vorschlag `flexibleDays` für den ganzen Zeitraum und ein
 * Ausschnitt sein Anteil daran (`shareOf`); die tatsächliche Zahl kann der
 * Antrag von Hand tragen (days_manual).
 */
export function countAbsenceDays(opts: CountOptions): number {
  const from = opts.clipFrom && opts.clipFrom > opts.dateFrom ? opts.clipFrom : opts.dateFrom;
  const to = opts.clipTo && opts.clipTo < opts.dateTo ? opts.clipTo : opts.dateTo;
  if (from > to) return 0;
  const schedule = opts.place.schedule ?? DEFAULT_WORK_SCHEDULE;
  if (schedule.weekdays !== null) {
    return scheduledDays(opts, schedule, opts.closures ?? closureDates(from, to), from, to);
  }
  const profile = dayProfile(opts, schedule, opts.closures ?? closureDates(opts.dateFrom, opts.dateTo));
  return shareOf(flexibleDays(profile.all, schedule.daysPerWeek), opts, () => profile, from, to);
}

/**
 * Werktage Mo bis Fr im Zeitraum (ohne Feiertage und Betriebsruhe), unabhängig
 * von der Arbeitswoche: Obergrenze für die von Hand genannten Arbeitstage
 * eines Antrags bei flexibler Woche.
 */
export function countWeekdays(opts: CountOptions): number {
  return countAbsenceDays({ ...opts, place: { ...opts.place, schedule: DEFAULT_WORK_SCHEDULE } });
}

/**
 * Felder der Antragsvorschau zur Arbeitswoche (HR und Portal gleich): Bei
 * flexibler Woche zeigt das Formular "Davon Arbeitstage" mit dem Vorschlag
 * `days_counted` und der Obergrenze `weekdays` (Werktage Mo bis Fr).
 */
export function schedulePreview(opts: CountOptions): { flexible: boolean; days_per_week: number; weekdays: number | null } {
  const schedule = opts.place.schedule ?? DEFAULT_WORK_SCHEDULE;
  const flexible = schedule.weekdays === null;
  return { flexible, days_per_week: schedule.daysPerWeek, weekdays: flexible ? countWeekdays(opts) : null };
}

/**
 * Tage eines Antrags in einem Ausschnitt. Maßgeblich ist die gespeicherte
 * Zahl `days_counted` (beim Anlegen gezählt oder von Hand genannt; neu
 * gezählt bei Betriebsruhe und, für noch nicht begonnene Anträge, bei
 * geänderter Arbeitswoche oder geändertem Ort: `recountUpcomingRequests`).
 * Ein vergangener Antrag zählt deshalb weiter, wie er gezählt wurde, auch
 * wenn sich die Arbeitswoche seither geändert hat. Ein Ausschnitt
 * (Jahreswechsel, bis heute) ist ihr Anteil nach den Tagen der Arbeitswoche
 * (`shareOf`). Ohne gespeicherte Zahl (ein neuer Antrag) wird gezählt.
 */
export function requestDaysIn(
  r: { date_from: string; date_to: string; half_day_start: number; half_day_end: number; days_counted?: number | null },
  opts: Omit<CountOptions, 'dateFrom' | 'dateTo' | 'halfDayStart' | 'halfDayEnd'>,
): number {
  const base: CountOptions = {
    ...opts,
    dateFrom: r.date_from,
    dateTo: r.date_to,
    halfDayStart: r.half_day_start === 1,
    halfDayEnd: r.half_day_end === 1,
  };
  if (r.days_counted === undefined || r.days_counted === null) return countAbsenceDays(base);
  const from = opts.clipFrom && opts.clipFrom > r.date_from ? opts.clipFrom : r.date_from;
  const to = opts.clipTo && opts.clipTo < r.date_to ? opts.clipTo : r.date_to;
  const profile = () => {
    const closures = opts.closures ?? closureDates(r.date_from, r.date_to);
    const cached = profileCache.get(r);
    if (cached && cached.place === opts.place && cached.closures === closures) return cached.profile;
    const fresh = dayProfile(base, opts.place.schedule ?? DEFAULT_WORK_SCHEDULE, closures);
    profileCache.set(r, { place: opts.place, closures, profile: fresh });
    return fresh;
  };
  return shareOf(r.days_counted, base, profile, from, to);
}

/**
 * Betriebsruhe für from bis to und den ganzen Zeitraum jedes Antrags: Ein
 * Ausschnitt rechnet über den ganzen Antrag (`shareOf`), auch über den Teil
 * vor dem ersten betrachteten Jahr.
 */
export function closuresCovering(
  rows: readonly { date_from: string; date_to: string }[],
  from: string,
  to: string,
): Set<string> {
  let lo = from;
  let hi = to;
  for (const r of rows) {
    if (r.date_from < lo) lo = r.date_from;
    if (r.date_to > hi) hi = r.date_to;
  }
  return closureDates(lo, hi);
}

/**
 * Wert fuer `absence_requests.closure_covered`: 1 nur, wenn ERST die
 * Betriebsruhe den Zeitraum auf 0 Tage bringt, ohne sie also mindestens ein
 * Tag zaehlen wuerde. Eine 0 aus Wochenende oder Feiertag bleibt 0, auch
 * wenn der Zeitraum eine Betriebsruhe beruehrt. Die Clients zeigen bei 1
 * „Betriebsruhe“ statt der Zahl. Geschrieben an den beiden Stellen, die
 * `days_counted` schreiben (createRequest, recountRequestsOverlapping).
 */
export function closureCoveredFlag(days: number, opts: CountOptions): number {
  if (days !== 0) return 0;
  return countAbsenceDays({ ...opts, closures: new Set() }) > 0 ? 1 : 0;
}

/** Kaufmännisch auf halbe Tage runden. */
export function roundHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

export interface BalanceRequestRow {
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  status: string;
  /** Gespeicherte Tage (gezählt oder von Hand); fehlt nur bei einem neuen Antrag. */
  days_counted?: number;
  /** Nur fuer die Aufschluesselung (ctx.breakdown) noetig. */
  id?: number;
  type_name?: string;
  type_color?: string;
}

/**
 * Vorgeladener Kontext für Sammel-Aufrufe (z. B. die Saldo-Übersicht über die
 * gesamte Belegschaft): erspart die Queries je Person, die den synchronen
 * Prozess sonst für alle parallelen Requests blockieren. `closures` und
 * `requests` dürfen ein Superset (größerer Zeitraum bzw. eigener Antrag
 * ausgenommen) sein — Zeiträume außerhalb der Jahresfenster zählen über das
 * Clipping als 0. `closures` deckt dabei den ganzen Zeitraum jedes Antrags
 * ab (`closuresCovering`). Einzel-Aufrufe lassen den Kontext einfach weg.
 */
export interface BalanceContext {
  place?: EmployeeRegion;
  /** Verfallsstichtag "MM-TT" (getSetting('carryoverDeadline')). */
  carryoverDeadline?: string;
  closures?: Set<string>;
  requests?: BalanceRequestRow[];
  /**
   * Zeitabschnitte der Person (CONTRACT_PERIODS_SQL samt Grundlage, sortiert
   * nach valid_from, id), sonst selbst geladen (contractPeriodsOf).
   */
  contracts?: ContractPeriodRow[];
  /**
   * Aufschluesselung der Kacheln mitliefern (Personalakte). Verlangt Zeilen
   * mit id, type_name und type_color; die eigene Abfrage liefert sie.
   */
  breakdown?: boolean;
}

/**
 * Werte einer Vertragsversion, mit denen der Urlaubsanspruch ihren Zeitraum
 * rechnet, oder eines festgehaltenen Zeitraums ohne Version (CONTRACT_PERIODS_SQL).
 */
export interface ContractPeriodRow {
  employee_id: number;
  valid_from: string;
  valid_to: string | null;
  /** 0 = festgehaltener Zeitraum ohne Version (contract_gap_values), sonst Version. */
  kind?: number;
  employee_type: string | null;
  annual_leave_days: number | null;
  work_weekdays: string | null;
  work_days_per_week: number | null;
}

/**
 * Zeilen fuer ContractPeriodRow: die Vertragsversionen (`kind` 1) und,
 * solange es welche gibt, die festgehaltenen Zeitraeume ohne Version aus
 * `contract_gap_values` (`kind` 0, Migration 119, freezeEntitlementInputs).
 * Aufrufer filtern und sortieren nach CONTRACT_PERIODS_ORDER:
 * `SELECT * FROM (${CONTRACT_PERIODS_SQL}) WHERE employee_id = ? ORDER BY ${CONTRACT_PERIODS_ORDER}`.
 */
export const CONTRACT_PERIODS_SQL = `
  SELECT g.employee_id, g.valid_from, g.valid_to, g.employee_type, g.annual_leave_days,
         g.work_weekdays, g.work_days_per_week, 0 AS kind, g.id
    FROM contract_gap_values g
   WHERE EXISTS (SELECT 1 FROM contracts c WHERE c.employee_id = g.employee_id)
  UNION ALL
  SELECT employee_id, valid_from, valid_to, employee_type, annual_leave_days, work_weekdays,
         work_days_per_week, 1 AS kind, id
    FROM contracts`;

/** Reihenfolge der Zeilen aus CONTRACT_PERIODS_SQL je Person. */
export const CONTRACT_PERIODS_ORDER = 'valid_from, kind, id';

/** Zeitabschnitte einer Person fuer den Anspruch, aufsteigend (CONTRACT_PERIODS_SQL). */
export function contractPeriodsOf(employeeId: number): ContractPeriodRow[] {
  return getDb()
    .prepare(`SELECT * FROM (${CONTRACT_PERIODS_SQL}) WHERE employee_id = ? ORDER BY ${CONTRACT_PERIODS_ORDER}`)
    .all(employeeId) as ContractPeriodRow[];
}

/**
 * Spalten der Akte, mit denen Versionen ohne eigene Angabe und Zeitraeume ohne
 * Version den Anspruch rechnen (entitlementPeriods).
 */
export const ENTITLEMENT_EMPLOYEE_COLUMNS = [
  'employee_type',
  'annual_leave_days',
  'work_weekdays',
  'work_days_per_week',
] as const;

type EntitlementInputs = Pick<ContractPeriodRow, 'annual_leave_days' | 'work_weekdays' | 'work_days_per_week'>;

/**
 * Woche, mit der die Akte rechnet, als festes Paar: ihre Angabe, sonst bei
 * Vollzeit und Ausbildung Mo bis Fr (entitlementDaysPerWeek), sonst leer
 * (unbekannt). `type`: Art, deren Vorgabe gilt (die der Version, sonst der Akte).
 */
function akteWeekOf(
  emp: Pick<EntitlementInputs, 'work_weekdays' | 'work_days_per_week'>,
  type: string,
): Pick<EntitlementInputs, 'work_weekdays' | 'work_days_per_week'> {
  if (emp.work_weekdays !== null || emp.work_days_per_week !== null) {
    return { work_weekdays: emp.work_weekdays, work_days_per_week: emp.work_days_per_week };
  }
  return entitlementDaysPerWeek({ employee_type: type }) === 5
    ? { work_weekdays: '1,2,3,4,5', work_days_per_week: 5 }
    : { work_weekdays: null, work_days_per_week: null };
}

/**
 * Vor einer Aenderung von Beschaeftigungsart, Jahresurlaub oder Arbeitswoche
 * der Akte: Was bisher aus der Akte rechnete, bekommt ihre bisherigen Werte
 * fest, damit der Anspruch frueherer Zeitraeume bleibt. Das sind
 * - Jahresurlaub und Arbeitswoche ABGELAUFENER Vertragsversionen ohne eigene
 *   Angabe (Ende vor `today`; die heute geltende nicht, die korrigiert
 *   syncCurrentContract fuer ihren ganzen Zeitraum, und eine aus alten Werten
 *   abgeleitete Woche bliebe sonst neben der korrigierten Art stehen),
 *   vermerkt in `contracts.entitlement_frozen`. Nicht die Art: Sie ist die
 *   Historie der Beschaeftigungsart, und eine hier aus der heutigen Akte
 *   geschaetzte Art verfaelschte sie; die bekommt eine Version nur beim
 *   Abloesen (fillClosedVersion in employees/contractRoutes.ts, dann spiegelt
 *   die Akte genau sie). Eine Version ohne Art rechnet weiter mit der Art der
 *   Akte; das wirkt nur bei unbekannter Woche und freier Mitarbeit,
 * - und, sobald es Versionen gibt, jeder Zeitraum bis gestern, den weder eine
 *   Version noch ein schon festgehaltener Zeitraum abdeckt (vor der ersten,
 *   zwischen zwei, nach der letzten Version), als Zeile in
 *   `contract_gap_values`; schliesst er an eine Zeile mit denselben Werten
 *   an, waechst diese. Ab `today` gelten die neuen Werte.
 * Eine Akte ohne Arbeitswoche rechnet bei Vollzeit und Ausbildung mit Mo bis
 * Fr (entitlementDaysPerWeek) und wird so festgehalten; eine unbekannte Woche
 * bleibt leer und folgt weiter der Akte. Ohne Versionen rechnen alle Jahre mit
 * der Akte (so sagt es der Hinweis in den Stammdaten). Die geschriebenen Werte
 * sind die, mit denen ohnehin gerechnet wurde; am Anspruch aendert das
 * nichts. Aufrufen in der Transaktion der Aenderung und VOR dem UPDATE
 * (statisch geprueft: test/placeChangeCheck.ts). Liefert, was festgehalten
 * wurde, fuer den Audit-Eintrag des Aufrufers.
 */
export function freezeEntitlementInputs(
  employeeId: number,
  today = todayIso(),
): { contracts: number[]; gaps: { from: string; to: string }[] } {
  const db = getDb();
  const columns = ENTITLEMENT_EMPLOYEE_COLUMNS.join(', ');
  const emp = db.prepare(`SELECT ${columns}, hire_date FROM employees WHERE id = ?`).get(employeeId) as
    | (EntitlementInputs & { employee_type: string; hire_date: string | null })
    | undefined;
  const frozen = { contracts: [] as number[], gaps: [] as { from: string; to: string }[] };
  if (!emp) return frozen;
  const weekOf = (type: string) => akteWeekOf(emp, type);
  const versions = db
    .prepare(
      `SELECT id, ${columns}, entitlement_frozen FROM contracts
       WHERE employee_id = ? AND valid_to IS NOT NULL AND valid_to < ?`,
    )
    .all([employeeId, today]) as (EntitlementInputs & {
    id: number;
    employee_type: string | null;
    entitlement_frozen: string | null;
  })[];
  for (const v of versions) {
    const set: Record<string, unknown> = {};
    const fields: EntitlementFrozenField[] = [];
    if (v.annual_leave_days === null && emp.annual_leave_days !== null) {
      set.annual_leave_days = emp.annual_leave_days;
      fields.push('annual_leave_days');
    }
    if (v.work_weekdays === null && v.work_days_per_week === null) {
      const week = weekOf(v.employee_type ?? emp.employee_type);
      if (week.work_days_per_week !== null) {
        Object.assign(set, week);
        fields.push('work_week');
      }
    }
    if (fields.length === 0) continue;
    set.entitlement_frozen = formatEntitlementFrozen([...parseEntitlementFrozen(v.entitlement_frozen), ...fields]);
    const cols = Object.keys(set);
    db.prepare(`UPDATE contracts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run([
      ...cols.map((c) => set[c]),
      v.id,
    ]);
    frozen.contracts.push(v.id);
  }
  if (!db.prepare('SELECT 1 FROM contracts WHERE employee_id = ? LIMIT 1').get(employeeId)) return frozen;
  // Zeitraeume bis gestern ohne Version und ohne festgehaltene Werte.
  const yesterday = addDaysIso(today, -1);
  const covered = db
    .prepare(`SELECT valid_from, valid_to FROM (${CONTRACT_PERIODS_SQL}) WHERE employee_id = ? ORDER BY ${CONTRACT_PERIODS_ORDER}`)
    .all(employeeId) as { valid_from: string; valid_to: string | null }[];
  let cursor = '0000-01-01';
  for (const c of covered) {
    if (cursor > yesterday) break;
    if (c.valid_from > cursor) {
      const to = addDaysIso(c.valid_from, -1);
      frozen.gaps.push({ from: cursor, to: to < yesterday ? to : yesterday });
    }
    if (c.valid_to === null) {
      cursor = '9999-12-31';
      break;
    }
    const after = addDaysIso(c.valid_to, 1);
    if (after > cursor) cursor = after;
  }
  if (cursor <= yesterday) frozen.gaps.push({ from: cursor, to: yesterday });
  // Ganz vor dem Eintritt zaehlt nichts zum Anspruch; dort nichts festhalten.
  const hire = emp.hire_date;
  if (hire) frozen.gaps = frozen.gaps.filter((gap) => gap.to >= hire);
  const week = weekOf(emp.employee_type);
  const values = [emp.employee_type, emp.annual_leave_days, week.work_weekdays, week.work_days_per_week];
  // Schliesst die Luecke an eine Zeile mit denselben Werten an, waechst diese
  // (sonst legte jede Aenderung nach der letzten Version eine weitere an).
  const adjoining = db.prepare(
    `SELECT id FROM contract_gap_values
     WHERE employee_id = ? AND valid_to = ? AND employee_type IS ? AND annual_leave_days IS ?
       AND work_weekdays IS ? AND work_days_per_week IS ?`,
  );
  const extend = db.prepare('UPDATE contract_gap_values SET valid_to = ? WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO contract_gap_values
       (employee_id, valid_from, valid_to, employee_type, annual_leave_days, work_weekdays, work_days_per_week)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const gap of frozen.gaps) {
    const before = adjoining.get([employeeId, addDaysIso(gap.from, -1), ...values]) as { id: number } | undefined;
    if (before) extend.run([gap.to, before.id]);
    else insert.run([employeeId, gap.from, gap.to, ...values]);
  }
  return frozen;
}

/**
 * Gegenstueck zu freezeEntitlementInputs fuer eine abgelaufene Version, die
 * wieder gilt (eine Korrektur verschiebt den Beginn der Folgeversion nach
 * hinten, PATCH /api/contracts/:id verlaengert die Vorversion): Festgehaltene
 * Urlaubstage und Woche, die genau dem entsprechen, was die Akte heute
 * liefert, werden wieder leer, damit die geltende Version wie jede andere der
 * Korrektur in den Stammdaten folgt (sonst bliebe etwa eine aus alter
 * Vollzeit abgeleitete Woche neben einer korrigierten Art stehen). Beim
 * Abloesen uebernommene Art und Stunden bleiben als Werte (geleert gingen sie
 * beim naechsten Abloesen verloren, gefuellt wird nur beim POST), verlieren
 * aber bei Gleichheit ihren Vermerk: Die geltende Version folgt jetzt den
 * Korrekturen. Abweichende Felder bleiben samt Vermerk, sonst aenderte sich
 * der Anspruch ihres Zeitraums (die Akte traegt dann noch die Werte der
 * verschobenen Folgeversion). Liefert die Felder ohne Vermerk fuer den Audit-Eintrag.
 */
export function unfreezeReopenedContract(contractId: number, today = todayIso()): EntitlementFrozenField[] {
  const db = getDb();
  const v = db
    .prepare(
      `SELECT employee_id, employee_type, weekly_hours, annual_leave_days, work_weekdays, work_days_per_week, valid_to,
              entitlement_frozen
       FROM contracts WHERE id = ?`,
    )
    .get(contractId) as
    | (EntitlementInputs & {
        employee_id: number;
        employee_type: string | null;
        weekly_hours: number | null;
        valid_to: string | null;
        entitlement_frozen: string | null;
      })
    | undefined;
  if (!v || v.entitlement_frozen === null || (v.valid_to !== null && v.valid_to < today)) return [];
  const emp = db
    .prepare(`SELECT ${ENTITLEMENT_EMPLOYEE_COLUMNS.join(', ')}, weekly_hours FROM employees WHERE id = ?`)
    .get(v.employee_id) as (EntitlementInputs & { employee_type: string; weekly_hours: number | null }) | undefined;
  if (!emp) return [];
  const held = parseEntitlementFrozen(v.entitlement_frozen);
  const cleared: EntitlementFrozenField[] = [];
  const set: Record<string, unknown> = {};
  // Art und Stunden: Wert bleibt, nur der Vermerk faellt bei Gleichheit weg.
  for (const c of ['employee_type', 'weekly_hours'] as const) {
    if (held.includes(c) && v[c] === emp[c]) cleared.push(c);
  }
  if (held.includes('annual_leave_days') && v.annual_leave_days === emp.annual_leave_days) {
    set.annual_leave_days = null;
    cleared.push('annual_leave_days');
  }
  if (held.includes('work_week')) {
    const week = akteWeekOf(emp, v.employee_type ?? emp.employee_type);
    if (week.work_weekdays === v.work_weekdays && week.work_days_per_week === v.work_days_per_week) {
      set.work_weekdays = null;
      set.work_days_per_week = null;
      cleared.push('work_week');
    }
  }
  if (cleared.length === 0) return [];
  set.entitlement_frozen = formatEntitlementFrozen(held.filter((f) => !cleared.includes(f)));
  const cols = Object.keys(set);
  db.prepare(`UPDATE contracts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run([
    ...cols.map((c) => set[c]),
    contractId,
  ]);
  return cleared;
}

/**
 * Zeitabschnitte eines Jahres fuer den Urlaubsanspruch: je Vertragsversion
 * ihr Zeitraum mit ihrer Arbeitswoche und ihrem Jahresurlaub, bis zum Beginn
 * der naechsten Version. Versionen gehen vor; was keine abdeckt, rechnet mit
 * festgehaltenen Werten (`kind` 0 aus contract_gap_values), wo es sie gibt,
 * sonst wie auch die leeren Felder einer Version mit den Werten der
 * Personalakte (freezeEntitlementInputs haelt fest, bevor die sich aendert).
 * `rows` aus CONTRACT_PERIODS_SQL, sortiert nach CONTRACT_PERIODS_ORDER
 * (contractPeriodsOf).
 */
export function entitlementPeriods(emp: EmployeeRow, rows: readonly ContractPeriodRow[], year: number): EntitlementPeriod[] {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const valuesOf = (c: ContractPeriodRow): Omit<EntitlementPeriod, 'from' | 'to'> => {
    const type = c.employee_type ?? emp.employee_type;
    const ownWeek = c.work_weekdays !== null || c.work_days_per_week !== null;
    return {
      annual_leave_days: c.annual_leave_days ?? emp.annual_leave_days,
      days_per_week: entitlementDaysPerWeek(
        ownWeek
          ? { employee_type: type, work_weekdays: c.work_weekdays, work_days_per_week: c.work_days_per_week }
          : { ...emp, employee_type: type },
      ),
    };
  };
  // Versionen gehen vor; was keine abdeckt, rechnet mit festgehaltenen Werten
  // (contract_gap_values), wo es sie gibt, sonst mit der Akte.
  const contracts = rows.filter((r) => r.kind !== 0);
  const gaps = rows.filter((r) => r.kind === 0);
  const fromEmployee = { annual_leave_days: emp.annual_leave_days, days_per_week: entitlementDaysPerWeek(emp) };
  const periods: EntitlementPeriod[] = [];
  const fill = (from: string, to: string) => {
    let at = from;
    for (const g of gaps) {
      const gFrom = g.valid_from > at ? g.valid_from : at;
      const gTo = g.valid_to !== null && g.valid_to < to ? g.valid_to : to;
      if (gFrom > gTo) continue;
      if (gFrom > at) periods.push({ from: at, to: addDaysIso(gFrom, -1), ...fromEmployee });
      periods.push({ from: gFrom, to: gTo, ...valuesOf(g) });
      at = addDaysIso(gTo, 1);
    }
    if (at <= to) periods.push({ from: at, to, ...fromEmployee });
  };
  let cursor = yearStart;
  contracts.forEach((c, i) => {
    const nextStart = contracts[i + 1]?.valid_from;
    let to = c.valid_to ?? yearEnd;
    if (nextStart && nextStart <= to) to = addDaysIso(nextStart, -1);
    const from = c.valid_from > yearStart ? c.valid_from : yearStart;
    if (to > yearEnd) to = yearEnd;
    if (from > to || from > yearEnd) return;
    if (from > cursor) fill(cursor, addDaysIso(from, -1));
    periods.push({ from, to, ...valuesOf(c) });
    cursor = addDaysIso(to, 1);
  });
  if (cursor <= yearEnd) fill(cursor, yearEnd);
  return periods;
}

/**
 * Ein Zeitabschnitt eines saldowirksamen Antrags: der bis heute genommene Teil
 * und der ab morgen verplante Teil sind ZWEI Abschnitte desselben Antrags,
 * beantragte Antraege ein einziger verplanter. Auf das Jahr geclippt.
 */
export interface BalanceBreakdownSegment {
  request_id: number;
  type_name: string;
  type_color: string;
  status: string;
  kind: 'taken' | 'planned';
  date_from: string;
  date_to: string;
  days: number;
}

export interface BalanceBreakdown {
  /** Letzter Tag, bis zu dem "genommen" zaehlt; null, wenn das Jahr noch nicht begonnen hat. */
  taken_until: string | null;
  segments: BalanceBreakdownSegment[];
}

export interface BalanceResult {
  employee_id: number;
  year: number;
  entitlement: number;
  /** Aufteilung des Anspruchs (gesetzlich, vertraglich, Zusatzurlaub, anteilig). */
  entitlement_detail: EntitlementDetail;
  carryover: number;
  carryover_expired: boolean;
  taken: number;
  planned: number;
  remaining: number;
  breakdown?: BalanceBreakdown;
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
export function computeBalance(
  emp: EmployeeRow,
  year: number,
  today = todayIso(),
  ctx?: BalanceContext,
): BalanceResult {
  const db = getDb();
  const place = ctx?.place ?? regionForEmployee(emp.id);
  const entitlementInput = {
    hire_date: emp.hire_date,
    exit_date: emp.exit_date,
    disability_degree: emp.disability_degree ?? null,
    disability_equal: emp.disability_equal === 1,
  };
  // Arbeitswoche und Jahresurlaub je Vertragsversion: ein Wechsel (etwa in
  // Teilzeit) aendert den Anspruch nur ab seinem Beginn, fruehere Jahre und der
  // Uebertrag bleiben (leaveEntitlementForPeriods).
  const contracts = ctx?.contracts ?? contractPeriodsOf(emp.id);
  const deadlineMmDd = ctx?.carryoverDeadline ?? getSetting('carryoverDeadline');

  const hireYear = emp.hire_date ? Number(emp.hire_date.slice(0, 4)) : null;
  const startYear = Math.max(hireYear ?? year - 1, year - 5);

  const spanFrom = `${startYear}-01-01`;
  const spanTo = `${year}-12-31`;

  const rows =
    ctx?.requests ??
    (db
      .prepare(
        `SELECT r.id, r.date_from, r.date_to, r.half_day_start, r.half_day_end, r.status,
                r.days_counted,
                t.name AS type_name, t.color AS type_color
         FROM absence_requests r
         JOIN absence_types t ON t.id = r.type_id
         WHERE r.employee_id = ? AND t.affects_balance = 1
           AND r.status IN ('genehmigt', 'beantragt')
           AND r.date_from <= ? AND r.date_to >= ?
         ORDER BY r.date_from`,
      )
      .all([emp.id, spanTo, spanFrom]) as BalanceRequestRow[]);
  const closures = ctx?.closures ?? closuresCovering(rows, spanFrom, spanTo);

  const days = (r: BalanceRequestRow, clipFrom: string, clipTo: string) =>
    requestDaysIn(r, { place, clipFrom, clipTo, closures });

  // Anspruch je Jahr nach BUrlG (gesetzlich, vertraglich, Zusatzurlaub),
  // Regeln und Rundung in shared/leaveEntitlement.ts.
  const entitlementOf = (y: number) =>
    leaveEntitlementForPeriods(entitlementInput, entitlementPeriods(emp, contracts, y), y);
  const entitlementFor = (y: number): number => entitlementOf(y).total;

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

  const entitlementDetail = entitlementOf(year);
  const entitlement = entitlementDetail.total;
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

  let breakdown: BalanceBreakdown | undefined;
  if (ctx?.breakdown) {
    // Dieselben Ausschnitte wie oben, nur je Antrag als Zeitabschnitt: Die
    // Tagessummen der Abschnitte ergeben exakt die Kacheln.
    const futureFrom = takenClipTo === null ? yearStart : nextDay(takenClipTo);
    const segments: BalanceBreakdownSegment[] = [];
    const push = (r: BalanceRequestRow, kind: 'taken' | 'planned', clipFrom: string, clipTo: string) => {
      const from = r.date_from > clipFrom ? r.date_from : clipFrom;
      const to = r.date_to < clipTo ? r.date_to : clipTo;
      if (from > to) return;
      const counted = days(r, clipFrom, clipTo);
      if (counted <= 0) return;
      segments.push({
        request_id: r.id ?? 0,
        type_name: r.type_name ?? '',
        type_color: r.type_color ?? '',
        status: r.status,
        kind,
        date_from: from,
        date_to: to,
        days: counted,
      });
    };
    for (const r of rows) {
      if (r.date_from > yearEnd || r.date_to < yearStart) continue;
      if (r.status === 'genehmigt') {
        if (takenClipTo !== null) push(r, 'taken', yearStart, takenClipTo);
        push(r, 'planned', futureFrom, yearEnd);
      } else {
        push(r, 'planned', yearStart, yearEnd);
      }
    }
    segments.sort((a, b) => a.date_from.localeCompare(b.date_from));
    breakdown = { taken_until: takenClipTo, segments };
  }

  // Zwei Stellen statt halber Tage (round2): Der gesetzliche Teilurlaub kann
  // Bruchteile unter einem halben Tag tragen (§ 5 Abs. 2 BUrlG rundet nur ab
  // einem halben Tag auf). Ganze und halbe Tage bleiben, was sie waren.
  return {
    employee_id: emp.id,
    year,
    entitlement,
    entitlement_detail: entitlementDetail,
    carryover: round2(carry),
    carryover_expired: carryoverExpired,
    taken: round2(taken),
    planned: round2(planned),
    remaining: round2(entitlement + carry - taken - planned),
    ...(breakdown ? { breakdown } : {}),
  };
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface AbsenceTypeRow {
  id: number;
  name: string;
  category: string;
  paid: number;
  affects_balance: number;
  requires_proof: number;
  requires_approval: number;
  color: string;
  max_days_per_year: number | null;
  active: number;
}

/**
 * Berechtigung für eine Abwesenheitsart auflösen. Zwei Regelquellen:
 * eine Rollen-Allowlist je Art (keine Zeile bedeutet bewusst "alle dürfen",
 * damit bestehende Arten ohne Pflege offen bleiben) und eine Personenregel,
 * die die Rollenregel in beide Richtungen schlägt.
 */
function isTypeAllowed(employeeId: number, typeId: number, category: string): boolean {
  // Krankmeldungen dürfen nie an einer Berechtigung scheitern.
  if (category === 'krankheit') return true;
  const db = getDb();

  const rule = db
    .prepare('SELECT effect FROM absence_type_employee_rules WHERE type_id = ? AND employee_id = ?')
    .get([typeId, employeeId]) as { effect: string } | undefined;
  if (rule) return rule.effect === 'allow';

  // Ein Query statt "Allowlist laden, dann Rollen laden": der LEFT JOIN auf die
  // Rollen der Person liefert Umfang und Treffer der Allowlist in einem Zug.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS listed,
              COALESCE(SUM(CASE WHEN er.employee_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS matched
       FROM absence_type_roles atr
       LEFT JOIN employee_roles er ON er.role_id = atr.role_id AND er.employee_id = ?
       WHERE atr.type_id = ?`,
    )
    .get([employeeId, typeId]) as { listed: number; matched: number };
  return row.listed === 0 || row.matched > 0;
}

/**
 * Wirft 403, wenn die Person diese Abwesenheitsart nicht beantragen darf.
 * `self` unterscheidet die Anrede: Wer fuer sich selbst beantragt (Portal),
 * liest "fuer Sie"; die HR-Erfassung fuer eine andere Person liest den Namen,
 * sonst suchte die Sachbearbeitung den Fehler bei sich selbst.
 */
export function assertTypeAllowed(employeeId: number, type: AbsenceTypeRow, self = true): void {
  if (isTypeAllowed(employeeId, type.id, type.category)) return;
  if (self) {
    throw forbidden(
      `Die Abwesenheitsart „${type.name}“ ist für Sie nicht freigegeben. Bitte wenden Sie sich an die Personalabteilung.`,
    );
  }
  const emp = getDb()
    .prepare('SELECT first_name, last_name FROM employees WHERE id = ?')
    .get(employeeId) as { first_name: string; last_name: string } | undefined;
  const name = emp ? `${emp.first_name} ${emp.last_name}` : 'diese Person';
  throw forbidden(
    `Die Abwesenheitsart „${type.name}“ ist für ${name} nicht freigegeben. Die Berechtigung lässt sich unter Abwesenheitsarten anpassen.`,
  );
}

/**
 * Rechnet `days_counted` und `closure_covered` der offenen und genehmigten
 * Antraege neu, die den
 * Zeitraum ueberlappen. Aufgerufen nach Anlegen oder Loeschen einer
 * Betriebsruhe, weil die gespeicherte Tageszahl sonst den alten Kalender
 * abbildet: Saldo, Jahresobergrenze und Listen laesen dann verschiedene
 * Wahrheiten. Gehoert in dieselbe Transaktion wie die Betriebsruhe-Aenderung.
 * Abgelehnte und stornierte Antraege bleiben als Historie unangetastet, mit
 * EINER Ausnahme: Stehen sie wegen einer Betriebsruhe auf 0
 * (`closure_covered = 1`), werden sie mitgerechnet. Sonst zeigte ein Antrag,
 * der in der Betriebsruhe auf 0 fiel und danach abgelehnt wurde, nach dem
 * Loeschen der Betriebsruhe dauerhaft 0 statt der beantragten Tage. Eine
 * nachtraeglich angelegte Betriebsruhe schreibt dagegen keine
 * abgeschlossene Entscheidung um.
 * Liefert die IDs der geaenderten Antraege (fuer Audit und Rueckmeldung).
 */
export function recountRequestsOverlapping(from: string, to: string): number[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RECOUNT_COLUMNS}
       FROM absence_requests
       WHERE (status IN ('beantragt', 'genehmigt') OR closure_covered = 1)
         AND days_manual = 0
         AND date_from <= ? AND date_to >= ?`,
    )
    .all([to, from]) as RecountRow[];
  return recountRows(rows);
}

/**
 * Zählt die noch nicht begonnenen offenen und genehmigten Anträge dieser
 * Personen neu. Aufzurufen, wenn sich ihre Arbeitswoche oder ihr Ort
 * (Standort, dessen Region, Firmenvorgabe) ändert: Der Saldo liest die
 * gespeicherten Tage (`requestDaysIn`), ein Antrag für den nächsten Monat
 * gilt so schon nach der neuen Woche. Begonnene und vergangene Anträge
 * bleiben, wie sie gezählt wurden, sonst änderte eine neue Arbeitswoche
 * rückwirkend genommene Tage und den Übertrag. Tage von Hand bleiben stehen,
 * solange die Woche flexibel ist; bei festen Tagen gibt es sie nicht, der
 * Antrag wird gezählt und verliert die Kennzeichnung. Gehört in dieselbe
 * Transaktion wie die Änderung; liefert die IDs der geänderten Anträge.
 * Jede Schreibstelle für Woche oder Ort ruft das (statisch geprüft:
 * src/test/placeChangeCheck.ts).
 */
export function recountUpcomingRequests(employeeIds: readonly number[] | 'all', today = todayIso()): number[] {
  if (employeeIds !== 'all' && employeeIds.length === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT ${RECOUNT_COLUMNS}, days_manual
       FROM absence_requests
       WHERE status IN ('beantragt', 'genehmigt') AND date_from > ?
         ${employeeIds === 'all' ? '' : 'AND employee_id IN (SELECT value FROM json_each(?))'}`,
    )
    .all(employeeIds === 'all' ? [today] : [today, JSON.stringify(employeeIds)]) as RecountRow[];
  return recountRows(rows);
}

/**
 * Spalten einer Person, von denen die Zählung ihrer Anträge abhängt (Woche,
 * Standort und damit Feiertage). Wer sie schreibt, ruft
 * `recountUpcomingRequests`.
 */
export const COUNTING_EMPLOYEE_COLUMNS = ['work_weekdays', 'work_days_per_week', 'location_id'] as const;

/**
 * Feiertage sind Code (core/holidays.ts). Ändert ein Update die Regeln,
 * zählt der Start des Moduls die noch nicht begonnenen Anträge neu, denn der
 * Saldo liest die gespeicherten Tage. Erkannt am Fingerabdruck der Feiertage
 * aller Länder und Regionen für dieses und die nächsten zwei Jahre (Tabelle
 * `_holiday_rules_state`, Migration 208); dass ein Jahreswechsel das Fenster
 * verschiebt und einmal mehr zählt, ist harmlos. Liefert die geänderten
 * Anträge; ein Protokolleintrag ohne Konto nennt sie.
 */
export function recountAfterHolidayRuleChange(today = todayIso()): number[] {
  const year = Number(today.slice(0, 4));
  const parts: string[] = [];
  for (const country of COUNTRY_CODES) {
    const regions = regionCodesFor(country);
    for (const region of regions.length ? regions : ['']) {
      for (let y = year; y <= year + 2; y++) {
        parts.push(`${country}|${region}|${y}|${holidaysForYear(y, country, region).map((h) => h.date).join(',')}`);
      }
    }
  }
  const fingerprint = createHash('sha256').update(parts.join('\n')).digest('hex');
  const db = getDb();
  return inTransaction(() => {
    const stored = db.prepare('SELECT fingerprint FROM _holiday_rules_state WHERE id = 1').get() as
      | { fingerprint: string }
      | undefined;
    if (stored?.fingerprint === fingerprint) return [];
    const recounted = recountUpcomingRequests('all', today);
    db.prepare(
      `INSERT INTO _holiday_rules_state (id, fingerprint) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint`,
    ).run(fingerprint);
    if (recounted.length > 0) {
      auditSystem('absence_request.recount_holidays', 'absence_request', { recounted_requests: recounted });
    }
    return recounted;
  });
}

const RECOUNT_COLUMNS =
  'id, employee_id, date_from, date_to, half_day_start, half_day_end, days_counted, closure_covered';

interface RecountRow {
  id: number;
  employee_id: number;
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  days_counted: number;
  closure_covered: number;
  /** Nur bei recountUpcomingRequests geladen; 1 = Tage von Hand. */
  days_manual?: number;
}

function recountRows(rows: RecountRow[]): number[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const placeCache = new Map<number, EmployeeRegion>();
  const update = db.prepare(
    'UPDATE absence_requests SET days_counted = ?, closure_covered = ?, days_manual = 0 WHERE id = ?',
  );
  // Liegt ein Antrag vollstaendig in der Betriebsruhe, faellt er auf 0 Tage,
  // bleibt aber in seinem Status: Die Listen kennzeichnen ihn als „in
  // Betriebsruhe“. Bewusst KEINE Stornierung: Krankmeldungen muessen auch in
  // einer Betriebsruhe dokumentiert bleiben (AU, Entgeltfortzahlung, § 9
  // BUrlG), und das Loeschen einer versehentlich angelegten Betriebsruhe
  // rechnet die Tage wieder zurueck, was nach einer Stornierung nicht ginge.
  const changed: number[] = [];
  for (const r of rows) {
    let place = placeCache.get(r.employee_id);
    if (!place) placeCache.set(r.employee_id, (place = regionForEmployee(r.employee_id)));
    // Tage von Hand gibt es nur bei flexibler Woche (createRequest prueft das).
    const manual = r.days_manual === 1;
    if (manual && (place.schedule ?? DEFAULT_WORK_SCHEDULE).weekdays === null) continue;
    const opts: CountOptions = {
      place,
      dateFrom: r.date_from,
      dateTo: r.date_to,
      halfDayStart: r.half_day_start === 1,
      halfDayEnd: r.half_day_end === 1,
    };
    const days = countAbsenceDays(opts);
    const covered = closureCoveredFlag(days, opts);
    if (days === r.days_counted && covered === r.closure_covered && !manual) continue;
    update.run(days, covered, r.id);
    changed.push(r.id);
  }
  return changed;
}

/**
 * Dieselbe Auflösung mengenweise für Lesefilter (z. B. die Auswahlliste im
 * Portal). Bewusst drei Queries statt einer je Art, damit die Anzahl der
 * Abfragen nicht mit der Anzahl der Arten wächst.
 */
export function allowedTypeIdsFor(employeeId: number): Set<number> {
  const db = getDb();

  const types = db.prepare('SELECT id, category FROM absence_types').all() as {
    id: number;
    category: string;
  }[];

  const rules = db
    .prepare('SELECT type_id, effect FROM absence_type_employee_rules WHERE employee_id = ?')
    .all(employeeId) as { type_id: number; effect: string }[];
  const ruleByType = new Map(rules.map((r) => [r.type_id, r.effect]));

  const listRows = db
    .prepare(
      `SELECT atr.type_id,
              MAX(CASE WHEN er.employee_id IS NOT NULL THEN 1 ELSE 0 END) AS matched
       FROM absence_type_roles atr
       LEFT JOIN employee_roles er ON er.role_id = atr.role_id AND er.employee_id = ?
       GROUP BY atr.type_id`,
    )
    .all(employeeId) as { type_id: number; matched: number }[];
  const matchedByType = new Map(listRows.map((r) => [r.type_id, r.matched]));

  const allowed = new Set<number>();
  for (const t of types) {
    if (t.category === 'krankheit') {
      allowed.add(t.id);
      continue;
    }
    const rule = ruleByType.get(t.id);
    if (rule) {
      if (rule === 'allow') allowed.add(t.id);
      continue;
    }
    const matched = matchedByType.get(t.id);
    // Keine Zeile in der Allowlist ⇒ die Art ist für alle offen.
    if (matched === undefined || matched === 1) allowed.add(t.id);
  }
  return allowed;
}

/**
 * Obergrenze der Spanne je Antrag/Vorschau in der HR-Erfassung. Schutz des
 * synchronen Backends vor absurden Zeiträumen (ein Jahres-Tippfehler wie
 * "20260" reicht, um die tageweise Zählung minutenlang laufen zu lassen und
 * damit ALLE parallelen Requests zu blockieren). Großzügiger als die
 * 731-Tage-Grenze des Portals, damit lange Elternzeit-Ketten erfassbar bleiben.
 */
const MAX_REQUEST_SPAN_DAYS = 5 * 366;

export function assertSpanWithinLimit(dateFrom: string, dateTo: string): void {
  const span =
    Math.round(
      (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  if (span > MAX_REQUEST_SPAN_DAYS) {
    throw badRequest('Der Zeitraum ist zu lang (maximal 5 Jahre)');
  }
}

/**
 * Kontingentprüfung: Der Antrag darf den Restanspruch keines betroffenen
 * Kalenderjahres ins Minus ziehen (jahresübergreifend wird je Jahr geclippt
 * gezählt). computeBalance rechnet bereits beantragte Tage als geplant ein —
 * der neue Antrag kommt obendrauf. Kategorie 'krankheit' ist ausgenommen:
 * Krankmeldungen dürfen nie an einer Saldoprüfung scheitern.
 *
 * `excludeRequestId` dient der Neuprüfung bei der Genehmigung (der Saldo kann
 * sich seit Antragstellung geändert haben): Der zu genehmigende Antrag steckt
 * als 'beantragt' schon in der Planung und zählte sonst doppelt.
 *
 * `pre` reicht bereits geladene Werte des Aufrufers weiter (createRequest hat
 * Bundesland und Zeitraum-Betriebsruhe ohnehin in der Hand) — sonst wird
 * selbst geladen.
 */
export function assertBalanceCovers(
  employeeId: number,
  type: AbsenceTypeRow,
  span: {
    date_from: string;
    date_to: string;
    half_day_start?: boolean;
    half_day_end?: boolean;
    /** Arbeitstage von Hand (flexible Woche); gilt für den ganzen Zeitraum. */
    days_override?: number | null;
  },
  excludeRequestId?: number,
  pre?: { place?: EmployeeRegion; closures?: Set<string> },
): void {
  if (type.affects_balance !== 1 || type.category === 'krankheit') return;
  const db = getDb();
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as
    | EmployeeRow
    | undefined;
  if (!emp) return; // Existenz haben die Routen bereits geprüft
  const fromYear = Number(span.date_from.slice(0, 4));
  const toYear = Number(span.date_to.slice(0, 4));
  const today = todayIso();

  // Den vollständigen Rechen-Kontext EINMAL vor dem Jahres-Loop aufbauen:
  // ohne ihn lüde computeBalance je geprüftem Jahr Bundesland, Verfalls-
  // stichtag, Betriebsruhe und Anträge der gesamten Übertrags-Kette erneut.
  // Betriebsruhe und Anträge sind ein Superset über alle geprüften Jahre samt
  // maximaler Übertrags-Kette (computeBalance geht höchstens 5 Jahre zurück);
  // überzählige Tage/Zeilen clippen sich dort zu 0.
  const place = pre?.place ?? regionForEmployee(employeeId);
  const chainFrom = `${fromYear - 5}-01-01`;
  const chainTo = `${toYear}-12-31`;
  const requestParams: unknown[] = [employeeId, chainTo, chainFrom];
  let requestSql = `SELECT r.date_from, r.date_to, r.half_day_start, r.half_day_end, r.status,
              r.days_counted
       FROM absence_requests r
       JOIN absence_types t ON t.id = r.type_id
       WHERE r.employee_id = ? AND t.affects_balance = 1
         AND r.status IN ('genehmigt', 'beantragt')
         AND r.date_from <= ? AND r.date_to >= ?`;
  if (excludeRequestId !== undefined) {
    requestSql += ' AND r.id != ?';
    requestParams.push(excludeRequestId);
  }
  const requests = db.prepare(requestSql).all(requestParams) as BalanceRequestRow[];
  const chainClosures = closuresCovering([...requests, span], chainFrom, chainTo);
  const ctx: BalanceContext = {
    place,
    carryoverDeadline: getSetting('carryoverDeadline'),
    closures: chainClosures,
    requests,
    contracts: contractPeriodsOf(employeeId),
  };
  // Betriebsruhe des Antragszeitraums selbst: vom Aufrufer übernommen, sonst
  // deckt das Ketten-Superset sie mit ab (countAbsenceDays fragt nur `has`).
  const spanClosures = pre?.closures ?? chainClosures;

  for (let y = fromYear; y <= toYear; y++) {
    const requested = requestDaysIn(
      {
        date_from: span.date_from,
        date_to: span.date_to,
        half_day_start: span.half_day_start ? 1 : 0,
        half_day_end: span.half_day_end ? 1 : 0,
        ...(span.days_override != null ? { days_counted: span.days_override } : {}),
      },
      { place, clipFrom: `${y}-01-01`, clipTo: `${y}-12-31`, closures: spanClosures },
    );
    if (requested <= 0) continue;
    const balance = computeBalance(emp, y, today, ctx);
    if (balance.remaining - requested < 0) {
      throw new AppError(
        409,
        'BALANCE_EXCEEDED',
        `Der Urlaubsanspruch für ${y} reicht nicht aus (Restanspruch: ${balance.remaining} Tage, beantragt: ${requested} Tage)`,
        { year: y, remaining: balance.remaining, requested_days: requested },
      );
    }
  }
}

export interface CreateRequestBody {
  employee_id: number;
  type_id: number;
  date_from: string;
  date_to: string;
  half_day_start?: boolean;
  half_day_end?: boolean;
  comment?: string;
  /**
   * Überspringt die Saldoprüfung (BALANCE_EXCEEDED) — nur die HR-Erfassung
   * reicht das Feld durch, das Portal nimmt es bewusst nicht an. Die
   * Übersteuerung landet im Audit-Detail.
   */
  override_balance?: boolean;
  /**
   * Arbeitstage von Hand bei flexibler Arbeitswoche (keine festen Tage): wie
   * viele ihrer Arbeitstage im Zeitraum liegen. Höchstens die Werktage Mo bis Fr
   * des Zeitraums; bei fester Woche abgewiesen, dort zählt der Kalender.
   */
  days_override?: number | null;
  /**
   * Erfasst und genehmigt in einem Schritt (nachträgliche Erfassung durch die
   * HR: vergessener Antrag, Person ohne Portalzugang). Nur die HR-Erfassung
   * reicht das Feld durch; das Vier-Augen-Prinzip gilt wie beim Genehmigen,
   * die eigene Abwesenheit bleibt ausgenommen.
   */
  approve?: boolean;
}

/**
 * Legt einen Antrag an (gemeinsam für HR-Erfassung, Krankmeldungen und den
 * Self-Service des Web-Portals): Überlappungsprüfung, Tageszählung,
 * Jahres-Obergrenze der Art, Saldoprüfung (nur bei Auto-Genehmigung, s. u.),
 * Auto-Genehmigung bei Arten ohne Genehmigungspflicht oder auf Wunsch der HR.
 */
/**
 * Vier-Augen-Prinzip: Wer selbst die betroffene Person ist, entscheidet nicht
 * über die eigene Abwesenheit. Ein Konto ohne Personalprofil ist nie betroffen.
 */
export function assertNotOwnEmployee(
  req: Parameters<typeof audit>[0],
  employeeId: number,
  message: string,
): void {
  const actorEmployeeId = (req.user as { employee_id?: number | null } | undefined)?.employee_id ?? null;
  // Regel gemeinsam mit der Anzeige im Dashboard (shared/fourEyes.ts).
  if (isOwnPersonDecision(actorEmployeeId, employeeId)) throw forbidden(message);
}

/**
 * Kundenausgabe dronivo (PORTAL_ABSENCE_CAPTURE, packages/shared/src/dronivo.ts):
 * Im Portal erfasst niemand Abwesenheiten. Geprueft in createRequest, dem einen
 * Punkt, durch den jede Neuanlage laeuft, an der Route der Anfrage: /api/me/*
 * ist das Portal, die HR-Erfassung (/api/absences/*) bleibt offen. So trifft die
 * Sperre auch einen Portalweg, den ein Merge von main unter neuem Pfad oder
 * ueber eine Hilfsfunktion bringt. Der globale Hook in server.ts sperrt
 * zusaetzlich jede schreibende Portalroute ausser den geprueften
 * (PORTAL_OPEN_WRITES), also auch den Rueckzug, der createRequest nicht
 * durchlaeuft.
 */
export function assertNoPortalCapture(req: Parameters<typeof audit>[0]): void {
  const route = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? '';
  if (!PORTAL_ABSENCE_CAPTURE && route.startsWith('/api/me/')) {
    throw forbidden('Dieser Bereich ist der HR-Administration vorbehalten');
  }
}

/** Herkunft eines Antrags: 1, wenn das anlegende Konto nicht der betroffenen Person gehoert. */
export const CREATED_BY_PROXY_SQL = `
  CASE WHEN c.id IS NOT NULL AND (c.employee_id IS NULL OR c.employee_id != r.employee_id) THEN 1 ELSE 0 END
    AS created_by_proxy`;

export function createRequest(
  req: Parameters<typeof audit>[0],
  body: CreateRequestBody,
  type: AbsenceTypeRow,
): number {
  assertNoPortalCapture(req); // PORTAL_ABSENCE_CAPTURE (Kundenausgabe dronivo)
  const db = getDb();
  // Die Berechtigungsprüfung sitzt hier und nicht in den Routen, weil
  // createRequest der einzige gemeinsame Engpass aller vier Erfassungswege ist
  // (HR-Erfassung, HR-Krankmeldung, Portal-Antrag, Portal-Krankmeldung). In den
  // Routen müsste dieselbe Prüfung viermal stehen und würde bei einem fünften
  // Weg vergessen. Geprüft wird ausschließlich die Neuanlage: bestehende
  // Anträge bleiben gültig, wenn eine Berechtigung später entzogen wird.
  const actorEmployeeId =
    (req.user as { employee_id?: number | null } | undefined)?.employee_id ?? null;
  assertTypeAllowed(body.employee_id, type, actorEmployeeId === body.employee_id);
  assertSpanWithinLimit(body.date_from, body.date_to);

  // Ein "halber Tag am Ende" eines eintägigen Antrags IST der halbe Tag am
  // Beginn — ohne Normalisierung zöge countAbsenceDays nichts ab (der
  // End-Abzug greift nur bei date_to !== date_from) und der gewollte Halbtag
  // würde still als voller Tag gezählt und persistiert.
  if (body.date_from === body.date_to && body.half_day_end) {
    body = { ...body, half_day_start: true, half_day_end: false };
  }

  // Prüfen und Schreiben in EINER Transaktion. Heute schützt bereits die
  // Ein-Prozess-Synchronität (kein await zwischen Prüfung und INSERT) vor
  // verschränkten Anträgen — die Transaktion sichert genau diese Invariante
  // ab, damit ein später eingeschobenes await oder ein zweiter Prozess auf
  // derselben DB keine stillen Doppelbuchungen ermöglicht. Die
  // Krankmeldungs-Routen verschachteln das (better-sqlite3 nutzt Savepoints).
  return inTransaction(() => {
    const overlapping = db
      .prepare(
        `SELECT r.id, r.date_from, r.date_to, t.name AS type_name, t.category AS type_category
         FROM absence_requests r
         JOIN absence_types t ON t.id = r.type_id
         WHERE r.employee_id = ? AND r.status IN ('beantragt', 'genehmigt')
           AND r.date_from <= ? AND r.date_to >= ?`,
      )
      .all([body.employee_id, body.date_to, body.date_from]) as {
      id: number;
      date_from: string;
      date_to: string;
      type_name: string;
      type_category: string;
    }[];
    // „Krank im Urlaub" (§ 9 BUrlG): Eine Krankmeldung muss sich mit Urlaub
    // oder Sonderabwesenheit überschneiden dürfen, sonst wäre der Fall gar
    // nicht erfassbar. Der überlappte Urlaub wird bewusst NICHT automatisch
    // gekürzt oder geteilt — die Gutschrift nach § 9 BUrlG setzt die Prüfung
    // der AU-Bescheinigung voraus und bleibt eine Entscheidung der HR; die
    // überlappten Anträge stehen dafür im Audit-Detail. Zwei Krankheits-
    // Zeiträume schließen sich weiterhin aus (Folgebescheinigungen laufen
    // über follow_up_of_id).
    const sick = type.category === 'krankheit';
    const blocking = sick
      ? overlapping.filter((o) => o.type_category === 'krankheit')
      : overlapping;
    if (blocking.length > 0) {
      const o = blocking[0];
      throw conflict(
        `Überschneidung mit bestehender Abwesenheit (${o.type_name}, ${o.date_from} bis ${o.date_to})`,
      );
    }
    const overlapped = sick ? overlapping : [];

    const place = regionForEmployee(body.employee_id);
    const closures = closureDates(body.date_from, body.date_to);
    const countOpts: CountOptions = {
      place,
      dateFrom: body.date_from,
      dateTo: body.date_to,
      halfDayStart: body.half_day_start,
      halfDayEnd: body.half_day_end,
      closures,
    };
    let days = countAbsenceDays(countOpts);
    const manual = body.days_override !== undefined && body.days_override !== null;
    if (manual) {
      if (place.schedule?.weekdays !== null) {
        throw badRequest('Arbeitstage lassen sich nur bei einer flexiblen Arbeitswoche ohne feste Tage angeben');
      }
      const weekdays = countWeekdays(countOpts);
      const value = body.days_override!;
      if (!(value > 0) || value > weekdays || Math.round(value * 2) !== value * 2) {
        throw badRequest(
          `Die Arbeitstage müssen zwischen 0,5 und ${String(weekdays).replace('.', ',')} liegen (Werktage im Zeitraum), in halben Tagen`,
        );
      }
      days = value;
    }
    // Krankmeldungen sind auch ohne zu zaehlenden Arbeitstag zu erfassen (etwa
    // vollstaendig in einer Betriebsruhe oder am Wochenende): AU-Frist,
    // Bescheinigung und Kette der Entgeltfortzahlung haengen am Kalender, nicht
    // an days_counted. Alle anderen Arten waeren ein Antrag auf nichts.
    if (days <= 0 && !sick) {
      throw badRequest('Der Zeitraum enthält keine zu zählenden Arbeitstage (Wochenende, Feiertage oder Betriebsruhe)');
    }

    if (type.max_days_per_year !== null) {
      // Jahreszuordnung über das Startdatum des Antrags (bewusste Vereinfachung).
      const year = body.date_from.slice(0, 4);
      const usedRow = db
        .prepare(
          `SELECT COALESCE(SUM(days_counted), 0) AS used FROM absence_requests
           WHERE employee_id = ? AND type_id = ? AND status IN ('beantragt', 'genehmigt')
             AND substr(date_from, 1, 4) = ?`,
        )
        .get([body.employee_id, body.type_id, year]) as { used: number };
      if (usedRow.used + days > type.max_days_per_year) {
        throw conflict(
          `Jahresobergrenze für "${type.name}" überschritten (maximal ${type.max_days_per_year} Tage, bereits ${usedRow.used} erfasst)`,
        );
      }
    }

    // Saldoprüfung nur bei Auto-Genehmigung: Ein genehmigungspflichtiger
    // Antrag ist zunächst nur ein Wunsch — dort passiert die Saldo-Kontrolle
    // bei der Genehmigung (der approve-Handler in routes.ts prüft erneut).
    // Griffe sie schon hier, könnte niemand mit einem offenen Antrag einen
    // Alternativ-Zeitraum einreichen, weil 'beantragt' im Saldo bereits als
    // geplant zählt.
    const userId = (req.user as { id?: number } | undefined)?.id ?? null;
    if (body.approve) {
      assertNotOwnEmployee(
        req,
        body.employee_id,
        'Eigene Abwesenheiten dürfen nicht selbst genehmigt werden. Erfassen Sie den Antrag ohne Genehmigung und lassen Sie ihn von einer anderen Person der HR-Administration prüfen.',
      );
    }
    const autoApprove = type.requires_approval === 0 || body.approve === true;
    if (autoApprove && !body.override_balance) {
      assertBalanceCovers(body.employee_id, type, { ...body, days_override: manual ? days : null }, undefined, {
        place,
        closures,
      });
    }
    const result = db
      .prepare(
        `INSERT INTO absence_requests
         (employee_id, type_id, date_from, date_to, half_day_start, half_day_end, days_counted,
          days_manual, closure_covered, status, comment, decided_by_user_id, decided_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${autoApprove ? "datetime('now')" : 'NULL'}, ?)`,
      )
      .run(
        body.employee_id,
        body.type_id,
        body.date_from,
        body.date_to,
        body.half_day_start ? 1 : 0,
        body.half_day_end ? 1 : 0,
        days,
        manual ? 1 : 0,
        manual ? 0 : closureCoveredFlag(days, countOpts),
        autoApprove ? 'genehmigt' : 'beantragt',
        body.comment ?? null,
        autoApprove ? userId : null,
        userId,
      );
    const id = Number(result.lastInsertRowid);
    audit(req, 'create', 'absence_request', id, {
      employee_id: body.employee_id,
      type: type.name,
      date_from: body.date_from,
      date_to: body.date_to,
      days_counted: days,
      status: autoApprove ? 'genehmigt' : 'beantragt',
      ...(body.override_balance ? { override_balance: true } : {}),
      ...(body.approve ? { approved_on_create: true } : {}),
      ...(overlapped.length > 0
        ? {
            overlapped_requests: overlapped.map((o) => ({
              id: o.id,
              type: o.type_name,
              date_from: o.date_from,
              date_to: o.date_to,
            })),
          }
        : {}),
    });
    return id;
  });
}

/**
 * Krankmeldung, die eine neue nahtlos fortsetzt: die juengste nicht stornierte
 * derselben Person und derselben Art (Kind krank oder nicht), die genau am
 * Vortag von `dateFrom` endet; sonst null. Ohne diese Verkettung begaenne eine
 * neue AU-Kette, und die Entgeltfortzahlung (42 Kalendertage) zaehlte falsch.
 * Portal und HR-Erfassung (ohne ausdrueckliche Angabe) verketten ueber diese
 * eine Regel.
 */
export function seamlessPredecessorSickNoteId(employeeId: number, childSick: boolean, dateFrom: string): number | null {
  const previous = getDb()
    .prepare(
      `SELECT s.id FROM sick_notes s
       JOIN absence_requests r ON r.id = s.absence_request_id
       WHERE r.employee_id = ? AND r.status != 'storniert' AND s.child_sick = ?
         AND r.date_to = ?
       ORDER BY r.date_to DESC, s.id DESC LIMIT 1`,
    )
    .get([employeeId, childSick ? 1 : 0, addDaysIso(dateFrom, -1)]) as { id: number } | undefined;
  return previous?.id ?? null;
}
