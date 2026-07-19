import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { AppError, badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { getSetting } from '../../core/settings.js';
import { signDownloadUrl } from '../../core/files.js';
import {
  audienceShape,
  audienceName,
  checkAudience,
  countAudience,
  type AudienceType,
} from './audience.js';

// ---------------------------------------------------------------------------
// Gemeinsame Helfer
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT erwartet');
const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Heutiges Datum als ISO-String in lokaler Zeit (Serverzeit = Firmenzeit). */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function userId(req: { user: unknown }): number | null {
  return (req.user as { id?: number } | undefined)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Verzeichnis
// ---------------------------------------------------------------------------

const DIRECTORY_FIELDS = [
  'email',
  'phone',
  'photo',
  'job_title',
  'department',
  'team',
  'location',
  'skills',
] as const;
type DirectoryField = (typeof DIRECTORY_FIELDS)[number];

function getFieldVisibility(): Record<DirectoryField, boolean> {
  const rows = getDb()
    .prepare('SELECT field_key, visible FROM directory_field_visibility')
    .all() as { field_key: string; visible: number }[];
  const map = Object.fromEntries(rows.map((r) => [r.field_key, r.visible === 1]));
  return Object.fromEntries(
    DIRECTORY_FIELDS.map((f) => [f, map[f] ?? true]),
  ) as Record<DirectoryField, boolean>;
}

/**
 * Skills/Employee-Skills gehören dem Leistungs-Modul (Kontrakt: skills(id,
 * name), employee_skills(employee_id, skill_id, level)). Wir lesen nur — und
 * funktionieren auch, wenn die Tabellen (noch) nicht existieren oder leer sind.
 */
function skillTablesExist(): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('skills', 'employee_skills')",
    )
    .get() as { c: number };
  return row.c === 2;
}

// ---------------------------------------------------------------------------
// Umfragen: Fragen & Antworten
// ---------------------------------------------------------------------------

const questionSchema = z.object({
  kind: z.enum(['skala', 'einfachauswahl', 'mehrfachauswahl', 'freitext']),
  text: z.string().min(1, 'Fragetext fehlt'),
  options: z.array(z.string().min(1)).nullable().optional(),
  scale_max: z.number().int().min(2).max(10).nullable().optional(),
});

const surveyBodySchema = z.object({
  title: z.string().min(1, 'Titel fehlt'),
  description: z.string().nullable().optional(),
  ...audienceShape,
  date_from: isoDate,
  date_to: isoDate,
  min_participants: z.number().int().min(1).nullable().optional(),
  questions: z.array(questionSchema).min(1, 'Mindestens eine Frage erforderlich'),
});

function validateQuestions(questions: z.infer<typeof questionSchema>[]): void {
  for (const q of questions) {
    if (q.kind === 'skala' && !q.scale_max) {
      throw badRequest(`Skalenfrage „${q.text}“ benötigt scale_max`);
    }
    if ((q.kind === 'einfachauswahl' || q.kind === 'mehrfachauswahl') && (!q.options || q.options.length < 2)) {
      throw badRequest(`Auswahlfrage „${q.text}“ benötigt mindestens zwei Optionen`);
    }
  }
}

interface SurveyRow {
  id: number;
  title: string;
  description: string | null;
  audience_type: AudienceType;
  audience_id: number | null;
  date_from: string;
  date_to: string;
  min_participants: number | null;
  status: 'entwurf' | 'laufend' | 'beendet';
  created_by_user_id: number | null;
  created_at: string;
}

interface QuestionRow {
  id: number;
  survey_id: number;
  kind: 'skala' | 'einfachauswahl' | 'mehrfachauswahl' | 'freitext';
  text: string;
  options: string | null;
  scale_max: number | null;
  sort_order: number;
}

function getSurvey(id: number): SurveyRow {
  const row = getDb().prepare('SELECT * FROM surveys WHERE id = ?').get(id) as SurveyRow | undefined;
  if (!row) throw notFound('Umfrage nicht gefunden');
  return row;
}

function getQuestions(surveyId: number): QuestionRow[] {
  return getDb()
    .prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id')
    .all(surveyId) as QuestionRow[];
}

function questionToJson(q: QuestionRow) {
  return {
    id: q.id,
    survey_id: q.survey_id,
    kind: q.kind,
    text: q.text,
    options: q.options ? (JSON.parse(q.options) as string[]) : null,
    scale_max: q.scale_max,
    sort_order: q.sort_order,
  };
}

