import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import {
  EMPLOYEE_COLUMNS,
  assertTypeRules,
  bulkBodySchema,
  employeeBodySchema,
  employeePatchSchema,
} from './validation.js';

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: z.enum(['aktiv', 'ausgeschieden']).optional(),
  employee_type: z.string().optional(),
  department_id: z.coerce.number().int().positive().optional(),
  team_id: z.coerce.number().int().positive().optional(),
  location_id: z.coerce.number().int().positive().optional(),
  fields: z.enum(['lite', 'full']).optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;

const BASE_SELECT = `
  SELECT e.*,
         d.name AS department_name,
         t.name AS team_name,
         l.name AS location_name,
         l.bundesland AS location_bundesland,
         m.first_name || ' ' || m.last_name AS manager_name
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN teams t ON t.id = e.team_id
  LEFT JOIN locations l ON l.id = e.location_id
  LEFT JOIN employees m ON m.id = e.manager_id
`;

/** Alle für die Suche relevanten Felder (Name, Kontakt, Ort, Steuer/SV, Orga). */
const SEARCH_FIELDS = [
  "e.first_name", "e.last_name", "e.first_name || ' ' || e.last_name",
  'e.email', 'e.private_email', 'e.phone', 'e.private_phone',
  'e.private_street', 'e.private_zip', 'e.private_city',
  'e.job_title', 'e.iban', 'e.tax_id', 'e.social_security_number',
  'e.health_insurance', 'd.name', 't.name', 'l.name', 'l.city',
];

function queryEmployees(query: ListQuery): Record<string, unknown>[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    where.push('e.status = ?');
    params.push(query.status);
  }
  if (query.employee_type) {
    where.push('e.employee_type = ?');
    params.push(query.employee_type);
  }
  for (const key of ['department_id', 'team_id', 'location_id'] as const) {
    if (query[key] !== undefined) {
      where.push(`e.${key} = ?`);
      params.push(query[key]);
    }
  }
  if (query.search) {
    const like = `%${query.search.toLowerCase()}%`;
    where.push(`(${SEARCH_FIELDS.map((f) => `lower(coalesce(${f}, '')) LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < SEARCH_FIELDS.length; i++) params.push(like);
  }
  const sql = `${BASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`;
  return getDb().prepare(sql).all(...params) as Record<string, unknown>[];
}

function toLite(row: Record<string, unknown>) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    employee_type: row.employee_type,
    status: row.status,
    job_title: row.job_title,
    department_id: row.department_id,
    team_id: row.team_id,
    location_id: row.location_id,
  };
}

