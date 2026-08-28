/**
 * Self-Service-API des Mitarbeitenden-Web-Portals (/api/me/*).
 *
 * Alle Routen setzen einen Account mit verknüpftem Personalprofil voraus
 * (users.employee_id, role 'mitarbeiter'); die Daten sind strikt auf das
 * eigene Profil beschränkt. Die Fachlogik (Überlappung, Tageszählung,
 * Jahresobergrenzen, Auto-Genehmigung) ist dieselbe wie in der
 * HR-Administration (modules/absences/service.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { addDaysIso, isValidIsoDate, todayIso } from '../../core/dates.js';
import {
  allowedTypeIdsFor,
  bundeslandForEmployee,
  computeBalance,
  countAbsenceDays,
  createRequest,
  type AbsenceTypeRow,
} from '../absences/service.js';
import { assertReasonableSpan, requireEmployee } from './lib.js';
import { meCalendarRoutes } from './calendarRoutes.js';
import { meDocumentRoutes } from './documentRoutes.js';
import { meOrgRoutes } from './orgRoutes.js';
import { meSalaryRoutes } from './salaryRoutes.js';

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Datum muss im Format YYYY-MM-DD vorliegen' });

const leaveRequestBodySchema = z.object({
  type_id: z.number().int().positive(),
  date_from: isoDate,
  date_to: isoDate,
  half_day_start: z.boolean().optional(),
  half_day_end: z.boolean().optional(),
  comment: z.string().trim().max(2000).optional(),
});

const sickNoteBodySchema = z.object({
  date_from: isoDate,
  date_to: isoDate,
  child_sick: z.boolean().optional(),
  comment: z.string().trim().max(2000).optional(),
});

/** Eigene Anträge, angereichert um Art und Namen der entscheidenden Person. */
const MY_REQUEST_SELECT = `
  SELECT r.*, t.name AS type_name, t.color AS type_color, t.category AS type_category,
         u.name AS decided_by_name
  FROM absence_requests r
  JOIN absence_types t ON t.id = r.type_id
  LEFT JOIN users u ON u.id = r.decided_by_user_id`;

const MY_SICK_SELECT = `
  SELECT s.id, s.absence_request_id, s.certificate_file_id, s.certificate_due_date,
         s.received_date, s.follow_up_of_id, s.child_sick, s.created_at,
         r.date_from, r.date_to, r.days_counted, r.status AS request_status
  FROM sick_notes s
  JOIN absence_requests r ON r.id = s.absence_request_id`;

