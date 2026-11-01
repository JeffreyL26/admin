import type { FastifyRequest } from 'fastify';
import { DISABILITY_FIELDS, permits, type PermissionLevel } from '@ohrganize/shared';
import { forbidden } from '../../core/errors.js';
import { permissionsFor } from '../../core/permissions.js';

/**
 * Schwerbehinderung in der Personalakte (shared/disability.ts): Gesundheitsdaten
 * nach Art. 9 DSGVO, deshalb ein eigener Rechtebereich `schwerbehinderung`
 * neben `personal`. Kein Eintrag in ROUTE_AREAS (die Felder liegen auf
 * /api/employees); die Personal-Routen filtern und sperren je Feld:
 * Lesen ohne `schwerbehinderung: lesen` liefert die Felder nicht, Schreiben
 * eines Wertes ohne `bearbeiten` ist 403. Portal-Konten erreichen die Routen
 * nicht, `GET /api/me/profile` nennt die Felder nicht.
 */
export function mayDisability(req: FastifyRequest, needed: Exclude<PermissionLevel, 'kein'>): boolean {
  const user = req.user as { role?: string; admin_role_id?: number | null } | undefined;
  if (!user || user.role !== 'admin') return false;
  return permits(permissionsFor(user.admin_role_id ?? null).schwerbehinderung, needed);
}

/** Personalzeile ohne die Felder der Schwerbehinderung, wenn das Leserecht fehlt. */
export function stripDisability<T extends Record<string, unknown>>(req: FastifyRequest, row: T): T {
  if (mayDisability(req, 'lesen')) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const field of DISABILITY_FIELDS) delete copy[field];
  return copy as T;
}

/** Ändert das Patch einen Wert der Schwerbehinderung (gegen den Bestand bzw. leer beim Anlegen)? */
function touchesDisability(patch: Record<string, unknown>, existing?: Record<string, unknown>): boolean {
  return DISABILITY_FIELDS.some((field) => {
    const value = patch[field];
    if (value === undefined) return false;
    const before = existing ? (existing[field] ?? null) : null;
    const normalized = field === 'disability_equal' ? (value ? 1 : 0) : (value ?? null);
    const base = field === 'disability_equal' ? (before ? 1 : 0) : before;
    return normalized !== base;
  });
}

/**
 * Schreiben der Felder verlangt `schwerbehinderung: bearbeiten`. Leere Werte
 * beim Anlegen und unveränderte beim Ändern gehen durch, damit Formulare ohne
 * das Recht weiter speichern.
 */
export function assertDisabilityWrite(
  req: FastifyRequest,
  patch: Record<string, unknown>,
  existing?: Record<string, unknown>,
): void {
  if (!touchesDisability(patch, existing)) return;
  if (!mayDisability(req, 'bearbeiten')) {
    throw forbidden('Angaben zur Schwerbehinderung ändert nur, wer das Recht „Schwerbehinderung: Bearbeiten“ hat.');
  }
}
