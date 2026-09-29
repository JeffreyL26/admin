/**
 * Gespraechsprotokolle aus Sicht der Fuehrung: Die zustaendige Fuehrungskraft
 * liest unter „Mein Team“, was die HR fuer sie freigegeben hat, und die HR sieht
 * beim Erfassen, wen ein Protokoll erreicht.
 *
 * Haengt an ZWEI Modulen (die Tabelle gehoert zu communication, die
 * Zustaendigkeit zu leadership) und wird deshalb ueber die Variantenverdrahtung
 * registriert, nur wenn die Variante beide enthaelt (wie meSalaryRoutes).
 *
 * Regeln:
 * - Zustaendig ist, wen `service.scopeFor` heute im Bereich fuehrt. Keine eigene
 *   Zustaendigkeitslogik: Wer frueher zustaendig war, sieht nichts mehr, und eine
 *   neue Fuehrungskraft sieht auch aeltere freigegebene Protokolle ihrer Leute
 *   (die Zustaendigkeit hat keinen Verlauf; die HR steuert je Protokoll ueber
 *   die Stufe).
 * - Welche Stufen die Fuehrung erreichen, steht allein in
 *   `MEETING_VISIBILITY_READERS` (shared); SQL ueber `meetingVisibilitySql`.
 * - Nur lesen. Das Protokoll fuehrt die HR.
 * - Ausserhalb des Bereichs 403, wie bei den uebrigen `/me`-Routen der Fuehrung.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { permits, type LeaderMeeting, type MeetingRecipientsResponse } from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { parse } from '../../core/errors.js';
import { todayIso } from '../../core/dates.js';
import { permissionsFor } from '../../core/permissions.js';
import { meetingVisibilitySql } from '../communication/meetingVisibility.js';
import { leaderIdOf, registerLeaderRoutes } from './routes.js';
import * as service from './service.js';

const LEADER_VISIBLE_SQL = meetingVisibilitySql('m.visibility', 'leaders');

/**
 * Nur Protokolle, die die Fuehrung erreichen: Der Filter steckt in der Basis,
 * jede Abfrage haengt ihre Bedingung mit AND an. `visible_to_employee` heisst
 * freigegeben UND ein Konto mit verknuepftem Profil (Portalzugang).
 */
const LEADER_MEETING_FROM = `
  FROM meeting_protocols m
  JOIN employees e ON e.id = m.employee_id
  WHERE ${LEADER_VISIBLE_SQL}`;

const LEADER_MEETING_SELECT = `
  SELECT m.id, m.employee_id, e.first_name, e.last_name, m.meeting_date, m.occasion,
         m.participants, m.content, m.agreements, m.follow_up_date,
         (${meetingVisibilitySql('m.visibility', 'employee')}) AS released_to_employee,
         (${meetingVisibilitySql('m.visibility', 'employee')}
          AND EXISTS (SELECT 1 FROM users u WHERE u.employee_id = m.employee_id)) AS visible_to_employee
  ${LEADER_MEETING_FROM}`;

const idParam = z.object({ id: z.coerce.number().int().positive() });
const recipientsQuery = z.object({ employee_id: z.coerce.number().int().positive() });

/** Protokolle einer Person, die die Fuehrung erreichen, neueste zuerst. */
function meetingsOf(employeeId: number): LeaderMeeting[] {
  return getDb()
    .prepare(`${LEADER_MEETING_SELECT} AND m.employee_id = ? ORDER BY m.meeting_date DESC, m.id DESC`)
    .all(employeeId) as LeaderMeeting[];
}

type FollowUp = Pick<
  LeaderMeeting,
  'id' | 'employee_id' | 'first_name' | 'last_name' | 'meeting_date' | 'occasion' | 'follow_up_date'
>;

/**
 * Faellige Wiedervorlagen (heute oder ueberfaellig) im Bereich der
 * Fuehrungskraft. Nur die Felder der Karte: der Text steht auf der Seite der
 * Person. Erst faellige Protokolle holen, `scopeFor` nur, wenn es welche gibt.
 */
function followUpsFor(leaderId: number): FollowUp[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.employee_id, e.first_name, e.last_name, m.meeting_date, m.occasion, m.follow_up_date
       ${LEADER_MEETING_FROM} AND m.follow_up_date <= ?
       ORDER BY m.follow_up_date, m.id`,
    )
    .all(todayIso()) as FollowUp[];
  if (rows.length === 0) return rows;
  const scope = service.scopeFor(leaderId);
  return rows.filter((r) => scope.has(r.employee_id));
}

export const leaderMeetingRoutes: FastifyPluginAsync = async (app) => {
  /**
   * HR-Seite (Bereich `kommunikation` ueber den Praefix in ROUTE_AREAS): wen
   * erreicht ein Protokoll dieser Person heute? Namen und Erreichbarkeit
   * braucht, wer die Stufe waehlt. Die QUELLEN der Zustaendigkeit (inklusive
   * manueller Zuweisungen) gehoeren zur Fuehrungsverwaltung und gehen nur an
   * Konten mit `fuehrung: lesen`, sonst weitete `kommunikation` still auf sie aus.
   */
  app.get('/api/communication/meetings/recipients', async (req): Promise<MeetingRecipientsResponse> => {
    const { employee_id } = parse(recipientsQuery, req.query);
    const withSources = permits(permissionsFor(req.user.admin_role_id ?? null).fuehrung, 'lesen');
    const leaders = service.responsibleLeaders(employee_id);
    return {
      leaders: leaders.map((l) =>
        withSources ? l : { employee_id: l.employee_id, name: l.name, has_account: l.has_account },
      ),
    };
  });

  // Parameter bewusst `app`: der Abgleich „Backend-Route ohne Aufrufer“
  // (CLAUDE.md) sucht nach `app.<verb>('/api/...')`.
  await registerLeaderRoutes(app, (app) => {
    // Parametername `:id` wie bei `/me/employees/:id` (find-my-way verlangt an
    // derselben Baumposition denselben Namen).
    app.get('/api/leadership/me/employees/:id/meetings', async (req) => {
      const { id } = parse(idParam, req.params);
      service.assertInScope(leaderIdOf(req), id);
      return { meetings: meetingsOf(id) };
    });

    app.get('/api/leadership/me/meetings/follow-ups', async (req) => {
      return { meetings: followUpsFor(leaderIdOf(req)) };
    });
  });
};
