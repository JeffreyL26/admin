import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { homeOfficeExceptionFor, type HomeOfficeException } from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { notFound, parse } from '../../core/errors.js';
import { isoDateString } from '../../core/validation.js';

/**
 * Home Office im Kalender (shared/homeOffice.ts): Das Muster je Person pflegt
 * die Personalakte (`employees.home_office_weekdays`), einzelne Tage weichen
 * hier ab. Bereich `abwesenheit` (ROUTE_AREAS über /api/absences): wer den
 * Kalender bearbeiten darf, trägt Bürotage ein. Kein Audit: Ein Arbeitsort
 * je Tag ist keine Änderung mit Begründungspflicht.
 */
const setSchema = z.object({
  employee_id: z.number().int().positive(),
  date: isoDateString,
  /** true = an diesem Tag Home Office, false = im Büro. */
  home_office: z.boolean(),
});

const deleteParams = z.object({
  employeeId: z.coerce.number().int().positive(),
  date: isoDateString,
});

/** Ausnahmen aller genannten Personen im Zeitraum, je Person als Liste. */
export function homeOfficeExceptionsByEmployee(
  employeeIds: number[],
  from: string,
  to: string,
): Map<number, HomeOfficeException[]> {
  const map = new Map<number, HomeOfficeException[]>();
  if (employeeIds.length === 0) return map;
  const rows = getDb()
    .prepare(
      `SELECT employee_id, date, kind FROM home_office_exceptions
       WHERE date >= ? AND date <= ? AND employee_id IN (${employeeIds.map(() => '?').join(',')})
       ORDER BY date`,
    )
    .all([from, to, ...employeeIds]) as { employee_id: number; date: string; kind: HomeOfficeException['kind'] }[];
  for (const r of rows) {
    const list = map.get(r.employee_id);
    const entry = { date: r.date, kind: r.kind };
    if (list) list.push(entry);
    else map.set(r.employee_id, [entry]);
  }
  return map;
}

export async function homeOfficeRoutes(app: FastifyInstance): Promise<void> {
  // Arbeitsort an einem Tag setzen. Entspricht er dem Muster, fällt eine
  // bestehende Ausnahme weg; sonst wird sie angelegt oder umgestellt.
  app.post('/api/absences/home-office', async (req) => {
    const body = parse(setSchema, req.body);
    const db = getDb();
    const employee = db.prepare('SELECT home_office_weekdays FROM employees WHERE id = ?').get(body.employee_id) as
      | { home_office_weekdays: string | null }
      | undefined;
    if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
    const kind = homeOfficeExceptionFor(employee.home_office_weekdays, body.date, body.home_office);
    if (kind === null) {
      db.prepare('DELETE FROM home_office_exceptions WHERE employee_id = ? AND date = ?').run(body.employee_id, body.date);
    } else {
      db.prepare(
        `INSERT INTO home_office_exceptions (employee_id, date, kind, created_by_user_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(employee_id, date) DO UPDATE SET kind = excluded.kind, created_by_user_id = excluded.created_by_user_id`,
      ).run(body.employee_id, body.date, kind, req.user.id);
    }
    return { employee_id: body.employee_id, date: body.date, exception: kind };
  });

  // Ausnahme entfernen: Der Tag folgt wieder dem Muster.
  app.delete('/api/absences/home-office/:employeeId/:date', async (req, reply) => {
    const { employeeId, date } = parse(deleteParams, req.params);
    getDb().prepare('DELETE FROM home_office_exceptions WHERE employee_id = ? AND date = ?').run(employeeId, date);
    reply.status(204);
    return null;
  });
}
