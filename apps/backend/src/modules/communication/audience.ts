import { z } from 'zod';
import { getDb } from '../../db/db.js';
import { badRequest } from '../../core/errors.js';

/**
 * Einheitliches Zielgruppen-Muster (Kontrakt): audience_type
 * 'alle'|'abteilung'|'team'|'standort' + audience_id (NULL bei 'alle').
 * Wird von Ankündigungen, Umfragen und Kanälen identisch verwendet.
 */
export const AUDIENCE_TYPES = ['alle', 'abteilung', 'team', 'standort'] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export const audienceShape = {
  audience_type: z.enum(AUDIENCE_TYPES),
  audience_id: z.number().int().positive().nullable(),
};

/** Konsistenzprüfung audience_type <-> audience_id (nach dem Zod-Parse). */
export function checkAudience(v: { audience_type: AudienceType; audience_id: number | null }): void {
  if (v.audience_type === 'alle' && v.audience_id !== null) {
    throw badRequest('Bei Zielgruppe „Alle Mitarbeitenden“ darf keine audience_id gesetzt sein');
  }
  if (v.audience_type !== 'alle' && v.audience_id === null) {
    throw badRequest('Für diese Zielgruppe ist eine audience_id erforderlich');
  }
}

/** Anzahl der aktiven Mitarbeitenden in der Zielgruppe. */
export function countAudience(audienceType: AudienceType, audienceId: number | null): number {
  const db = getDb();
  const base = "SELECT COUNT(*) AS c FROM employees WHERE status = 'aktiv'";
  let row: { c: number };
  switch (audienceType) {
    case 'abteilung':
      row = db.prepare(`${base} AND department_id = ?`).get(audienceId) as { c: number };
      break;
    case 'team':
      row = db.prepare(`${base} AND team_id = ?`).get(audienceId) as { c: number };
      break;
    case 'standort':
      row = db.prepare(`${base} AND location_id = ?`).get(audienceId) as { c: number };
      break;
    default:
      row = db.prepare(base).get() as { c: number };
  }
  return row.c;
}

/** Anzeigename der Zielgruppe (NULL bei 'alle'). */
export function audienceName(audienceType: AudienceType, audienceId: number | null): string | null {
  if (audienceType === 'alle' || audienceId === null) return null;
  const table =
    audienceType === 'abteilung' ? 'departments' : audienceType === 'team' ? 'teams' : 'locations';
  const row = getDb().prepare(`SELECT name FROM ${table} WHERE id = ?`).get(audienceId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}