function surveyToJson(s: SurveyRow) {
  const participantCount = (
    getDb().prepare('SELECT COUNT(*) AS c FROM survey_participations WHERE survey_id = ?').get(s.id) as {
      c: number;
    }
  ).c;
  return {
    ...s,
    audience_name: audienceName(s.audience_type, s.audience_id),
    recipients: countAudience(s.audience_type, s.audience_id),
    participant_count: participantCount,
    effective_min_participants: s.min_participants ?? getSetting('surveyMinParticipants'),
  };
}

// ---------------------------------------------------------------------------
// Ankündigungen
// ---------------------------------------------------------------------------

const announcementBodySchema = z.object({
  title: z.string().min(1, 'Titel fehlt'),
  body: z.string().min(1, 'Text fehlt'),
  ...audienceShape,
  publish_at: isoDate,
  expires_at: isoDate.nullable(),
  requires_ack: z.boolean(),
  attachment_file_ids: z.array(z.number().int().positive()).optional(),
});

interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  audience_type: AudienceType;
  audience_id: number | null;
  publish_at: string;
  expires_at: string | null;
  requires_ack: number;
  created_by_user_id: number | null;
  created_at: string;
}

function announcementStatus(a: Pick<AnnouncementRow, 'publish_at' | 'expires_at'>): string {
  const today = todayIso();
  if (a.publish_at > today) return 'geplant';
  if (a.expires_at && a.expires_at < today) return 'abgelaufen';
  return 'aktiv';
}

function announcementToJson(a: AnnouncementRow) {
  const db = getDb();
  const ackCount = (
    db.prepare('SELECT COUNT(*) AS c FROM announcement_acks WHERE announcement_id = ?').get(a.id) as {
      c: number;
    }
  ).c;
  return {
    ...a,
    requires_ack: a.requires_ack === 1,
    status: announcementStatus(a),
    audience_name: audienceName(a.audience_type, a.audience_id),
    recipients: countAudience(a.audience_type, a.audience_id),
    ack_count: ackCount,
  };
}

// ---------------------------------------------------------------------------
// Gespräche
// ---------------------------------------------------------------------------

const meetingBodySchema = z.object({
  employee_id: z.number().int().positive(),
  meeting_date: isoDate,
  occasion: z.enum(['einzelgespraech', 'probezeit', 'jahresgespraech', 'konflikt', 'rueckkehr', 'sonstiges']),
  participants: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  agreements: z.string().nullable().optional(),
  follow_up_date: isoDate.nullable().optional(),
  visibility: z.enum(['nur_hr', 'hr_vorgesetzte', 'hr_vorgesetzte_mitarbeiter']),
});

const MEETING_SELECT = `
  SELECT m.*, e.first_name, e.last_name
  FROM meeting_protocols m
  JOIN employees e ON e.id = m.employee_id
`;

// ---------------------------------------------------------------------------
// Kanäle
// ---------------------------------------------------------------------------

const channelBodySchema = z.object({
  name: z.string().min(1, 'Name fehlt'),
  topic: z.string().nullable().optional(),
  ...audienceShape,
  archived: z.boolean().optional(),
});

interface ChannelRow {
  id: number;
  name: string;
  topic: string | null;
  audience_type: AudienceType;
  audience_id: number | null;
  archived: number;
  created_at: string;
}

function getChannel(id: number): ChannelRow {
  const row = getDb().prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
  if (!row) throw notFound('Kanal nicht gefunden');
  return row;
}

function channelToJson(c: ChannelRow) {
  const db = getDb();
  const stats = db
    .prepare(
      'SELECT COUNT(*) AS message_count, MAX(sent_at) AS last_message_at FROM channel_messages WHERE channel_id = ?',
    )
    .get(c.id) as { message_count: number; last_message_at: string | null };
  return {
    ...c,
    archived: c.archived === 1,
    audience_name: audienceName(c.audience_type, c.audience_id),
    recipients: countAudience(c.audience_type, c.audience_id),
    message_count: stats.message_count,
    last_message_at: stats.last_message_at,
  };
}

// ---------------------------------------------------------------------------
// Modul-Plugin
// ---------------------------------------------------------------------------