export function getEmployeeOr404(id: number): Record<string, unknown> {
  const row = getDb()
    .prepare(`${BASE_SELECT} WHERE e.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw notFound('Mitarbeiter:in nicht gefunden');
  return row;
}

/** Reporting-Line: Vorgesetztenkette von der Person bis zur Spitze (max. 20 Stufen). */
function reportingLine(employeeId: number): { id: number; name: string; job_title: string | null }[] {
  const db = getDb();
  const line: { id: number; name: string; job_title: string | null }[] = [];
  let current = db
    .prepare('SELECT id, manager_id, first_name, last_name, job_title FROM employees WHERE id = ?')
    .get(employeeId) as
    | { id: number; manager_id: number | null; first_name: string; last_name: string; job_title: string | null }
    | undefined;
  const seen = new Set<number>([employeeId]);
  while (current?.manager_id && line.length < 20) {
    if (seen.has(current.manager_id)) break; // defensiv gegen Zyklen
    const mgr = db
      .prepare('SELECT id, manager_id, first_name, last_name, job_title FROM employees WHERE id = ?')
      .get(current.manager_id) as typeof current | undefined;
    if (!mgr) break;
    seen.add(mgr.id);
    line.push({ id: mgr.id, name: `${mgr.first_name} ${mgr.last_name}`, job_title: mgr.job_title });
    current = mgr;
  }
  return line;
}

/** CSV-Zelle für deutsches Excel (Semikolon-Separator) escapen. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'birth_date',
  'private_street', 'private_zip', 'private_city', 'private_phone', 'private_email',
  'iban', 'bic', 'tax_id', 'tax_class', 'church_tax', 'child_allowances',
  'social_security_number', 'health_insurance',
  'employee_type', 'status', 'job_title',
  'department_name', 'team_name', 'location_name', 'manager_name',
  'hire_date', 'exit_date', 'weekly_hours', 'annual_leave_days',
];

export async function employeeRoutes(app: FastifyInstance): Promise<void> {
  // Liste inkl. Suche/Filter; fields=lite ist Kontrakt für andere Module.
  app.get('/api/employees', async (req) => {
    const query = parse(listQuerySchema, req.query ?? {});
    const rows = queryEmployees(query);
    if (query.fields === 'lite') return { employees: rows.map(toLite) };
    return { employees: rows };
  });

  // CSV-Export (BOM + Semikolon für deutsches Excel), gleiche Filter wie die Liste.
  app.get('/api/employees/export.csv', async (req, reply) => {
    const query = parse(listQuerySchema, req.query ?? {});
    const rows = queryEmployees(query);
    const lines = [
      CSV_COLUMNS.join(';'),
      ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(';')),
    ];
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="mitarbeitende.csv"');
    return '﻿' + lines.join('\r\n');
  });

  // Massenbearbeitung: nur die freigegebenen Felder, transaktional, auditiert.
  app.post('/api/employees/bulk', async (req) => {
    const { ids, set } = parse(bulkBodySchema, req.body);
    const fields = Object.entries(set).filter(([, v]) => v !== undefined);
    if (fields.length === 0) throw badRequest('Keine Felder zum Setzen angegeben');

    const db = getDb();
    inTransaction(() => {
      const update = db.prepare(
        `UPDATE employees SET ${fields.map(([k]) => `${k} = ?`).join(', ')},
         updated_at = datetime('now') WHERE id = ?`,
      );
      for (const id of ids) {
        const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!existing) throw notFound(`Mitarbeiter:in mit ID ${id} nicht gefunden`);
        assertTypeRules({ ...existing, ...set });
        update.run(...fields.map(([, v]) => v), id);
      }
    });
    audit(req, 'bulk_update', 'employee', undefined, { ids, set });
    return { updated: ids.length };
  });

  app.get('/api/employees/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const employee = getEmployeeOr404(id);
    return { employee, reporting_line: reportingLine(id) };
  });

  app.post('/api/employees', async (req, reply) => {
    const body = parse(employeeBodySchema, req.body);
    assertTypeRules(body);
    const cols = EMPLOYEE_COLUMNS.filter((c) => body[c] !== undefined);
    const info = getDb()
      .prepare(
        `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      )
      .run(...cols.map((c) => body[c] ?? null));
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'employee', id, { name: `${body.first_name} ${body.last_name}` });
    reply.status(201);
    return { employee: getEmployeeOr404(id) };
  });

  app.patch('/api/employees/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw notFound('Mitarbeiter:in nicht gefunden');
    const patch = parse(employeePatchSchema, req.body);
    const cols = EMPLOYEE_COLUMNS.filter((c) => patch[c] !== undefined);
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    assertTypeRules({ ...existing, ...patch });
    getDb()
      .prepare(
        `UPDATE employees SET ${cols.map((c) => `${c} = ?`).join(', ')},
         updated_at = datetime('now') WHERE id = ?`,
      )
      .run(...cols.map((c) => patch[c] ?? null), id);
    audit(req, 'update', 'employee', id, { changed: Object.fromEntries(cols.map((c) => [c, patch[c]])) });
    return { employee: getEmployeeOr404(id) };
  });

  app.delete('/api/employees/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb()
      .prepare('SELECT first_name, last_name FROM employees WHERE id = ?')
      .get(id) as { first_name: string; last_name: string } | undefined;
    if (!existing) throw notFound('Mitarbeiter:in nicht gefunden');
    try {
      getDb().prepare('DELETE FROM employees WHERE id = ?').run(id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('SQLITE_CONSTRAINT')) {
        throw conflict(
          'Mitarbeiter:in wird von anderen Modulen referenziert — bitte stattdessen den Status auf „ausgeschieden“ setzen',
        );
      }
      throw e;
    }
    audit(req, 'delete', 'employee', id, {
      name: `${existing.first_name} ${existing.last_name}`,
    });
    reply.status(204);
  });
}
