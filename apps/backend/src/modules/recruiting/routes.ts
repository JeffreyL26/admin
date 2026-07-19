import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { signDownloadUrl } from '../../core/files.js';
import { todayIso } from '../../core/dates.js';

// ---------------------------------------------------------------------------
// Gemeinsame Helfer
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT erwartet');
// Interview-Zeitpunkt: Datum optional mit Uhrzeit ('YYYY-MM-DD' oder 'YYYY-MM-DD HH:MM').
const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/, 'Zeitpunkt im Format JJJJ-MM-TT [HH:MM] erwartet');
const idParam = z.object({ id: z.coerce.number().int().positive() });

const EMPLOYMENT_TYPES = [
  'vollzeit', 'teilzeit', 'minijob', 'werkstudent', 'praktikant', 'freiberufler', 'auszubildender',
] as const;
const SOURCES = [
  'website', 'stellenportal', 'linkedin', 'empfehlung', 'personalvermittlung',
  'initiativ', 'hochschule', 'sonstiges',
] as const;

function userId(req: { user: unknown }): number | null {
  return (req.user as { id?: number } | undefined)?.id ?? null;
}

/** Ganze Tage zwischen zwei ISO-Daten (auf das Datum reduziert). */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Stufen
// ---------------------------------------------------------------------------

interface StageRow {
  id: number;
  name: string;
  category: 'aktiv' | 'eingestellt' | 'abgelehnt';
  sort_order: number;
  color: string;
  active: number;
}

function allStages(): StageRow[] {
  return getDb()
    .prepare('SELECT * FROM recruiting_stages ORDER BY sort_order, id')
    .all() as StageRow[];
}

function stageById(id: number): StageRow {
  const row = getDb().prepare('SELECT * FROM recruiting_stages WHERE id = ?').get(id) as
    | StageRow
    | undefined;
  if (!row) throw badRequest('Unbekannte Pipeline-Stufe');
  return row;
}

function stageByCategory(category: 'eingestellt' | 'abgelehnt'): StageRow {
  const row = getDb()
    .prepare('SELECT * FROM recruiting_stages WHERE category = ? ORDER BY sort_order LIMIT 1')
    .get(category) as StageRow | undefined;
  if (!row) throw notFound(`Keine Stufe der Kategorie „${category}“ vorhanden`);
  return row;
}

function firstActiveStage(): StageRow {
  const row = getDb()
    .prepare("SELECT * FROM recruiting_stages WHERE category = 'aktiv' ORDER BY sort_order LIMIT 1")
    .get() as StageRow | undefined;
  if (!row) throw notFound('Keine aktive Pipeline-Stufe konfiguriert');
  return row;
}

function stageToJson(s: StageRow) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    sort_order: s.sort_order,
    color: s.color,
    active: s.active === 1,
  };
}

// ---------------------------------------------------------------------------
// Stellen
// ---------------------------------------------------------------------------

interface PostingRow {
  id: number;
  title: string;
  employment_type: string;
  department_id: number | null;
  team_id: number | null;
  location_id: number | null;
  hiring_manager_id: number | null;
  seats: number;
  employment_start: string | null;
  salary_min_cents: number | null;
  salary_max_cents: number | null;
  description: string | null;
  requirements: string | null;
  status: string;
  published_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const POSTING_SELECT = `
  SELECT p.*,
         d.name AS department_name,
         t.name AS team_name,
         l.name AS location_name,
         (m.first_name || ' ' || m.last_name) AS hiring_manager_name
  FROM job_postings p
  LEFT JOIN departments d ON d.id = p.department_id
  LEFT JOIN teams t ON t.id = p.team_id
  LEFT JOIN locations l ON l.id = p.location_id
  LEFT JOIN employees m ON m.id = p.hiring_manager_id
`;

function postingWithCounts(id: number): Record<string, unknown> {
  const db = getDb();
  const row = db.prepare(`${POSTING_SELECT} WHERE p.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('Stelle nicht gefunden');
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS application_count,
         SUM(CASE WHEN status = 'aktiv' THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN status = 'eingestellt' THEN 1 ELSE 0 END) AS hired_count
       FROM applications WHERE posting_id = ?`,
    )
    .get(id) as { application_count: number; active_count: number | null; hired_count: number | null };
  return {
    ...row,
    application_count: counts.application_count,
    active_count: counts.active_count ?? 0,
    hired_count: counts.hired_count ?? 0,
  };
}

const postingBodySchema = z.object({
  title: z.string().min(1, 'Titel fehlt'),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  department_id: z.number().int().positive().nullable().optional(),
  team_id: z.number().int().positive().nullable().optional(),
  location_id: z.number().int().positive().nullable().optional(),
  hiring_manager_id: z.number().int().positive().nullable().optional(),
  seats: z.number().int().min(1).max(999),
  employment_start: isoDate.nullable().optional(),
  salary_min_cents: z.number().int().min(0).nullable().optional(),
  salary_max_cents: z.number().int().min(0).nullable().optional(),
  description: z.string().nullable().optional(),
  requirements: z.string().nullable().optional(),
});

const POSTING_TRANSITIONS: Record<string, string[]> = {
  entwurf: ['veroeffentlicht', 'geschlossen'],
  veroeffentlicht: ['pausiert', 'besetzt', 'geschlossen'],
  pausiert: ['veroeffentlicht', 'besetzt', 'geschlossen'],
  besetzt: ['geschlossen', 'veroeffentlicht'],
  geschlossen: ['entwurf'],
};

// ---------------------------------------------------------------------------
// Bewerber:innen
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  source: string;
  headline: string | null;
  linkedin_url: string | null;
  photo_file_id: number | null;
  note: string | null;
  consent_until: string | null;
  created_at: string;
  updated_at: string;
}