export const communicationModule: FastifyPluginAsync = async (app) => {
  // ------------------------------------------------------------------ Org-Lookup
  // Lesender Blick auf die Kerntabellen (für Zielgruppen-Auswahl & Filter).
  app.get('/api/communication/org', async () => {
    const db = getDb();
    return {
      departments: db.prepare('SELECT id, name FROM departments ORDER BY name').all(),
      teams: db.prepare('SELECT id, name, department_id FROM teams ORDER BY name').all(),
      locations: db.prepare('SELECT id, name FROM locations ORDER BY name').all(),
    };
  });

  // ------------------------------------------------------------------ Verzeichnis
  app.get('/api/communication/directory', async (req) => {
    const q = parse(
      z.object({
        search: z.string().optional(),
        department_id: z.coerce.number().int().positive().optional(),
        location_id: z.coerce.number().int().positive().optional(),
        skill: z.string().optional(),
      }),
      req.query,
    );
    const db = getDb();
    const vis = getFieldVisibility();
    const hasSkills = skillTablesExist();

    // DATENSCHUTZ: harte Positivliste dienstlicher Felder — niemals SELECT *.
    // Private Daten (Adresse, IBAN, Steuer, SV, Geburtsdatum, private
    // Kontakte) sind bewusst NICHT Teil dieser Abfrage.
    const where: string[] = ["e.status = 'aktiv'"];
    const params: unknown[] = [];
    if (q.search) {
      where.push(
        "(e.first_name LIKE ? OR e.last_name LIKE ? OR (e.first_name || ' ' || e.last_name) LIKE ? OR e.job_title LIKE ? OR e.email LIKE ?)",
      );
      const like = `%${q.search}%`;
      params.push(like, like, like, like, like);
    }
    if (q.department_id) {
      where.push('e.department_id = ?');
      params.push(q.department_id);
    }
    if (q.location_id) {
      where.push('e.location_id = ?');
      params.push(q.location_id);
    }
    if (q.skill) {
      if (!hasSkills) return { employees: [], fields: vis };
      where.push(
        'e.id IN (SELECT es.employee_id FROM employee_skills es JOIN skills s ON s.id = es.skill_id WHERE s.name LIKE ?)',
      );
      params.push(`%${q.skill}%`);
    }

    const rows = db
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, e.job_title, e.email, e.phone, e.photo_file_id,
                d.name AS department_name, t.name AS team_name, l.name AS location_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN teams t ON t.id = e.team_id
         LEFT JOIN locations l ON l.id = e.location_id
         WHERE ${where.join(' AND ')}
         ORDER BY e.last_name, e.first_name`,
      )
      .all(...params) as {
      id: number;
      first_name: string;
      last_name: string;
      job_title: string | null;
      email: string | null;
      phone: string | null;
      photo_file_id: number | null;
      department_name: string | null;
      team_name: string | null;
      location_name: string | null;
    }[];

    // Skills je Mitarbeiter:in (LEFT-JOIN-Semantik: leere Tabellen sind ok).
    const skillMap = new Map<number, { name: string; level: number }[]>();
    if (vis.skills && hasSkills && rows.length > 0) {
      const skillRows = db
        .prepare(
          `SELECT es.employee_id, s.name, es.level
           FROM employee_skills es JOIN skills s ON s.id = es.skill_id
           ORDER BY s.name`,
        )
        .all() as { employee_id: number; name: string; level: number }[];
      for (const s of skillRows) {
        const list = skillMap.get(s.employee_id) ?? [];
        list.push({ name: s.name, level: s.level });
        skillMap.set(s.employee_id, list);
      }
    }

    // Unsichtbare Felder werden HIER serverseitig entfernt — der Client
    // bekommt sie gar nicht erst zu sehen.
    const employees = rows.map((r) => {
      const emp: Record<string, unknown> = {
        id: r.id,
        first_name: r.first_name,
        last_name: r.last_name,
      };
      if (vis.job_title) emp.job_title = r.job_title;
      if (vis.email) emp.email = r.email;
      if (vis.phone) emp.phone = r.phone;
      if (vis.photo) {
        emp.photo_file_id = r.photo_file_id;
        emp.photo_url = r.photo_file_id ? signDownloadUrl(r.photo_file_id) : null;
      }
      if (vis.department) emp.department_name = r.department_name;
      if (vis.team) emp.team_name = r.team_name;
      if (vis.location) emp.location_name = r.location_name;
      if (vis.skills) emp.skills = skillMap.get(r.id) ?? [];
      return emp;
    });

    return { employees, fields: vis };
  });

  app.get('/api/communication/directory/fields', async () => {
    const rows = getDb()
      .prepare('SELECT field_key, visible FROM directory_field_visibility ORDER BY field_key')
      .all() as { field_key: string; visible: number }[];
    return { fields: rows.map((r) => ({ field_key: r.field_key, visible: r.visible === 1 })) };
  });

  app.put('/api/communication/directory/fields', async (req) => {
    const body = parse(
      z.object({
        fields: z
          .array(
            z.object({
              field_key: z.enum(DIRECTORY_FIELDS),
              visible: z.boolean(),
            }),
          )
          .min(1),
      }),
      req.body,
    );
    inTransaction(() => {
      const stmt = getDb().prepare(
        'UPDATE directory_field_visibility SET visible = ? WHERE field_key = ?',
      );
      for (const f of body.fields) stmt.run(f.visible ? 1 : 0, f.field_key);
    });
    audit(req, 'update', 'directory_field_visibility', undefined, body.fields);
    const rows = getDb()
      .prepare('SELECT field_key, visible FROM directory_field_visibility ORDER BY field_key')
      .all() as { field_key: string; visible: number }[];
    return { fields: rows.map((r) => ({ field_key: r.field_key, visible: r.visible === 1 })) };
  });

  // ------------------------------------------------------------------ Ankündigungen
  app.get('/api/communication/announcements', async () => {
    const rows = getDb()
      .prepare('SELECT * FROM announcements ORDER BY publish_at DESC, id DESC')
      .all() as AnnouncementRow[];
    return { announcements: rows.map(announcementToJson) };
  });

  app.get('/api/communication/announcements/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id) as
      | AnnouncementRow
      | undefined;
    if (!row) throw notFound('Ankündigung nicht gefunden');
    const attachments = getDb()
      .prepare(
        `SELECT aa.id, aa.file_id, f.original_name, f.size_bytes, f.mime_type
         FROM announcement_attachments aa JOIN files f ON f.id = aa.file_id
         WHERE aa.announcement_id = ? ORDER BY aa.id`,
      )
      .all(id);
    return { announcement: { ...announcementToJson(row), attachments } };
  });

  app.post('/api/communication/announcements', async (req, reply) => {
    const body = parse(announcementBodySchema, req.body);
    checkAudience(body);
    if (body.expires_at && body.expires_at < body.publish_at) {
      throw badRequest('Das Ablaufdatum darf nicht vor dem Veröffentlichungsdatum liegen');
    }
    const id = inTransaction(() => {
      const info = getDb()
        .prepare(
          `INSERT INTO announcements (title, body, audience_type, audience_id, publish_at, expires_at, requires_ack, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.title,
          body.body,
          body.audience_type,
          body.audience_id,
          body.publish_at,
          body.expires_at,
          body.requires_ack ? 1 : 0,
          userId(req),
        );
      const announcementId = Number(info.lastInsertRowid);
      const attach = getDb().prepare(
        'INSERT INTO announcement_attachments (announcement_id, file_id) VALUES (?, ?)',
      );
      for (const fileId of body.attachment_file_ids ?? []) attach.run(announcementId, fileId);
      return announcementId;
    });
    audit(req, 'create', 'announcement', id, { title: body.title });
    const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow;
    reply.code(201);
    return { announcement: announcementToJson(row) };
  });

  app.put('/api/communication/announcements/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const existing = getDb().prepare('SELECT id FROM announcements WHERE id = ?').get(id);
    if (!existing) throw notFound('Ankündigung nicht gefunden');
    const body = parse(announcementBodySchema, req.body);
    checkAudience(body);
    if (body.expires_at && body.expires_at < body.publish_at) {
      throw badRequest('Das Ablaufdatum darf nicht vor dem Veröffentlichungsdatum liegen');
    }
    inTransaction(() => {
      getDb()
        .prepare(
          `UPDATE announcements SET title = ?, body = ?, audience_type = ?, audience_id = ?,
           publish_at = ?, expires_at = ?, requires_ack = ? WHERE id = ?`,
        )
        .run(
          body.title,
          body.body,
          body.audience_type,
          body.audience_id,
          body.publish_at,
          body.expires_at,
          body.requires_ack ? 1 : 0,
          id,
        );
      getDb().prepare('DELETE FROM announcement_attachments WHERE announcement_id = ?').run(id);
      const attach = getDb().prepare(
        'INSERT INTO announcement_attachments (announcement_id, file_id) VALUES (?, ?)',
      );
      for (const fileId of body.attachment_file_ids ?? []) attach.run(id, fileId);
    });
    audit(req, 'update', 'announcement', id, { title: body.title });
    const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow;
    return { announcement: announcementToJson(row) };
  });

  app.delete('/api/communication/announcements/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const info = getDb().prepare('DELETE FROM announcements WHERE id = ?').run(id);
    if (info.changes === 0) throw notFound('Ankündigung nicht gefunden');
    audit(req, 'delete', 'announcement', id);
    reply.code(204);
  });

  // ------------------------------------------------------------------ Umfragen
  app.get('/api/communication/surveys', async () => {
    const rows = getDb().prepare('SELECT * FROM surveys ORDER BY date_from DESC, id DESC').all() as SurveyRow[];
    return { surveys: rows.map(surveyToJson) };
  });

  app.get('/api/communication/surveys/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const survey = getSurvey(id);
    return { survey: { ...surveyToJson(survey), questions: getQuestions(id).map(questionToJson) } };
  });

  app.post('/api/communication/surveys', async (req, reply) => {
    const body = parse(surveyBodySchema, req.body);
    checkAudience(body);
    if (body.date_to < body.date_from) throw badRequest('Enddatum darf nicht vor dem Startdatum liegen');
    validateQuestions(body.questions);
    const id = inTransaction(() => {
      const info = getDb()
        .prepare(
          `INSERT INTO surveys (title, description, audience_type, audience_id, date_from, date_to, min_participants, status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'entwurf', ?)`,
        )
        .run(
          body.title,
          body.description ?? null,
          body.audience_type,
          body.audience_id,
          body.date_from,
          body.date_to,
          body.min_participants ?? null,
          userId(req),
        );
      const surveyId = Number(info.lastInsertRowid);
      const insertQ = getDb().prepare(
        `INSERT INTO survey_questions (survey_id, kind, text, options, scale_max, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      body.questions.forEach((q, i) => {
        insertQ.run(
          surveyId,
          q.kind,
          q.text,
          q.options ? JSON.stringify(q.options) : null,
          q.kind === 'skala' ? (q.scale_max ?? 5) : null,
          i,
        );
      });
      return surveyId;
    });
    audit(req, 'create', 'survey', id, { title: body.title });
    reply.code(201);
    return { survey: { ...surveyToJson(getSurvey(id)), questions: getQuestions(id).map(questionToJson) } };
  });

  app.put('/api/communication/surveys/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const survey = getSurvey(id);
    if (survey.status !== 'entwurf') {
      throw conflict('Nur Umfragen im Status „Entwurf“ können bearbeitet werden');
    }
    const body = parse(surveyBodySchema, req.body);
    checkAudience(body);
    if (body.date_to < body.date_from) throw badRequest('Enddatum darf nicht vor dem Startdatum liegen');
    validateQuestions(body.questions);
    inTransaction(() => {
      getDb()
        .prepare(
          `UPDATE surveys SET title = ?, description = ?, audience_type = ?, audience_id = ?,
           date_from = ?, date_to = ?, min_participants = ? WHERE id = ?`,
        )
        .run(
          body.title,
          body.description ?? null,
          body.audience_type,
          body.audience_id,
          body.date_from,
          body.date_to,
          body.min_participants ?? null,
          id,
        );
      getDb().prepare('DELETE FROM survey_questions WHERE survey_id = ?').run(id);
      const insertQ = getDb().prepare(
        `INSERT INTO survey_questions (survey_id, kind, text, options, scale_max, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      body.questions.forEach((q, i) => {
        insertQ.run(
          id,
          q.kind,
          q.text,
          q.options ? JSON.stringify(q.options) : null,
          q.kind === 'skala' ? (q.scale_max ?? 5) : null,
          i,
        );
      });
    });
    audit(req, 'update', 'survey', id, { title: body.title });
    return { survey: { ...surveyToJson(getSurvey(id)), questions: getQuestions(id).map(questionToJson) } };
  });

  app.delete('/api/communication/surveys/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const survey = getSurvey(id);
    if (survey.status !== 'entwurf') {
      throw conflict('Nur Umfragen im Status „Entwurf“ können gelöscht werden');
    }
    getDb().prepare('DELETE FROM surveys WHERE id = ?').run(id);
    audit(req, 'delete', 'survey', id, { title: survey.title });
    reply.code(204);
  });

  app.post('/api/communication/surveys/:id/status', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ status: z.enum(['laufend', 'beendet']) }), req.body);
    const survey = getSurvey(id);
    const allowed: Record<string, string[]> = { entwurf: ['laufend'], laufend: ['beendet'], beendet: [] };
    if (!allowed[survey.status]?.includes(body.status)) {
      throw conflict(
        `Statuswechsel von „${survey.status}“ nach „${body.status}“ ist nicht zulässig`,
      );
    }
    getDb().prepare('UPDATE surveys SET status = ? WHERE id = ?').run(body.status, id);
    audit(req, 'status', 'survey', id, { from: survey.status, to: body.status });
    return { survey: surveyToJson(getSurvey(id)) };
  });

  /**
   * Antworterfassung (Demo/Test im Desktop; produktiv später über den
   * Web-Client-Endpunkt POST /api/me/surveys/:id/response, s. base.yaml).
   *
   * ANONYMITÄT: Die Teilnahme wird in survey_participations markiert (Dedup +
   * Quote), die Antworten landen OHNE employee_id in survey_responses — eine
   * Zuordnung Antwort<->Person ist im Datenmodell nicht möglich. Deshalb wird
   * hier auch bewusst NICHT auditiert.
   */
  app.post('/api/communication/surveys/:id/responses', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        employee_id: z.number().int().positive(),
        answers: z
          .array(
            z.object({
              question_id: z.number().int().positive(),
              value: z.union([z.string(), z.number(), z.array(z.string())]),
            }),
          )
          .min(1, 'Mindestens eine Antwort erforderlich'),
      }),
      req.body,
    );
    const survey = getSurvey(id);
    if (survey.status !== 'laufend') {
      throw conflict('Antworten sind nur möglich, während die Umfrage läuft');
    }
    const employee = getDb()
      .prepare("SELECT id FROM employees WHERE id = ? AND status = 'aktiv'")
      .get(body.employee_id);
    if (!employee) throw badRequest('Mitarbeiter:in nicht gefunden oder nicht aktiv');
    const already = getDb()
      .prepare('SELECT 1 FROM survey_participations WHERE survey_id = ? AND employee_id = ?')
      .get(id, body.employee_id);
    if (already) throw conflict('Diese Person hat an der Umfrage bereits teilgenommen');

    const questions = new Map(getQuestions(id).map((q) => [q.id, q]));
    for (const a of body.answers) {
      const q = questions.get(a.question_id);
      if (!q) throw badRequest(`Frage ${a.question_id} gehört nicht zu dieser Umfrage`);
      if (q.kind === 'skala') {
        if (typeof a.value !== 'number' || a.value < 1 || a.value > (q.scale_max ?? 5)) {
          throw badRequest(`Ungültiger Skalenwert für Frage „${q.text}“`);
        }
      } else if (q.kind === 'einfachauswahl') {
        const options = q.options ? (JSON.parse(q.options) as string[]) : [];
        if (typeof a.value !== 'string' || !options.includes(a.value)) {
          throw badRequest(`Ungültige Auswahl für Frage „${q.text}“`);
        }
      } else if (q.kind === 'mehrfachauswahl') {
        const options = q.options ? (JSON.parse(q.options) as string[]) : [];
        if (!Array.isArray(a.value) || a.value.some((v) => !options.includes(v))) {
          throw badRequest(`Ungültige Auswahl für Frage „${q.text}“`);
        }
      } else if (typeof a.value !== 'string') {
        throw badRequest(`Freitextantwort für Frage „${q.text}“ muss Text sein`);
      }
    }

    inTransaction(() => {
      getDb()
        .prepare('INSERT INTO survey_participations (survey_id, employee_id) VALUES (?, ?)')
        .run(id, body.employee_id);
      getDb()
        .prepare('INSERT INTO survey_responses (survey_id, answers) VALUES (?, ?)')
        .run(id, JSON.stringify(body.answers));
    });
    reply.code(201);
    const participantCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS c FROM survey_participations WHERE survey_id = ?')
        .get(id) as { c: number }
    ).c;
    return { participation: { survey_id: id, participant_count: participantCount } };
  });

  /**
   * ANONYME AUSWERTUNG: Ergebnisse gibt es erst, wenn die Mindestteilnehmer-
   * zahl erreicht ist — vorher 403 MIN_PARTICIPANTS_NOT_REACHED ohne jede
   * Teilinformation (k-Anonymität).
   */
  app.get('/api/communication/surveys/:id/results', async (req) => {
    const { id } = parse(idParam, req.params);
    const survey = getSurvey(id);
    const minParticipants = survey.min_participants ?? getSetting('surveyMinParticipants');
    const responses = getDb()
      .prepare('SELECT answers FROM survey_responses WHERE survey_id = ?')
      .all(id) as { answers: string }[];
    if (responses.length < minParticipants) {
      throw new AppError(
        403,
        'MIN_PARTICIPANTS_NOT_REACHED',
        `Ergebnisse werden erst ab ${minParticipants} Teilnahmen angezeigt`,
        {
          required: minParticipants,
          current: responses.length,
          missing: minParticipants - responses.length,
        },
      );
    }
    const parsed = responses.map(
      (r) => JSON.parse(r.answers) as { question_id: number; value: unknown }[],
    );
    const results = getQuestions(id).map((q) => {
      const values = parsed
        .flatMap((answers) => answers.filter((a) => a.question_id === q.id))
        .map((a) => a.value);
      const base = { id: q.id, kind: q.kind, text: q.text, answer_count: values.length };
      if (q.kind === 'skala') {
        const nums = values.filter((v): v is number => typeof v === 'number');
        const max = q.scale_max ?? 5;
        const distribution = Array.from({ length: max }, (_, i) => ({
          value: i + 1,
          count: nums.filter((n) => n === i + 1).length,
        }));
        const average =
          nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
        return { ...base, scale_max: max, average, distribution };
      }
      if (q.kind === 'einfachauswahl' || q.kind === 'mehrfachauswahl') {
        const options = q.options ? (JSON.parse(q.options) as string[]) : [];
        const flat =
          q.kind === 'einfachauswahl'
            ? values.filter((v): v is string => typeof v === 'string')
            : values.flatMap((v) => (Array.isArray(v) ? (v as string[]) : []));
        const frequencies = options.map((option) => ({
          option,
          count: flat.filter((v) => v === option).length,
        }));
        return { ...base, frequencies };
      }
      return { ...base, texts: values.filter((v): v is string => typeof v === 'string' && v.trim() !== '') };
    });
    return {
      results: {
        survey_id: id,
        response_count: responses.length,
        min_participants: minParticipants,
        questions: results,
      },
    };
  });

  // ------------------------------------------------------------------ Gespräche
  app.get('/api/communication/meetings', async (req) => {
    const q = parse(
      z.object({
        employee_id: z.coerce.number().int().positive().optional(),
        occasion: z.string().optional(),
      }),
      req.query,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.employee_id) {
      where.push('m.employee_id = ?');
      params.push(q.employee_id);
    }
    if (q.occasion) {
      where.push('m.occasion = ?');
      params.push(q.occasion);
    }
    const rows = getDb()
      .prepare(
        `${MEETING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.meeting_date DESC, m.id DESC`,
      )
      .all(...params);
    return { meetings: rows };
  });

  // Fällige Wiedervorlagen (heute oder überfällig).
  app.get('/api/communication/meetings/follow-ups', async () => {
    const rows = getDb()
      .prepare(
        `${MEETING_SELECT} WHERE m.follow_up_date IS NOT NULL AND m.follow_up_date <= ?
         ORDER BY m.follow_up_date, m.id`,
      )
      .all(todayIso());
    return { meetings: rows };
  });

  app.get('/api/communication/meetings/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getDb().prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(id);
    if (!row) throw notFound('Gesprächsprotokoll nicht gefunden');
    return { meeting: row };
  });

  app.post('/api/communication/meetings', async (req, reply) => {
    const body = parse(meetingBodySchema, req.body);
    const employee = getDb().prepare('SELECT id FROM employees WHERE id = ?').get(body.employee_id);
    if (!employee) throw badRequest('Mitarbeiter:in nicht gefunden');
    const info = getDb()
      .prepare(
        `INSERT INTO meeting_protocols (employee_id, meeting_date, occasion, participants, content, agreements, follow_up_date, visibility, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.employee_id,
        body.meeting_date,
        body.occasion,
        body.participants ?? null,
        body.content ?? null,
        body.agreements ?? null,
        body.follow_up_date ?? null,
        body.visibility,
        userId(req),
      );
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'meeting_protocol', id, {
      employee_id: body.employee_id,
      occasion: body.occasion,
    });
    reply.code(201);
    return { meeting: getDb().prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(id) };
  });

  app.put('/api/communication/meetings/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const existing = getDb().prepare('SELECT id FROM meeting_protocols WHERE id = ?').get(id);
    if (!existing) throw notFound('Gesprächsprotokoll nicht gefunden');
    const body = parse(meetingBodySchema, req.body);
    getDb()
      .prepare(
        `UPDATE meeting_protocols SET employee_id = ?, meeting_date = ?, occasion = ?, participants = ?,
         content = ?, agreements = ?, follow_up_date = ?, visibility = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        body.employee_id,
        body.meeting_date,
        body.occasion,
        body.participants ?? null,
        body.content ?? null,
        body.agreements ?? null,
        body.follow_up_date ?? null,
        body.visibility,
        id,
      );
    audit(req, 'update', 'meeting_protocol', id, {
      employee_id: body.employee_id,
      occasion: body.occasion,
    });
    return { meeting: getDb().prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(id) };
  });

  app.delete('/api/communication/meetings/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const info = getDb().prepare('DELETE FROM meeting_protocols WHERE id = ?').run(id);
    if (info.changes === 0) throw notFound('Gesprächsprotokoll nicht gefunden');
    audit(req, 'delete', 'meeting_protocol', id);
    reply.code(204);
  });

  // ------------------------------------------------------------------ Kanäle
  app.get('/api/communication/channels', async () => {
    const rows = getDb().prepare('SELECT * FROM channels ORDER BY archived, name').all() as ChannelRow[];
    return { channels: rows.map(channelToJson) };
  });

  app.post('/api/communication/channels', async (req, reply) => {
    const body = parse(channelBodySchema, req.body);
    checkAudience(body);
    const duplicate = getDb().prepare('SELECT id FROM channels WHERE name = ?').get(body.name);
    if (duplicate) throw conflict('Ein Kanal mit diesem Namen existiert bereits');
    const info = getDb()
      .prepare(
        'INSERT INTO channels (name, topic, audience_type, audience_id, archived) VALUES (?, ?, ?, ?, ?)',
      )
      .run(body.name, body.topic ?? null, body.audience_type, body.audience_id, body.archived ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'channel', id, { name: body.name });
    reply.code(201);
    return { channel: channelToJson(getChannel(id)) };
  });

  app.put('/api/communication/channels/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    getChannel(id);
    const body = parse(channelBodySchema, req.body);
    checkAudience(body);
    const duplicate = getDb()
      .prepare('SELECT id FROM channels WHERE name = ? AND id != ?')
      .get(body.name, id);
    if (duplicate) throw conflict('Ein Kanal mit diesem Namen existiert bereits');
    getDb()
      .prepare(
        'UPDATE channels SET name = ?, topic = ?, audience_type = ?, audience_id = ?, archived = ? WHERE id = ?',
      )
      .run(body.name, body.topic ?? null, body.audience_type, body.audience_id, body.archived ? 1 : 0, id);
    audit(req, 'update', 'channel', id, { name: body.name, archived: body.archived ?? false });
    return { channel: channelToJson(getChannel(id)) };
  });

  app.delete('/api/communication/channels/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const channel = getChannel(id);
    getDb().prepare('DELETE FROM channels WHERE id = ?').run(id);
    audit(req, 'delete', 'channel', id, { name: channel.name });
    reply.code(204);
  });

  app.get('/api/communication/channels/:id/messages', async (req) => {
    const { id } = parse(idParam, req.params);
    getChannel(id);
    const rows = getDb()
      .prepare(
        `SELECT cm.id, cm.channel_id, cm.body, cm.sent_at, cm.sent_by_user_id, u.name AS sent_by_name
         FROM channel_messages cm LEFT JOIN users u ON u.id = cm.sent_by_user_id
         WHERE cm.channel_id = ? ORDER BY cm.sent_at, cm.id`,
      )
      .all(id);
    return { messages: rows };
  });

  app.post('/api/communication/channels/:id/messages', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const channel = getChannel(id);
    if (channel.archived === 1) {
      throw conflict('Der Kanal ist archiviert — es können keine Nachrichten mehr gesendet werden');
    }
    const body = parse(z.object({ body: z.string().min(1, 'Nachrichtentext fehlt') }), req.body);
    const info = getDb()
      .prepare('INSERT INTO channel_messages (channel_id, body, sent_by_user_id) VALUES (?, ?, ?)')
      .run(id, body.body, userId(req));
    audit(req, 'send', 'channel_message', Number(info.lastInsertRowid), { channel_id: id });
    reply.code(201);
    const row = getDb()
      .prepare(
        `SELECT cm.id, cm.channel_id, cm.body, cm.sent_at, cm.sent_by_user_id, u.name AS sent_by_name
         FROM channel_messages cm LEFT JOIN users u ON u.id = cm.sent_by_user_id WHERE cm.id = ?`,
      )
      .get(Number(info.lastInsertRowid));
    return { message: row };
  });
};
