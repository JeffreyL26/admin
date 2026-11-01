import type { FastifyRequest } from 'fastify';
import { permits, type PermissionLevel } from '@ohrganize/shared';
import { getDb } from '../db/db.js';
import { forbidden } from './errors.js';
import { permissionsFor } from './permissions.js';

/**
 * Leitungsebene (Chief-HR): Personen mit `employees.executive = 1` sehen
 * Konten ohne das Recht `leitung` nur mit ihren Verzeichnisdaten. Ein zweites
 * Gate JE PERSON neben dem Bereich der Route (der globale Hook prüft weiter
 * `personal`, `verguetung` usw.); jede Route mit Personenbezug in Personal
 * und Vergütung ruft es selbst auf. Lesen verlangt `leitung: lesen`,
 * Schreiben `leitung: bearbeiten`, jeweils ZUSÄTZLICH zum Fachbereich.
 * `admin_role_id = NULL` (Vollzugriff) hat alles, Portal-Konten nie etwas.
 *
 * Verzeichnis, Organigramm, Auswahlfelder (`/api/lookup/employees`,
 * `fields=lite`) und Abwesenheiten bleiben für alle sichtbar: Die Person
 * soll im Unternehmen gelistet bleiben, geschützt sind Stammdaten,
 * Verträge, Dokumente und Vergütung.
 */

/** Spalten, die jedes Konto mit `personal: lesen` auch von Leitungspersonen sieht. */
export const DIRECTORY_COLUMNS: ReadonlySet<string> = new Set([
  'id', 'first_name', 'last_name', 'job_title', 'email', 'phone', 'photo_file_id', 'photo_thumb_file_id',
  'department_id', 'team_id', 'location_id', 'manager_id', 'status', 'employee_type', 'executive',
  'department_name', 'team_name', 'location_name', 'location_bundesland', 'manager_name',
  'home_office_weekdays', 'created_at', 'updated_at',
]);

type Needed = Exclude<PermissionLevel, 'kein'>;

export function mayAccessExecutive(req: FastifyRequest, needed: Needed): boolean {
  const user = req.user as { role?: string; admin_role_id?: number | null } | undefined;
  if (!user || user.role !== 'admin') return false;
  return permits(permissionsFor(user.admin_role_id ?? null).leitung, needed);
}

export function isExecutive(employeeId: number): boolean {
  const row = getDb().prepare('SELECT executive FROM employees WHERE id = ?').get(employeeId) as
    | { executive: number }
    | undefined;
  return row?.executive === 1;
}

const DENIED =
  'Diese Person gehört zur Leitungsebene. Für ihre Stammdaten, Verträge, Dokumente und Vergütung fehlt Ihrer Rolle das Recht „Leitungsebene“.';

/** 403, wenn die Person zur Leitungsebene gehört und das Konto das Recht nicht hat. */
export function assertExecutiveAccess(req: FastifyRequest, employeeId: number | null | undefined, needed: Needed): void {
  if (employeeId == null) return;
  if (isExecutive(employeeId) && !mayAccessExecutive(req, needed)) throw forbidden(DENIED);
}

/**
 * SQL-Bedingung für Listen über Personen: Leitungspersonen nur mit
 * `leitung: lesen`. Immer mit Platzhalter; \`nullable\` für LEFT JOINs auf
 * employees (Dokumente ohne Person bleiben sichtbar).
 */
export function executiveFilterSql(
  req: FastifyRequest,
  alias = 'e',
  nullable = false,
): { sql: string; params: number[] } {
  const allowed = mayAccessExecutive(req, 'lesen') ? 1 : 0;
  const base = `(${alias}.executive = 0 OR ? = 1)`;
  return { sql: nullable ? `(${alias}.id IS NULL OR ${base})` : base, params: [allowed] };
}

/**
 * Personalzeile auf die Verzeichnisdaten kürzen, wenn sie zur Leitungsebene
 * gehört und das Konto das Recht nicht hat: Schlüssel bleiben, Werte werden
 * null, dazu \`restricted: true\` (die Personalakte zeigt dann einen Hinweis
 * statt eines Fehlers).
 */
export function projectDirectory<T extends Record<string, unknown>>(req: FastifyRequest, row: T): T {
  if (row.executive !== 1 || mayAccessExecutive(req, 'lesen')) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = DIRECTORY_COLUMNS.has(key) ? value : null;
  out.restricted = true;
  return out as T;
}
