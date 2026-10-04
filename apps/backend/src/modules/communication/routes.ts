import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MEETING_VISIBILITIES } from '@ohrganize/shared';
import { getDb, inTransaction } from '../../db/db.js';
import { AppError, badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { todayIso } from '../../core/dates.js';
import { getSetting } from '../../core/settings.js';
import { deleteFileIfUnreferenced } from '../../core/files.js';
import { isoDateString } from '../../core/validation.js';
import {
  audienceShape,
  audienceName,
  audienceResolver,
  checkAudience,
  countAudience,
  type AudienceType,
} from './audience.js';
import { distributionListRoutes } from './distributionListRoutes.js';
import { DIRECTORY_FIELDS, queryDirectory } from './directoryService.js';
import {
  answersSchema,
  getQuestions,
  getSurvey,
  markResponseTableRebuild,
  questionToJson,
  rebuildForExpiredSurveys,
  rebuildResponseTableNow,
  recordParticipation,
  retryResponseTableRebuild,
  type SurveyRow,
} from './surveyService.js';
import { errorText } from '../../core/errorText.js';

// ---------------------------------------------------------------------------
// Gemeinsame Helfer
// ---------------------------------------------------------------------------

// Kalenderprüfung inklusive (core/validation.ts) — ein Regex allein ließe
// '2026-02-31' durch, gespeichert verfälscht das die String-Vergleiche in
// announcementStatus & Co.
const isoDate = isoDateString;
const idParam = z.object({ id: z.coerce.number().int().positive() });

function userId(req: { user: unknown }): number | null {
  return (req.user as { id?: number } | undefined)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Zielgruppen-Auflösung für Listen
// ---------------------------------------------------------------------------

/**
 * In den Listen (Ankündigungen, Umfragen) wiederholen sich wenige Zielgruppen
 * über viele Zeilen. audienceResolver() berechnet Name und Empfängerzahl je
 * Zielgruppe nur einmal pro Anfrage; die Einzel-Routen (GET :id, POST, PUT)
 * bleiben bei audienceName()/countAudience().
 */
type AudienceLookup = ReturnType<typeof audienceResolver>;

/** Zähler je Fremdschlüssel in einer Query — GROUP BY statt COUNT je Zeile. */
function countsBy(sql: string): Map<number, number> {
  return new Map(
    (getDb().prepare(sql).all() as { id: number; c: number }[]).map((r) => [r.id, r.c] as const),
  );
}

// ---------------------------------------------------------------------------
// Verzeichnis: Abfrage und Feldsichtbarkeit liegen in directoryService.ts,
// weil das Portal (modules/me/communicationRoutes.ts) dieselbe Logik liest.
// ---------------------------------------------------------------------------

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
  // Mindestens 2: Mit 1 waere die einzige Antwort einer Person zuzuordnen,
  // die Anonymitaet der Auswertung damit nur behauptet.
  min_participants: z.number().int().min(2).nullable().optional(),
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

/** Kontext der Listen-Route — siehe AudienceLookup. */
interface SurveyListContext {
  participantCounts: Map<number, number>;
  audience: AudienceLookup;
  defaultMinParticipants: number;
}

function surveyToJson(s: SurveyRow, ctx?: SurveyListContext) {
  const participantCount = ctx
    ? (ctx.participantCounts.get(s.id) ?? 0)
    : (
        getDb()
          .prepare('SELECT COUNT(*) AS c FROM survey_participations WHERE survey_id = ?')
          .get(s.id) as { c: number }
      ).c;
  const audience = ctx
    ? ctx.audience(s)
    : {
        audience_name: audienceName(s.audience_type, s.audience_id),
        recipients: countAudience(s.audience_type, s.audience_id),
      };
  return {
    ...s,
    ...audience,
    participant_count: participantCount,
    effective_min_participants:
      s.min_participants ?? ctx?.defaultMinParticipants ?? getSetting('surveyMinParticipants'),
    // Laufend, aber Enddatum ueberschritten: Das Portal bietet die Umfrage
    // nicht mehr an (me/communicationRoutes.ts), die HR sollte sie beenden.
    deadline_passed: s.status === 'laufend' && s.date_to < todayIso(),
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

/** Datei-IDs der Anhaenge, um nach Ersetzen oder Loeschen aufzuraeumen. */
function attachmentFileIds(announcementId: number): number[] {
  return (
    getDb()
      .prepare('SELECT file_id FROM announcement_attachments WHERE announcement_id = ?')
      .all(announcementId) as { file_id: number }[]
  ).map((r) => r.file_id);
}

function announcementStatus(a: Pick<AnnouncementRow, 'publish_at' | 'expires_at'>): string {
  const today = todayIso();
  if (a.publish_at > today) return 'geplant';
  if (a.expires_at && a.expires_at < today) return 'abgelaufen';
  return 'aktiv';
}

/** Kontext der Listen-Route — siehe AudienceLookup. */
interface AnnouncementListContext {
  ackCounts: Map<number, number>;
  audience: AudienceLookup;
}

function announcementToJson(a: AnnouncementRow, ctx?: AnnouncementListContext) {
  const ackCount = ctx
    ? (ctx.ackCounts.get(a.id) ?? 0)
    : (
        getDb()
          .prepare('SELECT COUNT(*) AS c FROM announcement_acks WHERE announcement_id = ?')
          .get(a.id) as { c: number }
      ).c;
  const audience = ctx
    ? ctx.audience(a)
    : {
        audience_name: audienceName(a.audience_type, a.audience_id),
        recipients: countAudience(a.audience_type, a.audience_id),
      };
  return {
    ...a,
    requires_ack: a.requires_ack === 1,
    status: announcementStatus(a),
    ...audience,
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
  visibility: z.enum(MEETING_VISIBILITIES),
});

const MEETING_SELECT = `
  SELECT m.*, e.first_name, e.last_name
  FROM meeting_protocols m
  JOIN employees e ON e.id = m.employee_id
`;

// ---------------------------------------------------------------------------
// Modul-Plugin
// ---------------------------------------------------------------------------

export const communicationModule: FastifyPluginAsync = async (app) => {
  // Ein beim Umfrageende gescheiterter Neuaufbau der Antworten wird hier
  // nachgeholt (die Migrationen sind beim Registrieren der Module durch).
  retryResponseTableRebuild((message) => app.log.warn(message));
  // Ausgelaufene, nicht beendete Umfragen (surveyService.rebuildForExpiredSurveys).
  const expiredCheck = () => {
    try {
      rebuildForExpiredSurveys();
    } catch (err) {
      app.log.warn(`Neuaufbau der Umfrageantworten nach Ablauf einer Umfrage gescheitert (${errorText(err)}).`);
    }
  };
  expiredCheck();
  const expiredTimer = setInterval(expiredCheck, 60 * 60 * 1000);
  expiredTimer.unref();
  app.addHook('onClose', async () => clearInterval(expiredTimer));

  // Verteiler (eigene Datei, gleiche Bereichspruefung ueber den Praefix).
  await app.register(distributionListRoutes);

  // ------------------------------------------------------------------ Org-Lookup
  // Lesender Blick auf die Kerntabellen (für Zielgruppen-Auswahl & Filter).
  app.get('/api/communication/org', async () => {
    const db = getDb();
    return {
      departments: db.prepare('SELECT id, name, parent_id FROM departments ORDER BY name').all(),
      teams: db.prepare('SELECT id, name, department_id FROM teams ORDER BY name').all(),
      locations: db.prepare('SELECT id, name FROM locations ORDER BY name').all(),
      distribution_lists: db.prepare('SELECT id, name FROM distribution_lists ORDER BY name').all(),
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
    return queryDirectory(q);
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
    const ctx: AnnouncementListContext = {
      ackCounts: countsBy(
        'SELECT announcement_id AS id, COUNT(*) AS c FROM announcement_acks GROUP BY announcement_id',
      ),
      audience: audienceResolver(),
    };
    return { announcements: rows.map((a) => announcementToJson(a, ctx)) };
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
    // Wer hat bestaetigt (Detail, nicht in der Liste): Name und Zeitpunkt,
    // neueste zuerst. Die Quote allein sagt der HR nicht, wen sie noch
    // erinnern muss.
    const acks = getDb()
      .prepare(
        `SELECT k.employee_id, (e.first_name || ' ' || e.last_name) AS name, k.acked_at
         FROM announcement_acks k JOIN employees e ON e.id = k.employee_id
         WHERE k.announcement_id = ? ORDER BY k.acked_at DESC, k.id DESC`,
      )
      .all(id);
    return { announcement: { ...announcementToJson(row), attachments, acks } };
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
    const previousFileIds = attachmentFileIds(id);
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
    // Entfernte Anhaenge: Datei nur loeschen, wenn sie nirgends mehr haengt
    // (core/files.ts prueft alle Referenztabellen). Erst NACH dem Commit, die
    // Referenzpruefung muss den neuen Stand sehen.
    const kept = new Set(body.attachment_file_ids ?? []);
    for (const fileId of previousFileIds) if (!kept.has(fileId)) deleteFileIfUnreferenced(fileId);
    audit(req, 'update', 'announcement', id, { title: body.title });
    const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id) as AnnouncementRow;
    return { announcement: announcementToJson(row) };
  });

  app.delete('/api/communication/announcements/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    // Anhang-Zeilen fallen per CASCADE; die Dateien selbst raeumt erst
    // deleteFileIfUnreferenced weg, sonst blieben sie ueber eine signierte
    // URL abrufbar.
    const fileIds = attachmentFileIds(id);
    const info = getDb().prepare('DELETE FROM announcements WHERE id = ?').run(id);
    if (info.changes === 0) throw notFound('Ankündigung nicht gefunden');
    for (const fileId of fileIds) deleteFileIfUnreferenced(fileId);
    audit(req, 'delete', 'announcement', id);
    reply.code(204);
  });

  // ------------------------------------------------------------------ Umfragen
  app.get('/api/communication/surveys', async () => {
    const rows = getDb().prepare('SELECT * FROM surveys ORDER BY date_from DESC, id DESC').all() as SurveyRow[];
    const ctx: SurveyListContext = {
      participantCounts: countsBy(
        'SELECT survey_id AS id, COUNT(*) AS c FROM survey_participations GROUP BY survey_id',
      ),
      audience: audienceResolver(),
      // Einmal je Request statt je Zeile — getSetting liest ungecacht aus der DB.
      defaultMinParticipants: getSetting('surveyMinParticipants'),
    };
    return { surveys: rows.map((s) => surveyToJson(s, ctx)) };
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
    // Beim Neuschreiben der Antworten (surveyService.storeAnonymousResponse)
    // bleiben vereinzelt Kopien aelterer Antworten in Seitenluecken stehen;
    // nach dem Ende kommt keine Antwort mehr hinzu, also raeumt ein Neuaufbau
    // der Tabelle sie jetzt aus der Datei, sofern seit dem letzten Antworten
    // hinzukamen. Vermerkt im selben Commit wie das Ende: Scheitert er, ist
    // die Umfrage trotzdem beendet, und der naechste Start holt ihn nach.
    const rebuild = inTransaction(() => {
      getDb().prepare('UPDATE surveys SET status = ? WHERE id = ?').run(body.status, id);
      return body.status === 'beendet' && markResponseTableRebuild(getDb());
    });
    audit(req, 'status', 'survey', id, { from: survey.status, to: body.status });
    if (rebuild) {
      try {
        rebuildResponseTableNow();
      } catch (err) {
        req.log.warn(
          `Neuaufbau der Umfrageantworten nach Umfrageende gescheitert; der nächste Start holt ihn nach (${errorText(err)}).`,
        );
      }
    }
    return { survey: surveyToJson(getSurvey(id)) };
  });

  /**
   * Testerfassung durch die HR (Umfrage durchspielen). Produktiv nehmen
   * Mitarbeitende ueber POST /api/me/surveys/:id/responses teil; beide Wege
   * laufen durch surveyService.recordParticipation (eine Pruefung, ein
   * Schreibpfad, Antworten ohne Personenbezug, deshalb kein Audit).
   */
  app.post('/api/communication/surveys/:id/responses', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ employee_id: z.number().int().positive(), answers: answersSchema }),
      req.body,
    );
    const participantCount = recordParticipation(id, body.employee_id, body.answers);
    reply.code(201);
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
    // Gezaehlt werden die Antworten wie bisher, nicht die Teilnahmen: Eine
    // Teilnahme faellt mit dem Personalprofil weg (ON DELETE CASCADE), die
    // anonyme Antwort bleibt. Nur gezaehlt, ohne sie zu laden; gelesen werden
    // die Antworten erst, wenn es Ergebnisse gibt.
    const responseCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?').get(id) as { n: number }
    ).n;
    if (responseCount < minParticipants) {
      throw new AppError(
        403,
        'MIN_PARTICIPANTS_NOT_REACHED',
        `Ergebnisse werden erst ab ${minParticipants} Teilnahmen angezeigt`,
        {
          required: minParticipants,
          current: responseCount,
          missing: minParticipants - responseCount,
        },
      );
    }
    const responses = getDb()
      .prepare('SELECT answers FROM survey_responses WHERE survey_id = ?')
      .all(id) as { answers: string }[];
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
};
