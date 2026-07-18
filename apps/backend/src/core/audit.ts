import type { FastifyRequest } from 'fastify';
import { getDb } from '../db/db.js';

/** Schreibt einen Audit-Eintrag. `details` wird als JSON persistiert. */
export function audit(
  req: FastifyRequest,
  action: string,
  entity: string,
  entityId?: number,
  details?: unknown,
): void {
  const userId = (req.user as { id?: number } | undefined)?.id ?? null;
  getDb()
    .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId, action, entity, entityId ?? null, details ? JSON.stringify(details) : null);
}

export function auditTrail(entity: string, entityId: number) {
  return getDb()
    .prepare(
      `SELECT a.*, u.name AS user_name FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.created_at DESC, a.id DESC`,
    )
    .all(entity, entityId);
}