const candidateBodySchema = z.object({
  first_name: z.string().min(1, 'Vorname fehlt'),
  last_name: z.string().min(1, 'Nachname fehlt'),
  email: z.string().email('Ungültige E-Mail').nullable().optional().or(z.literal('')),
  phone: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  source: z.enum(SOURCES),
  headline: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  photo_file_id: z.number().int().positive().nullable().optional(),
  note: z.string().nullable().optional(),
  consent_until: isoDate.nullable().optional(),
});

function getCandidate(id: number): CandidateRow {
  const row = getDb().prepare('SELECT * FROM candidates WHERE id = ?').get(id) as
    | CandidateRow
    | undefined;
  if (!row) throw notFound('Bewerber:in nicht gefunden');
  return row;
}

function candidateToJson(c: CandidateRow) {
  const count = (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ?')
      .get(c.id) as { n: number }
  ).n;
  return {
    ...c,
    photo_url: c.photo_file_id ? signDownloadUrl(c.photo_file_id) : null,
    application_count: count,
  };
}

// ---------------------------------------------------------------------------
// Bewerbungen
// ---------------------------------------------------------------------------

const APPLICATION_SELECT = `
  SELECT a.*,
         c.first_name AS candidate_first_name,
         c.last_name  AS candidate_last_name,
         c.email      AS candidate_email,
         p.title      AS posting_title,
         s.name       AS stage_name,
         s.category   AS stage_category,
         s.color      AS stage_color,
         (SELECT COUNT(*) FROM interviews i WHERE i.application_id = a.id) AS interview_count
  FROM applications a
  JOIN candidates c ON c.id = a.candidate_id
  JOIN job_postings p ON p.id = a.posting_id
  JOIN recruiting_stages s ON s.id = a.stage_id
`;

