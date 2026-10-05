import { z } from 'zod';
import { parse } from './errors.js';

/**
 * Blättern in langen Listen (alle Anträge, Dokumentablage).
 *
 * Ohne `limit` bleibt eine Route ungeblättert und liefert wie bisher alle
 * Treffer ihres Filters: Personalakte, Genehmigungsliste, Tests und Skripte
 * verlassen sich darauf. Mit `limit` liefert sie genau eine Seite und dazu
 * `total` (Treffer über alle Seiten) und `offset` (tatsächlicher Beginn der
 * Seite, siehe `focus_id`). Gelöscht oder ausgeblendet wird nichts, jede
 * Zeile bleibt über die Seiten erreichbar.
 *
 * Die Obergrenze hält eine Seite so klein, dass ein Request den synchronen
 * Prozess nicht spürbar anhält (die ungeblätterte Antragsliste brauchte bei
 * 221 000 Zeilen 2,2 s SQL und 109 MB Antwort). Ein größeres `limit` wird
 * still gedeckelt statt abgewiesen.
 */
export const PAGE_LIMIT_MAX = 500;

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  focus_id: z.coerce.number().int().positive().optional(),
});

export interface PageRequest {
  limit: number;
  offset: number;
  /**
   * Datensatz, dessen Seite geliefert werden soll (Absprung per Adresse, etwa
   * aus dem Kalender auf einen Antrag). Passt er nicht zu den Filtern, gilt
   * `offset` unverändert.
   */
  focusId: number | null;
}

/** Liest limit/offset/focus_id aus der Query; null heißt ungeblättert. */
export function pageRequest(query: unknown): PageRequest | null {
  const q = parse(pageQuerySchema, query ?? {});
  if (q.limit === undefined) return null;
  return {
    limit: Math.min(q.limit, PAGE_LIMIT_MAX),
    offset: q.offset ?? 0,
    focusId: q.focus_id ?? null,
  };
}

/** Beginn der Seite, auf der eine Zeile mit `before` Vorgängern in der Sortierung steht. */
export function pageOffsetOf(before: number, limit: number): number {
  return Math.floor(before / limit) * limit;
}