export const meModule: FastifyPluginAsync = async (app) => {
  const db = () => getDb();

  // Das Self-Service-Modul ist auf mehrere Routendateien verteilt (Vorbild:
  // modules/employees/routes.ts), damit parallele Arbeit keine Dateikonflikte
  // erzeugt. modules/index.ts registriert nur dieses eine Modul-Plugin, die
  // Teilpakete hängen sich hier ein.
  await app.register(meSalaryRoutes);
  await app.register(meOrgRoutes);
  await app.register(meCalendarRoutes);
  await app.register(meDocumentRoutes);

  // ------------------------------------------------------------- Stammdaten ---
  app.get('/api/me/profile', async (req) => {
    const emp = requireEmployee(req);
    const profile = db()
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, e.email, e.phone, e.birth_date,
                e.private_street, e.private_zip, e.private_city, e.private_phone, e.private_email,
                e.employee_type, e.job_title, e.hire_date, e.weekly_hours, e.annual_leave_days,
                e.health_insurance,
                d.name AS department_name, t.name AS team_name, l.name AS location_name,
                CASE WHEN m.id IS NULL THEN NULL ELSE (m.first_name || ' ' || m.last_name) END AS manager_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN teams t ON t.id = e.team_id
         LEFT JOIN locations l ON l.id = e.location_id
         LEFT JOIN employees m ON m.id = e.manager_id
         WHERE e.id = ?`,
      )
      .get(emp.id);
    return { profile };
  });

  // ------------------------------------------------------- Abwesenheitsarten ---
  /**
   * Beantragbare Arten (aktiv, ohne Krankheit — die läuft über Krankmeldung).
   *
   * Der Lesefilter muss dieselbe Auflösung verwenden wie die Schreibseite
   * (assertTypeAllowed in createRequest), sonst böte das Portal Arten zur
   * Auswahl an, deren Antrag anschließend mit 403 scheitert.
   * allowedTypeIdsFor kapselt genau diese Logik mengenweise (leere Allowlist
   * ⇒ alle dürfen, Personenregel schlägt Rolle) — hier bewusst nicht als
   * eigenes SQL nachgebaut, damit beide Seiten nicht auseinanderlaufen.
   */
  app.get('/api/me/leave-types', async (req) => {
    const emp = requireEmployee(req);
    const types = db()
      .prepare(
        `SELECT * FROM absence_types WHERE active = 1 AND category != 'krankheit'
         ORDER BY CASE category WHEN 'urlaub' THEN 0 ELSE 1 END, name`,
      )
      .all() as AbsenceTypeRow[];
    // Eine Sammelabfrage für alle Arten (kein N+1 über die Liste).
    const allowed = allowedTypeIdsFor(emp.id);
    return { types: types.filter((t) => allowed.has(t.id)) };
  });

  // ----------------------------------------------------------------- Anträge ---
  app.get('/api/me/leave-requests', async (req) => {
    const emp = requireEmployee(req);
    const q = req.query as { year?: string; status?: string };
    const where: string[] = ['r.employee_id = ?'];
    const params: unknown[] = [emp.id];
    if (q.year && /^\d{4}$/.test(q.year)) {
      where.push('r.date_to >= ? AND r.date_from <= ?');
      params.push(`${q.year}-01-01`, `${q.year}-12-31`);
    }
    if (q.status) {
      where.push('r.status = ?');
      params.push(q.status);
    }
    const requests = db()
      .prepare(
        `${MY_REQUEST_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.date_from DESC, r.id DESC`,
      )
      .all(params);
    return { requests };
  });

  app.post('/api/me/leave-requests', async (req, reply) => {
    const emp = requireEmployee(req);
    const body = parse(leaveRequestBodySchema, req.body);
    if (body.date_to < body.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    assertReasonableSpan(body.date_from, body.date_to);
    if (body.date_from === body.date_to && body.half_day_start && body.half_day_end) {
      throw badRequest('Bei einem eintägigen Zeitraum kann nur ein halber Tag gewählt werden');
    }
    const type = db().prepare('SELECT * FROM absence_types WHERE id = ?').get(body.type_id) as
      | AbsenceTypeRow
      | undefined;
    if (!type) throw notFound('Abwesenheitsart nicht gefunden');
    if (!type.active) throw badRequest('Diese Abwesenheitsart ist deaktiviert');
    if (type.category === 'krankheit') {
      throw badRequest('Krankmeldungen reichen Sie bitte über den Bereich "Krankmeldung" ein');
    }

    const id = createRequest(req, { ...body, employee_id: emp.id }, type);
    reply.status(201);
    return { request: db().prepare(`${MY_REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  /** Eigenen, noch offenen Antrag zurückziehen. */
  app.post('/api/me/leave-requests/:id/cancel', async (req) => {
    const emp = requireEmployee(req);
    const id = Number((req.params as { id: string }).id);
    const row = db()
      .prepare('SELECT * FROM absence_requests WHERE id = ? AND employee_id = ?')
      .get([id, emp.id]) as { id: number; status: string } | undefined;
    if (!row) throw notFound('Antrag nicht gefunden');
    if (row.status !== 'beantragt') {
      throw conflict(
        `Nur offene Anträge können zurückgezogen werden (Status: ${row.status}). Wenden Sie sich sonst bitte an die Personalabteilung.`,
      );
    }
    db()
      .prepare(
        `UPDATE absence_requests SET status = 'storniert', decided_by_user_id = ?, decided_at = datetime('now')
         WHERE id = ?`,
      )
      .run(req.user.id, id);
    audit(req, 'cancel', 'absence_request', id, { self_service: true });
    return { request: db().prepare(`${MY_REQUEST_SELECT} WHERE r.id = ?`).get(id) };
  });

  // ------------------------------------------------------------------- Saldo ---
  app.get('/api/me/leave-balance', async (req) => {
    const emp = requireEmployee(req);
    const q = req.query as { year?: string };
    const year = q.year ? Number(q.year) : Number(todayIso().slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Ungültiges Jahr');
    return { balance: computeBalance(emp, year) };
  });

  /** Live-Vorschau der gezählten Tage für das Antragsformular. */
  app.get('/api/me/leave-preview', async (req) => {
    const emp = requireEmployee(req);
    const q = req.query as Record<string, string | undefined>;
    if (!q.date_from || !q.date_to || !isValidIsoDate(q.date_from) || !isValidIsoDate(q.date_to)) {
      throw badRequest('date_from und date_to sind erforderlich');
    }
    if (q.date_to < q.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    assertReasonableSpan(q.date_from, q.date_to);
    const land = bundeslandForEmployee(emp.id);
    const days = countAbsenceDays({
      land,
      dateFrom: q.date_from,
      dateTo: q.date_to,
      halfDayStart: q.half_day_start === '1' || q.half_day_start === 'true',
      halfDayEnd: q.half_day_end === '1' || q.half_day_end === 'true',
    });
    return { days_counted: days, bundesland: land };
  });

  // ---------------------------------------------------------- Krankmeldungen ---
  app.get('/api/me/sick-notes', async (req) => {
    const emp = requireEmployee(req);
    const sickNotes = db()
      .prepare(
        `${MY_SICK_SELECT} WHERE r.employee_id = ? AND r.status != 'storniert'
         ORDER BY r.date_from DESC, s.id DESC`,
      )
      .all(emp.id);
    return { sick_notes: sickNotes };
  });

  app.post('/api/me/sick-notes', async (req, reply) => {
    const emp = requireEmployee(req);
    const body = parse(sickNoteBodySchema, req.body);
    if (body.date_to < body.date_from) throw badRequest('Das Enddatum liegt vor dem Startdatum');
    assertReasonableSpan(body.date_from, body.date_to);
    const typeName = body.child_sick ? 'Kind krank' : 'Krankheit';
    const type = db()
      .prepare("SELECT * FROM absence_types WHERE name = ? AND category = 'krankheit' AND active = 1")
      .get(typeName) as AbsenceTypeRow | undefined;
    if (!type) {
      throw badRequest(`Die Abwesenheitsart "${typeName}" ist nicht konfiguriert oder deaktiviert`);
    }

    const sickNoteId = inTransaction(() => {
      const requestId = createRequest(
        req,
        {
          employee_id: emp.id,
          type_id: type.id,
          date_from: body.date_from,
          date_to: body.date_to,
          comment: body.comment,
        },
        type,
      );
      const result = db()
        .prepare(
          `INSERT INTO sick_notes (absence_request_id, certificate_due_date, child_sick)
           VALUES (?, ?, ?)`,
        )
        // Ausstellungspflicht am 3. Kalendertag der Erkrankung.
        .run(requestId, addDaysIso(body.date_from, 2), body.child_sick ? 1 : 0);
      return Number(result.lastInsertRowid);
    });
    audit(req, 'create', 'sick_note', sickNoteId, {
      employee_id: emp.id,
      date_from: body.date_from,
      date_to: body.date_to,
      child_sick: !!body.child_sick,
      self_service: true,
    });
    reply.status(201);
    return { sick_note: db().prepare(`${MY_SICK_SELECT} WHERE s.id = ?`).get(sickNoteId) };
  });
};
