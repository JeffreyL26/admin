import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import type { AudienceType } from './audience.js';

/**
 * Teilnahme an Umfragen, gemeinsam fuer die HR-Testerfassung
 * (POST /api/communication/surveys/:id/responses) und das Portal
 * (POST /api/me/surveys/:id/responses). Es gibt genau EINE Pruefung der
 * Antworten und EINEN Schreibpfad, sonst liesse die eine Seite Werte durch,
 * an denen die Auswertung der anderen scheitert.
 *
 * ANONYMITAET: Die Teilnahme wird in survey_participations markiert (Dedup
 * und Quote), die Antworten landen OHNE employee_id in survey_responses. Eine
 * Zuordnung Antwort zu Person ist im Datenmodell nicht moeglich, deshalb wird
 * hier auch bewusst nicht auditiert.
 */

export interface SurveyRow {
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

export interface QuestionRow {
  id: number;
  survey_id: number;
  kind: 'skala' | 'einfachauswahl' | 'mehrfachauswahl' | 'freitext';
  text: string;
  options: string | null;
  scale_max: number | null;
  sort_order: number;
}

export const answersSchema = z
  .array(
    z.object({
      question_id: z.number().int().positive(),
      value: z.union([z.string(), z.number(), z.array(z.string())]),
    }),
  )
  .min(1, 'Mindestens eine Antwort erforderlich');

export type SurveyAnswers = z.infer<typeof answersSchema>;

export function getSurvey(id: number): SurveyRow {
  const row = getDb().prepare('SELECT * FROM surveys WHERE id = ?').get(id) as SurveyRow | undefined;
  if (!row) throw notFound('Umfrage nicht gefunden');
  return row;
}

export function getQuestions(surveyId: number): QuestionRow[] {
  return getDb()
    .prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order, id')
    .all(surveyId) as QuestionRow[];
}

export function questionToJson(q: QuestionRow) {
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

export function hasParticipated(surveyId: number, employeeId: number): boolean {
  return (
    getDb()
      .prepare('SELECT 1 AS x FROM survey_participations WHERE survey_id = ? AND employee_id = ?')
      .get(surveyId, employeeId) !== undefined
  );
}

/** Prueft jede Antwort gegen Art und Wertebereich ihrer Frage. */
export function validateAnswers(surveyId: number, answers: SurveyAnswers): void {
  const questions = new Map(getQuestions(surveyId).map((q) => [q.id, q]));
  for (const a of answers) {
    const q = questions.get(a.question_id);
    if (!q) throw badRequest(`Frage ${a.question_id} gehört nicht zu dieser Umfrage`);
    if (q.kind === 'skala') {
      if (typeof a.value !== 'number' || !Number.isInteger(a.value) || a.value < 1 || a.value > (q.scale_max ?? 5)) {
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
}

/**
 * Teilnahme einer aktiven Person an einer laufenden Umfrage. Wirft 409 bei
 * Doppelteilnahme oder wenn die Umfrage nicht laeuft, 400 bei ungueltigen
 * Antworten. Liefert die neue Teilnahmezahl.
 */
export function recordParticipation(surveyId: number, employeeId: number, answers: SurveyAnswers): number {
  const survey = getSurvey(surveyId);
  if (survey.status !== 'laufend') {
    throw conflict('Antworten sind nur möglich, während die Umfrage läuft');
  }
  const employee = getDb()
    .prepare("SELECT id FROM employees WHERE id = ? AND status = 'aktiv'")
    .get(employeeId);
  if (!employee) throw badRequest('Mitarbeiter:in nicht gefunden oder nicht aktiv');
  if (hasParticipated(surveyId, employeeId)) {
    throw conflict('Diese Person hat an der Umfrage bereits teilgenommen');
  }
  validateAnswers(surveyId, answers);

  inTransaction(() => {
    getDb()
      .prepare('INSERT INTO survey_participations (survey_id, employee_id) VALUES (?, ?)')
      .run(surveyId, employeeId);
    getDb()
      .prepare('INSERT INTO survey_responses (survey_id, answers) VALUES (?, ?)')
      .run(surveyId, JSON.stringify(answers));
  });
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM survey_participations WHERE survey_id = ?')
      .get(surveyId) as { c: number }
  ).c;
}