function applicationRow(id: number): Record<string, unknown> {
  const row = getDb().prepare(`${APPLICATION_SELECT} WHERE a.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('Bewerbung nicht gefunden');
  return enrichApplication(row);
}

function enrichApplication(row: Record<string, unknown>): Record<string, unknown> {
  const stageChanged = String(row.stage_changed_at ?? row.applied_at ?? todayIso());
  return { ...row, days_in_stage: daysBetween(stageChanged, todayIso()) };
}

function logEvent(
  applicationId: number,
  kind: string,
  opts: { body?: string | null; fromStage?: number | null; toStage?: number | null; userId?: number | null } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO application_events (application_id, kind, body, from_stage_id, to_stage_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      applicationId,
      kind,
      opts.body ?? null,
      opts.fromStage ?? null,
      opts.toStage ?? null,
      opts.userId ?? null,
    );
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

const scorecardSchema = z.array(
  z.object({ criterion: z.string().min(1), score: z.number().int().min(1).max(5) }),
);

const INTERVIEW_SELECT = `
  SELECT i.*,
         c.first_name AS candidate_first_name,
         c.last_name  AS candidate_last_name,
         p.title      AS posting_title
  FROM interviews i
  JOIN applications a ON a.id = i.application_id
  JOIN candidates c ON c.id = a.candidate_id
  JOIN job_postings p ON p.id = a.posting_id
`;

function interviewToJson(row: Record<string, unknown>): Record<string, unknown> {
  const ids = JSON.parse(String(row.interviewer_ids ?? '[]')) as number[];
  let names: string[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = getDb()
      .prepare(
        `SELECT (first_name || ' ' || last_name) AS name FROM employees WHERE id IN (${placeholders})`,
      )
      .all(...ids) as { name: string }[];
    names = rows.map((r) => r.name);
  }
  return {
    ...row,
    interviewer_ids: ids,
    interviewer_names: names,
    scorecard: JSON.parse(String(row.scorecard ?? '[]')),
  };
}

// ---------------------------------------------------------------------------
// Modul-Plugin
// ---------------------------------------------------------------------------

export const recruitingModule: FastifyPluginAsync = async (app) => {
  // ------------------------------------------------------------------ Org-Lookup
  app.get('/api/recruiting/org', async () => {
    const db = getDb();
    return {
      departments: db.prepare('SELECT id, name FROM departments ORDER BY name').all(),
      teams: db.prepare('SELECT id, name, department_id FROM teams ORDER BY name').all(),
      locations: db.prepare('SELECT id, name FROM locations ORDER BY name').all(),
    };
  });

  // ------------------------------------------------------------------ Stufen
  app.get('/api/recruiting/stages', async () => ({ stages: allStages().map(stageToJson) }));

  // ------------------------------------------------------------------ Stellen
  app.get('/api/recruiting/postings', async (req) => {
    const q = parse(
      z.object({
        status: z.string().optional(),
        search: z.string().optional(),
        department_id: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) {
      where.push('p.status = ?');
      params.push(q.status);
    }
    if (q.department_id) {
      where.push('p.department_id = ?');
      params.push(q.department_id);
    }
    if (q.search) {
      where.push('(p.title LIKE ? OR p.description LIKE ?)');
      const like = `%${q.search}%`;
      params.push(like, like);
    }
    const rows = getDb()
      .prepare(
        `${POSTING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE p.status WHEN 'veroeffentlicht' THEN 0 WHEN 'pausiert' THEN 1
                  WHEN 'entwurf' THEN 2 WHEN 'besetzt' THEN 3 ELSE 4 END, p.updated_at DESC`,
      )
      .all(...params) as PostingRow[];
    const postings = rows.map((r) => postingWithCounts(r.id));
    return { postings };
  });

  app.get('/api/recruiting/postings/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const posting = postingWithCounts(id);
    // Verteilung über die aktiven Stufen (für die Detailanzeige).
    const stageCounts = getDb()
      .prepare(
        `SELECT s.id AS stage_id, s.name, s.color, COUNT(a.id) AS count
         FROM recruiting_stages s
         LEFT JOIN applications a ON a.stage_id = s.id AND a.posting_id = ?
         WHERE s.category = 'aktiv'
         GROUP BY s.id ORDER BY s.sort_order`,
      )
      .all(id);
    return { posting: { ...posting, stage_counts: stageCounts } };
  });

  app.post('/api/recruiting/postings', async (req, reply) => {
    const body = parse(postingBodySchema, req.body);
    if (
      body.salary_min_cents != null &&
      body.salary_max_cents != null &&
      body.salary_max_cents < body.salary_min_cents
    ) {
      throw badRequest('Das Maximalgehalt darf nicht unter dem Mindestgehalt liegen');
    }
    const info = getDb()
      .prepare(
        `INSERT INTO job_postings
           (title, employment_type, department_id, team_id, location_id, hiring_manager_id,
            seats, employment_start, salary_min_cents, salary_max_cents, description, requirements,
            status, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entwurf', ?)`,
      )
      .run(
        body.title,
        body.employment_type,
        body.department_id ?? null,
        body.team_id ?? null,
        body.location_id ?? null,
        body.hiring_manager_id ?? null,
        body.seats,
        body.employment_start ?? null,
        body.salary_min_cents ?? null,
        body.salary_max_cents ?? null,
        body.description ?? null,
        body.requirements ?? null,
        userId(req),
      );
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'job_posting', id, { title: body.title });
    reply.code(201);
    return { posting: postingWithCounts(id) };
  });

  app.put('/api/recruiting/postings/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const existing = getDb().prepare('SELECT id FROM job_postings WHERE id = ?').get(id);
    if (!existing) throw notFound('Stelle nicht gefunden');
    const body = parse(postingBodySchema, req.body);
    if (
      body.salary_min_cents != null &&
      body.salary_max_cents != null &&
      body.salary_max_cents < body.salary_min_cents
    ) {
      throw badRequest('Das Maximalgehalt darf nicht unter dem Mindestgehalt liegen');
    }
    getDb()
      .prepare(
        `UPDATE job_postings SET title = ?, employment_type = ?, department_id = ?, team_id = ?,
           location_id = ?, hiring_manager_id = ?, seats = ?, employment_start = ?,
           salary_min_cents = ?, salary_max_cents = ?, description = ?, requirements = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        body.title,
        body.employment_type,
        body.department_id ?? null,
        body.team_id ?? null,
        body.location_id ?? null,
        body.hiring_manager_id ?? null,
        body.seats,
        body.employment_start ?? null,
        body.salary_min_cents ?? null,
        body.salary_max_cents ?? null,
        body.description ?? null,
        body.requirements ?? null,
        id,
      );
    audit(req, 'update', 'job_posting', id, { title: body.title });
    return { posting: postingWithCounts(id) };
  });

  app.post('/api/recruiting/postings/:id/status', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ status: z.enum(['entwurf', 'veroeffentlicht', 'pausiert', 'besetzt', 'geschlossen']) }),
      req.body,
    );
    const row = getDb().prepare('SELECT status FROM job_postings WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!row) throw notFound('Stelle nicht gefunden');
    if (row.status === body.status) return { posting: postingWithCounts(id) };
    if (!POSTING_TRANSITIONS[row.status]?.includes(body.status)) {
      throw conflict(`Statuswechsel von „${row.status}“ nach „${body.status}“ ist nicht zulässig`);
    }
    const now = todayIso();
    const publishedAt = body.status === 'veroeffentlicht' ? now : null;
    const closedAt = body.status === 'geschlossen' || body.status === 'besetzt' ? now : null;
    getDb()
      .prepare(
        `UPDATE job_postings
         SET status = ?,
             published_at = COALESCE(?, published_at),
             closed_at = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(body.status, publishedAt, closedAt, id);
    audit(req, 'status', 'job_posting', id, { from: row.status, to: body.status });
    return { posting: postingWithCounts(id) };
  });

  app.delete('/api/recruiting/postings/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const existing = getDb().prepare('SELECT title FROM job_postings WHERE id = ?').get(id) as
      | { title: string }
      | undefined;
    if (!existing) throw notFound('Stelle nicht gefunden');
    const apps = (
      getDb().prepare('SELECT COUNT(*) AS n FROM applications WHERE posting_id = ?').get(id) as {
        n: number;
      }
    ).n;
    if (apps > 0) {
      throw conflict(
        'Zu dieser Stelle existieren Bewerbungen — bitte stattdessen den Status auf „Geschlossen“ setzen',
      );
    }
    getDb().prepare('DELETE FROM job_postings WHERE id = ?').run(id);
    audit(req, 'delete', 'job_posting', id, { title: existing.title });
    reply.code(204);
  });

  // ------------------------------------------------------------------ Bewerber:innen
  app.get('/api/recruiting/candidates', async (req) => {
    const q = parse(z.object({ search: z.string().optional() }), req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.search) {
      where.push(
        "(c.first_name LIKE ? OR c.last_name LIKE ? OR (c.first_name || ' ' || c.last_name) LIKE ? OR c.email LIKE ? OR c.headline LIKE ?)",
      );
      const like = `%${q.search}%`;
      params.push(like, like, like, like, like);
    }
    const rows = getDb()
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id) AS application_count
         FROM candidates c
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`,
      )
      .all(...params) as (CandidateRow & { application_count: number })[];
    return {
      candidates: rows.map((c) => ({
        ...c,
        photo_url: c.photo_file_id ? signDownloadUrl(c.photo_file_id) : null,
      })),
    };
  });

  app.get('/api/recruiting/candidates/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const candidate = getCandidate(id);
    const applications = getDb()
      .prepare(`${APPLICATION_SELECT} WHERE a.candidate_id = ? ORDER BY a.applied_at DESC`)
      .all(id) as Record<string, unknown>[];
    return {
      candidate: {
        ...candidateToJson(candidate),
        applications: applications.map(enrichApplication),
      },
    };
  });

  app.post('/api/recruiting/candidates', async (req, reply) => {
    const body = parse(candidateBodySchema, req.body);
    const id = insertCandidate(body);
    audit(req, 'create', 'candidate', id, { name: `${body.first_name} ${body.last_name}` });
    reply.code(201);
    return { candidate: candidateToJson(getCandidate(id)) };
  });

  app.put('/api/recruiting/candidates/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    getCandidate(id);
    const body = parse(candidateBodySchema, req.body);
    getDb()
      .prepare(
        `UPDATE candidates SET first_name = ?, last_name = ?, email = ?, phone = ?, city = ?,
           source = ?, headline = ?, linkedin_url = ?, photo_file_id = ?, note = ?, consent_until = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        body.first_name,
        body.last_name,
        body.email || null,
        body.phone ?? null,
        body.city ?? null,
        body.source,
        body.headline ?? null,
        body.linkedin_url ?? null,
        body.photo_file_id ?? null,
        body.note ?? null,
        body.consent_until ?? null,
        id,
      );
    audit(req, 'update', 'candidate', id, { name: `${body.first_name} ${body.last_name}` });
    return { candidate: candidateToJson(getCandidate(id)) };
  });

  app.delete('/api/recruiting/candidates/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const candidate = getCandidate(id);
    getDb().prepare('DELETE FROM candidates WHERE id = ?').run(id);
    audit(req, 'delete', 'candidate', id, {
      name: `${candidate.first_name} ${candidate.last_name}`,
    });
    reply.code(204);
  });

  // ------------------------------------------------------------------ Bewerbungen
  app.get('/api/recruiting/applications', async (req) => {
    const q = parse(
      z.object({
        posting_id: z.coerce.number().int().positive().optional(),
        stage_id: z.coerce.number().int().positive().optional(),
        status: z.string().optional(),
        search: z.string().optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.posting_id) {
      where.push('a.posting_id = ?');
      params.push(q.posting_id);
    }
    if (q.stage_id) {
      where.push('a.stage_id = ?');
      params.push(q.stage_id);
    }
    if (q.status) {
      where.push('a.status = ?');
      params.push(q.status);
    }
    if (q.search) {
      where.push(
        "((c.first_name || ' ' || c.last_name) LIKE ? OR c.email LIKE ? OR p.title LIKE ?)",
      );
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }
    const rows = getDb()
      .prepare(
        `${APPLICATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.sort_order, a.rating DESC NULLS LAST, a.applied_at DESC`,
      )
      .all(...params) as Record<string, unknown>[];
    return { applications: rows.map(enrichApplication) };
  });

  app.get('/api/recruiting/applications/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const application = applicationRow(id);
    const events = getDb()
      .prepare(
        `SELECT e.*, u.name AS user_name,
                fs.name AS from_stage_name, ts.name AS to_stage_name
         FROM application_events e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN recruiting_stages fs ON fs.id = e.from_stage_id
         LEFT JOIN recruiting_stages ts ON ts.id = e.to_stage_id
         WHERE e.application_id = ? ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all(id);
    const interviews = getDb()
      .prepare(`${INTERVIEW_SELECT} WHERE i.application_id = ? ORDER BY i.scheduled_at DESC`)
      .all(id) as Record<string, unknown>[];
    const cvId = application.cv_file_id as number | null;
    return {
      application: {
        ...application,
        cv_url: cvId ? signDownloadUrl(cvId) : null,
        events,
        interviews: interviews.map(interviewToJson),
      },
    };
  });

  app.post('/api/recruiting/applications', async (req, reply) => {
    // Entweder bestehende:r Bewerber:in (candidate_id) ODER inline neue:r (candidate).
    const body = parse(
      z.object({
        posting_id: z.number().int().positive(),
        candidate_id: z.number().int().positive().optional(),
        candidate: candidateBodySchema.optional(),
        applied_at: isoDate.optional(),
        source: z.enum(SOURCES).nullable().optional(),
        cover_letter: z.string().nullable().optional(),
        cv_file_id: z.number().int().positive().nullable().optional(),
        salary_expectation_cents: z.number().int().min(0).nullable().optional(),
        available_from: isoDate.nullable().optional(),
        rating: z.number().int().min(1).max(5).nullable().optional(),
      }),
      req.body,
    );
    if (!body.candidate_id && !body.candidate) {
      throw badRequest('Bitte eine:n bestehende:n Bewerber:in wählen oder neu anlegen');
    }
    const posting = getDb().prepare('SELECT id, status FROM job_postings WHERE id = ?').get(body.posting_id) as
      | { id: number; status: string }
      | undefined;
    if (!posting) throw badRequest('Stelle nicht gefunden');
    if (posting.status === 'geschlossen') {
      throw conflict('Für eine geschlossene Stelle können keine Bewerbungen erfasst werden');
    }

    const stage = firstActiveStage();
    const appliedAt = body.applied_at ?? todayIso();
    const result = inTransaction(() => {
      const candidateId = body.candidate_id ?? insertCandidate(body.candidate!);
      const existing = getDb()
        .prepare('SELECT id FROM applications WHERE candidate_id = ? AND posting_id = ?')
        .get(candidateId, body.posting_id);
      if (existing) throw conflict('Diese:r Bewerber:in ist für diese Stelle bereits erfasst');
      const info = getDb()
        .prepare(
          `INSERT INTO applications
             (candidate_id, posting_id, stage_id, status, rating, source, cover_letter, cv_file_id,
              salary_expectation_cents, available_from, applied_at, stage_changed_at)
           VALUES (?, ?, ?, 'aktiv', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidateId,
          body.posting_id,
          stage.id,
          body.rating ?? null,
          body.source ?? null,
          body.cover_letter ?? null,
          body.cv_file_id ?? null,
          body.salary_expectation_cents ?? null,
          body.available_from ?? null,
          appliedAt,
          appliedAt,
        );
      const applicationId = Number(info.lastInsertRowid);
      logEvent(applicationId, 'eingang', { toStage: stage.id, userId: userId(req) });
      return applicationId;
    });
    audit(req, 'create', 'application', result, { posting_id: body.posting_id });
    reply.code(201);
    return { application: applicationRow(result) };
  });

  app.patch('/api/recruiting/applications/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const existing = getDb().prepare('SELECT rating FROM applications WHERE id = ?').get(id) as
      | { rating: number | null }
      | undefined;
    if (!existing) throw notFound('Bewerbung nicht gefunden');
    const body = parse(
      z.object({
        rating: z.number().int().min(1).max(5).nullable().optional(),
        source: z.enum(SOURCES).nullable().optional(),
        cover_letter: z.string().nullable().optional(),
        cv_file_id: z.number().int().positive().nullable().optional(),
        salary_expectation_cents: z.number().int().min(0).nullable().optional(),
        available_from: isoDate.nullable().optional(),
      }),
      req.body,
    );
    const fields = Object.entries(body).filter(([, v]) => v !== undefined);
    if (fields.length === 0) throw badRequest('Keine Änderungen übergeben');
    getDb()
      .prepare(`UPDATE applications SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map(([, v]) => v ?? null), id);
    if (body.rating !== undefined && body.rating !== existing.rating) {
      logEvent(id, 'bewertung', { body: body.rating ? `${body.rating} von 5` : 'zurückgesetzt', userId: userId(req) });
    }
    audit(req, 'update', 'application', id, Object.fromEntries(fields));
    return { application: applicationRow(id) };
  });

  // Stufenwechsel (Kanban-Move).
  app.post('/api/recruiting/applications/:id/stage', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ stage_id: z.number().int().positive() }), req.body);
    const appl = getDb().prepare('SELECT stage_id, status FROM applications WHERE id = ?').get(id) as
      | { stage_id: number; status: string }
      | undefined;
    if (!appl) throw notFound('Bewerbung nicht gefunden');
    if (appl.status !== 'aktiv') {
      throw conflict('Nur aktive Bewerbungen können in der Pipeline verschoben werden');
    }
    const target = stageById(body.stage_id);
    if (target.category !== 'aktiv') {
      throw badRequest('Für Einstellung/Absage bitte die entsprechenden Aktionen nutzen');
    }
    if (target.id === appl.stage_id) return { application: applicationRow(id) };
    getDb()
      .prepare(
        "UPDATE applications SET stage_id = ?, stage_changed_at = datetime('now') WHERE id = ?",
      )
      .run(target.id, id);
    logEvent(id, 'stufenwechsel', { fromStage: appl.stage_id, toStage: target.id, userId: userId(req) });
    audit(req, 'stage', 'application', id, { to: target.name });
    return { application: applicationRow(id) };
  });

  // Notiz zur Timeline.
  app.post('/api/recruiting/applications/:id/notes', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    getDb().prepare('SELECT id FROM applications WHERE id = ?').get(id) ??
      (() => { throw notFound('Bewerbung nicht gefunden'); })();
    const body = parse(z.object({ body: z.string().min(1, 'Notiztext fehlt') }), req.body);
    logEvent(id, 'notiz', { body: body.body, userId: userId(req) });
    reply.code(201);
    return { application: applicationRow(id) };
  });

  // Absage.
  app.post('/api/recruiting/applications/:id/reject', async (req) => {
    const { id } = parse(idParam, req.params);
    const appl = getDb().prepare('SELECT stage_id, status FROM applications WHERE id = ?').get(id) as
      | { stage_id: number; status: string }
      | undefined;
    if (!appl) throw notFound('Bewerbung nicht gefunden');
    if (appl.status === 'eingestellt') throw conflict('Eingestellte Bewerbungen können nicht abgelehnt werden');
    const body = parse(z.object({ reason: z.string().min(1, 'Absagegrund fehlt') }), req.body);
    const rejected = stageByCategory('abgelehnt');
    getDb()
      .prepare(
        `UPDATE applications
         SET status = 'abgelehnt', stage_id = ?, rejection_reason = ?,
             decided_at = datetime('now'), stage_changed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(rejected.id, body.reason, id);
    logEvent(id, 'absage', { body: body.reason, fromStage: appl.stage_id, toStage: rejected.id, userId: userId(req) });
    audit(req, 'reject', 'application', id, { reason: body.reason });
    return { application: applicationRow(id) };
  });

  // Zurückziehen (durch Bewerber:in).
  app.post('/api/recruiting/applications/:id/withdraw', async (req) => {
    const { id } = parse(idParam, req.params);
    const appl = getDb().prepare('SELECT status FROM applications WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!appl) throw notFound('Bewerbung nicht gefunden');
    if (appl.status === 'eingestellt') throw conflict('Eingestellte Bewerbungen können nicht zurückgezogen werden');
    getDb()
      .prepare(
        "UPDATE applications SET status = 'zurueckgezogen', decided_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    logEvent(id, 'status', { body: 'Bewerbung zurückgezogen', userId: userId(req) });
    audit(req, 'withdraw', 'application', id);
    return { application: applicationRow(id) };
  });

  /**
   * Einstellung — Lebenszyklus-Brücke zum Personal-Modul.
   *
   * KONTRAKT (docs/modul-kontrakte.md §2): Dies ist der EINZIGE erlaubte
   * Schreibzugriff eines Fachmoduls auf `employees` außerhalb des Personals.
   * Es wird bewusst nur ein Stammdaten-Grundgerüst angelegt (Name, Kontakt,
   * Orga, Eintritt) — die HR vervollständigt Steuer/SV/Bank im Personal-Modul.
   */
  app.post('/api/recruiting/applications/:id/hire', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        hire_date: isoDate,
        employee_type: z.enum(EMPLOYMENT_TYPES).optional(),
        job_title: z.string().nullable().optional(),
        department_id: z.number().int().positive().nullable().optional(),
        team_id: z.number().int().positive().nullable().optional(),
        location_id: z.number().int().positive().nullable().optional(),
        weekly_hours: z.number().min(0).max(80).nullable().optional(),
        annual_leave_days: z.number().min(0).max(365).nullable().optional(),
      }),
      req.body,
    );
    const appl = getDb()
      .prepare(
        `SELECT a.id, a.status, a.candidate_id, a.posting_id, a.applied_at,
                c.first_name, c.last_name, c.email, c.phone,
                p.title AS posting_title, p.employment_type, p.department_id AS p_dep,
                p.team_id AS p_team, p.location_id AS p_loc, p.seats
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN job_postings p ON p.id = a.posting_id
         WHERE a.id = ?`,
      )
      .get(id) as
      | {
          id: number; status: string; candidate_id: number; posting_id: number; applied_at: string;
          first_name: string; last_name: string; email: string | null; phone: string | null;
          posting_title: string; employment_type: string; p_dep: number | null; p_team: number | null;
          p_loc: number | null; seats: number;
        }
      | undefined;
    if (!appl) throw notFound('Bewerbung nicht gefunden');
    if (appl.status === 'eingestellt') throw conflict('Diese:r Bewerber:in ist bereits eingestellt');
    if (appl.status === 'abgelehnt' || appl.status === 'zurueckgezogen') {
      throw conflict('Nur aktive Bewerbungen können eingestellt werden');
    }

    const hiredStage = stageByCategory('eingestellt');
    const result = inTransaction(() => {
      const empInfo = getDb()
        .prepare(
          `INSERT INTO employees
             (first_name, last_name, email, phone, employee_type, status, job_title,
              department_id, team_id, location_id, hire_date, weekly_hours, annual_leave_days)
           VALUES (?, ?, ?, ?, ?, 'aktiv', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          appl.first_name,
          appl.last_name,
          appl.email,
          appl.phone,
          body.employee_type ?? appl.employment_type,
          body.job_title ?? appl.posting_title,
          body.department_id ?? appl.p_dep,
          body.team_id ?? appl.p_team,
          body.location_id ?? appl.p_loc,
          body.hire_date,
          body.weekly_hours ?? null,
          body.annual_leave_days ?? null,
        );
      const employeeId = Number(empInfo.lastInsertRowid);
      getDb()
        .prepare(
          `UPDATE applications
           SET status = 'eingestellt', stage_id = ?, converted_employee_id = ?,
               decided_at = datetime('now'), stage_changed_at = datetime('now')
           WHERE id = ?`,
        )
        .run(hiredStage.id, employeeId, id);
      logEvent(id, 'einstellung', {
        body: `Eingestellt zum ${body.hire_date}`,
        toStage: hiredStage.id,
        userId: userId(req),
      });

      // Stelle automatisch auf „besetzt“, sobald alle Plätze vergeben sind.
      const hiredCount = (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM applications WHERE posting_id = ? AND status = 'eingestellt'")
          .get(appl.posting_id) as { n: number }
      ).n;
      let postingClosed = false;
      if (hiredCount >= appl.seats) {
        getDb()
          .prepare(
            "UPDATE job_postings SET status = 'besetzt', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status NOT IN ('geschlossen')",
          )
          .run(appl.posting_id);
        postingClosed = true;
      }
      return { employeeId, postingClosed };
    });

    audit(req, 'create', 'employee', result.employeeId, {
      source: 'recruiting',
      application_id: id,
      name: `${appl.first_name} ${appl.last_name}`,
    });
    audit(req, 'hire', 'application', id, { employee_id: result.employeeId });
    return {
      application: applicationRow(id),
      employee_id: result.employeeId,
      posting_closed: result.postingClosed,
    };
  });

  // ------------------------------------------------------------------ Interviews
  app.get('/api/recruiting/interviews', async (req) => {
    const q = parse(
      z.object({
        status: z.string().optional(),
        upcoming: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) {
      where.push('i.status = ?');
      params.push(q.status);
    }
    if (q.upcoming) {
      where.push("i.status = 'geplant' AND substr(i.scheduled_at, 1, 10) >= ?");
      params.push(todayIso());
    }
    const rows = getDb()
      .prepare(
        `${INTERVIEW_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.scheduled_at ${q.upcoming ? 'ASC' : 'DESC'}`,
      )
      .all(...params) as Record<string, unknown>[];
    return { interviews: rows.map(interviewToJson) };
  });

  const interviewBodySchema = z.object({
    kind: z.enum(['telefon', 'video', 'vor_ort', 'technik', 'kennenlernen']),
    scheduled_at: isoDateTime,
    duration_minutes: z.number().int().min(1).max(600).nullable().optional(),
    location: z.string().nullable().optional(),
    interviewer_ids: z.array(z.number().int().positive()).optional(),
  });

  app.post('/api/recruiting/applications/:id/interviews', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const appl = getDb().prepare('SELECT id, status FROM applications WHERE id = ?').get(id) as
      | { id: number; status: string }
      | undefined;
    if (!appl) throw notFound('Bewerbung nicht gefunden');
    if (appl.status !== 'aktiv') throw conflict('Interviews sind nur für aktive Bewerbungen möglich');
    const body = parse(interviewBodySchema, req.body);
    const info = getDb()
      .prepare(
        `INSERT INTO interviews (application_id, kind, scheduled_at, duration_minutes, location, interviewer_ids)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        body.kind,
        body.scheduled_at,
        body.duration_minutes ?? null,
        body.location ?? null,
        JSON.stringify(body.interviewer_ids ?? []),
      );
    const interviewId = Number(info.lastInsertRowid);
    logEvent(id, 'interview', { body: `Interview geplant (${body.kind}) am ${body.scheduled_at}`, userId: userId(req) });
    audit(req, 'create', 'interview', interviewId, { application_id: id });
    reply.code(201);
    const row = getDb().prepare(`${INTERVIEW_SELECT} WHERE i.id = ?`).get(interviewId) as Record<
      string,
      unknown
    >;
    return { interview: interviewToJson(row) };
  });

  app.put('/api/recruiting/interviews/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const existing = getDb().prepare('SELECT application_id FROM interviews WHERE id = ?').get(id) as
      | { application_id: number }
      | undefined;
    if (!existing) throw notFound('Interview nicht gefunden');
    const body = parse(
      interviewBodySchema.extend({
        status: z.enum(['geplant', 'stattgefunden', 'abgesagt']),
        recommendation: z.enum(['ja', 'nein', 'vielleicht']).nullable().optional(),
        scorecard: scorecardSchema.optional(),
        feedback: z.string().nullable().optional(),
      }),
      req.body,
    );
    getDb()
      .prepare(
        `UPDATE interviews SET kind = ?, scheduled_at = ?, duration_minutes = ?, location = ?,
           interviewer_ids = ?, status = ?, recommendation = ?, scorecard = ?, feedback = ?
         WHERE id = ?`,
      )
      .run(
        body.kind,
        body.scheduled_at,
        body.duration_minutes ?? null,
        body.location ?? null,
        JSON.stringify(body.interviewer_ids ?? []),
        body.status,
        body.recommendation ?? null,
        JSON.stringify(body.scorecard ?? []),
        body.feedback ?? null,
        id,
      );
    if (body.status === 'stattgefunden' && body.recommendation) {
      logEvent(existing.application_id, 'interview', {
        body: `Interview-Feedback: ${body.recommendation}`,
        userId: userId(req),
      });
    }
    audit(req, 'update', 'interview', id, { status: body.status });
    const row = getDb().prepare(`${INTERVIEW_SELECT} WHERE i.id = ?`).get(id) as Record<string, unknown>;
    return { interview: interviewToJson(row) };
  });

  app.delete('/api/recruiting/interviews/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const info = getDb().prepare('DELETE FROM interviews WHERE id = ?').run(id);
    if (info.changes === 0) throw notFound('Interview nicht gefunden');
    audit(req, 'delete', 'interview', id);
    reply.code(204);
  });

  // ------------------------------------------------------------------ Analyse
  app.get('/api/recruiting/analytics', async () => {
    const db = getDb();
    const year = todayIso().slice(0, 4);
    const num = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

    const openPostings = num(
      "SELECT COUNT(*) n FROM job_postings WHERE status IN ('veroeffentlicht','pausiert')",
    );
    const openSeats = num(
      `SELECT COALESCE(SUM(p.seats), 0) - COALESCE(
         (SELECT COUNT(*) FROM applications a WHERE a.status = 'eingestellt'
            AND a.posting_id IN (SELECT id FROM job_postings WHERE status IN ('veroeffentlicht','pausiert'))), 0) n
       FROM job_postings p WHERE p.status IN ('veroeffentlicht','pausiert')`,
    );
    const activeApplications = num("SELECT COUNT(*) n FROM applications WHERE status = 'aktiv'");
    const hiresYtd = num(
      "SELECT COUNT(*) n FROM applications WHERE status = 'eingestellt' AND substr(decided_at,1,4) = ?",
      year,
    );
    const upcomingInterviews = num(
      "SELECT COUNT(*) n FROM interviews WHERE status = 'geplant' AND substr(scheduled_at,1,10) >= ?",
      todayIso(),
    );

    // Funnel über aktive Stufen (aktueller Bestand je Stufe) + Terminalzahlen.
    const funnel = db
      .prepare(
        `SELECT s.name, s.color, s.category, COUNT(a.id) AS count
         FROM recruiting_stages s
         LEFT JOIN applications a ON a.stage_id = s.id
         GROUP BY s.id ORDER BY s.sort_order`,
      )
      .all();

    // Time-to-Hire: Ø Tage zwischen Eingang und Einstellung (nur eingestellte).
    const hired = db
      .prepare(
        "SELECT applied_at, decided_at FROM applications WHERE status = 'eingestellt' AND decided_at IS NOT NULL",
      )
      .all() as { applied_at: string; decided_at: string }[];
    const tthValues = hired.map((h) => daysBetween(h.applied_at, h.decided_at));
    const avgTimeToHire =
      tthValues.length > 0 ? Math.round(tthValues.reduce((a, b) => a + b, 0) / tthValues.length) : null;

    // Bewerbungen je Kanal (Quelle der Bewerbung, Fallback Kandidatenquelle).
    const bySource = db
      .prepare(
        `SELECT COALESCE(a.source, c.source) AS source, COUNT(*) AS count,
                SUM(CASE WHEN a.status = 'eingestellt' THEN 1 ELSE 0 END) AS hired
         FROM applications a JOIN candidates c ON c.id = a.candidate_id
         GROUP BY COALESCE(a.source, c.source) ORDER BY count DESC`,
      )
      .all();

    return {
      analytics: {
        stats: { openPostings, openSeats, activeApplications, hiresYtd, upcomingInterviews, avgTimeToHire },
        funnel,
        bySource,
      },
    };
  });
};

// ---------------------------------------------------------------------------
// interne Helfer
// ---------------------------------------------------------------------------

function insertCandidate(body: z.infer<typeof candidateBodySchema>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO candidates
         (first_name, last_name, email, phone, city, source, headline, linkedin_url, photo_file_id, note, consent_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.first_name,
      body.last_name,
      body.email || null,
      body.phone ?? null,
      body.city ?? null,
      body.source,
      body.headline ?? null,
      body.linkedin_url ?? null,
      body.photo_file_id ?? null,
      body.note ?? null,
      body.consent_until ?? null,
    );
  return Number(info.lastInsertRowid);
}
