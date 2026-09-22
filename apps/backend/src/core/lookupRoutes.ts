/**
 * Bereichsneutrale Nachschlagelisten fuer Auswahlfelder.
 *
 * Fast jedes Modul braucht eine Personenliste (Hiring Manager, Interviewer,
 * On-/Offboarding, Rollenmitglieder). Die haengt bisher an
 * `GET /api/employees?fields=lite` und damit am Bereich `personal`: Eine
 * Rolle mit `recruiting: bearbeiten`, aber `personal: kein` sah ueberall
 * leere Auswahlfelder. Diese Route liefert dieselbe schlanke Form (Kontrakt
 * `fields=lite`, keine Fachdaten wie Gehalt, Steuer oder Adresse) und steht in
 * ALWAYS_ALLOWED (core/permissions.ts). Wer die Feldliste hier erweitert,
 * gibt die Felder JEDER Admin-Rolle preis; alles ueber Name, Zuordnung und
 * Status hinaus bleibt in `modules/employees`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { parse } from './errors.js';

const LITE_COLUMNS =
  'id, first_name, last_name, employee_type, status, job_title, department_id, team_id, location_id';

export async function lookupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/lookup/employees', async (req) => {
    const q = parse(
      z.object({ include_inactive: z.enum(['1', 'true', '0', 'false']).optional() }),
      req.query ?? {},
    );
    // Wer die Route erreicht, hat laut core/permissions.ts (ANY_AREA_ROUTES)
    // mindestens einen Fachbereich lesend. Ausgeschiedene gehoeren dazu: Viele
    // Seiten zeigen gespeicherte Verweise (Kontoverknuepfung, Personenregeln,
    // Beurteilungen, Protokolle), die sonst namenlos blieben.
    const includeInactive = q.include_inactive === '1' || q.include_inactive === 'true';
    const rows = getDb()
      .prepare(
        `SELECT ${LITE_COLUMNS} FROM employees
         ${includeInactive ? '' : "WHERE status = 'aktiv'"}
         ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE`,
      )
      .all();
    return { employees: rows };
  });
}
