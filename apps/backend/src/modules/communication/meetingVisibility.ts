/**
 * SQL-Bedingungen der Protokoll-Sichtbarkeit, abgeleitet aus der einzigen
 * Quelle `MEETING_VISIBILITY_READERS` (packages/shared/src/communication.ts).
 * Portal (me/communicationRoutes.ts) und Fuehrung (leadership/meetingRoutes.ts)
 * filtern nur hierueber; eine eigene Liste von Stufen waere eine Einladung zum
 * Auseinanderlaufen.
 */
import { meetingVisibilitiesFor } from '@ohrganize/shared';

/**
 * `<column> IN ('…', '…')` fuer die Stufen, die `reader` erreichen. Die Werte
 * stammen aus der Konstante, nicht aus einer Eingabe; deshalb ohne Bindung.
 */
export function meetingVisibilitySql(column: string, reader: 'leaders' | 'employee'): string {
  const levels = meetingVisibilitiesFor(reader);
  return levels.length === 0 ? '0' : `${column} IN (${levels.map((v) => `'${v}'`).join(', ')})`;
}
