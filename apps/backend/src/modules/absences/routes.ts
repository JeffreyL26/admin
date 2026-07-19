import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { addDaysIso, eachDay, isValidIsoDate, isWeekend, todayIso } from '../../core/dates.js';
import { holidaysForYear, type Bundesland } from '../../core/holidays.js';
import { getSetting } from '../../core/settings.js';
import {
  bundeslandForEmployee,
  closureDates,
  computeBalance,
  countAbsenceDays,
  type EmployeeRow,
} from './service.js';

/** Konflikt-Schwelle Kalender: > 50 % eines Teams gleichzeitig abwesend. */
const CONFLICT_THRESHOLD = 0.5;

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Datum muss im Format YYYY-MM-DD vorliegen' });

const typeBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich'),
  category: z.enum(['urlaub', 'krankheit', 'sonder']),
  paid: z.boolean(),
  affects_balance: z.boolean(),
  requires_proof: z.boolean(),
  requires_approval: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als Hex-Wert (#RRGGBB) angeben'),
  max_days_per_year: z.number().positive().nullable().optional(),
  active: z.boolean().optional(),
});

const requestBodySchema = z.object({
  employee_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  date_from: isoDate,
  date_to: isoDate,
  half_day_start: z.boolean().optional(),
  half_day_end: z.boolean().optional(),
  comment: z.string().trim().max(2000).optional(),
});

const sickNoteBodySchema = z.object({
  employee_id: z.number().int().positive(),
  date_from: isoDate,
  date_to: isoDate,
  child_sick: z.boolean().optional(),
  certificate_file_id: z.number().int().positive().nullable().optional(),
  received_date: isoDate.nullable().optional(),
  follow_up_of_id: z.number().int().positive().nullable().optional(),
  comment: z.string().trim().max(2000).optional(),
});

const closureBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich'),
  date_from: isoDate,
  date_to: isoDate,
});

