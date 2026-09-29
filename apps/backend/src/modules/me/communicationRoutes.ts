/**
 * Self-Service Kommunikation: Ankuendigungen lesen und bestaetigen, an
 * Umfragen teilnehmen (/api/me/announcements, /api/me/surveys).
 *
 * Haengt am Modul communication und wird deshalb ueber die
 * Variantenverdrahtung (src/variants/<id>.ts) registriert, nur wenn die
 * Variante das Modul enthaelt (wie meSalaryRoutes fuer compensation).
 *
 * Sichtbar ist ausschliesslich, was sich an die angemeldete Person richtet:
 * Zielgruppe ueber audience.ts (dieselbe Aufloesung, mit der die HR die
 * Empfaengerzahl sieht), Ankuendigungen nur im Zeitfenster
 * publish_at..expires_at, Umfragen nur im Status 'laufend'. Alles andere ist
 * 404, nicht 403: Ob es eine Ankuendigung mit dieser ID fuer andere gibt,
 * geht die Person nichts an.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/db.js';
import { notFound, parse } from '../../core/errors.js';
import { todayIso } from '../../core/dates.js';
import { signDownloadUrl } from '../../core/files.js';
import { audienceOfEmployeeSql } from '../communication/audience.js';
import { queryDirectory } from '../communication/directoryService.js';
import { meetingVisibilitySql } from '../communication/meetingVisibility.js';
import {
  answersSchema,
  getQuestions,
  hasParticipated,
  recordParticipation,
  type SurveyRow,
} from '../communication/surveyService.js';
import { requireEmployee } from './lib.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  publish_at: string;
  expires_at: string | null;
  requires_ack: number;
  acked_at: string | null;
}

/** Aktive Ankuendigungen an die Person, neueste zuerst. */
function myAnnouncements(employeeId: number, onlyId: number | null): AnnouncementRow[] {
  const today = todayIso();
  const audience = audienceOfEmployeeSql('a', employeeId);
  return getDb()
    .prepare(
      `SELECT a.id, a.title, a.body, a.publish_at, a.expires_at, a.requires_ack, k.acked_at
       FROM announcements a
       LEFT JOIN announcement_acks k ON k.announcement_id = a.id AND k.employee_id = ?
       WHERE a.publish_at <= ? AND (a.expires_at IS NULL OR a.expires_at >= ?)
         AND ${audience.sql}
         ${onlyId === null ? '' : 'AND a.id = ?'}
       ORDER BY a.publish_at DESC, a.id DESC`,
    )
    .all(employeeId, today, today, ...audience.params, ...(onlyId === null ? [] : [onlyId])) as AnnouncementRow[];
}

/** Anhaenge ohne signierte URL; signiert wird beim Klick (Route unten). */
function attachmentsOf(announcementId: number) {
  return getDb()
    .prepare(
      `SELECT aa.file_id, f.original_name, f.size_bytes, f.mime_type
       FROM announcement_attachments aa JOIN files f ON f.id = aa.file_id
       WHERE aa.announcement_id = ? ORDER BY aa.id`,
    )
    .all(announcementId) as { file_id: number; original_name: string; size_bytes: number; mime_type: string | null }[];
}

function announcementToJson(a: AnnouncementRow) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    publish_at: a.publish_at,
    expires_at: a.expires_at,
    requires_ack: a.requires_ack === 1,
    acked_at: a.acked_at,
    attachments: attachmentsOf(a.id),
  };
}

/**
 * Laufende Umfragen an die Person; optional auf eine ID eingeschraenkt.
 * Neben dem Status zaehlt das Enddatum: Eine Umfrage, die die HR nach
 * `date_to` nicht beendet hat, wird der Person nicht mehr angeboten (die
 * Karte nennt das Datum, ein Widerspruch dazu waere sichtbar). Die
 * HR-Testerfassung bleibt davon unberuehrt.
 */
function mySurveys(employeeId: number, onlyId: number | null): SurveyRow[] {
  const audience = audienceOfEmployeeSql('s', employeeId);
  return getDb()
    .prepare(
      `SELECT s.* FROM surveys s
       WHERE s.status = 'laufend' AND s.date_to >= ? AND ${audience.sql}
         ${onlyId === null ? '' : 'AND s.id = ?'}
       ORDER BY s.date_to, s.id`,
    )
    .all(todayIso(), ...audience.params, ...(onlyId === null ? [] : [onlyId])) as SurveyRow[];
}

function surveyToJson(s: SurveyRow, employeeId: number) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    date_from: s.date_from,
    date_to: s.date_to,
    participated: hasParticipated(s.id, employeeId),
  };
}

/** Eigene Gespraechsprotokolle, die die HR fuer die Person freigegeben hat. */
function myMeetings(employeeId: number) {
  return getDb()
    .prepare(
      `SELECT id, meeting_date, occasion, participants, content, agreements, follow_up_date
       FROM meeting_protocols
       WHERE employee_id = ? AND ${meetingVisibilitySql('visibility', 'employee')}
       ORDER BY meeting_date DESC, id DESC`,
    )
    .all(employeeId);
}

