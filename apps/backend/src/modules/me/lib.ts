/**
 * Gemeinsame Bausteine der Self-Service-Routen (/api/me/*).
 *
 * Liegen hier, weil das Self-Service-Modul auf mehrere Routendateien verteilt
 * ist (routes.ts, salaryRoutes.ts, orgRoutes.ts, calendarRoutes.ts,
 * documentRoutes.ts) und jede davon dieselbe Profilprüfung braucht — es darf
 * genau EINE Definition geben, damit die Zugriffsgrenze nicht auseinanderläuft.
 */
import type { FastifyRequest } from 'fastify';
import { getDb } from '../../db/db.js';
import { badRequest, forbidden } from '../../core/errors.js';
import type { EmployeeRow } from '../absences/service.js';

// Das Personalprofil ist in allen Self-Service-Routen dieselbe Zeile; der Typ
// wird hier durchgereicht, damit die Routendateien nur aus me/lib.ts importieren.
export type { EmployeeRow };

/**
 * Obergrenze der Zeitspanne je Antrag/Vorschau. Schutz vor absurden Spannen
 * (z. B. bis 9999-12-31), deren tageweise Zählung das synchrone Backend
 * blockieren würde — legitime lange Abwesenheiten (Elternzeit, Sabbatical)
 * bleiben mit zwei Jahren möglich, alles darüber erfasst die HR.
 */
export const MAX_SPAN_DAYS = 731;

export function assertReasonableSpan(dateFrom: string, dateTo: string): void {
  const span =
    Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
  if (span > MAX_SPAN_DAYS) {
    throw badRequest(
      'Der Zeitraum ist zu lang (maximal zwei Jahre). Bitte wenden Sie sich für längere Abwesenheiten an die Personalabteilung.',
    );
  }
}

/** Lädt das eigene Personalprofil oder lehnt den Zugriff ab. */
export function requireEmployee(req: FastifyRequest): EmployeeRow {
  const employeeId = req.user.employee_id ?? null;
  if (employeeId === null) {
    throw forbidden(
      'Für diesen Account ist kein Personalprofil hinterlegt. Bitte wenden Sie sich an die Personalabteilung.',
    );
  }
  const emp = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as
    | EmployeeRow
    | undefined;
  if (!emp) {
    throw forbidden(
      'Das verknüpfte Personalprofil existiert nicht mehr. Bitte wenden Sie sich an die Personalabteilung.',
    );
  }
  if (emp.status !== 'aktiv') {
    throw forbidden('Ihr Personalprofil ist nicht mehr aktiv.');
  }
  return emp;
}
