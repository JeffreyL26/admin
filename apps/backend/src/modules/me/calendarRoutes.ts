/**
 * Firmenweiter Abwesenheitskalender des Mitarbeitenden-Portals
 * (GET /api/me/calendar).
 *
 * Bewusste Unterschiede zum HR-Kalender (GET /api/absences/calendar):
 *  - `month` ist PFLICHT (siehe MONTH_REQUIRED_MESSAGE),
 *  - nur `status = 'genehmigt'` (fremde Anträge in Prüfung sind niemandes Sache),
 *  - keine Konfliktberechnung (Teamgrößen und Quoten sind eine HR-Kennzahl),
 *  - Arten mit `portal_visibility = 'neutral'` werden maskiert ausgeliefert.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CountryCode,
  MeCalendarEmployee,
  MeCalendarEntry,
  RegionCode,
} from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { badRequest, parse } from '../../core/errors.js';
import { holidaysByRegion } from '../../core/holidays.js';
import {
  companyRegionDefaults,
  regionSelectParams,
  REGION_JOIN_SQL,
  REGION_SELECT_SQL,
} from '../absences/service.js';
import { requireEmployee } from './lib.js';

/**
 * Farbe maskierter Einträge: `--gray-400` des Hell-Themes. Als konkreter
 * Hex-Wert, weil die Antwort clientseitig direkt als Farbe gesetzt wird und
 * in allen vier Farbschemata lesbar bleiben muss.
 */
const NEUTRAL_COLOR = '#9aa7bc';

/** Maskierter Anzeigename, wenn die Art nicht im Klartext erscheinen darf. */
const NEUTRAL_TYPE_NAME = 'Abwesend';

const MONTH_REQUIRED_MESSAGE =
  'Bitte einen Monat (1–12) angeben — der Firmenkalender wird immer monatsweise geladen.';

const querySchema = z.object({
  year: z.coerce.number().int(),
  month: z.coerce.number().int(),
});

/** Zeile der Sammelabfrage — bereits maskiert aus der Datenbank. */
interface CalendarAbsenceRow extends MeCalendarEntry {
  employee_id: number;
}

interface CalendarEmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  department_id: number | null;
  team_id: number | null;
  country: CountryCode;
  bundesland: RegionCode;
}

export async function meCalendarRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getDb();

  app.get('/api/me/calendar', async (req) => {
    // Erste Zeile jeder Self-Service-Route: eigenes Profil oder 403.
    requireEmployee(req);

    const q = req.query as { year?: string; month?: string };
    // Anders als im HR-Kalender ist der Monat Pflicht: diese Route liefert ALLE
    // aktiven Mitarbeitenden und wird von allen Portal-Nutzenden gleichzeitig
    // aufgerufen. Ohne Monatsgrenze würde jeder Aufruf ein komplettes Jahr über
    // die gesamte Belegschaft laden — die Last wächst mit Belegschaft mal
    // Nutzenden. Die Monatsgrenze deckelt sie hart.
    if (q.month === undefined || q.month === '') throw badRequest(MONTH_REQUIRED_MESSAGE);

    const { year, month } = parse(querySchema, { year: q.year, month: q.month });
    if (year < 2000 || year > 2100) throw badRequest('Ungültiges Jahr');
    if (month < 1 || month > 12) throw badRequest('Ungültiger Monat');

    const mm = String(month).padStart(2, '0');
    // Tag 0 des Folgemonats = letzter Tag des gesuchten Monats.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const from = `${year}-${mm}-01`;
    const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

    // Nur aktive Mitarbeitende. Land und Region kommen vom Standort, sonst
    // aus der Firmenvorgabe; derselbe Ausdruck wie im HR-Kalender.
    const defaults = companyRegionDefaults();
    const employees = db()
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, e.department_id, e.team_id,
                ${REGION_SELECT_SQL}
         FROM employees e
         ${REGION_JOIN_SQL}
         WHERE e.status = 'aktiv'
         ORDER BY e.last_name, e.first_name`,
      )
      .all(regionSelectParams(defaults)) as CalendarEmployeeRow[];

    // Eine Sammelabfrage für alle Mitarbeitenden (keine Abfrage je Person).
    // Die Maskierung passiert in SQL: Name, Farbe und ID der Art verlassen die
    // Datenbank bei `portal_visibility = 'neutral'` gar nicht erst, damit es
    // keinen Weg gibt, auf dem der Klarname doch nach draußen gelangt.
    const absences = db()
      .prepare(
        `SELECT r.id AS request_id, r.employee_id,
                CASE WHEN t.portal_visibility = 'neutral' THEN NULL ELSE t.id END AS type_id,
                CASE WHEN t.portal_visibility = 'neutral' THEN ? ELSE t.name END AS type_name,
                CASE WHEN t.portal_visibility = 'neutral' THEN ? ELSE t.color END AS color,
                r.date_from, r.date_to, r.half_day_start, r.half_day_end
         FROM absence_requests r
         JOIN absence_types t ON t.id = r.type_id
         JOIN employees e ON e.id = r.employee_id
         WHERE r.status = 'genehmigt' AND e.status = 'aktiv'
           AND r.date_from <= ? AND r.date_to >= ?
         ORDER BY r.date_from, r.id`,
      )
      .all([NEUTRAL_TYPE_NAME, NEUTRAL_COLOR, to, from]) as CalendarAbsenceRow[];

    // Zuordnung im Speicher statt N+1-Abfragen.
    const byEmployee = new Map<number, MeCalendarEntry[]>();
    for (const row of absences) {
      const { employee_id, ...entry } = row;
      let list = byEmployee.get(employee_id);
      if (!list) byEmployee.set(employee_id, (list = []));
      list.push(entry);
    }

    // Feiertage je vorkommender Region, beschnitten auf den Monat.
    const holidays = holidaysByRegion(year, from, to, [
      ...employees.map((e) => ({ country: e.country, region: e.bundesland })),
      defaults,
    ]);

    const closures = db()
      .prepare('SELECT * FROM company_closures WHERE date_from <= ? AND date_to >= ? ORDER BY date_from')
      .all([to, from]);

    const result: MeCalendarEmployee[] = employees.map((e) => ({
      ...e,
      region: e.bundesland,
      absences: byEmployee.get(e.id) ?? [],
    }));

    return { range: { from, to }, employees: result, holidays, closures };
  });
}
