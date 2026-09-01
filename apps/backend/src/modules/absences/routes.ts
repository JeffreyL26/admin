import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { addDaysIso, eachDay, isValidIsoDate, isWeekend, todayIso } from '../../core/dates.js';
import { holidaysForYear, type Bundesland } from '../../core/holidays.js';
import { getSetting } from '../../core/settings.js';
import {
  assertBalanceCovers,
  assertSpanWithinLimit,
  bundeslandForEmployee,
  closureDates,
  computeBalance,
  countAbsenceDays,
  createRequest,
  type AbsenceTypeRow as TypeRow,
  type BalanceRequestRow,
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
  // Sichtbarkeit im Firmenkalender des Portals. Fehlt das Feld, entscheidet
  // die Kategorie (siehe defaultPortalVisibility) — nicht pauschal 'name'.
  portal_visibility: z.enum(['name', 'neutral']).optional(),
});

/**
 * Vorgabe für die Portal-Sichtbarkeit, wenn der Client das Feld weglässt.
 *
 * SICHERHEITSENTSCHEIDUNG — bitte nicht auf ein pauschales 'name' zurückdrehen:
 * Krankheits-Arten sind Gesundheitsdaten (Art. 9 DSGVO, besondere Kategorie).
 * Mit 'name' zeigt der Firmenkalender des Portals (`modules/me/calendarRoutes.ts`)
 * jeder Kollegin und jedem Kollegen den Klartext-Grund einer Abwesenheit. Der
 * Spalten-Default der Tabelle ist historisch 'name'; ohne diese Vorgabe fiele
 * jede NEU angelegte Krankheits-Art wieder in genau diese Lücke — auch dann,
 * wenn ein älterer Client das Feld schlicht nicht kennt.
 *
 * Bewusst nur eine Vorgabe, keine Sperre: Schickt der Client ausdrücklich
 * 'name', wird das übernommen (die Oberfläche warnt an dieser Stelle deutlich).
 */
function defaultPortalVisibility(category: 'urlaub' | 'krankheit' | 'sonder'): 'name' | 'neutral' {
  return category === 'krankheit' ? 'neutral' : 'name';
}

const eligibilityBodySchema = z.object({
  role_ids: z.array(z.number().int().positive()).optional(),
  employee_rules: z
    .array(
      z.object({
        employee_id: z.number().int().positive(),
        effect: z.enum(['allow', 'deny']),
      }),
    )
    .optional(),
});

const requestBodySchema = z.object({
  employee_id: z.number().int().positive(),
  type_id: z.number().int().positive(),
  date_from: isoDate,
  date_to: isoDate,
  half_day_start: z.boolean().optional(),
  half_day_end: z.boolean().optional(),
  comment: z.string().trim().max(2000).optional(),
  // Nur die HR darf die Saldoprüfung übersteuern; das Portal-Schema
  // (me/routes.ts) kennt das Feld bewusst nicht.
  override_balance: z.boolean().optional(),
});