export const meCommunicationRoutes: FastifyPluginAsync = async (app) => {
  // ---------------------------------------------------------- Gespraeche ---
  /**
   * Nur Stufen mit `MEETING_VISIBILITY_READERS[..].employee` erreichen die
   * Person (heute 'hr_vorgesetzte_mitarbeiter'); 'hr_vorgesetzte' geht an die
   * zustaendigen Fuehrungskraefte (leadership/meetingRoutes.ts). Kein
   * Einzelabruf und keine Schreibroute: Das Protokoll fuehrt die HR.
   */
  app.get('/api/me/meetings', async (req) => {
    const emp = requireEmployee(req);
    return { meetings: myMeetings(emp.id) };
  });

  // --------------------------------------------------------- Verzeichnis ---
  /**
   * Kolleg:innen mit denselben Feldern und Filtern wie das HR-Verzeichnis
   * (communication/directoryService.ts). Fotos kommen kurzlebig signiert wie
   * bei /api/me/org-chart; der Client haengt API_BASE davor. `departments`
   * nur, wenn das Feld sichtbar ist, sonst gaebe es einen Filter auf etwas,
   * das die Karten nicht zeigen.
   */
  app.get('/api/me/directory', async (req) => {
    requireEmployee(req);
    const q = parse(
      z.object({
        search: z.string().optional(),
        department_id: z.coerce.number().int().positive().optional(),
        location_id: z.coerce.number().int().positive().optional(),
        skill: z.string().optional(),
      }),
      req.query,
    );
    const result = queryDirectory(q);
    const departments = result.fields.department
      ? (getDb().prepare('SELECT id, name, parent_id FROM departments ORDER BY name').all() as {
          id: number;
          name: string;
          parent_id: number | null;
        }[])
      : [];
    return { ...result, departments };
  });

  // ------------------------------------------------------------ Ankuendigungen ---
  app.get('/api/me/announcements', async (req) => {
    const emp = requireEmployee(req);
    return { announcements: myAnnouncements(emp.id, null).map(announcementToJson) };
  });

  /**
   * Lesebestaetigung. Idempotent: Eine zweite Bestaetigung aendert nichts
   * und antwortet trotzdem 204, damit ein Doppelklick keinen Fehler zeigt.
   * Ohne requires_ack ist die Bestaetigung ebenfalls erlaubt (sie schadet
   * nicht und die HR sieht die Quote), aber die Clients bieten sie dann
   * nicht an.
   */
  app.post('/api/me/announcements/:id/ack', async (req, reply) => {
    const emp = requireEmployee(req);
    const { id } = parse(idParam, req.params);
    const [row] = myAnnouncements(emp.id, id);
    if (!row) throw notFound('Ankündigung nicht gefunden');
    getDb()
      .prepare('INSERT OR IGNORE INTO announcement_acks (announcement_id, employee_id) VALUES (?, ?)')
      .run(id, emp.id);
    reply.code(204);
  });

  /**
   * Anhang signieren, erst beim Klick: ERST Zielgruppe und Zugehoerigkeit des
   * Anhangs pruefen, DANN signieren (die Signatur traegt keine Nutzerpruefung,
   * die URL ist bis zum Ablauf ein Bearer-Token auf die Datei; Vorbild
   * me/documentRoutes.ts). Steht in LICENSE_OPEN_ROUTES: reiner Lesevorgang.
   */
  app.post('/api/me/announcements/:id/attachments/:fileId/sign', async (req, reply) => {
    const emp = requireEmployee(req);
    const { id, fileId } = parse(
      z.object({ id: z.coerce.number().int().positive(), fileId: z.coerce.number().int().positive() }),
      req.params,
    );
    const [row] = myAnnouncements(emp.id, id);
    if (!row) throw notFound('Ankündigung nicht gefunden');
    const attachment = getDb()
      .prepare('SELECT 1 AS x FROM announcement_attachments WHERE announcement_id = ? AND file_id = ?')
      .get(id, fileId);
    if (!attachment) throw notFound('Anhang nicht gefunden');
    reply.header('Cache-Control', 'no-store');
    return { url: signDownloadUrl(fileId) };
  });

  // ------------------------------------------------------------------ Umfragen ---
  app.get('/api/me/surveys', async (req) => {
    const emp = requireEmployee(req);
    return { surveys: mySurveys(emp.id, null).map((s) => surveyToJson(s, emp.id)) };
  });

  app.get('/api/me/surveys/:id', async (req) => {
    const emp = requireEmployee(req);
    const { id } = parse(idParam, req.params);
    const [row] = mySurveys(emp.id, id);
    if (!row) throw notFound('Umfrage nicht gefunden');
    const questions = getQuestions(id).map((q) => ({
      id: q.id,
      kind: q.kind,
      text: q.text,
      options: q.options ? (JSON.parse(q.options) as string[]) : null,
      scale_max: q.scale_max,
    }));
    return { survey: { ...surveyToJson(row, emp.id), questions } };
  });

  /**
   * Teilnahme. Die Person kommt aus dem Konto, nie aus dem Body; Pruefung und
   * Schreibpfad teilt sich die Route mit der HR-Testerfassung
   * (communication/surveyService.ts). Kein Audit: Antworten sind anonym.
   */
  app.post('/api/me/surveys/:id/responses', async (req, reply) => {
    const emp = requireEmployee(req);
    const { id } = parse(idParam, req.params);
    const [row] = mySurveys(emp.id, id);
    if (!row) throw notFound('Umfrage nicht gefunden');
    const body = parse(z.object({ answers: answersSchema }), req.body);
    recordParticipation(id, emp.id, body.answers);
    reply.code(201);
    return { participation: { survey_id: id, participated: true } };
  });
};
