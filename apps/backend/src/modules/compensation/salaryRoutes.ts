import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { parse, badRequest, conflict, notFound } from '../../core/errors.js';
import { audit, auditTrail } from '../../core/audit.js';
import { todayIso, isValidIsoDate } from '../../core/dates.js';
import { SALARY_COMPONENT_KINDS } from '@hrmonic/shared';
import {
  componentsAt,
  currentMonthlyGross,
  getEmployee,
  insertSalaryComponent,
  monthlyCents,
  type EmployeeRow,
} from './lib.js';

const kindSchema = z.enum(SALARY_COMPONENT_KINDS as [string, ...string[]]);

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Datum muss das Format JJJJ-MM-TT haben' });

const componentSchema = z.object({
  kind: kindSchema,
  amount_cents: z.number().int().positive('Der Betrag muss größer als 0 sein'),
  valid_from: isoDate,
  note: z.string().trim().max(500).optional().nullable(),
});

const changeRequestSchema = z.object({
  employee_id: z.number().int().positive(),
  kind: kindSchema,
  new_amount_cents: z.number().int().positive('Der Betrag muss größer als 0 sein'),
  effective_date: isoDate,
  reason: z.string().trim().min(3, 'Eine Begründung ist Pflicht'),
});

const decisionSchema = z.object({
  decision: z.enum(['genehmigt', 'abgelehnt']),
  decision_note: z.string().trim().max(500).optional().nullable(),
});

