import type { FastifyRequest } from 'fastify';
import { getDb } from '../db/db.js';

function insertAuditRow(req: FastifyRequest, action: string, entity: string, entityId?: number, details?: unknown): void {
  const userId = (req.user as { id?: number } | undefined)?.id ?? null;
  getDb()
    .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId, action, entity, entityId ?? null, details ? JSON.stringify(details) : null);
}

/**
 * Werfen nur im Quelltextbetrieb (Entwicklung und alle Tests unter tsx). Im
 * gebündelten Betrieb (Server, Desktop-App) setzt scripts/build.mjs die
 * Variable per define auf "1": Dort ist die Änderung beim Aufruf von audit()
 * außerhalb einer Transaktion schon geschrieben, ein Fehler hinterliesse sie
 * ohne Eintrag und meldete obendrein 500.
 */
let throwOutsideTransaction = process.env.OHRGANIZE_BUNDLED !== '1';

/**
 * Nur für Tests (src/test/smoke.ts): schaltet auf das Verhalten im
 * gebündelten Betrieb (schreiben und melden statt werfen) und zurück, damit
 * auch dieser Weg geprüft ist.
 */
export function setAuditThrowsOutsideTransaction(value: boolean): void {
  throwOutsideTransaction = value;
}

/**
 * Schreibt den Audit-Eintrag zu einer fachlichen Änderung. `details` wird als
 * JSON persistiert. Nur INNERHALB der Transaktion der Änderung aufrufen
 * (`inTransaction(() => { ...; audit(...) })`): Änderung und Eintrag gehen in
 * einem Commit auf die Platte, und keiner bleibt ohne den anderen stehen.
 * Außerhalb wirft die Funktion in Entwicklung und Tests;
 * src/test/auditTransactionCheck.ts prüft dasselbe statisch für jede Stelle.
 * Im Betrieb schreibt sie den Eintrag trotzdem (eigener Commit) und meldet
 * den Fehler im Log: Ein vollständiges Protokoll wiegt dort mehr als die
 * Regel.
 */
export function audit(
  req: FastifyRequest,
  action: string,
  entity: string,
  entityId?: number,
  details?: unknown,
): void {
  if (!getDb().inTransaction) {
    const message = `audit('${action}') ausserhalb einer Transaktion; Änderung und Eintrag gehören in denselben Commit`;
    if (throwOutsideTransaction) throw new Error(message);
    req.log.error({ action, entity, entityId }, message);
  }
  insertAuditRow(req, action, entity, entityId, details);
}

/**
 * Audit-Eintrag OHNE fachliche Änderung, deren Commit er teilen könnte:
 * Anmeldung, Fehlversuche, ausgestellte Download-Links, eingespielte
 * Lizenzdatei (die liegt im Dateisystem). Schreibt in einem eigenen Commit.
 */
export function auditStandalone(
  req: FastifyRequest,
  action: string,
  entity: string,
  entityId?: number,
  details?: unknown,
): void {
  insertAuditRow(req, action, entity, entityId, details);
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