interface TypeRow {
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

interface RequestRow {
  id: number;
  employee_id: number;
  type_id: number;
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  days_counted: number;
  status: string;
}

const REQUEST_SELECT = `
  SELECT r.*, e.first_name, e.last_name,
         t.name AS type_name, t.color AS type_color, t.category AS type_category
  FROM absence_requests r
  JOIN employees e ON e.id = r.employee_id
  JOIN absence_types t ON t.id = r.type_id`;

export const absencesModule: FastifyPluginAsync = async (app) => {
  const db = () => getDb();

  // ---------------------------------------------------------------- Arten ---
  app.get('/api/absences/types', async () => ({
    types: db().prepare('SELECT * FROM absence_types ORDER BY active DESC, category, name').all(),
  }));

  app.post('/api/absences/types', async (req, reply) => {
    const body = parse(typeBodySchema, req.body);
    const result = db()
      .prepare(
        `INSERT INTO absence_types
         (name, category, paid, affects_balance, requires_proof, requires_approval, color, max_days_per_year, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.category,
        body.paid ? 1 : 0,
        body.affects_balance ? 1 : 0,
        body.requires_proof ? 1 : 0,
        body.requires_approval ? 1 : 0,
        body.color,
        body.max_days_per_year ?? null,
        body.active === false ? 0 : 1,
      );
    const id = Number(result.lastInsertRowid);
    audit(req, 'create', 'absence_type', id, body);
    reply.status(201);
    return { type: db().prepare('SELECT * FROM absence_types WHERE id = ?').get(id) };
  });

  app.put('/api/absences/types/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT * FROM absence_types WHERE id = ?').get(id);
    if (!existing) throw notFound('Abwesenheitsart nicht gefunden');
    const body = parse(typeBodySchema, req.body);
    db()
      .prepare(
        `UPDATE absence_types SET name = ?, category = ?, paid = ?, affects_balance = ?,
         requires_proof = ?, requires_approval = ?, color = ?, max_days_per_year = ?, active = ?
         WHERE id = ?`,
      )
      .run(
        body.name,
        body.category,
        body.paid ? 1 : 0,
        body.affects_balance ? 1 : 0,
        body.requires_proof ? 1 : 0,
        body.requires_approval ? 1 : 0,
        body.color,
        body.max_days_per_year ?? null,
        body.active === false ? 0 : 1,
        id,
      );
    audit(req, 'update', 'absence_type', id, body);
    return { type: db().prepare('SELECT * FROM absence_types WHERE id = ?').get(id) };
  });

  app.delete('/api/absences/types/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT * FROM absence_types WHERE id = ?').get(id) as
      | TypeRow
      | undefined;
    if (!existing) throw notFound('Abwesenheitsart nicht gefunden');
    const used = db()
      .prepare('SELECT COUNT(*) AS n FROM absence_requests WHERE type_id = ?')
      .get(id) as { n: number };
    if (used.n > 0) {
      throw conflict(
        `Die Art "${existing.name}" wird von ${used.n} Antrag/Anträgen verwendet und kann nicht gelöscht werden. Deaktivieren Sie sie stattdessen.`,
      );
    }
    db().prepare('DELETE FROM absence_types WHERE id = ?').run(id);
    audit(req, 'delete', 'absence_type', id, { name: existing.name });
    reply.status(204);
  });

  // -------------------------------------------------------------- Anträge ---
  app.get('/api/absences/requests', async (req) => {
    const q = req.query as {
      status?: string;
      type_id?: string;
      employee_id?: string;
      from?: string;
      to?: string;
    };
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) {
      where.push('r.status = ?');
      params.push(q.status);
    }
    if (q.type_id) {
      where.push('r.type_id = ?');
      params.push(Number(q.type_id));
    }
    if (q.employee_id) {
      where.push('r.employee_id = ?');
      params.push(Number(q.employee_id));
    }
    if (q.from && isValidIsoDate(q.from)) {
      where.push('r.date_to >= ?');
      params.push(q.from);
    }
    if (q.to && isValidIsoDate(q.to)) {
      where.push('r.date_from <= ?');
      params.push(q.to);
    }
    const sql = `${REQUEST_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.date_from DESC, r.id DESC`;
    return { requests: db().prepare(sql).all(...params) };
  });

  /** Live-Vorschau der gezählten Tage für das Antragsformular. */
  app.get('/api/absences/preview', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const employeeId = Number(q.employee_id);
    if (!employeeId || !q.date_from || !q.date_to || !isValidIsoDate(q.date_from) || !isValidIsoDate(q.date_to)) {
      throw badRequest('employee_id, date_from und date_to sind erforderlich');
    }
    if (q.date_to < q.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    const land = bundeslandForEmployee(employeeId);
    const days = countAbsenceDays({
      land,
      dateFrom: q.date_from,
      dateTo: q.date_to,
      halfDayStart: q.half_day_start === '1' || q.half_day_start === 'true',
      halfDayEnd: q.half_day_end === '1' || q.half_day_end === 'true',
    });
    return { days_counted: days, bundesland: land };
  });

  app.post('/api/absences/requests', async (req, reply) => {
    const body = parse(requestBodySchema, req.body);
    if (body.date_to < body.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    if (body.date_from === body.date_to && body.half_day_start && body.half_day_end) {
      throw badRequest('Bei einem eintägigen Zeitraum kann nur ein halber Tag gewählt werden');
    }
    const employee = db()
      .prepare("SELECT * FROM employees WHERE id = ?")
      .get(body.employee_id) as EmployeeRow | undefined;
    if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
    const type = db().prepare('SELECT * FROM absence_types WHERE id = ?').get(body.type_id) as
      | TypeRow
      | undefined;
    if (!type) throw notFound('Abwesenheitsart nicht gefunden');
    if (!type.active) throw badRequest('Diese Abwesenheitsart ist deaktiviert');

    const id = createRequest(req, body, employee, type);
    reply.status(201);
    return { request: db().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  app.post('/api/absences/requests/:id/approve', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const row = db().prepare('SELECT * FROM absence_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    if (!row) throw notFound('Antrag nicht gefunden');
    if (row.status !== 'beantragt') {
      throw conflict(`Nur beantragte Anträge können genehmigt werden (Status: ${row.status})`);
    }
    const userId = (req.user as { id?: number }).id ?? null;
    db()
      .prepare(
        `UPDATE absence_requests SET status = 'genehmigt', decided_by_user_id = ?, decided_at = datetime('now')
         WHERE id = ?`,
      )
      .run(userId, id);
    audit(req, 'approve', 'absence_request', id);
    return { request: db().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  app.post('/api/absences/requests/:id/reject', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(
      z.object({ reason: z.string().trim().min(3, 'Eine Begründung ist bei Ablehnung erforderlich') }),
      req.body,
    );
    const row = db().prepare('SELECT * FROM absence_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    if (!row) throw notFound('Antrag nicht gefunden');
    if (row.status !== 'beantragt') {
      throw conflict(`Nur beantragte Anträge können abgelehnt werden (Status: ${row.status})`);
    }
    const userId = (req.user as { id?: number }).id ?? null;
    db()
      .prepare(
        `UPDATE absence_requests SET status = 'abgelehnt', rejection_reason = ?,
         decided_by_user_id = ?, decided_at = datetime('now') WHERE id = ?`,
      )
      .run(body.reason, userId, id);
    audit(req, 'reject', 'absence_request', id, { reason: body.reason });
    return { request: db().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  app.post('/api/absences/requests/:id/cancel', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const row = db().prepare('SELECT * FROM absence_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    if (!row) throw notFound('Antrag nicht gefunden');
    if (row.status !== 'beantragt' && row.status !== 'genehmigt') {
      throw conflict(`Dieser Antrag kann nicht mehr storniert werden (Status: ${row.status})`);
    }
    const userId = (req.user as { id?: number }).id ?? null;
    db()
      .prepare(
        `UPDATE absence_requests SET status = 'storniert', decided_by_user_id = ?, decided_at = datetime('now')
         WHERE id = ?`,
      )
      .run(userId, id);
    audit(req, 'cancel', 'absence_request', id);
    return { request: db().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  // ---------------------------------------------------------------- Saldo ---
  app.get('/api/absences/balance/:employeeId/:year', async (req) => {
    const { employeeId, year } = req.params as { employeeId: string; year: string };
    const emp = db().prepare('SELECT * FROM employees WHERE id = ?').get(Number(employeeId)) as
      | EmployeeRow
      | undefined;
    if (!emp) throw notFound('Mitarbeiter:in nicht gefunden');
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Ungültiges Jahr');
    return { balance: computeBalance(emp, y) };
  });

  app.get('/api/absences/balances/:year', async (req) => {
    const y = Number((req.params as { year: string }).year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Ungültiges Jahr');
    const employees = db()
      .prepare("SELECT * FROM employees WHERE status = 'aktiv' ORDER BY last_name, first_name")
      .all() as EmployeeRow[];
    const balances = employees.map((e) => ({
      ...computeBalance(e, y),
      first_name: e.first_name,
      last_name: e.last_name,
    }));
    return { balances, carryover_deadline: `${y}-${getSetting('carryoverDeadline')}` };
  });

  // -------------------------------------------------------- Krankmeldungen ---
  const SICK_SELECT = `
    SELECT s.*, r.employee_id, r.date_from, r.date_to, r.days_counted, r.status AS request_status,
           e.first_name, e.last_name
    FROM sick_notes s
    JOIN absence_requests r ON r.id = s.absence_request_id
    JOIN employees e ON e.id = r.employee_id`;

  app.get('/api/absences/sick-notes', async (req) => {
    const q = req.query as { child_sick?: string; year?: string };
    const where: string[] = ["r.status != 'storniert'"];
    const params: unknown[] = [];
    if (q.child_sick === '1' || q.child_sick === 'true') where.push('s.child_sick = 1');
    if (q.child_sick === '0' || q.child_sick === 'false') where.push('s.child_sick = 0');
    if (q.year && /^\d{4}$/.test(q.year)) {
      where.push('r.date_from <= ? AND r.date_to >= ?');
      params.push(`${q.year}-12-31`, `${q.year}-01-01`);
    }
    const rows = db()
      .prepare(`${SICK_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.date_from DESC, s.id DESC`)
      .all(...params);
    return { sick_notes: rows };
  });

  /** AU-Bescheinigungen, deren Frist überschritten ist und die noch fehlen. */
  app.get('/api/absences/sick-notes/missing', async () => {
    const rows = db()
      .prepare(
        `${SICK_SELECT}
         WHERE r.status != 'storniert' AND s.certificate_file_id IS NULL
           AND s.certificate_due_date < ?
         ORDER BY s.certificate_due_date ASC`,
      )
      .all(todayIso());
    return { sick_notes: rows };
  });

  app.post('/api/absences/sick-notes', async (req, reply) => {
    const body = parse(sickNoteBodySchema, req.body);
    if (body.date_to < body.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    const employee = db().prepare('SELECT * FROM employees WHERE id = ?').get(body.employee_id) as
      | EmployeeRow
      | undefined;
    if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
    const typeName = body.child_sick ? 'Kind krank' : 'Krankheit';
    const type = db()
      .prepare("SELECT * FROM absence_types WHERE name = ? AND category = 'krankheit' AND active = 1")
      .get(typeName) as TypeRow | undefined;
    if (!type) throw badRequest(`Die Abwesenheitsart "${typeName}" ist nicht konfiguriert oder deaktiviert`);
    if (body.follow_up_of_id) {
      const parent = db().prepare('SELECT id FROM sick_notes WHERE id = ?').get(body.follow_up_of_id);
      if (!parent) throw badRequest('Die referenzierte Erstbescheinigung existiert nicht');
    }
    if (body.received_date && !body.certificate_file_id) {
      throw badRequest('Ein Eingangsdatum erfordert eine hochgeladene Bescheinigung');
    }

    const sickNoteId = inTransaction(() => {
      const requestId = createRequest(
        req,
        {
          employee_id: body.employee_id,
          type_id: type.id,
          date_from: body.date_from,
          date_to: body.date_to,
          comment: body.comment,
        },
        employee,
        type,
      );
      const result = db()
        .prepare(
          `INSERT INTO sick_notes
           (absence_request_id, certificate_file_id, certificate_due_date, received_date, follow_up_of_id, child_sick)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          body.certificate_file_id ?? null,
          // Ausstellungspflicht am 3. Kalendertag der Erkrankung.
          addDaysIso(body.date_from, 2),
          body.received_date ?? null,
          body.follow_up_of_id ?? null,
          body.child_sick ? 1 : 0,
        );
      return Number(result.lastInsertRowid);
    });
    audit(req, 'create', 'sick_note', sickNoteId, {
      employee_id: body.employee_id,
      date_from: body.date_from,
      date_to: body.date_to,
      child_sick: !!body.child_sick,
    });
    reply.status(201);
    return { sick_note: db().prepare(`${SICK_SELECT} WHERE s.id = ?`).get(sickNoteId) };
  });

  /** Nachtrag der AU-Bescheinigung (Upload + Eingangsdatum). */
  app.patch('/api/absences/sick-notes/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT * FROM sick_notes WHERE id = ?').get(id);
    if (!existing) throw notFound('Krankmeldung nicht gefunden');
    const body = parse(
      z.object({
        certificate_file_id: z.number().int().positive().nullable().optional(),
        received_date: isoDate.nullable().optional(),
      }),
      req.body,
    );
    if (body.certificate_file_id !== undefined) {
      db()
        .prepare('UPDATE sick_notes SET certificate_file_id = ? WHERE id = ?')
        .run(body.certificate_file_id, id);
    }
    if (body.received_date !== undefined) {
      db().prepare('UPDATE sick_notes SET received_date = ? WHERE id = ?').run(body.received_date, id);
    }
    audit(req, 'update', 'sick_note', id, body);
    return { sick_note: db().prepare(`${SICK_SELECT} WHERE s.id = ?`).get(id) };
  });

  // ---------------------------------------------------------- Betriebsruhe ---
  app.get('/api/absences/closures', async () => ({
    closures: db().prepare('SELECT * FROM company_closures ORDER BY date_from DESC').all(),
  }));

  app.post('/api/absences/closures', async (req, reply) => {
    const body = parse(closureBodySchema, req.body);
    if (body.date_to < body.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    const result = db()
      .prepare('INSERT INTO company_closures (name, date_from, date_to) VALUES (?, ?, ?)')
      .run(body.name, body.date_from, body.date_to);
    const id = Number(result.lastInsertRowid);
    audit(req, 'create', 'company_closure', id, body);
    reply.status(201);
    return { closure: db().prepare('SELECT * FROM company_closures WHERE id = ?').get(id) };
  });

  app.delete('/api/absences/closures/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT * FROM company_closures WHERE id = ?').get(id);
    if (!existing) throw notFound('Betriebsruhe nicht gefunden');
    db().prepare('DELETE FROM company_closures WHERE id = ?').run(id);
    audit(req, 'delete', 'company_closure', id, existing);
    reply.status(204);
  });

  // -------------------------------------------------------------- Kalender ---
  app.get('/api/absences/calendar', async (req) => {
    const q = req.query as {
      year?: string;
      month?: string;
      department_id?: string;
      team_id?: string;
    };
    const year = Number(q.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Ungültiges Jahr');
    let from = `${year}-01-01`;
    let to = `${year}-12-31`;
    if (q.month) {
      const month = Number(q.month);
      if (!Number.isInteger(month) || month < 1 || month > 12) throw badRequest('Ungültiger Monat');
      const mm = String(month).padStart(2, '0');
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      from = `${year}-${mm}-01`;
      to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
    }

    const empWhere: string[] = ["e.status = 'aktiv'"];
    const empParams: unknown[] = [];
    if (q.department_id) {
      empWhere.push('e.department_id = ?');
      empParams.push(Number(q.department_id));
    }
    if (q.team_id) {
      empWhere.push('e.team_id = ?');
      empParams.push(Number(q.team_id));
    }
    const defaultLand = getSetting('defaultBundesland');
    const employees = db()
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, e.department_id, e.team_id,
                COALESCE(l.bundesland, ?) AS bundesland
         FROM employees e
         LEFT JOIN locations l ON l.id = e.location_id
         WHERE ${empWhere.join(' AND ')}
         ORDER BY e.last_name, e.first_name`,
      )
      .all(defaultLand, ...empParams) as {
      id: number;
      first_name: string;
      last_name: string;
      department_id: number | null;
      team_id: number | null;
      bundesland: string;
    }[];

    const empIds = employees.map((e) => e.id);
    const absences =
      empIds.length === 0
        ? []
        : (db()
            .prepare(
              `SELECT r.id AS request_id, r.employee_id, r.type_id, t.name AS type_name,
                      t.color, r.status, r.date_from, r.date_to, r.half_day_start, r.half_day_end
               FROM absence_requests r
               JOIN absence_types t ON t.id = r.type_id
               WHERE r.status IN ('beantragt', 'genehmigt')
                 AND r.date_from <= ? AND r.date_to >= ?
                 AND r.employee_id IN (${empIds.map(() => '?').join(',')})
               ORDER BY r.date_from`,
            )
            .all(to, from, ...empIds) as {
            request_id: number;
            employee_id: number;
            type_id: number;
            type_name: string;
            color: string;
            status: string;
            date_from: string;
            date_to: string;
            half_day_start: number;
            half_day_end: number;
          }[]);

    // Feiertage je vorkommendem Bundesland, beschnitten auf den Zeitraum.
    const laender = [...new Set([...employees.map((e) => e.bundesland), defaultLand])];
    const holidays = Object.fromEntries(
      laender.map((land) => [
        land,
        holidaysForYear(year, land as Bundesland).filter((h) => h.date >= from && h.date <= to),
      ]),
    );

    const closures = db()
      .prepare('SELECT * FROM company_closures WHERE date_from <= ? AND date_to >= ? ORDER BY date_from')
      .all(to, from);

    // Konflikterkennung: pro Tag und Team der Anteil gleichzeitig Abwesender
    // (beantragt oder genehmigt); > CONFLICT_THRESHOLD (50 %) → Konflikt.
    // Teamgröße = alle aktiven Mitglieder des Teams (unabhängig vom Filter).
    const teamSizes = db()
      .prepare(
        "SELECT team_id, COUNT(*) AS n FROM employees WHERE status = 'aktiv' AND team_id IS NOT NULL GROUP BY team_id",
      )
      .all() as { team_id: number; n: number }[];
    const teamSizeMap = new Map(teamSizes.map((t) => [t.team_id, t.n]));
    const teamByEmployee = new Map(
      (db()
        .prepare("SELECT id, team_id FROM employees WHERE status = 'aktiv' AND team_id IS NOT NULL")
        .all() as { id: number; team_id: number }[]).map((e) => [e.id, e.team_id]),
    );
    // Alle relevanten Abwesenheiten (unabhängig vom Abteilungs-/Teamfilter),
    // damit Konflikte auch bei gefilterter Ansicht vollständig sind.
    const allAbsences = db()
      .prepare(
        `SELECT r.employee_id, r.date_from, r.date_to FROM absence_requests r
         JOIN employees e ON e.id = r.employee_id
         WHERE r.status IN ('beantragt', 'genehmigt') AND e.status = 'aktiv'
           AND e.team_id IS NOT NULL AND r.date_from <= ? AND r.date_to >= ?`,
      )
      .all(to, from) as { employee_id: number; date_from: string; date_to: string }[];
    const absentPerDayTeam = new Map<string, Set<number>>();
    for (const a of allAbsences) {
      const teamId = teamByEmployee.get(a.employee_id);
      if (teamId === undefined) continue;
      const start = a.date_from > from ? a.date_from : from;
      const end = a.date_to < to ? a.date_to : to;
      for (const d of eachDay(start, end)) {
        if (isWeekend(d)) continue;
        const key = `${d}|${teamId}`;
        let set = absentPerDayTeam.get(key);
        if (!set) absentPerDayTeam.set(key, (set = new Set()));
        set.add(a.employee_id);
      }
    }
    const conflicts = [...absentPerDayTeam.entries()]
      .map(([key, set]) => {
        const [date, teamIdStr] = key.split('|');
        const teamId = Number(teamIdStr);
        const size = teamSizeMap.get(teamId) ?? 0;
        return { date, team_id: teamId, absent: set.size, team_size: size, ratio: size ? set.size / size : 0 };
      })
      .filter((c) => c.team_size > 1 && c.ratio > CONFLICT_THRESHOLD)
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      range: { from, to },
      employees: employees.map((e) => ({
        ...e,
        absences: absences.filter((a) => a.employee_id === e.id),
      })),
      holidays,
      closures,
      conflicts,
    };
  });

  // ------------------------------------------------------------------------
  /**
   * Legt einen Antrag an (gemeinsam für Anträge und Krankmeldungen):
   * Überlappungsprüfung, Tageszählung, Jahres-Obergrenze der Art,
   * Auto-Genehmigung bei Arten ohne Genehmigungspflicht.
   */
  function createRequest(
    req: Parameters<typeof audit>[0],
    body: {
      employee_id: number;
      type_id: number;
      date_from: string;
      date_to: string;
      half_day_start?: boolean;
      half_day_end?: boolean;
      comment?: string;
    },
    employee: EmployeeRow,
    type: TypeRow,
  ): number {
    const overlapping = db()
      .prepare(
        `SELECT r.id, r.date_from, r.date_to, t.name AS type_name FROM absence_requests r
         JOIN absence_types t ON t.id = r.type_id
         WHERE r.employee_id = ? AND r.status IN ('beantragt', 'genehmigt')
           AND r.date_from <= ? AND r.date_to >= ?`,
      )
      .get(body.employee_id, body.date_to, body.date_from) as
      | { id: number; date_from: string; date_to: string; type_name: string }
      | undefined;
    if (overlapping) {
      throw conflict(
        `Überschneidung mit bestehender Abwesenheit (${overlapping.type_name}, ${overlapping.date_from} bis ${overlapping.date_to})`,
      );
    }

    const land = bundeslandForEmployee(body.employee_id);
    const days = countAbsenceDays({
      land,
      dateFrom: body.date_from,
      dateTo: body.date_to,
      halfDayStart: body.half_day_start,
      halfDayEnd: body.half_day_end,
      closures: closureDates(body.date_from, body.date_to),
    });
    if (days <= 0) {
      throw badRequest('Der Zeitraum enthält keine zu zählenden Arbeitstage (Wochenende, Feiertage oder Betriebsruhe)');
    }

    if (type.max_days_per_year !== null) {
      // Jahreszuordnung über das Startdatum des Antrags (bewusste Vereinfachung).
      const year = body.date_from.slice(0, 4);
      const usedRow = db()
        .prepare(
          `SELECT COALESCE(SUM(days_counted), 0) AS used FROM absence_requests
           WHERE employee_id = ? AND type_id = ? AND status IN ('beantragt', 'genehmigt')
             AND substr(date_from, 1, 4) = ?`,
        )
        .get(body.employee_id, body.type_id, year) as { used: number };
      if (usedRow.used + days > type.max_days_per_year) {
        throw conflict(
          `Jahresobergrenze für "${type.name}" überschritten (maximal ${type.max_days_per_year} Tage, bereits ${usedRow.used} erfasst)`,
        );
      }
    }

    const userId = (req.user as { id?: number } | undefined)?.id ?? null;
    const autoApprove = type.requires_approval === 0;
    const result = db()
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
    });
    return id;
  }
};
