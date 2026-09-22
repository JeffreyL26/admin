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
import { forbidden, parse } from './errors.js';
import { ADMIN_AREAS, permits, type AdminArea } from '@ohrganize/shared';
import { permissionsFor } from './permissions.js';

/**
 * Bereiche, in denen Auswahlfelder Personen anbieten. Wer keinen davon lesen
 * darf (etwa die Rolle „Führungskraft“ mit allen Bereichen auf `kein`), bekommt
 * die Liste nicht: Sie haette sonst ueber diese Route die ganze Belegschaft
 * gesehen, obwohl ihr die Personalakte verschlossen ist. Die Fuehrung holt
 * ihre Auswahl ueber GET /api/leadership/lookup (Bereich `fuehrung`).
 */
const PICKER_AREAS: readonly AdminArea[] = ADMIN_AREAS.filter((a) => a !== 'einstellungen' && a !== 'fuehrung');
/** Ausgeschiedene nur mit Einblick in Personal oder Verwaltung (Offboarding, Vorgesetzte). */
const INACTIVE_AREAS: readonly AdminArea[] = ['personal', 'verwaltung'];

const LITE_COLUMNS =
  'id, first_name, last_name, employee_type, status, job_title, department_id, team_id, location_id';

export async function lookupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/lookup/employees', async (req) => {
    const q = parse(
      z.object({ include_inactive: z.enum(['1', 'true', '0', 'false']).optional() }),
      req.query ?? {},
    );
    const permissions = permissionsFor(req.user.admin_role_id);
    if (!PICKER_AREAS.some((a) => permits(permissions[a], 'lesen'))) {
      throw forbidden('Für die Personenauswahl fehlt Ihnen die Berechtigung');
    }
    const includeInactive =
      (q.include_inactive === '1' || q.include_inactive === 'true') &&
      INACTIVE_AREAS.some((a) => permits(permissions[a], 'lesen'));
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
