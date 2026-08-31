import type { FastifyRequest } from 'fastify';
import { CLIENT_VERSION_HEADER, MIN_CLIENT_VERSION, isAtLeast } from '@hrmonic/shared';
import pkg from '../../package.json';
import { AppError } from './errors.js';

/**
 * Die laufende Version — eine einzige Quelle (package.json), damit sie beim
 * Release nicht an zwei Stellen gepflegt werden muss und auseinanderlaufen
 * kann. Beide Betriebsarten sind abgedeckt: esbuild bindet die JSON-Datei
 * beim Bündeln ein (server.cjs/cli.cjs), tsx löst sie im Dev-Betrieb auf.
 */
export const APP_VERSION: string = pkg.version;

/**
 * Weist Desktop-Apps ab, die älter sind als MIN_CLIENT_VERSION.
 *
 * Greift bewusst auch auf öffentlichen Routen, insbesondere beim Login: Dort
 * merkt es der Nutzer zuerst, und eine klare Meldung beim Anmelden ist
 * ungleich besser als eine kaputte Maske danach. Ausgenommen ist allein
 * /api/health — die Route muss erreichbar bleiben, sonst kann die App gar
 * nicht herausfinden, WARUM sie abgewiesen wird.
 *
 * Fehlt der Header vollständig, wird nicht geprüft. Das ist Absicht und kein
 * Loch: Das Mitarbeitenden-Portal wird vom selben Server ausgeliefert und ist
 * damit immer im Gleichschritt, und Monitoring oder curl sollen nicht an
 * einer Client-Version scheitern, die sie gar nicht haben. Geprüft wird, wer
 * sich als Client zu erkennen gibt.
 */
export function assertClientSupported(req: FastifyRequest): void {
  const raw = req.headers[CLIENT_VERSION_HEADER];
  const version = Array.isArray(raw) ? raw[0] : raw;
  if (version === undefined) return;
  if (isAtLeast(version, MIN_CLIENT_VERSION)) return;

  // 426 statt 403: Der Zugriff scheitert nicht an fehlenden Rechten, sondern
  // an der Version — der Client soll aktualisieren, nicht sich neu anmelden.
  throw new AppError(
    426,
    'CLIENT_TOO_OLD',
    `Diese HRMONIC-Version (${version || 'unbekannt'}) ist zu alt für den Server (${APP_VERSION}). ` +
      `Bitte aktualisieren Sie die App auf mindestens Version ${MIN_CLIENT_VERSION}.`,
  );
}
