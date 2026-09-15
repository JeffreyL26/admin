import { LICENSE_ERROR_CODES, PORTAL_READ_ONLY_TEXT } from '@ohrganize/shared';
import { ApiRequestError } from '../api/client';

/**
 * Nur-Lese-Betrieb aus Sicht des Portals.
 *
 * Das Portal kennt vom Lizenzmodell (packages/shared/src/license.ts) bewusst
 * nur EIN Bit: `read_only`. Testphase, Warnfrist und Kulanz gehen die
 * Mitarbeitenden nichts an — der Zahlungsstand des Arbeitgebers ist nicht ihr
 * Thema; das Backend liefert Portal-Konten ohnehin nur `{ read_only }`.
 *
 * Der Hinweis hier ist absichtlich neutral formuliert und nennt weder Lizenz
 * noch Ablauf: Was Mitarbeitende tun können, ist sich an die
 * Personalabteilung zu wenden. Er ersetzt auch die Servermeldung zu
 * LICENSE_EXPIRED, die auf „Einstellungen → Lizenz“ verweist — einen Ort,
 * den es im Portal nicht gibt.
 */
export const PORTAL_READ_ONLY_NOTICE = PORTAL_READ_ONLY_TEXT;

/**
 * DOM-Id des globalen Hinweises in der Shell. Gesperrte Schaltflächen, neben
 * denen kein Platz für den Satz ist (Tabellenzeilen), verweisen per
 * aria-describedby darauf.
 */
export const READ_ONLY_NOTICE_ID = 'portal-read-only-notice';

/**
 * Meldung eines fehlgeschlagenen Schreibzugriffs für die Anzeige. Alle
 * API-Fehler sind deutsch und werden direkt gezeigt — außer LICENSE_EXPIRED,
 * dessen Text an die HR-Administration gerichtet ist. LICENSE_FEATURE_MISSING
 * ("Die Funktion ... ist in Ihrer Lizenz nicht enthalten.") geht unveraendert
 * durch: Der Satz nennt keine Vertragsdaten.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiRequestError)) return fallback;
  if (err.code === LICENSE_ERROR_CODES.EXPIRED) return PORTAL_READ_ONLY_NOTICE;
  return err.message;
}