/** Zuletzt gültiger Betrag einer Art (für Audit-Details alter/neuer Betrag). */
function currentAmountCents(employeeId: number, kind: string, date: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT amount_cents FROM salary_components
       WHERE employee_id = ? AND kind = ? AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to >= ?)
       ORDER BY valid_from DESC LIMIT 1`,
    )
    .get(employeeId, kind, date, date) as { amount_cents: number } | undefined;
  return row?.amount_cents ?? null;
}

export async function salaryRoutes(app: FastifyInstance): Promise<void> {
  // Gesamtübersicht: aktuelles Monatsbrutto aller Mitarbeitenden (ohne
  // Freiberufler:innen — deren Vergütung läuft getrennt über Honorare).
  app.get('/api/compensation/salaries', async () => {
    const today = todayIso();
    const employees = getDb()
      .prepare(
        `SELECT * FROM employees WHERE employee_type != 'freiberufler'
         ORDER BY last_name, first_name`,
      )
      .all() as EmployeeRow[];
    const lastChanges = getDb()
      .prepare(
        `SELECT employee_id, MAX(valid_from) AS last_change FROM salary_components GROUP BY employee_id`,
      )
      .all() as { employee_id: number; last_change: string }[];
    const lastByEmployee = new Map(lastChanges.map((r) => [r.employee_id, r.last_change]));
    return {
      salaries: employees.map((e) => ({
        employee_id: e.id,
        first_name: e.first_name,
        last_name: e.last_name,
        employee_type: e.employee_type,
        status: e.status,
        job_title: e.job_title,
        monthly_gross_cents: currentMonthlyGross(e, today),
        component_count: componentsAt(e.id, today).length,
        last_change: lastByEmployee.get(e.id) ?? null,
      })),
    };
  });

  // Aktuelle Vergütung einer Mitarbeiter:in: Komponenten + Monatsbrutto.
  app.get('/api/compensation/employees/:id/salary', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const employee = getEmployee(id);
    const today = todayIso();
    const components = componentsAt(id, today).map((c) => ({
      ...c,
      monthly_cents: monthlyCents(c.kind, c.amount_cents, employee.weekly_hours),
    }));
    return {
      salary: {
        employee_id: id,
        first_name: employee.first_name,
        last_name: employee.last_name,
        employee_type: employee.employee_type,
        weekly_hours: employee.weekly_hours,
        monthly_gross_cents: components.reduce((s, c) => s + c.monthly_cents, 0),
        components,
      },
    };
  });

  // Historie (Timeline) aller Komponenten einer Mitarbeiter:in.
  app.get('/api/compensation/employees/:id/salary/history', async (req) => {
    const id = Number((req.params as { id: string }).id);
    getEmployee(id);
    const components = getDb()
      .prepare(
        `SELECT * FROM salary_components WHERE employee_id = ?
         ORDER BY valid_from DESC, kind`,
      )
      .all(id);
    return { components };
  });

  // Neue Gehaltskomponente (direkt, ohne Workflow) — schließt die offene
  // Vorgängerzeile gleicher Art transaktional (lückenlose Historie).
  app.post('/api/compensation/employees/:id/components', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const employee = getEmployee(id);
    if (employee.employee_type === 'freiberufler') {
      throw badRequest('Freiberufler:innen werden über Honorarsätze vergütet, nicht über Gehaltskomponenten');
    }
    const body = parse(componentSchema, req.body);
    const oldAmount = currentAmountCents(id, body.kind, body.valid_from);
    const component = inTransaction(() =>
      insertSalaryComponent(id, body.kind, body.amount_cents, body.valid_from, body.note ?? null),
    );
    audit(req, 'salary_component.create', 'compensation_employee', id, {
      kind: body.kind,
      old_amount_cents: oldAmount,
      new_amount_cents: body.amount_cents,
      valid_from: body.valid_from,
      reason: body.note ?? null,
    });
    reply.status(201);
    return { component };
  });

  // Audit-Historie der Vergütung je Mitarbeiter:in („wer/wann/was/warum").
  app.get('/api/compensation/employees/:id/audit', async (req) => {
    const id = Number((req.params as { id: string }).id);
    getEmployee(id);
    const entries = (auditTrail('compensation_employee', id) as { details: string | null }[]).map(
      (e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null }),
    );
    return { entries };
  });

  // ---------------- Gehaltsänderungs-Workflow ----------------

  app.get('/api/compensation/change-requests', async (req) => {
    const { status, employee_id } = req.query as { status?: string; employee_id?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) {
      conditions.push('r.status = ?');
      params.push(status);
    }
    if (employee_id) {
      conditions.push('r.employee_id = ?');
      params.push(Number(employee_id));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const requests = getDb()
      .prepare(
        `SELECT r.*, e.first_name, e.last_name,
                ru.name AS requested_by_name, du.name AS decided_by_name
         FROM salary_change_requests r
         JOIN employees e ON e.id = r.employee_id
         LEFT JOIN users ru ON ru.id = r.requested_by_user_id
         LEFT JOIN users du ON du.id = r.decided_by_user_id
         ${where}
         ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(...params);
    return { requests };
  });

  app.post('/api/compensation/change-requests', async (req, reply) => {
    const body = parse(changeRequestSchema, req.body);
    const employee = getEmployee(body.employee_id);
    if (employee.employee_type === 'freiberufler') {
      throw badRequest('Für Freiberufler:innen sind keine Gehaltsänderungen möglich');
    }
    const info = getDb()
      .prepare(
        `INSERT INTO salary_change_requests
           (employee_id, kind, new_amount_cents, effective_date, reason, requested_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.employee_id,
        body.kind,
        body.new_amount_cents,
        body.effective_date,
        body.reason,
        req.user.id,
      );
    const request = getDb()
      .prepare('SELECT * FROM salary_change_requests WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    audit(req, 'salary_change_request.create', 'compensation_employee', body.employee_id, {
      request_id: Number(info.lastInsertRowid),
      kind: body.kind,
      old_amount_cents: currentAmountCents(body.employee_id, body.kind, body.effective_date),
      new_amount_cents: body.new_amount_cents,
      effective_date: body.effective_date,
      reason: body.reason,
    });
    reply.status(201);
    return { request };
  });

  // Entscheidung: Genehmigung wendet die Änderung transaktional auf
  // salary_components an (Vorgängerzeile wird lückenlos geschlossen).
  app.post('/api/compensation/change-requests/:id/decide', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(decisionSchema, req.body);
    const db = getDb();
    const request = db
      .prepare('SELECT * FROM salary_change_requests WHERE id = ?')
      .get(id) as
      | {
          id: number;
          employee_id: number;
          kind: string;
          new_amount_cents: number;
          effective_date: string;
          reason: string;
          status: string;
        }
      | undefined;
    if (!request) throw notFound('Änderungsantrag nicht gefunden');
    if (request.status !== 'beantragt') {
      throw conflict('Der Antrag wurde bereits entschieden');
    }
    const oldAmount = currentAmountCents(
      request.employee_id,
      request.kind,
      request.effective_date,
    );
    inTransaction(() => {
      if (body.decision === 'genehmigt') {
        insertSalaryComponent(
          request.employee_id,
          request.kind,
          request.new_amount_cents,
          request.effective_date,
          `Änderungsantrag #${request.id}: ${request.reason}`,
        );
      }
      db.prepare(
        `UPDATE salary_change_requests
         SET status = ?, decided_by_user_id = ?, decided_at = datetime('now'), decision_note = ?
         WHERE id = ?`,
      ).run(body.decision, req.user.id, body.decision_note ?? null, id);
    });
    audit(
      req,
      body.decision === 'genehmigt'
        ? 'salary_change_request.approve'
        : 'salary_change_request.reject',
      'compensation_employee',
      request.employee_id,
      {
        request_id: id,
        kind: request.kind,
        old_amount_cents: oldAmount,
        new_amount_cents: request.new_amount_cents,
        effective_date: request.effective_date,
        reason: request.reason,
        decision_note: body.decision_note ?? null,
      },
    );
    const updated = db.prepare('SELECT * FROM salary_change_requests WHERE id = ?').get(id);
    return { request: updated };
  });
}
