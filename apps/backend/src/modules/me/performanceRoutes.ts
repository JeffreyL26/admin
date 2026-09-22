/**
 * Self-Service „Meine Entwicklung“ (GET /api/me/development).
 *
 * Haengt am Modul performance und wird deshalb ueber die Variantenverdrahtung
 * (src/variants/<id>.ts) registriert, nur wenn die Variante das Modul
 * enthaelt (wie meSalaryRoutes fuer compensation).
 *
 * EINE Antwort mit allem, was die Person ueber sich sehen darf: eigene Ziele,
 * eigene Trainings-Anmeldungen, eigene Gespraeche samt vereinbarter
 * Massnahmen und eigene Skill-Levels.
 * Alles ist strikt ueber employee_id gefiltert; es gibt keine IDs anderer
 * Personen im Pfad, also auch nichts, was 404 werden koennte.
 *
 * Bewusst NICHT enthalten (Entscheidung der Produktverantwortung): die
 * Vorgesetztenbewertung samt Kommentaren (leadership_ratings bleiben HR und
 * Fuehrung vorbehalten, Fuehrungskraefte schreiben sie nicht fuer die
 * Person), die Notiz der HR zur Trainingsanmeldung und die
 * Gespraechsnotizen (Vorbereitungs- und Verlaufsnotizen der HR).
 */
import type { FastifyPluginAsync } from 'fastify';
import type {
  MeDevelopmentAction,
  MeDevelopmentGoal,
  MeDevelopmentMeeting,
  MeDevelopmentResponse,
  MeDevelopmentSkill,
  MeDevelopmentTraining,
} from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { requireEmployee } from './lib.js';

function myGoals(employeeId: number): MeDevelopmentGoal[] {
  return getDb()
    .prepare(
      `SELECT id, title, description, kind, parent_goal_id, metric, target_value, current_value,
              progress, period_from, period_to, status
       FROM goals WHERE employee_id = ?
       ORDER BY created_at, id`,
    )
    .all(employeeId) as MeDevelopmentGoal[];
}

function myTrainings(employeeId: number): MeDevelopmentTraining[] {
  return getDb()
    .prepare(
      `SELECT r.id, r.training_id, t.title AS training_title, t.provider, t.kind AS training_kind,
              t.mandatory, r.status, r.date, r.completed_at
       FROM training_registrations r
       JOIN trainings t ON t.id = r.training_id
       WHERE r.employee_id = ?
       ORDER BY r.date IS NULL, r.date DESC, r.id DESC`,
    )
    .all(employeeId) as MeDevelopmentTraining[];
}

function myMeetings(employeeId: number): MeDevelopmentMeeting[] {
  const db = getDb();
  const meetings = db
    .prepare(
      `SELECT id, kind, scheduled_date, held_date, status, recurrence_months
       FROM feedback_meetings WHERE employee_id = ?
       ORDER BY scheduled_date DESC, id DESC`,
    )
    .all(employeeId) as Omit<MeDevelopmentMeeting, 'actions'>[];
  if (meetings.length === 0) return [];
  const actions = db
    .prepare(
      `SELECT a.id, a.meeting_id, a.title, a.due_date, a.status,
              o.first_name || ' ' || o.last_name AS owner_name
       FROM feedback_actions a
       JOIN feedback_meetings m ON m.id = a.meeting_id
       LEFT JOIN employees o ON o.id = a.owner_employee_id
       WHERE m.employee_id = ?
       ORDER BY a.due_date IS NULL, a.due_date, a.id`,
    )
    .all(employeeId) as MeDevelopmentAction[];
  const byMeeting = new Map<number, MeDevelopmentAction[]>();
  for (const a of actions) byMeeting.set(a.meeting_id, [...(byMeeting.get(a.meeting_id) ?? []), a]);
  return meetings.map((m) => ({ ...m, actions: byMeeting.get(m.id) ?? [] }));
}

function mySkills(employeeId: number): MeDevelopmentSkill[] {
  return getDb()
    .prepare(
      `SELECT es.skill_id, s.name, s.category, es.level, es.assessed_at
       FROM employee_skills es JOIN skills s ON s.id = es.skill_id
       WHERE es.employee_id = ?
       ORDER BY s.category, s.name`,
    )
    .all(employeeId) as MeDevelopmentSkill[];
}

export const mePerformanceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/me/development', async (req): Promise<MeDevelopmentResponse> => {
    const me = requireEmployee(req);
    return {
      goals: myGoals(me.id),
      trainings: myTrainings(me.id),
      meetings: myMeetings(me.id),
      skills: mySkills(me.id),
    };
  });
};
