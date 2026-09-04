import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { parse, badRequest, notFound, conflict } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { todayIso, addDaysIso } from '../../core/dates.js';
import { isoDateString } from '../../core/validation.js';
import type { Goal, ReviewCriterion, ReviewScore, Review, TrainingDueEntry } from '@ohrganize/shared';

// Modul: Leistungsverwaltung & Entwicklung — Ziele/OKR, Beurteilungen,
// Entwicklungspläne & Karrierepfade, Skills, Trainings, Feedback-Zyklen.

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

// Kalenderprüfung inklusive (core/validation.ts) — ein Regex allein ließe
// '2026-02-31' durch.
const isoDate = isoDateString;

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function idParam(req: FastifyRequest): number {
  return parse(idParamSchema, req.params).id;
}

/** ISO-Datum + n Monate (Tagesüberlauf wird von JS-Date normalisiert). */
function addMonthsIso(date: string, months: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function getRowOrThrow<T>(table: string, id: number, message: string): T {
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as T | undefined;
  if (!row) throw notFound(message);
  return row;
}

function ensureEmployeeExists(employeeId: number): void {
  const row = getDb().prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
  if (!row) throw notFound('Mitarbeiter:in nicht gefunden');
}

// ---------------------------------------------------------------------------
// Zod-Schemata
// ---------------------------------------------------------------------------

const goalKind = z.enum(['objective', 'key_result', 'kpi']);
const goalStatus = z.enum(['aktiv', 'erreicht', 'verfehlt', 'abgebrochen']);

const goalCreateSchema = z.object({
  employee_id: z.number().int().positive(),
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  description: z.string().nullish(),
  kind: goalKind.default('objective'),
  parent_goal_id: z.number().int().positive().nullish(),
  metric: z.string().nullish(),
  target_value: z.string().nullish(),
  current_value: z.string().nullish(),
  progress: z.number().int().min(0).max(100).default(0),
  period_from: isoDate.nullish(),
  period_to: isoDate.nullish(),
  status: goalStatus.default('aktiv'),
});

const goalUpdateSchema = goalCreateSchema.omit({ employee_id: true, kind: true }).partial();

const goalProgressSchema = z.object({
  progress: z.number().int().min(0).max(100),
  current_value: z.string().nullish(),
  status: goalStatus.optional(),
});

const cycleKind = z.enum(['jaehrlich', 'halbjaehrlich', 'adhoc']);
const cycleStatus = z.enum(['geplant', 'laufend', 'abgeschlossen']);

const cycleCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich'),
  kind: cycleKind.default('jaehrlich'),
  period_from: isoDate,
  period_to: isoDate,
  status: cycleStatus.default('geplant'),
});

const criterionSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().optional(),
  scale_max: z.number().int().min(2).max(10),
});

const templateSchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich'),
  criteria: z.array(criterionSchema).min(1, 'Mindestens ein Kriterium ist erforderlich'),
});

const reviewKind = z.enum(['selbst', 'vorgesetzt', 'feedback360']);

const reviewCreateSchema = z.object({
  cycle_id: z.number().int().positive(),
  employee_id: z.number().int().positive(),
  template_id: z.number().int().positive(),
  reviewer_employee_id: z.number().int().positive().nullish(),
  kind: reviewKind,
});

const reviewSaveSchema = z.object({
  scores: z
    .array(
      z.object({
        key: z.string().min(1),
        score: z.number().int().min(1),
        comment: z.string().optional(),
      }),
    )
    .default([]),
  summary: z.string().nullish(),
});

const planStatus = z.enum(['aktiv', 'abgeschlossen', 'abgebrochen']);
const planCreateSchema = z.object({
  employee_id: z.number().int().positive(),
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  goal: z.string().nullish(),
  status: planStatus.default('aktiv'),
});
const planUpdateSchema = planCreateSchema.omit({ employee_id: true }).partial();

const measureStatus = z.enum(['offen', 'laufend', 'erledigt', 'verworfen']);
const measureCreateSchema = z.object({
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  due_date: isoDate.nullish(),
  owner_employee_id: z.number().int().positive().nullish(),
  status: measureStatus.default('offen'),
  note: z.string().nullish(),
});
const measureUpdateSchema = measureCreateSchema.partial();

const careerLevelSchema = z.object({
  role_name: z.string().trim().min(1, 'Rolle ist erforderlich'),
  level: z.number().int().min(1),
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  requirements: z.string().nullish(),
});

const employeeLevelSchema = z.object({
  employee_id: z.number().int().positive(),
  career_level_id: z.number().int().positive(),
  since_date: isoDate,
});

const skillSchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich'),
  category: z.string().nullish(),
});

const employeeSkillSchema = z.object({
  employee_id: z.number().int().positive(),
  skill_id: z.number().int().positive(),
  level: z.number().int().min(1).max(5),
  assessed_at: isoDate.optional(),
});

const roleProfileSchema = z.object({
  role_name: z.string().trim().min(1, 'Rolle ist erforderlich'),
  skill_id: z.number().int().positive(),
  required_level: z.number().int().min(1).max(5),
});

const trainingKind = z.enum(['intern', 'extern']);
const trainingSchema = z.object({
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  provider: z.string().nullish(),
  kind: trainingKind.default('intern'),
  cost_cents: z.number().int().min(0).nullish(),
  mandatory: z.boolean().default(false),
  repeat_interval_months: z.number().int().min(1).nullish(),
  description: z.string().nullish(),
});

const registrationStatus = z.enum(['angemeldet', 'teilgenommen', 'abgeschlossen', 'storniert']);
const registrationCreateSchema = z.object({
  training_id: z.number().int().positive(),
  employee_id: z.number().int().positive(),
  date: isoDate.nullish(),
  note: z.string().nullish(),
});
const registrationUpdateSchema = z.object({
  status: registrationStatus.optional(),
  date: isoDate.nullish().optional(),
  completed_at: isoDate.nullish().optional(),
  certificate_file_id: z.number().int().positive().nullish().optional(),
  note: z.string().nullish().optional(),
});

const meetingKind = z.enum(['einzelgespraech', 'probezeitgespraech', 'jahresgespraech', 'sonstiges']);
const meetingCreateSchema = z.object({
  employee_id: z.number().int().positive(),
  kind: meetingKind.default('einzelgespraech'),
  scheduled_date: isoDate,
  notes: z.string().nullish(),
  recurrence_months: z.number().int().min(1).nullish(),
});
const meetingUpdateSchema = z.object({
  kind: meetingKind.optional(),
  scheduled_date: isoDate.optional(),
  notes: z.string().nullish().optional(),
  recurrence_months: z.number().int().min(1).nullish().optional(),
  status: z.enum(['geplant', 'stattgefunden', 'abgesagt']).optional(),
});
const meetingCompleteSchema = z.object({
  held_date: isoDate.optional(),
  notes: z.string().nullish(),
});

const actionCreateSchema = z.object({
  title: z.string().trim().min(1, 'Titel ist erforderlich'),
  due_date: isoDate.nullish(),
  owner_employee_id: z.number().int().positive().nullish(),
});
const actionUpdateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  due_date: isoDate.nullish().optional(),
  owner_employee_id: z.number().int().positive().nullish().optional(),
  status: z.enum(['offen', 'erledigt']).optional(),
});

