import { getDb } from '../db/db.js';

/** Was ein Portal-Konto über seine Fachrollen sehen darf; reist mit Login und /api/auth/me. */
export interface PortalAccess {
  /** Firmenweiter Abwesenheitskalender (GET /api/me/calendar). */
  calendar: boolean;
}

/**
 * Kalender sichtbar, solange mindestens eine zugewiesene Fachrolle es erlaubt
 * (roles.can_view_calendar) oder die Person gar keine Rolle trägt — wie bei
 * der Antragsberechtigung zählen zugewiesene Rollen unabhängig von `active`.
 */
export function canViewPortalCalendar(employeeId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS assigned, COALESCE(SUM(r.can_view_calendar), 0) AS allowing
       FROM employee_roles er
       JOIN roles r ON r.id = er.role_id
       WHERE er.employee_id = ?`,
    )
    .get(employeeId) as { assigned: number; allowing: number };
  return row.assigned === 0 || row.allowing > 0;
}

export function portalAccessFor(employeeId: number | null): PortalAccess | undefined {
  if (employeeId === null) return undefined;
  return { calendar: canViewPortalCalendar(employeeId) };
}
