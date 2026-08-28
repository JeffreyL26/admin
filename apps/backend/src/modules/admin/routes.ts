import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { isValidIsoDate } from '../../core/dates.js';
import { roleRoutes } from './roleRoutes.js';

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Datum muss im Format YYYY-MM-DD vorliegen' });

const templateCategory = z.enum([
  'schreiben',
  'vertrag',
  'formular',
  'richtlinie',
  'checkliste',
  'sonstiges',
]);

const templateBodySchema = z.object({
  file_id: z.number().int().positive(),
  category: templateCategory,
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  description: z.string().trim().max(2000).nullable().optional(),
});

const templatePatchSchema = z.object({
  file_id: z.number().int().positive().optional(),
  category: templateCategory.optional(),
  title: z.string().trim().min(1, 'Titel ist erforderlich').optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

const processBodySchema = z.object({
  employee_id: z.number().int().positive(),
  kind: z.enum(['onboarding', 'offboarding']),
  target_date: isoDate.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

const TEMPLATE_SELECT = `
  SELECT t.*, f.original_name, f.mime_type, f.size_bytes
  FROM hr_templates t
  JOIN files f ON f.id = t.file_id`;

const PROCESS_SELECT = `
  SELECT p.*, e.first_name, e.last_name, e.job_title, d.name AS department_name,
         (SELECT COUNT(*) FROM onboarding_tasks ot WHERE ot.process_id = p.id) AS total_tasks,
         (SELECT COUNT(*) FROM onboarding_tasks ot WHERE ot.process_id = p.id AND ot.done = 1) AS done_tasks
  FROM onboarding_processes p
  JOIN employees e ON e.id = p.employee_id
  LEFT JOIN departments d ON d.id = e.department_id`;

const TASK_SELECT = `
  SELECT ot.*, u.name AS done_by_name
  FROM onboarding_tasks ot
  LEFT JOIN users u ON u.id = ot.done_by_user_id`;

export const adminModule: FastifyPluginAsync = async (app) => {
  // Fachrollen liegen in einer eigenen Datei (Muster: modules/employees/routes.ts).
  await roleRoutes(app);

  const db = () => getDb();

  // ------------------------------------------------------------ HR-Vorlagen ---
  app.get('/api/admin/templates', async (req) => {
    const q = req.query as { search?: string; category?: string };
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.category) {
      where.push('t.category = ?');
      params.push(q.category);
    }
    if (q.search?.trim()) {
      where.push('(t.title LIKE ? OR t.description LIKE ? OR f.original_name LIKE ?)');
      const like = `%${q.search.trim()}%`;
      params.push(like, like, like);
    }
    const sql = `${TEMPLATE_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.category, t.title`;
    return { templates: db().prepare(sql).all(...params) };
  });

  app.post('/api/admin/templates', async (req, reply) => {
    const body = parse(templateBodySchema, req.body);
    if (!db().prepare('SELECT id FROM files WHERE id = ?').get(body.file_id)) {
      throw notFound('Datei nicht gefunden — bitte zuerst über POST /api/files hochladen');
    }
    const result = db()
      .prepare('INSERT INTO hr_templates (file_id, category, title, description) VALUES (?, ?, ?, ?)')
      .run(body.file_id, body.category, body.title, body.description ?? null);
    const id = Number(result.lastInsertRowid);
    audit(req, 'create', 'hr_template', id, { title: body.title, category: body.category });
    reply.status(201);
    return { template: db().prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).get(id) };
  });

  app.patch('/api/admin/templates/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!db().prepare('SELECT id FROM hr_templates WHERE id = ?').get(id)) {
      throw notFound('Vorlage nicht gefunden');
    }
    const patch = parse(templatePatchSchema, req.body);
    if (patch.file_id !== undefined && !db().prepare('SELECT id FROM files WHERE id = ?').get(patch.file_id)) {
      throw notFound('Datei nicht gefunden — bitte zuerst über POST /api/files hochladen');
    }
    const cols = (['file_id', 'category', 'title', 'description'] as const).filter(
      (c) => patch[c] !== undefined,
    );
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    db()
      .prepare(
        `UPDATE hr_templates SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(...cols.map((c) => patch[c] ?? null), id);
    audit(req, 'update', 'hr_template', id, { changed: patch });
    return { template: db().prepare(`${TEMPLATE_SELECT} WHERE t.id = ?`).get(id) };
  });

  app.delete('/api/admin/templates/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db().prepare('SELECT title FROM hr_templates WHERE id = ?').get(id) as
      | { title: string }
      | undefined;
    if (!existing) throw notFound('Vorlage nicht gefunden');
    db().prepare('DELETE FROM hr_templates WHERE id = ?').run(id);
    audit(req, 'delete', 'hr_template', id, { title: existing.title });
    reply.status(204);
  });

  // --------------------------------------------------------- On-/Offboarding ---
  app.get('/api/admin/onboarding', async (req) => {
    const q = req.query as { status?: string; kind?: string };
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) {
      where.push('p.status = ?');
      params.push(q.status);
    }
    if (q.kind) {
      where.push('p.kind = ?');
      params.push(q.kind);
    }
    const sql = `${PROCESS_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.status = 'laufend' DESC, p.target_date IS NULL, p.target_date, p.id DESC`;
    return { processes: db().prepare(sql).all(...params) };
  });

  app.get('/api/admin/onboarding/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const process = db().prepare(`${PROCESS_SELECT} WHERE p.id = ?`).get(id);
    if (!process) throw notFound('Prozess nicht gefunden');
    const tasks = db()
      .prepare(`${TASK_SELECT} WHERE ot.process_id = ? ORDER BY ot.sort_order, ot.id`)
      .all(id);
    return { process, tasks };
  });

  app.post('/api/admin/onboarding', async (req, reply) => {
    const body = parse(processBodySchema, req.body);
    const employee = db()
      .prepare('SELECT id, first_name, last_name FROM employees WHERE id = ?')
      .get(body.employee_id) as { id: number; first_name: string; last_name: string } | undefined;
    if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
    const running = db()
      .prepare(
        "SELECT id FROM onboarding_processes WHERE employee_id = ? AND kind = ? AND status = 'laufend'",
      )
      .get(body.employee_id, body.kind);
    if (running) {
      throw conflict(
        `Für ${employee.first_name} ${employee.last_name} läuft bereits ein ${body.kind === 'onboarding' ? 'Onboarding' : 'Offboarding'}`,
      );
    }

    const id = inTransaction(() => {
      const result = db()
        .prepare(
          'INSERT INTO onboarding_processes (employee_id, kind, target_date, note) VALUES (?, ?, ?, ?)',
        )
        .run(body.employee_id, body.kind, body.target_date ?? null, body.note ?? null);
      const processId = Number(result.lastInsertRowid);
      // Checkliste aus den aktiven Vorlagen des Prozesstyps kopieren.
      db()
        .prepare(
          `INSERT INTO onboarding_tasks (process_id, title, sort_order)
           SELECT ?, title, sort_order FROM onboarding_task_templates
           WHERE kind = ? AND active = 1 ORDER BY sort_order, id`,
        )
        .run(processId, body.kind);
      return processId;
    });
    audit(req, 'create', 'onboarding_process', id, {
      employee_id: body.employee_id,
      kind: body.kind,
      target_date: body.target_date ?? null,
    });
    reply.status(201);
    const process = db().prepare(`${PROCESS_SELECT} WHERE p.id = ?`).get(id);
    const tasks = db()
      .prepare(`${TASK_SELECT} WHERE ot.process_id = ? ORDER BY ot.sort_order, ot.id`)
      .all(id);
    return { process, tasks };
  });

  app.post('/api/admin/onboarding/:id/tasks', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const process = db().prepare('SELECT * FROM onboarding_processes WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!process) throw notFound('Prozess nicht gefunden');
    if (process.status !== 'laufend') throw conflict('Der Prozess ist bereits abgeschlossen');
    const body = parse(
      z.object({ title: z.string().trim().min(1, 'Titel ist erforderlich') }),
      req.body,
    );
    const max = db()
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM onboarding_tasks WHERE process_id = ?')
      .get(id) as { m: number };
    const result = db()
      .prepare('INSERT INTO onboarding_tasks (process_id, title, sort_order) VALUES (?, ?, ?)')
      .run(id, body.title, max.m + 10);
    const taskId = Number(result.lastInsertRowid);
    audit(req, 'create', 'onboarding_task', taskId, { process_id: id, title: body.title });
    reply.status(201);
    return { task: db().prepare(`${TASK_SELECT} WHERE ot.id = ?`).get(taskId) };
  });

  /** Abhaken bzw. wieder öffnen einer Checklisten-Aufgabe. */
  app.patch('/api/admin/onboarding/tasks/:taskId', async (req) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    const task = db()
      .prepare(
        `SELECT ot.*, p.status AS process_status FROM onboarding_tasks ot
         JOIN onboarding_processes p ON p.id = ot.process_id WHERE ot.id = ?`,
      )
      .get(taskId) as { id: number; process_id: number; process_status: string } | undefined;
    if (!task) throw notFound('Aufgabe nicht gefunden');
    if (task.process_status !== 'laufend') throw conflict('Der Prozess ist bereits abgeschlossen');
    const body = parse(z.object({ done: z.boolean() }), req.body);
    const userId = (req.user as { id?: number } | undefined)?.id ?? null;
    db()
      .prepare(
        `UPDATE onboarding_tasks
         SET done = ?, done_at = ${body.done ? "datetime('now')" : 'NULL'}, done_by_user_id = ?
         WHERE id = ?`,
      )
      .run(body.done ? 1 : 0, body.done ? userId : null, taskId);
    audit(req, body.done ? 'check' : 'uncheck', 'onboarding_task', taskId);
    return { task: db().prepare(`${TASK_SELECT} WHERE ot.id = ?`).get(taskId) };
  });

  app.delete('/api/admin/onboarding/tasks/:taskId', async (req, reply) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    const task = db()
      .prepare(
        `SELECT ot.*, p.status AS process_status FROM onboarding_tasks ot
         JOIN onboarding_processes p ON p.id = ot.process_id WHERE ot.id = ?`,
      )
      .get(taskId) as { title: string; process_status: string } | undefined;
    if (!task) throw notFound('Aufgabe nicht gefunden');
    if (task.process_status !== 'laufend') throw conflict('Der Prozess ist bereits abgeschlossen');
    db().prepare('DELETE FROM onboarding_tasks WHERE id = ?').run(taskId);
    audit(req, 'delete', 'onboarding_task', taskId, { title: task.title });
    reply.status(204);
  });

  /** Prozess abschließen — erst wenn die komplette Checkliste abgehakt ist. */
  app.post('/api/admin/onboarding/:id/complete', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const process = db().prepare('SELECT * FROM onboarding_processes WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!process) throw notFound('Prozess nicht gefunden');
    if (process.status !== 'laufend') throw conflict('Der Prozess ist bereits abgeschlossen');
    const open = db()
      .prepare('SELECT COUNT(*) AS n FROM onboarding_tasks WHERE process_id = ? AND done = 0')
      .get(id) as { n: number };
    if (open.n > 0) {
      throw conflict(`Es sind noch ${open.n} Aufgabe(n) offen — bitte zuerst die Checkliste abhaken`);
    }
    db()
      .prepare(
        "UPDATE onboarding_processes SET status = 'abgeschlossen', completed_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    audit(req, 'complete', 'onboarding_process', id);
    return { process: db().prepare(`${PROCESS_SELECT} WHERE p.id = ?`).get(id) };
  });

  app.delete('/api/admin/onboarding/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = db()
      .prepare(
        `SELECT p.kind, e.first_name, e.last_name FROM onboarding_processes p
         JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`,
      )
      .get(id) as { kind: string; first_name: string; last_name: string } | undefined;
    if (!existing) throw notFound('Prozess nicht gefunden');
    db().prepare('DELETE FROM onboarding_processes WHERE id = ?').run(id);
    audit(req, 'delete', 'onboarding_process', id, existing);
    reply.status(204);
  });
};
