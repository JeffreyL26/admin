/**
 * Fachlogik des Abwesenheitsmanagements: Zählung von Abwesenheitstagen
 * (Arbeitstage Mo–Fr minus Feiertage des Mitarbeiter-Bundeslands minus
 * Betriebsruhe, halbe Tage an Randtagen) und Urlaubssaldo-Berechnung.
 */
import { getDb, inTransaction } from '../../db/db.js';
import { eachDay, isWeekend, todayIso } from '../../core/dates.js';
import { isHoliday, type Bundesland } from '../../core/holidays.js';
import { getSetting } from '../../core/settings.js';
import { AppError, badRequest, conflict, forbidden } from '../../core/errors.js';
import { audit } from '../../core/audit.js';

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

export interface BalanceRequestRow {
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  status: string;
}

/**
 * Vorgeladener Kontext für Sammel-Aufrufe (z. B. die Saldo-Übersicht über die
 * gesamte Belegschaft): erspart die Queries je Person, die den synchronen
 * Prozess sonst für alle parallelen Requests blockieren. `closures` und
 * `requests` dürfen ein Superset (größerer Zeitraum bzw. eigener Antrag
 * ausgenommen) sein — Zeiträume außerhalb der Jahresfenster zählen über das
 * Clipping als 0. Einzel-Aufrufe lassen den Kontext einfach weg.
 */
export interface BalanceContext {
  land?: Bundesland;
  /** Verfallsstichtag "MM-TT" (getSetting('carryoverDeadline')). */
  carryoverDeadline?: string;
  closures?: Set<string>;
  requests?: BalanceRequestRow[];
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
export function computeBalance(
  emp: EmployeeRow,
  year: number,
  today = todayIso(),
  ctx?: BalanceContext,
): BalanceResult {
  const db = getDb();
  const annual = emp.annual_leave_days ?? 0;
  const land = ctx?.land ?? bundeslandForEmployee(emp.id);
  const deadlineMmDd = ctx?.carryoverDeadline ?? getSetting('carryoverDeadline');

  const hireYear = emp.hire_date ? Number(emp.hire_date.slice(0, 4)) : null;
  const startYear = Math.max(hireYear ?? year - 1, year - 5);

  const spanFrom = `${startYear}-01-01`;
  const spanTo = `${year}-12-31`;
  const closures = ctx?.closures ?? closureDates(spanFrom, spanTo);

  const rows =
    ctx?.requests ??
    (db
      .prepare(
        `SELECT r.date_from, r.date_to, r.half_day_start, r.half_day_end, r.status
         FROM absence_requests r
         JOIN absence_types t ON t.id = r.type_id
         WHERE r.employee_id = ? AND t.affects_balance = 1
           AND r.status IN ('genehmigt', 'beantragt')
           AND r.date_from <= ? AND r.date_to >= ?`,
      )
      .all([emp.id, spanTo, spanFrom]) as BalanceRequestRow[]);

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

/** Wirft 403, wenn die Person diese Abwesenheitsart nicht beantragen darf. */
export function assertTypeAllowed(employeeId: number, type: AbsenceTypeRow): void {
  if (isTypeAllowed(employeeId, type.id, type.category)) return;
  throw forbidden(
    `Die Abwesenheitsart „${type.name}“ ist für Sie nicht freigegeben. Bitte wenden Sie sich an die Personalabteilung.`,
  );
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
  span: { date_from: string; date_to: string; half_day_start?: boolean; half_day_end?: boolean },
  excludeRequestId?: number,
  pre?: { land?: Bundesland; closures?: Set<string> },
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
  const land = pre?.land ?? bundeslandForEmployee(employeeId);
  const chainFrom = `${fromYear - 5}-01-01`;
  const chainTo = `${toYear}-12-31`;
  const chainClosures = closureDates(chainFrom, chainTo);
  const requestParams: unknown[] = [employeeId, chainTo, chainFrom];
  let requestSql = `SELECT r.date_from, r.date_to, r.half_day_start, r.half_day_end, r.status
       FROM absence_requests r
       JOIN absence_types t ON t.id = r.type_id
       WHERE r.employee_id = ? AND t.affects_balance = 1
         AND r.status IN ('genehmigt', 'beantragt')
         AND r.date_from <= ? AND r.date_to >= ?`;
  if (excludeRequestId !== undefined) {
    requestSql += ' AND r.id != ?';
    requestParams.push(excludeRequestId);
  }
  const ctx: BalanceContext = {
    land,
    carryoverDeadline: getSetting('carryoverDeadline'),
    closures: chainClosures,
    requests: db.prepare(requestSql).all(requestParams) as BalanceRequestRow[],
  };
  // Betriebsruhe des Antragszeitraums selbst: vom Aufrufer übernommen, sonst
  // deckt das Ketten-Superset sie mit ab (countAbsenceDays fragt nur `has`).
  const spanClosures = pre?.closures ?? chainClosures;

  for (let y = fromYear; y <= toYear; y++) {
    const requested = countAbsenceDays({
      land,
      dateFrom: span.date_from,
      dateTo: span.date_to,
      halfDayStart: span.half_day_start,
      halfDayEnd: span.half_day_end,
      clipFrom: `${y}-01-01`,
      clipTo: `${y}-12-31`,
      closures: spanClosures,
    });
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
}

/**
 * Legt einen Antrag an (gemeinsam für HR-Erfassung, Krankmeldungen und den
 * Self-Service des Web-Portals): Überlappungsprüfung, Tageszählung,
 * Jahres-Obergrenze der Art, Saldoprüfung (nur bei Auto-Genehmigung, s. u.),
 * Auto-Genehmigung bei Arten ohne Genehmigungspflicht.
 */
export function createRequest(
  req: Parameters<typeof audit>[0],
  body: CreateRequestBody,
  type: AbsenceTypeRow,
): number {
  const db = getDb();
  // Die Berechtigungsprüfung sitzt hier und nicht in den Routen, weil
  // createRequest der einzige gemeinsame Engpass aller vier Erfassungswege ist
  // (HR-Erfassung, HR-Krankmeldung, Portal-Antrag, Portal-Krankmeldung). In den
  // Routen müsste dieselbe Prüfung viermal stehen und würde bei einem fünften
  // Weg vergessen. Geprüft wird ausschließlich die Neuanlage: bestehende
  // Anträge bleiben gültig, wenn eine Berechtigung später entzogen wird.
  assertTypeAllowed(body.employee_id, type);
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

    const land = bundeslandForEmployee(body.employee_id);
    const closures = closureDates(body.date_from, body.date_to);
    const days = countAbsenceDays({
      land,
      dateFrom: body.date_from,
      dateTo: body.date_to,
      halfDayStart: body.half_day_start,
      halfDayEnd: body.half_day_end,
      closures,
    });
    if (days <= 0) {
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
    const autoApprove = type.requires_approval === 0;
    if (autoApprove && !body.override_balance) {
      assertBalanceCovers(body.employee_id, type, body, undefined, { land, closures });
    }

    const userId = (req.user as { id?: number } | undefined)?.id ?? null;
    const result = db
      .prepare(
        `INSERT INTO absence_requests
         (employee_id, type_id, date_from, date_to, half_day_start, half_day_end, days_counted,
          status, comment, decided_by_user_id, decided_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${autoApprove ? "datetime('now')" : 'NULL'}, ?)`,
      )
      .run(
        body.employee_id,
        body.type_id,
        body.date_from,
        body.date_to,
        body.half_day_start ? 1 : 0,
        body.half_day_end ? 1 : 0,
        days,
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