// ---------------------------------------------------------------------------
// Fachlogik-Helfer
// ---------------------------------------------------------------------------

function getGoal(id: number): Goal {
  return getRowOrThrow<Goal>('goals', id, 'Ziel nicht gefunden');
}

/** Objective-Fortschritt = gerundetes Mittel seiner Key Results. */
function recomputeObjectiveProgress(objectiveId: number): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT AVG(progress) AS avg FROM goals WHERE parent_goal_id = ?`)
    .get(objectiveId) as { avg: number | null };
  if (row.avg !== null) {
    db.prepare('UPDATE goals SET progress = ? WHERE id = ?').run(Math.round(row.avg), objectiveId);
  }
}

function parseTemplateCriteria(row: { criteria: string }): ReviewCriterion[] {
  return JSON.parse(row.criteria) as ReviewCriterion[];
}

function reviewToApi(row: Record<string, unknown>): Review {
  return { ...row, scores: JSON.parse(String(row.scores ?? '[]')) } as unknown as Review;
}

/** Prüft Scores gegen die Kriterien des Bogens (Key bekannt, Skala eingehalten). */
function validateScores(scores: ReviewScore[], criteria: ReviewCriterion[]): void {
  const byKey = new Map(criteria.map((c) => [c.key, c]));
  for (const s of scores) {
    const criterion = byKey.get(s.key);
    if (!criterion) throw badRequest(`Unbekanntes Kriterium: ${s.key}`);
    if (s.score < 1 || s.score > criterion.scale_max) {
      throw badRequest(
        `Bewertung für „${criterion.label}“ muss zwischen 1 und ${criterion.scale_max} liegen`,
      );
    }
  }
  const seen = new Set(scores.map((s) => s.key));
  if (seen.size !== scores.length) throw badRequest('Kriterien dürfen nur einmal bewertet werden');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const performanceModule: FastifyPluginAsync = async (app) => {
  // ======================= Ziele & OKR =======================

  app.get('/api/performance/goals', async (req) => {
    const q = parse(
      z.object({
        employee_id: z.coerce.number().int().positive().optional(),
        status: goalStatus.optional(),
        kind: goalKind.optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.employee_id) {
      where.push('employee_id = ?');
      params.push(q.employee_id);
    }
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    const goals = getDb()
      .prepare(
        `SELECT * FROM goals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at, id`,
      )
      .all(...params);
    return { goals };
  });

  app.post('/api/performance/goals', async (req, reply) => {
    const body = parse(goalCreateSchema, req.body);
    ensureEmployeeExists(body.employee_id);
    if (body.kind === 'key_result') {
      if (!body.parent_goal_id) throw badRequest('Key Results benötigen ein übergeordnetes Objective');
      const parent = getGoal(body.parent_goal_id);
      if (parent.kind !== 'objective') {
        throw conflict('Das übergeordnete Ziel muss ein Objective sein');
      }
      if (parent.employee_id !== body.employee_id) {
        throw conflict('Key Result und Objective müssen derselben Person gehören');
      }
    } else if (body.parent_goal_id) {
      throw badRequest('Nur Key Results dürfen ein übergeordnetes Ziel haben');
    }
    const goal = inTransaction(() => {
      const info = getDb()
        .prepare(
          `INSERT INTO goals (employee_id, title, description, kind, parent_goal_id, metric,
             target_value, current_value, progress, period_from, period_to, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.employee_id,
          body.title,
          body.description ?? null,
          body.kind,
          body.parent_goal_id ?? null,
          body.metric ?? null,
          body.target_value ?? null,
          body.current_value ?? null,
          body.progress,
          body.period_from ?? null,
          body.period_to ?? null,
          body.status,
        );
      const id = Number(info.lastInsertRowid);
      if (body.kind === 'key_result') recomputeObjectiveProgress(body.parent_goal_id!);
      return getGoal(id);
    });
    audit(req, 'goal.created', 'goal', goal.id, { title: goal.title, kind: goal.kind });
    reply.code(201);
    return { goal };
  });

  app.put('/api/performance/goals/:id', async (req) => {
    const id = idParam(req);
    const existing = getGoal(id);
    const body = parse(goalUpdateSchema, req.body);
    const merged = { ...existing, ...body };
    const goal = inTransaction(() => {
      getDb()
        .prepare(
          `UPDATE goals SET title = ?, description = ?, metric = ?, target_value = ?,
             current_value = ?, progress = ?, period_from = ?, period_to = ?, status = ?
           WHERE id = ?`,
        )
        .run(
          merged.title,
          merged.description ?? null,
          merged.metric ?? null,
          merged.target_value ?? null,
          merged.current_value ?? null,
          merged.progress,
          merged.period_from ?? null,
          merged.period_to ?? null,
          merged.status,
          id,
        );
      if (existing.parent_goal_id) recomputeObjectiveProgress(existing.parent_goal_id);
      return getGoal(id);
    });
    audit(req, 'goal.updated', 'goal', id, body);
    return { goal };
  });

  app.post('/api/performance/goals/:id/progress', async (req) => {
    const id = idParam(req);
    const existing = getGoal(id);
    const body = parse(goalProgressSchema, req.body);
    if (existing.kind === 'objective') {
      const hasKrs = getDb()
        .prepare('SELECT COUNT(*) AS n FROM goals WHERE parent_goal_id = ?')
        .get(id) as { n: number };
      if (hasKrs.n > 0) {
        throw conflict('Der Fortschritt eines Objectives mit Key Results wird automatisch berechnet');
      }
    }
    const goal = inTransaction(() => {
      getDb()
        .prepare('UPDATE goals SET progress = ?, current_value = ?, status = ? WHERE id = ?')
        .run(
          body.progress,
          body.current_value !== undefined ? body.current_value : existing.current_value,
          body.status ?? existing.status,
          id,
        );
      if (existing.parent_goal_id) recomputeObjectiveProgress(existing.parent_goal_id);
      return getGoal(id);
    });
    const parent = goal.parent_goal_id ? getGoal(goal.parent_goal_id) : null;
    audit(req, 'goal.progress_updated', 'goal', id, { progress: body.progress });
    return { goal, parent };
  });

  app.delete('/api/performance/goals/:id', async (req, reply) => {
    const id = idParam(req);
    const goal = getGoal(id);
    inTransaction(() => {
      getDb().prepare('DELETE FROM goals WHERE id = ?').run(id);
      if (goal.parent_goal_id) recomputeObjectiveProgress(goal.parent_goal_id);
    });
    audit(req, 'goal.deleted', 'goal', id, { title: goal.title });
    reply.code(204);
  });

  // ======================= Beurteilungen: Zyklen =======================

  app.get('/api/performance/review-cycles', async () => {
    const cycles = getDb()
      .prepare('SELECT * FROM review_cycles ORDER BY period_from DESC, id DESC')
      .all();
    return { cycles };
  });

  app.post('/api/performance/review-cycles', async (req, reply) => {
    const body = parse(cycleCreateSchema, req.body);
    if (body.period_to < body.period_from) throw badRequest('Zeitraum-Ende liegt vor dem Beginn');
    const info = getDb()
      .prepare(
        `INSERT INTO review_cycles (name, kind, period_from, period_to, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(body.name, body.kind, body.period_from, body.period_to, body.status);
    const id = Number(info.lastInsertRowid);
    audit(req, 'review_cycle.created', 'review_cycle', id, { name: body.name });
    reply.code(201);
    return { cycle: getRowOrThrow('review_cycles', id, 'Zyklus nicht gefunden') };
  });

  app.put('/api/performance/review-cycles/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('review_cycles', id, 'Zyklus nicht gefunden');
    const body = parse(cycleCreateSchema.partial(), req.body);
    const merged = { ...existing, ...body } as Record<string, string>;
    if (merged.period_to < merged.period_from) throw badRequest('Zeitraum-Ende liegt vor dem Beginn');
    getDb()
      .prepare(
        'UPDATE review_cycles SET name = ?, kind = ?, period_from = ?, period_to = ?, status = ? WHERE id = ?',
      )
      .run(merged.name, merged.kind, merged.period_from, merged.period_to, merged.status, id);
    audit(req, 'review_cycle.updated', 'review_cycle', id, body);
    return { cycle: getRowOrThrow('review_cycles', id, 'Zyklus nicht gefunden') };
  });

  app.delete('/api/performance/review-cycles/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('review_cycles', id, 'Zyklus nicht gefunden');
    getDb().prepare('DELETE FROM review_cycles WHERE id = ?').run(id);
    audit(req, 'review_cycle.deleted', 'review_cycle', id);
    reply.code(204);
  });

  /** Teilnehmerübersicht eines Zyklus: Reviews je Mitarbeiter:in mit Fortschritt. */
  app.get('/api/performance/review-cycles/:id/overview', async (req) => {
    const id = idParam(req);
    getRowOrThrow('review_cycles', id, 'Zyklus nicht gefunden');
    const participants = getDb()
      .prepare(
        `SELECT r.employee_id, e.first_name, e.last_name,
                COUNT(*) AS reviews_total,
                SUM(CASE WHEN r.status = 'abgeschlossen' THEN 1 ELSE 0 END) AS reviews_completed,
                AVG(CASE WHEN r.status = 'abgeschlossen' THEN r.overall_score END) AS avg_overall_score
         FROM reviews r
         JOIN employees e ON e.id = r.employee_id
         WHERE r.cycle_id = ?
         GROUP BY r.employee_id
         ORDER BY e.last_name, e.first_name`,
      )
      .all(id);
    return { participants };
  });

  // ======================= Beurteilungen: Bögen =======================

  app.get('/api/performance/review-templates', async () => {
    const rows = getDb().prepare('SELECT * FROM review_templates ORDER BY name').all() as {
      criteria: string;
    }[];
    return { templates: rows.map((r) => ({ ...r, criteria: parseTemplateCriteria(r) })) };
  });

  app.post('/api/performance/review-templates', async (req, reply) => {
    const body = parse(templateSchema, req.body);
    const keys = new Set(body.criteria.map((c) => c.key));
    if (keys.size !== body.criteria.length) {
      throw badRequest('Kriterien-Schlüssel müssen eindeutig sein');
    }
    const info = getDb()
      .prepare('INSERT INTO review_templates (name, criteria) VALUES (?, ?)')
      .run(body.name, JSON.stringify(body.criteria));
    const id = Number(info.lastInsertRowid);
    audit(req, 'review_template.created', 'review_template', id, { name: body.name });
    reply.code(201);
    return { template: { id, name: body.name, criteria: body.criteria } };
  });

  app.put('/api/performance/review-templates/:id', async (req) => {
    const id = idParam(req);
    getRowOrThrow('review_templates', id, 'Bogen nicht gefunden');
    const body = parse(templateSchema, req.body);
    const keys = new Set(body.criteria.map((c) => c.key));
    if (keys.size !== body.criteria.length) {
      throw badRequest('Kriterien-Schlüssel müssen eindeutig sein');
    }
    getDb()
      .prepare('UPDATE review_templates SET name = ?, criteria = ? WHERE id = ?')
      .run(body.name, JSON.stringify(body.criteria), id);
    audit(req, 'review_template.updated', 'review_template', id, { name: body.name });
    return { template: { id, name: body.name, criteria: body.criteria } };
  });

  app.delete('/api/performance/review-templates/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('review_templates', id, 'Bogen nicht gefunden');
    const used = getDb()
      .prepare('SELECT COUNT(*) AS n FROM reviews WHERE template_id = ?')
      .get(id) as { n: number };
    if (used.n > 0) throw conflict('Der Bogen wird bereits in Beurteilungen verwendet');
    getDb().prepare('DELETE FROM review_templates WHERE id = ?').run(id);
    audit(req, 'review_template.deleted', 'review_template', id);
    reply.code(204);
  });

  // ======================= Beurteilungen: Reviews =======================

  app.get('/api/performance/reviews', async (req) => {
    const q = parse(
      z.object({
        cycle_id: z.coerce.number().int().positive().optional(),
        employee_id: z.coerce.number().int().positive().optional(),
        status: z.enum(['offen', 'in_bearbeitung', 'abgeschlossen']).optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.cycle_id) {
      where.push('cycle_id = ?');
      params.push(q.cycle_id);
    }
    if (q.employee_id) {
      where.push('employee_id = ?');
      params.push(q.employee_id);
    }
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    const rows = getDb()
      .prepare(
        `SELECT * FROM reviews ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...params) as Record<string, unknown>[];
    return { reviews: rows.map(reviewToApi) };
  });

  app.post('/api/performance/reviews', async (req, reply) => {
    const body = parse(reviewCreateSchema, req.body);
    getRowOrThrow('review_cycles', body.cycle_id, 'Zyklus nicht gefunden');
    getRowOrThrow('review_templates', body.template_id, 'Bogen nicht gefunden');
    ensureEmployeeExists(body.employee_id);
    if (body.kind === 'selbst') {
      if (body.reviewer_employee_id) {
        throw badRequest('Selbstbewertungen haben keine:n Reviewer:in');
      }
    } else {
      if (!body.reviewer_employee_id) throw badRequest('Reviewer:in ist erforderlich');
      ensureEmployeeExists(body.reviewer_employee_id);
      if (body.kind === 'feedback360' && body.reviewer_employee_id === body.employee_id) {
        throw badRequest('360°-Feedback: Reviewer:in darf nicht die bewertete Person sein');
      }
    }
    // Duplikate: je Zyklus+MA nur eine Selbst-/Vorgesetztenbewertung; 360°
    // nur einmal pro Reviewer:in.
    const dup = getDb()
      .prepare(
        `SELECT id FROM reviews
         WHERE cycle_id = ? AND employee_id = ? AND kind = ?
           AND (kind != 'feedback360' OR reviewer_employee_id = ?)`,
      )
      .get(body.cycle_id, body.employee_id, body.kind, body.reviewer_employee_id ?? null);
    if (dup) throw conflict('Für diese Kombination existiert bereits eine Beurteilung');
    const info = getDb()
      .prepare(
        `INSERT INTO reviews (cycle_id, employee_id, template_id, reviewer_employee_id, kind)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(body.cycle_id, body.employee_id, body.template_id, body.reviewer_employee_id ?? null, body.kind);
    const id = Number(info.lastInsertRowid);
    audit(req, 'review.created', 'review', id, body);
    reply.code(201);
    return { review: reviewToApi(getRowOrThrow('reviews', id, 'Beurteilung nicht gefunden')) };
  });

  app.put('/api/performance/reviews/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('reviews', id, 'Beurteilung nicht gefunden');
    if (existing.status === 'abgeschlossen') {
      throw conflict('Abgeschlossene Beurteilungen können nicht mehr bearbeitet werden');
    }
    const body = parse(reviewSaveSchema, req.body);
    const template = getRowOrThrow<{ criteria: string }>(
      'review_templates',
      Number(existing.template_id),
      'Bogen nicht gefunden',
    );
    const scores = body.scores ?? [];
    validateScores(scores, parseTemplateCriteria(template));
    getDb()
      .prepare(`UPDATE reviews SET scores = ?, summary = ?, status = 'in_bearbeitung' WHERE id = ?`)
      .run(JSON.stringify(scores), body.summary ?? null, id);
    audit(req, 'review.saved', 'review', id);
    return { review: reviewToApi(getRowOrThrow('reviews', id, 'Beurteilung nicht gefunden')) };
  });

  /** Abschluss einer einzelnen Beurteilung: alle Kriterien bewertet → Gesamtergebnis. */
  app.post('/api/performance/reviews/:id/complete', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('reviews', id, 'Beurteilung nicht gefunden');
    if (existing.status === 'abgeschlossen') throw conflict('Die Beurteilung ist bereits abgeschlossen');
    const template = getRowOrThrow<{ criteria: string }>(
      'review_templates',
      Number(existing.template_id),
      'Bogen nicht gefunden',
    );
    const criteria = parseTemplateCriteria(template);
    const scores = JSON.parse(String(existing.scores ?? '[]')) as ReviewScore[];
    validateScores(scores, criteria);
    const missing = criteria.filter((c) => !scores.some((s) => s.key === c.key));
    if (missing.length > 0) {
      throw badRequest(`Es fehlen Bewertungen für: ${missing.map((c) => c.label).join(', ')}`);
    }
    const overall = Math.round((scores.reduce((sum, s) => sum + s.score, 0) / scores.length) * 100) / 100;
    getDb()
      .prepare(
        `UPDATE reviews SET status = 'abgeschlossen', overall_score = ?, completed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(overall, id);
    audit(req, 'review.completed', 'review', id, { overall_score: overall });
    return { review: reviewToApi(getRowOrThrow('reviews', id, 'Beurteilung nicht gefunden')) };
  });

  app.delete('/api/performance/reviews/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('reviews', id, 'Beurteilung nicht gefunden');
    getDb().prepare('DELETE FROM reviews WHERE id = ?').run(id);
    audit(req, 'review.deleted', 'review', id);
    reply.code(204);
  });

  /** 360°-/Gesamt-Aggregat je Zyklus+MA: Ø je Kriterium über alle abgeschlossenen Reviews. */
  app.get('/api/performance/reviews/aggregate/:cycleId/:employeeId', async (req) => {
    const p = parse(
      z.object({
        cycleId: z.coerce.number().int().positive(),
        employeeId: z.coerce.number().int().positive(),
      }),
      req.params,
    );
    const rows = getDb()
      .prepare(
        `SELECT r.scores, r.overall_score, r.template_id FROM reviews r
         WHERE r.cycle_id = ? AND r.employee_id = ? AND r.status = 'abgeschlossen'`,
      )
      .all(p.cycleId, p.employeeId) as { scores: string; overall_score: number | null; template_id: number }[];
    const labels = new Map<string, string>();
    for (const templateId of new Set(rows.map((r) => r.template_id))) {
      const t = getDb().prepare('SELECT criteria FROM review_templates WHERE id = ?').get(templateId) as
        | { criteria: string }
        | undefined;
      if (t) for (const c of parseTemplateCriteria(t)) labels.set(c.key, c.label);
    }
    const sums = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
      for (const s of JSON.parse(row.scores) as ReviewScore[]) {
        const entry = sums.get(s.key) ?? { sum: 0, count: 0 };
        entry.sum += s.score;
        entry.count += 1;
        sums.set(s.key, entry);
      }
    }
    const criteria = [...sums.entries()].map(([key, { sum, count }]) => ({
      key,
      label: labels.get(key) ?? key,
      avg_score: Math.round((sum / count) * 100) / 100,
      count,
    }));
    const overallValues = rows.map((r) => r.overall_score).filter((v): v is number => v !== null);
    const overall =
      overallValues.length > 0
        ? Math.round((overallValues.reduce((a, b) => a + b, 0) / overallValues.length) * 100) / 100
        : null;
    return {
      aggregate: {
        cycle_id: p.cycleId,
        employee_id: p.employeeId,
        reviews_count: rows.length,
        criteria,
        overall_score: overall,
      },
    };
  });

  // ======================= Entwicklungspläne =======================

  app.get('/api/performance/development-plans', async (req) => {
    const q = parse(z.object({ employee_id: z.coerce.number().int().positive().optional() }), req.query);
    const plans = getDb()
      .prepare(
        `SELECT * FROM development_plans ${q.employee_id ? 'WHERE employee_id = ?' : ''}
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...(q.employee_id ? [q.employee_id] : []));
    return { plans };
  });

  app.get('/api/performance/development-plans/:id', async (req) => {
    const id = idParam(req);
    const plan = getRowOrThrow('development_plans', id, 'Entwicklungsplan nicht gefunden');
    const measures = getDb()
      .prepare('SELECT * FROM development_measures WHERE plan_id = ? ORDER BY due_date IS NULL, due_date, id')
      .all(id);
    return { plan, measures };
  });

  app.post('/api/performance/development-plans', async (req, reply) => {
    const body = parse(planCreateSchema, req.body);
    ensureEmployeeExists(body.employee_id);
    const info = getDb()
      .prepare('INSERT INTO development_plans (employee_id, title, goal, status) VALUES (?, ?, ?, ?)')
      .run(body.employee_id, body.title, body.goal ?? null, body.status);
    const id = Number(info.lastInsertRowid);
    audit(req, 'development_plan.created', 'development_plan', id, { title: body.title });
    reply.code(201);
    return { plan: getRowOrThrow('development_plans', id, 'Entwicklungsplan nicht gefunden') };
  });

  app.put('/api/performance/development-plans/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('development_plans', id, 'Entwicklungsplan nicht gefunden');
    const body = parse(planUpdateSchema, req.body);
    const merged = { ...existing, ...body } as Record<string, unknown>;
    getDb()
      .prepare('UPDATE development_plans SET title = ?, goal = ?, status = ? WHERE id = ?')
      .run(merged.title, merged.goal ?? null, merged.status, id);
    audit(req, 'development_plan.updated', 'development_plan', id, body);
    return { plan: getRowOrThrow('development_plans', id, 'Entwicklungsplan nicht gefunden') };
  });

  app.delete('/api/performance/development-plans/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('development_plans', id, 'Entwicklungsplan nicht gefunden');
    getDb().prepare('DELETE FROM development_plans WHERE id = ?').run(id);
    audit(req, 'development_plan.deleted', 'development_plan', id);
    reply.code(204);
  });

  app.post('/api/performance/development-plans/:id/measures', async (req, reply) => {
    const planId = idParam(req);
    getRowOrThrow('development_plans', planId, 'Entwicklungsplan nicht gefunden');
    const body = parse(measureCreateSchema, req.body);
    if (body.owner_employee_id) ensureEmployeeExists(body.owner_employee_id);
    const info = getDb()
      .prepare(
        `INSERT INTO development_measures (plan_id, title, due_date, owner_employee_id, status, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(planId, body.title, body.due_date ?? null, body.owner_employee_id ?? null, body.status, body.note ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'development_measure.created', 'development_measure', id, { title: body.title });
    reply.code(201);
    return { measure: getRowOrThrow('development_measures', id, 'Maßnahme nicht gefunden') };
  });

  app.put('/api/performance/development-measures/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('development_measures', id, 'Maßnahme nicht gefunden');
    const body = parse(measureUpdateSchema, req.body);
    const merged = { ...existing, ...body } as Record<string, unknown>;
    getDb()
      .prepare(
        'UPDATE development_measures SET title = ?, due_date = ?, owner_employee_id = ?, status = ?, note = ? WHERE id = ?',
      )
      .run(merged.title, merged.due_date ?? null, merged.owner_employee_id ?? null, merged.status, merged.note ?? null, id);
    audit(req, 'development_measure.updated', 'development_measure', id, body);
    return { measure: getRowOrThrow('development_measures', id, 'Maßnahme nicht gefunden') };
  });

  app.delete('/api/performance/development-measures/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('development_measures', id, 'Maßnahme nicht gefunden');
    getDb().prepare('DELETE FROM development_measures WHERE id = ?').run(id);
    audit(req, 'development_measure.deleted', 'development_measure', id);
    reply.code(204);
  });

  // ======================= Karrierepfade =======================

  app.get('/api/performance/career-levels', async (req) => {
    const q = parse(z.object({ role_name: z.string().optional() }), req.query);
    const levels = getDb()
      .prepare(
        `SELECT * FROM career_levels ${q.role_name ? 'WHERE role_name = ?' : ''}
         ORDER BY role_name, level`,
      )
      .all(...(q.role_name ? [q.role_name] : []));
    return { levels };
  });

  app.post('/api/performance/career-levels', async (req, reply) => {
    const body = parse(careerLevelSchema, req.body);
    const dup = getDb()
      .prepare('SELECT id FROM career_levels WHERE role_name = ? AND level = ?')
      .get(body.role_name, body.level);
    if (dup) throw conflict('Für diese Rolle existiert das Level bereits');
    const info = getDb()
      .prepare('INSERT INTO career_levels (role_name, level, title, requirements) VALUES (?, ?, ?, ?)')
      .run(body.role_name, body.level, body.title, body.requirements ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'career_level.created', 'career_level', id, { role_name: body.role_name, level: body.level });
    reply.code(201);
    return { level: getRowOrThrow('career_levels', id, 'Karrierestufe nicht gefunden') };
  });

  app.put('/api/performance/career-levels/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('career_levels', id, 'Karrierestufe nicht gefunden');
    const body = parse(careerLevelSchema.partial(), req.body);
    const merged = { ...existing, ...body } as Record<string, unknown>;
    const dup = getDb()
      .prepare('SELECT id FROM career_levels WHERE role_name = ? AND level = ? AND id != ?')
      .get(merged.role_name, merged.level, id);
    if (dup) throw conflict('Für diese Rolle existiert das Level bereits');
    getDb()
      .prepare('UPDATE career_levels SET role_name = ?, level = ?, title = ?, requirements = ? WHERE id = ?')
      .run(merged.role_name, merged.level, merged.title, merged.requirements ?? null, id);
    audit(req, 'career_level.updated', 'career_level', id, body);
    return { level: getRowOrThrow('career_levels', id, 'Karrierestufe nicht gefunden') };
  });

  app.delete('/api/performance/career-levels/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('career_levels', id, 'Karrierestufe nicht gefunden');
    getDb().prepare('DELETE FROM career_levels WHERE id = ?').run(id);
    audit(req, 'career_level.deleted', 'career_level', id);
    reply.code(204);
  });

  /** Aktuelles Level, nächster Karriereschritt (Level+1 derselben Rolle) und Historie. */
  app.get('/api/performance/employee-levels/:id', async (req) => {
    const employeeId = idParam(req);
    ensureEmployeeExists(employeeId);
    const history = getDb()
      .prepare(
        `SELECT el.*, cl.role_name, cl.level, cl.title, cl.requirements
         FROM employee_levels el JOIN career_levels cl ON cl.id = el.career_level_id
         WHERE el.employee_id = ? ORDER BY el.since_date DESC, el.id DESC`,
      )
      .all(employeeId) as ({ role_name: string; level: number } & Record<string, unknown>)[];
    const current = history[0] ?? null;
    const next = current
      ? (getDb()
          .prepare('SELECT * FROM career_levels WHERE role_name = ? AND level = ?')
          .get(current.role_name, current.level + 1) ?? null)
      : null;
    return { current, next, history };
  });

  app.post('/api/performance/employee-levels', async (req, reply) => {
    const body = parse(employeeLevelSchema, req.body);
    ensureEmployeeExists(body.employee_id);
    getRowOrThrow('career_levels', body.career_level_id, 'Karrierestufe nicht gefunden');
    const info = getDb()
      .prepare('INSERT INTO employee_levels (employee_id, career_level_id, since_date) VALUES (?, ?, ?)')
      .run(body.employee_id, body.career_level_id, body.since_date);
    const id = Number(info.lastInsertRowid);
    audit(req, 'employee_level.assigned', 'employee_level', id, body);
    reply.code(201);
    return { employee_level: getRowOrThrow('employee_levels', id, 'Eintrag nicht gefunden') };
  });

  // ======================= Skills =======================

  app.get('/api/performance/skills', async () => {
    const skills = getDb().prepare('SELECT * FROM skills ORDER BY category, name').all();
    return { skills };
  });

  /** Skill-Matrix: Mitarbeitende × Skills mit Levels (+ Filterlisten). */
  app.get('/api/performance/skills/matrix', async (req) => {
    const q = parse(
      z.object({
        department_id: z.coerce.number().int().positive().optional(),
        team_id: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const where: string[] = [`e.status = 'aktiv'`];
    const params: unknown[] = [];
    if (q.department_id) {
      where.push('e.department_id = ?');
      params.push(q.department_id);
    }
    if (q.team_id) {
      where.push('e.team_id = ?');
      params.push(q.team_id);
    }
    const employees = getDb()
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, e.job_title, e.department_id, e.team_id
         FROM employees e WHERE ${where.join(' AND ')} ORDER BY e.last_name, e.first_name`,
      )
      .all(...params);
    const skills = getDb().prepare('SELECT * FROM skills ORDER BY category, name').all();
    const levels = getDb()
      .prepare('SELECT employee_id, skill_id, level, assessed_at FROM employee_skills')
      .all();
    const departments = getDb().prepare('SELECT id, name FROM departments ORDER BY name').all();
    const teams = getDb().prepare('SELECT id, name, department_id FROM teams ORDER BY name').all();
    return { employees, skills, levels, departments, teams };
  });

  /** Lückenanalyse: Soll-Profil einer Rolle vs. Ist-Levels einer Person. */
  app.get('/api/performance/skills/gap/:id', async (req) => {
    const employeeId = idParam(req);
    const employee = getDb()
      .prepare('SELECT id, job_title FROM employees WHERE id = ?')
      .get(employeeId) as { id: number; job_title: string | null } | undefined;
    if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
    const q = parse(z.object({ role_name: z.string().optional() }), req.query);
    const roleName = q.role_name ?? employee.job_title;
    if (!roleName) throw badRequest('Keine Rolle angegeben und kein Jobtitel hinterlegt');
    const gaps = getDb()
      .prepare(
        `SELECT p.skill_id, s.name AS skill_name, p.required_level,
                COALESCE(es.level, 0) AS current_level,
                MAX(p.required_level - COALESCE(es.level, 0), 0) AS gap
         FROM role_skill_profiles p
         JOIN skills s ON s.id = p.skill_id
         LEFT JOIN employee_skills es ON es.skill_id = p.skill_id AND es.employee_id = ?
         WHERE p.role_name = ?
         ORDER BY gap DESC, s.name`,
      )
      .all(employeeId, roleName);
    return { role_name: roleName, gaps };
  });

  app.post('/api/performance/skills', async (req, reply) => {
    const body = parse(skillSchema, req.body);
    const dup = getDb().prepare('SELECT id FROM skills WHERE name = ?').get(body.name);
    if (dup) throw conflict('Ein Skill mit diesem Namen existiert bereits');
    const info = getDb()
      .prepare('INSERT INTO skills (name, category) VALUES (?, ?)')
      .run(body.name, body.category ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'skill.created', 'skill', id, { name: body.name });
    reply.code(201);
    return { skill: getRowOrThrow('skills', id, 'Skill nicht gefunden') };
  });

  app.put('/api/performance/skills/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('skills', id, 'Skill nicht gefunden');
    const body = parse(skillSchema.partial(), req.body);
    const merged = { ...existing, ...body } as Record<string, unknown>;
    const dup = getDb().prepare('SELECT id FROM skills WHERE name = ? AND id != ?').get(merged.name, id);
    if (dup) throw conflict('Ein Skill mit diesem Namen existiert bereits');
    getDb()
      .prepare('UPDATE skills SET name = ?, category = ? WHERE id = ?')
      .run(merged.name, merged.category ?? null, id);
    audit(req, 'skill.updated', 'skill', id, body);
    return { skill: getRowOrThrow('skills', id, 'Skill nicht gefunden') };
  });

  app.delete('/api/performance/skills/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('skills', id, 'Skill nicht gefunden');
    getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
    audit(req, 'skill.deleted', 'skill', id);
    reply.code(204);
  });

  /** Level einer Person für einen Skill setzen (Upsert). */
  app.put('/api/performance/employee-skills', async (req) => {
    const body = parse(employeeSkillSchema, req.body);
    ensureEmployeeExists(body.employee_id);
    getRowOrThrow('skills', body.skill_id, 'Skill nicht gefunden');
    getDb()
      .prepare(
        `INSERT INTO employee_skills (employee_id, skill_id, level, assessed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(employee_id, skill_id) DO UPDATE SET level = excluded.level, assessed_at = excluded.assessed_at`,
      )
      .run(body.employee_id, body.skill_id, body.level, body.assessed_at ?? todayIso());
    audit(req, 'employee_skill.set', 'employee', body.employee_id, body);
    const entry = getDb()
      .prepare('SELECT * FROM employee_skills WHERE employee_id = ? AND skill_id = ?')
      .get(body.employee_id, body.skill_id);
    return { employee_skill: entry };
  });

  app.delete('/api/performance/employee-skills/:employeeId/:skillId', async (req, reply) => {
    const p = parse(
      z.object({
        employeeId: z.coerce.number().int().positive(),
        skillId: z.coerce.number().int().positive(),
      }),
      req.params,
    );
    const info = getDb()
      .prepare('DELETE FROM employee_skills WHERE employee_id = ? AND skill_id = ?')
      .run(p.employeeId, p.skillId);
    if (info.changes === 0) throw notFound('Skill-Zuordnung nicht gefunden');
    audit(req, 'employee_skill.removed', 'employee', p.employeeId, { skill_id: p.skillId });
    reply.code(204);
  });

  // ======================= Soll-Profile =======================

  app.get('/api/performance/role-skill-profiles', async (req) => {
    const q = parse(z.object({ role_name: z.string().optional() }), req.query);
    const profiles = getDb()
      .prepare(
        `SELECT p.*, s.name AS skill_name FROM role_skill_profiles p
         JOIN skills s ON s.id = p.skill_id
         ${q.role_name ? 'WHERE p.role_name = ?' : ''}
         ORDER BY p.role_name, s.name`,
      )
      .all(...(q.role_name ? [q.role_name] : []));
    return { profiles };
  });

  app.post('/api/performance/role-skill-profiles', async (req, reply) => {
    const body = parse(roleProfileSchema, req.body);
    getRowOrThrow('skills', body.skill_id, 'Skill nicht gefunden');
    const dup = getDb()
      .prepare('SELECT id FROM role_skill_profiles WHERE role_name = ? AND skill_id = ?')
      .get(body.role_name, body.skill_id);
    if (dup) throw conflict('Für diese Rolle ist der Skill bereits im Soll-Profil');
    const info = getDb()
      .prepare('INSERT INTO role_skill_profiles (role_name, skill_id, required_level) VALUES (?, ?, ?)')
      .run(body.role_name, body.skill_id, body.required_level);
    const id = Number(info.lastInsertRowid);
    audit(req, 'role_skill_profile.created', 'role_skill_profile', id, body);
    reply.code(201);
    return { profile: getRowOrThrow('role_skill_profiles', id, 'Soll-Profil nicht gefunden') };
  });

  app.put('/api/performance/role-skill-profiles/:id', async (req) => {
    const id = idParam(req);
    getRowOrThrow('role_skill_profiles', id, 'Soll-Profil nicht gefunden');
    const body = parse(z.object({ required_level: z.number().int().min(1).max(5) }), req.body);
    getDb().prepare('UPDATE role_skill_profiles SET required_level = ? WHERE id = ?').run(body.required_level, id);
    audit(req, 'role_skill_profile.updated', 'role_skill_profile', id, body);
    return { profile: getRowOrThrow('role_skill_profiles', id, 'Soll-Profil nicht gefunden') };
  });

  app.delete('/api/performance/role-skill-profiles/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('role_skill_profiles', id, 'Soll-Profil nicht gefunden');
    getDb().prepare('DELETE FROM role_skill_profiles WHERE id = ?').run(id);
    audit(req, 'role_skill_profile.deleted', 'role_skill_profile', id);
    reply.code(204);
  });

  // ======================= Trainings =======================

  app.get('/api/performance/trainings', async () => {
    const trainings = getDb()
      .prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM training_registrations r
                  WHERE r.training_id = t.id AND r.status != 'storniert') AS registrations_count
         FROM trainings t ORDER BY t.title`,
      )
      .all();
    return { trainings };
  });

  /**
   * Fällige Pflichtschulungen je aktive:r Mitarbeiter:in: letzter Abschluss +
   * Intervall; nie absolviert = sofort fällig. Kennzeichnung überfällig /
   * bald fällig (60 Tage).
   */
  app.get('/api/performance/trainings/due', async () => {
    const rows = getDb()
      .prepare(
        `SELECT t.id AS training_id, t.title AS training_title, t.repeat_interval_months,
                e.id AS employee_id, e.first_name, e.last_name,
                (SELECT MAX(r.completed_at)
                   FROM training_registrations r
                  WHERE r.training_id = t.id AND r.employee_id = e.id AND r.status = 'abgeschlossen'
                ) AS last_completed_at
         FROM trainings t
         CROSS JOIN employees e
         WHERE t.mandatory = 1 AND e.status = 'aktiv'
         ORDER BY t.title, e.last_name, e.first_name`,
      )
      .all() as {
      training_id: number;
      training_title: string;
      repeat_interval_months: number | null;
      employee_id: number;
      first_name: string;
      last_name: string;
      last_completed_at: string | null;
    }[];
    const today = todayIso();
    const soonLimit = addDaysIso(today, 60);
    const due: TrainingDueEntry[] = [];
    for (const row of rows) {
      const lastCompleted = row.last_completed_at || null;
      if (!lastCompleted) {
        // Pflichttraining nie absolviert → sofort fällig.
        due.push({ ...row, last_completed_at: null, due_date: null, due_status: 'ueberfaellig' });
        continue;
      }
      if (row.repeat_interval_months === null) continue; // einmalig und erledigt
      const dueDate = addMonthsIso(lastCompleted, row.repeat_interval_months);
      if (dueDate < today) {
        due.push({ ...row, last_completed_at: lastCompleted, due_date: dueDate, due_status: 'ueberfaellig' });
      } else if (dueDate <= soonLimit) {
        due.push({ ...row, last_completed_at: lastCompleted, due_date: dueDate, due_status: 'bald_faellig' });
      }
    }
    return { due };
  });

  app.post('/api/performance/trainings', async (req, reply) => {
    const body = parse(trainingSchema, req.body);
    const info = getDb()
      .prepare(
        `INSERT INTO trainings (title, provider, kind, cost_cents, mandatory, repeat_interval_months, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.title,
        body.provider ?? null,
        body.kind,
        body.cost_cents ?? null,
        body.mandatory ? 1 : 0,
        body.repeat_interval_months ?? null,
        body.description ?? null,
      );
    const id = Number(info.lastInsertRowid);
    audit(req, 'training.created', 'training', id, { title: body.title });
    reply.code(201);
    return { training: getRowOrThrow('trainings', id, 'Training nicht gefunden') };
  });

  app.put('/api/performance/trainings/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('trainings', id, 'Training nicht gefunden');
    const body = parse(trainingSchema.partial(), req.body);
    const merged = {
      ...existing,
      ...body,
      mandatory: body.mandatory === undefined ? existing.mandatory : body.mandatory ? 1 : 0,
    } as Record<string, unknown>;
    getDb()
      .prepare(
        `UPDATE trainings SET title = ?, provider = ?, kind = ?, cost_cents = ?, mandatory = ?,
           repeat_interval_months = ?, description = ? WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.provider ?? null,
        merged.kind,
        merged.cost_cents ?? null,
        merged.mandatory,
        merged.repeat_interval_months ?? null,
        merged.description ?? null,
        id,
      );
    audit(req, 'training.updated', 'training', id, body);
    return { training: getRowOrThrow('trainings', id, 'Training nicht gefunden') };
  });

  app.delete('/api/performance/trainings/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('trainings', id, 'Training nicht gefunden');
    getDb().prepare('DELETE FROM trainings WHERE id = ?').run(id);
    audit(req, 'training.deleted', 'training', id);
    reply.code(204);
  });

  app.get('/api/performance/trainings/:id/registrations', async (req) => {
    const id = idParam(req);
    getRowOrThrow('trainings', id, 'Training nicht gefunden');
    const registrations = getDb()
      .prepare(
        `SELECT r.*, e.first_name, e.last_name FROM training_registrations r
         JOIN employees e ON e.id = r.employee_id
         WHERE r.training_id = ? ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(id);
    return { registrations };
  });

  app.post('/api/performance/training-registrations', async (req, reply) => {
    const body = parse(registrationCreateSchema, req.body);
    getRowOrThrow('trainings', body.training_id, 'Training nicht gefunden');
    ensureEmployeeExists(body.employee_id);
    const dup = getDb()
      .prepare(
        `SELECT id FROM training_registrations
         WHERE training_id = ? AND employee_id = ? AND status IN ('angemeldet', 'teilgenommen')`,
      )
      .get(body.training_id, body.employee_id);
    if (dup) throw conflict('Es besteht bereits eine aktive Anmeldung für dieses Training');
    const info = getDb()
      .prepare(
        `INSERT INTO training_registrations (training_id, employee_id, date, note)
         VALUES (?, ?, ?, ?)`,
      )
      .run(body.training_id, body.employee_id, body.date ?? null, body.note ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'training_registration.created', 'training_registration', id, body);
    reply.code(201);
    return { registration: getRowOrThrow('training_registrations', id, 'Anmeldung nicht gefunden') };
  });

  app.put('/api/performance/training-registrations/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('training_registrations', id, 'Anmeldung nicht gefunden');
    const body = parse(registrationUpdateSchema, req.body);
    const merged = { ...existing, ...body } as Record<string, unknown>;
    // Abschluss ohne explizites Datum → heute.
    if (body.status === 'abgeschlossen' && !merged.completed_at) merged.completed_at = todayIso();
    if (body.certificate_file_id) {
      getRowOrThrow('files', Number(body.certificate_file_id), 'Zertifikatsdatei nicht gefunden');
    }
    getDb()
      .prepare(
        `UPDATE training_registrations SET status = ?, date = ?, completed_at = ?,
           certificate_file_id = ?, note = ? WHERE id = ?`,
      )
      .run(
        merged.status,
        merged.date ?? null,
        merged.completed_at ?? null,
        merged.certificate_file_id ?? null,
        merged.note ?? null,
        id,
      );
    audit(req, 'training_registration.updated', 'training_registration', id, body);
    return { registration: getRowOrThrow('training_registrations', id, 'Anmeldung nicht gefunden') };
  });

  // ======================= Feedback-Gespräche =======================

  app.get('/api/performance/feedback-meetings', async (req) => {
    const q = parse(
      z.object({
        employee_id: z.coerce.number().int().positive().optional(),
        status: z.enum(['geplant', 'stattgefunden', 'abgesagt']).optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.employee_id) {
      where.push('m.employee_id = ?');
      params.push(q.employee_id);
    }
    if (q.status) {
      where.push('m.status = ?');
      params.push(q.status);
    }
    const meetings = getDb()
      .prepare(
        `SELECT m.*, e.first_name, e.last_name FROM feedback_meetings m
         JOIN employees e ON e.id = m.employee_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.scheduled_date DESC, m.id DESC`,
      )
      .all(...params);
    return { meetings };
  });

  app.get('/api/performance/feedback-meetings/:id', async (req) => {
    const id = idParam(req);
    const meeting = getRowOrThrow('feedback_meetings', id, 'Gespräch nicht gefunden');
    const actions = getDb()
      .prepare('SELECT * FROM feedback_actions WHERE meeting_id = ? ORDER BY due_date IS NULL, due_date, id')
      .all(id);
    return { meeting, actions };
  });

  app.post('/api/performance/feedback-meetings', async (req, reply) => {
    const body = parse(meetingCreateSchema, req.body);
    ensureEmployeeExists(body.employee_id);
    const info = getDb()
      .prepare(
        `INSERT INTO feedback_meetings (employee_id, kind, scheduled_date, notes, recurrence_months)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(body.employee_id, body.kind, body.scheduled_date, body.notes ?? null, body.recurrence_months ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'feedback_meeting.created', 'feedback_meeting', id, body);
    reply.code(201);
    return { meeting: getRowOrThrow('feedback_meetings', id, 'Gespräch nicht gefunden') };
  });

  app.put('/api/performance/feedback-meetings/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('feedback_meetings', id, 'Gespräch nicht gefunden');
    const body = parse(meetingUpdateSchema, req.body);
    if (body.status === 'stattgefunden') {
      throw badRequest('Bitte den Abschluss-Endpunkt verwenden (legt Folgetermine an)');
    }
    const merged = { ...existing, ...body } as Record<string, unknown>;
    getDb()
      .prepare(
        `UPDATE feedback_meetings SET kind = ?, scheduled_date = ?, notes = ?,
           recurrence_months = ?, status = ? WHERE id = ?`,
      )
      .run(merged.kind, merged.scheduled_date, merged.notes ?? null, merged.recurrence_months ?? null, merged.status, id);
    audit(req, 'feedback_meeting.updated', 'feedback_meeting', id, body);
    return { meeting: getRowOrThrow('feedback_meetings', id, 'Gespräch nicht gefunden') };
  });

  /** Abschluss: Status stattgefunden; bei Wiederholung wird der Folgetermin angelegt. */
  app.post('/api/performance/feedback-meetings/:id/complete', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<{
      status: string;
      employee_id: number;
      kind: string;
      notes: string | null;
      recurrence_months: number | null;
    }>('feedback_meetings', id, 'Gespräch nicht gefunden');
    if (existing.status !== 'geplant') {
      throw conflict('Nur geplante Gespräche können abgeschlossen werden');
    }
    const body = parse(meetingCompleteSchema, req.body ?? {});
    const heldDate = body.held_date ?? todayIso();
    const followUpId = inTransaction(() => {
      getDb()
        .prepare(`UPDATE feedback_meetings SET status = 'stattgefunden', held_date = ?, notes = ? WHERE id = ?`)
        .run(heldDate, body.notes !== undefined ? (body.notes ?? null) : existing.notes, id);
      if (!existing.recurrence_months) return null;
      const info = getDb()
        .prepare(
          `INSERT INTO feedback_meetings (employee_id, kind, scheduled_date, recurrence_months)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          existing.employee_id,
          existing.kind,
          addMonthsIso(heldDate, existing.recurrence_months),
          existing.recurrence_months,
        );
      return Number(info.lastInsertRowid);
    });
    audit(req, 'feedback_meeting.completed', 'feedback_meeting', id, {
      held_date: heldDate,
      follow_up_id: followUpId,
    });
    return {
      meeting: getRowOrThrow('feedback_meetings', id, 'Gespräch nicht gefunden'),
      follow_up: followUpId ? getRowOrThrow('feedback_meetings', followUpId, 'Folgetermin nicht gefunden') : null,
    };
  });

  app.delete('/api/performance/feedback-meetings/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('feedback_meetings', id, 'Gespräch nicht gefunden');
    getDb().prepare('DELETE FROM feedback_meetings WHERE id = ?').run(id);
    audit(req, 'feedback_meeting.deleted', 'feedback_meeting', id);
    reply.code(204);
  });

  app.post('/api/performance/feedback-meetings/:id/actions', async (req, reply) => {
    const meetingId = idParam(req);
    getRowOrThrow('feedback_meetings', meetingId, 'Gespräch nicht gefunden');
    const body = parse(actionCreateSchema, req.body);
    if (body.owner_employee_id) ensureEmployeeExists(body.owner_employee_id);
    const info = getDb()
      .prepare('INSERT INTO feedback_actions (meeting_id, title, due_date, owner_employee_id) VALUES (?, ?, ?, ?)')
      .run(meetingId, body.title, body.due_date ?? null, body.owner_employee_id ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'feedback_action.created', 'feedback_action', id, { title: body.title });
    reply.code(201);
    return { action: getRowOrThrow('feedback_actions', id, 'Maßnahme nicht gefunden') };
  });

  app.put('/api/performance/feedback-actions/:id', async (req) => {
    const id = idParam(req);
    const existing = getRowOrThrow<Record<string, unknown>>('feedback_actions', id, 'Maßnahme nicht gefunden');
    const body = parse(actionUpdateSchema, req.body);
    const merged = { ...existing, ...body } as Record<string, unknown>;
    getDb()
      .prepare('UPDATE feedback_actions SET title = ?, due_date = ?, owner_employee_id = ?, status = ? WHERE id = ?')
      .run(merged.title, merged.due_date ?? null, merged.owner_employee_id ?? null, merged.status, id);
    audit(req, 'feedback_action.updated', 'feedback_action', id, body);
    return { action: getRowOrThrow('feedback_actions', id, 'Maßnahme nicht gefunden') };
  });

  app.delete('/api/performance/feedback-actions/:id', async (req, reply) => {
    const id = idParam(req);
    getRowOrThrow('feedback_actions', id, 'Maßnahme nicht gefunden');
    getDb().prepare('DELETE FROM feedback_actions WHERE id = ?').run(id);
    audit(req, 'feedback_action.deleted', 'feedback_action', id);
    reply.code(204);
  });

  /** Erinnerungen: anstehende (14 Tage) + überfällige Gespräche, offene Maßnahmen. */
  app.get('/api/performance/feedback/reminders', async () => {
    const today = todayIso();
    const limit = addDaysIso(today, 14);
    const upcoming = getDb()
      .prepare(
        `SELECT m.*, e.first_name, e.last_name FROM feedback_meetings m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.status = 'geplant' AND m.scheduled_date >= ? AND m.scheduled_date <= ?
         ORDER BY m.scheduled_date`,
      )
      .all(today, limit);
    const overdue = getDb()
      .prepare(
        `SELECT m.*, e.first_name, e.last_name FROM feedback_meetings m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.status = 'geplant' AND m.scheduled_date < ?
         ORDER BY m.scheduled_date`,
      )
      .all(today);
    const open_actions = getDb()
      .prepare(
        `SELECT a.*, m.employee_id, m.kind AS meeting_kind, m.scheduled_date AS meeting_date,
                e.first_name, e.last_name
         FROM feedback_actions a
         JOIN feedback_meetings m ON m.id = a.meeting_id
         JOIN employees e ON e.id = m.employee_id
         WHERE a.status = 'offen'
         ORDER BY a.due_date IS NULL, a.due_date, a.id`,
      )
      .all();
    return { upcoming, overdue, open_actions };
  });
};