/** Body ist optional — bestehende Clients schicken keinen. */
const approveBodySchema = z.object({
  override_balance: z.boolean().optional(),
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

/**
 * Vier-Augen-Prinzip: Wer selbst hinter einem Antrag steht, darf ihn nicht
 * entscheiden. Bewusst nur bei `approve`/`reject` — `cancel` ist kein
 * Entscheid, sondern ein Rückzug und muss der eigenen Person offenstehen;
 * die Auto-Genehmigung bei `requires_approval = 0` (service.ts) trifft
 * niemand persönlich, sondern folgt der Konfiguration der Abwesenheitsart.
 *
 * Ein Admin-Konto ohne Personalprofil (`employee_id = null`) hat keinen
 * eigenen Antrag und wird deshalb nie geblockt. Im Ein-Admin-Betrieb bleibt
 * der eigene Antrag liegen, bis ein zweites HR-Konto ihn prüft — das ist
 * gewollt, ein Schlupfloch gäbe es sonst immer.
 */
function assertNotOwnRequest(req: FastifyRequest, row: RequestRow): void {
  const actorEmployeeId = (req.user as { employee_id?: number | null }).employee_id ?? null;
  if (actorEmployeeId !== null && actorEmployeeId === row.employee_id) {
    throw forbidden(
      'Eigene Abwesenheitsanträge dürfen nicht selbst entschieden werden. Bitte lassen Sie den Antrag von einer anderen Person der HR-Administration prüfen.',
    );
  }
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
  /**
   * HR-Liste: bewusst UNGEFILTERT (die Berechtigung greift beim Anlegen eines
   * Antrags, nicht beim Lesen der Stammdaten) — die Zuordnung wird nur zur
   * Anzeige mitgeliefert. Beide Verknüpfungen kommen als Sammelabfrage und
   * werden im Speicher zugeordnet, sonst wäre es eine Abfrage je Art.
   */
  app.get('/api/absences/types', async () => {
    const types = db()
      .prepare('SELECT * FROM absence_types ORDER BY active DESC, category, name')
      .all() as TypeRow[];
    const roleLinks = db()
      .prepare('SELECT type_id, role_id FROM absence_type_roles')
      .all() as { type_id: number; role_id: number }[];
    const ruleLinks = db()
      .prepare('SELECT type_id, employee_id, effect FROM absence_type_employee_rules')
      .all() as { type_id: number; employee_id: number; effect: 'allow' | 'deny' }[];

    const rolesByType = new Map<number, number[]>();
    for (const link of roleLinks) {
      const list = rolesByType.get(link.type_id);
      if (list) list.push(link.role_id);
      else rolesByType.set(link.type_id, [link.role_id]);
    }
    const rulesByType = new Map<number, { employee_id: number; effect: 'allow' | 'deny' }[]>();
    for (const link of ruleLinks) {
      const entry = { employee_id: link.employee_id, effect: link.effect };
      const list = rulesByType.get(link.type_id);
      if (list) list.push(entry);
      else rulesByType.set(link.type_id, [entry]);
    }

    return {
      types: types.map((t) => ({
        ...t,
        eligible_role_ids: rolesByType.get(t.id) ?? [],
        employee_rules: rulesByType.get(t.id) ?? [],
      })),
    };
  });

  app.post('/api/absences/types', async (req, reply) => {
    const body = parse(typeBodySchema, req.body);
    const result = db()
      .prepare(
        `INSERT INTO absence_types
         (name, category, paid, affects_balance, requires_proof, requires_approval, color, max_days_per_year, active, portal_visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        body.portal_visibility ?? defaultPortalVisibility(body.category),
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
         requires_proof = ?, requires_approval = ?, color = ?, max_days_per_year = ?, active = ?,
         portal_visibility = ?
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
        body.portal_visibility ?? defaultPortalVisibility(body.category),
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

  // -------------------------------------------------------- Berechtigungen ---
  // Wer darf eine Art beantragen? Rollen-Allowlist (leer = alle Rollen dürfen)
  // plus Personenregeln, die die Rollenregel schlagen. Ausgewertet wird das
  // beim Anlegen eines Antrags (service.ts), hier steht nur die Pflege.
  app.get('/api/absences/types/:id/eligibility', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT id FROM absence_types WHERE id = ?').get(id);
    if (!existing) throw notFound('Abwesenheitsart nicht gefunden');
    const roles = db()
      .prepare('SELECT role_id FROM absence_type_roles WHERE type_id = ? ORDER BY role_id')
      .all(id) as { role_id: number }[];
    const employeeRules = db()
      .prepare(
        `SELECT employee_id, effect FROM absence_type_employee_rules
         WHERE type_id = ? ORDER BY employee_id`,
      )
      .all(id) as { employee_id: number; effect: 'allow' | 'deny' }[];
    return { role_ids: roles.map((r) => r.role_id), employee_rules: employeeRules };
  });

  app.put('/api/absences/types/:id/eligibility', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT * FROM absence_types WHERE id = ?').get(id) as
      | TypeRow
      | undefined;
    if (!existing) throw notFound('Abwesenheitsart nicht gefunden');
    const body = parse(eligibilityBodySchema, req.body);

    // Doppelte Rollen sind harmlos (Menge), doppelte Personenregeln nicht:
    // zweimal dieselbe Person mit unterschiedlicher Wirkung ist mehrdeutig.
    const roleIds = [...new Set(body.role_ids ?? [])];
    const employeeRules = body.employee_rules ?? [];
    const employeeIds = employeeRules.map((r) => r.employee_id);
    if (new Set(employeeIds).size !== employeeIds.length) {
      throw badRequest('Für eine Person darf nur eine Regel angegeben werden');
    }
    // Fremdschlüssel würden zwar greifen, lieferten aber nur eine technische
    // Meldung — deshalb vorab prüfen und deutsch antworten.
    for (const roleId of roleIds) {
      const role = db().prepare('SELECT id FROM roles WHERE id = ?').get(roleId);
      if (!role) throw badRequest(`Die Rolle mit der ID ${roleId} existiert nicht`);
    }
    for (const employeeId of employeeIds) {
      const employee = db().prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
      if (!employee) throw badRequest(`Mitarbeiter:in mit der ID ${employeeId} existiert nicht`);
    }

    // Ersetzen statt Abgleichen: DELETE + INSERT in EINER Transaktion, damit
    // nie ein Zwischenstand ohne Allowlist sichtbar wird (leer = alle dürfen).
    inTransaction(() => {
      db().prepare('DELETE FROM absence_type_roles WHERE type_id = ?').run(id);
      db().prepare('DELETE FROM absence_type_employee_rules WHERE type_id = ?').run(id);
      const insertRole = db().prepare(
        'INSERT INTO absence_type_roles (type_id, role_id) VALUES (?, ?)',
      );
      for (const roleId of roleIds) insertRole.run(id, roleId);
      const insertRule = db().prepare(
        'INSERT INTO absence_type_employee_rules (type_id, employee_id, effect) VALUES (?, ?, ?)',
      );
      for (const rule of employeeRules) insertRule.run(id, rule.employee_id, rule.effect);
    });

    audit(req, 'update', 'absence_type_eligibility', id, {
      name: existing.name,
      role_ids: roleIds,
      employee_rules: employeeRules,
    });
    return { role_ids: roleIds, employee_rules: employeeRules };
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
    assertSpanWithinLimit(q.date_from, q.date_to);
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

    const id = createRequest(req, body, type);
    reply.status(201);
    return { request: db().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  app.post('/api/absences/requests/:id/approve', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(approveBodySchema, req.body ?? {});
    const row = db().prepare('SELECT * FROM absence_requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    if (!row) throw notFound('Antrag nicht gefunden');
    if (row.status !== 'beantragt') {
      throw conflict(`Nur beantragte Anträge können genehmigt werden (Status: ${row.status})`);
    }
    assertNotOwnRequest(req, row);
    // Saldo-Neuprüfung: Seit der Antragstellung können andere Anträge
    // genehmigt worden sein. assertBalanceCovers nimmt den eigenen Antrag aus
    // der Rechnung — als 'beantragt' steckt er schon in der Planung.
    if (!body.override_balance) {
      const type = db().prepare('SELECT * FROM absence_types WHERE id = ?').get(row.type_id) as
        | TypeRow
        | undefined;
      if (type) {
        assertBalanceCovers(
          row.employee_id,
          type,
          {
            date_from: row.date_from,
            date_to: row.date_to,
            half_day_start: row.half_day_start === 1,
            half_day_end: row.half_day_end === 1,
          },
          row.id,
        );
      }
    }
    const userId = (req.user as { id?: number }).id ?? null;
    db()
      .prepare(
        `UPDATE absence_requests SET status = 'genehmigt', decided_by_user_id = ?, decided_at = datetime('now')
         WHERE id = ?`,
      )
      .run(userId, id);
    audit(req, 'approve', 'absence_request', id, body.override_balance ? { override_balance: true } : undefined);
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
    assertNotOwnRequest(req, row);
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

  // Ohne Vier-Augen-Prüfung: Stornieren ist ein Rückzug, kein Entscheid.
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
    // Den Rechen-Kontext EINMAL für alle laden statt mehrerer Queries je
    // Person: Die Route rechnet synchron im einzigen Node-Prozess und
    // blockierte sonst bei großer Belegschaft alle parallelen Requests
    // (im Serverbetrieb auch das Portal). Das Bundesland kommt direkt mit
    // der Belegschaft — ein zweiter Lauf über dieselbe Tabelle entfällt.
    const defaultLand = getSetting('defaultBundesland');
    const employees = db()
      .prepare(
        `SELECT e.*, COALESCE(l.bundesland, ?) AS bundesland
         FROM employees e
         LEFT JOIN locations l ON l.id = e.location_id
         WHERE e.status = 'aktiv'
         ORDER BY e.last_name, e.first_name`,
      )
      .all(defaultLand) as (EmployeeRow & { bundesland: Bundesland })[];

    // Gesamtspanne = weiteste Übertrags-Kette (computeBalance geht maximal
    // 5 Jahre zurück); je Person überzählige Zeilen clippen sich dort zu 0.
    const spanFrom = `${y - 5}-01-01`;
    const spanTo = `${y}-12-31`;
    const closures = closureDates(spanFrom, spanTo);
    const requestRows = db()
      .prepare(
        `SELECT r.employee_id, r.date_from, r.date_to, r.half_day_start, r.half_day_end, r.status
         FROM absence_requests r
         JOIN absence_types t ON t.id = r.type_id
         WHERE t.affects_balance = 1 AND r.status IN ('genehmigt', 'beantragt')
           AND r.date_from <= ? AND r.date_to >= ?`,
      )
      .all([spanTo, spanFrom]) as (BalanceRequestRow & { employee_id: number })[];
    const requestsByEmployee = new Map<number, BalanceRequestRow[]>();
    for (const r of requestRows) {
      const list = requestsByEmployee.get(r.employee_id);
      if (list) list.push(r);
      else requestsByEmployee.set(r.employee_id, [r]);
    }

    const carryoverDeadline = getSetting('carryoverDeadline');
    const today = todayIso();
    const balances = employees.map((e) => ({
      ...computeBalance(e, y, today, {
        land: e.bundesland,
        carryoverDeadline,
        closures,
        requests: requestsByEmployee.get(e.id) ?? [],
      }),
      first_name: e.first_name,
      last_name: e.last_name,
    }));
    return { balances, carryover_deadline: `${y}-${carryoverDeadline}` };
  });

  // -------------------------------------------------------- Krankmeldungen ---
  const SICK_SELECT = `
    SELECT s.*, r.employee_id, r.date_from, r.date_to, r.days_counted, r.status AS request_status,
           e.first_name, e.last_name
    FROM sick_notes s
    JOIN absence_requests r ON r.id = s.absence_request_id
    JOIN employees e ON e.id = r.employee_id`;

  /** Entgeltfortzahlung im Krankheitsfall: 6 Wochen = 42 Kalendertage. */
  const SICK_PAY_LIMIT_DAYS = 42;

  interface SickRow {
    id: number;
    employee_id: number;
    date_from: string;
    date_to: string;
    follow_up_of_id: number | null;
    child_sick: number;
  }

  /**
   * Reichert Krankmeldungen um die bereits angefallenen Fehltage an:
   * - days_absent_so_far: Arbeitstage von Beginn bis heute (gedeckelt auf das Ende)
   * - sick_pay_days_used: Kalendertage seit Beginn der AU-Kette (Erst- plus
   *   Folgebescheinigungen), ebenfalls bis maximal heute
   * - sick_pay_exceeded: Entgeltfortzahlungszeitraum (42 Kalendertage) überzogen
   *   (nur eigene Erkrankung — Kind-krank läuft über Kinderkrankengeld)
   */
  function enrichSickNotes<T extends SickRow>(rows: T[]): (T & {
    days_absent_so_far: number;
    sick_pay_days_used: number;
    sick_pay_exceeded: boolean;
  })[] {
    if (rows.length === 0) return [];
    const today = todayIso();
    const employeeIds = [...new Set(rows.map((r) => r.employee_id))];

    // Für die Ketten-Betrachtung alle (nicht stornierten) AUs der betroffenen
    // Mitarbeitenden laden — die gefilterte Liste könnte Kettenglieder verlieren.
    const all = db()
      .prepare(
        `SELECT s.id, s.follow_up_of_id, s.child_sick, r.employee_id, r.date_from, r.date_to
         FROM sick_notes s
         JOIN absence_requests r ON r.id = s.absence_request_id
         WHERE r.status != 'storniert' AND r.employee_id IN (${employeeIds.map(() => '?').join(',')})`,
      )
      .all(...employeeIds) as SickRow[];
    const byId = new Map(all.map((n) => [n.id, n]));
    const rootOf = (note: SickRow): number => {
      let cur = note;
      const seen = new Set<number>();
      while (cur.follow_up_of_id !== null && byId.has(cur.follow_up_of_id) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.follow_up_of_id)!;
      }
      return cur.id;
    };
    // Kettenumfang je Wurzel: frühester Beginn, spätestes Ende.
    const chains = new Map<number, { from: string; to: string }>();
    for (const n of all) {
      const root = rootOf(n);
      const chain = chains.get(root);
      if (!chain) chains.set(root, { from: n.date_from, to: n.date_to });
      else {
        if (n.date_from < chain.from) chain.from = n.date_from;
        if (n.date_to > chain.to) chain.to = n.date_to;
      }
    }
    const calendarDays = (from: string, to: string): number =>
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

    const landCache = new Map<number, ReturnType<typeof bundeslandForEmployee>>();
    return rows.map((row) => {
      let land = landCache.get(row.employee_id);
      if (!land) landCache.set(row.employee_id, (land = bundeslandForEmployee(row.employee_id)));
      const daysAbsent = countAbsenceDays({
        land,
        dateFrom: row.date_from,
        dateTo: row.date_to,
        clipTo: today,
      });
      const chain = chains.get(rootOf(byId.get(row.id) ?? row)) ?? { from: row.date_from, to: row.date_to };
      const chainEnd = chain.to < today ? chain.to : today;
      const sickPayDays = chain.from > chainEnd ? 0 : calendarDays(chain.from, chainEnd);
      return {
        ...row,
        days_absent_so_far: daysAbsent,
        sick_pay_days_used: sickPayDays,
        sick_pay_exceeded: row.child_sick === 0 && sickPayDays > SICK_PAY_LIMIT_DAYS,
      };
    });
  }

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
      .all(...params) as SickRow[];
    return { sick_notes: enrichSickNotes(rows) };
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
      .all(todayIso()) as SickRow[];
    return { sick_notes: enrichSickNotes(rows) };
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
                      t.color, r.status, r.date_from, r.date_to, r.half_day_start, r.half_day_end,
                      r.days_counted
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
            days_counted: number;
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

    // Einmal gruppieren statt filter() je Person — die Jahresansicht ist hier
    // der Normalfall, und Mitarbeitende × Abwesenheiten wüchse quadratisch.
    const absencesByEmployee = new Map<number, typeof absences>();
    for (const a of absences) {
      const list = absencesByEmployee.get(a.employee_id);
      if (list) list.push(a);
      else absencesByEmployee.set(a.employee_id, [a]);
    }

    return {
      range: { from, to },
      employees: employees.map((e) => ({
        ...e,
        absences: absencesByEmployee.get(e.id) ?? [],
      })),
      holidays,
      closures,
      conflicts,
    };
  });

};
