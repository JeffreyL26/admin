/**
 * Kundenausgabe Dronivo (Branch `dronivo`, Version 1.0.0-dronivo).
 *
 * Diese Datei gibt es nur auf dem Kundenbranch. Sie haelt die Schalter, in
 * denen sich die Ausgabe vom Hauptprodukt unterscheidet. Jede abweichende
 * Stelle fragt hier nach, statt Code zu entfernen: So bleibt der Abstand zu
 * main klein, ein Merge von main trifft selten eine geaenderte Zeile, und die
 * Stellen lassen sich mit einer Suche nach dem Namen vollstaendig finden.
 */

/**
 * Ausgabe dieses Branches. Sie trennt Dronivo technisch vom Hauptprodukt:
 * Update-Skripte (VARIANTE.txt gegen env-Datei und /api/health), Backend
 * (OHRGANIZE_VARIANT gegen den Build), Desktop-App (Variante des Servers) und
 * Lizenz (edition) weisen jede Mischung mit `de-vollversion` ab, auch die
 * Fassungen dieser Werkzeuge auf main. Das Register auf diesem Branch kennt
 * NUR diese Variante (scripts/check-dronivo.mjs).
 */
export const CUSTOMER_VARIANT = 'de-dronivo';

/**
 * Kundenkennung der Version (`1.0.0-dronivo`, angezeigt "de-1.0.0-dronivo").
 * Jede Version dieses Branches traegt sie; scripts/release.mjs und
 * scripts/release-server.mjs bauen nichts ohne sie, scripts/check-dronivo.mjs
 * prueft package.json und Mindestversionen.
 */
export const CUSTOMER_TAG = 'dronivo';

/**
 * Erfassen Mitarbeitende ihre Abwesenheiten im Portal selbst (Antrag,
 * Rueckzug eines offenen Antrags, Krankmeldung)? Bei Dronivo nicht:
 * Abwesenheiten erfasst ausschliesslich die HR-Administration in der
 * Desktop-App.
 *
 * `false` heisst:
 *   - Backend: `createRequest` (absences/service.ts, der eine Punkt jeder
 *     Neuanlage) weist jede Anfrage einer /api/me-Route ab
 *     (`assertNoPortalCapture`); die HR-Erfassung unter /api/absences bleibt
 *     offen. Dazu sperrt der globale Hook jede schreibende Anfrage unter
 *     /api/me, die nicht in PORTAL_OPEN_WRITES steht (portalWriteBlocked),
 *     auch den Rueckzug, der createRequest nicht durchlaeuft.
 *   - Portal: Die Seiten unter PORTAL_ABSENCE_PATHS fehlen in Navigation und
 *     Router; die Uebersicht zeigt statt des Urlaubskontos die Kachel fuer
 *     Stammdaten-Aenderungen und keine Karte "Offene Antraege".
 *   - Desktop: Der Einrichtungs-Assistent verspricht keinen Urlaubsantrag im
 *     Portal mehr, und das Dashboard schreibt an keinen offenen Antrag "Aus dem
 *     Portal beantragt." (siehe dashboardModel.ts).
 *
 * Unberuehrt bleiben Stammdaten-Aenderungsantraege, die HR-Erfassung samt
 * Genehmigung, der Kalender und das Lesen der eigenen Abwesenheiten
 * (GET /api/me/leave-requests, leave-balance, calendar).
 *
 * Bewusst `boolean` statt des Literaltyps `false`: Sonst meldete der
 * Typecheck die Vergleiche an den abfragenden Stellen als immer gleich.
 */
export const PORTAL_ABSENCE_CAPTURE: boolean = false;

/**
 * Portalseiten der Abwesenheitserfassung (Antraege, neuer Antrag, Krankmeldung).
 * Gesperrt ist jeweils der Pfad samt allem darunter (`/antraege/:id`).
 */
export const PORTAL_ABSENCE_PATHS: readonly string[] = ['/antraege', '/krankmeldung'];

/** Gibt es diese Portalseite in der Ausgabe? Fuer Navigation und Router des Portals. */
export function portalPathOpen(path: string): boolean {
  return PORTAL_ABSENCE_CAPTURE || !PORTAL_ABSENCE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Schreibende Portalrouten, die in dieser Ausgabe OFFEN bleiben, als
 * "<METHODE> <Route>" in der Schreibweise, in der Fastify sie registriert
 * (`req.routeOptions.url`). Jede andere schreibende Anfrage unter /api/me
 * weist der globale Hook in server.ts ab (`portalWriteBlocked`), solange die
 * Erfassung gesperrt ist: Die Liste sagt, was offen ist, nicht was gesperrt
 * ist. Eine neue schreibende Portalroute aus main bleibt damit gesperrt, bis
 * jemand sie geprueft und hier eingetragen hat, auch wenn sie Abwesenheiten
 * ueber eine Hilfsfunktion schreibt, die keine Suche findet.
 * scripts/check-dronivo.mjs und src/test/smoke.ts melden jede Route, die in
 * keiner der beiden Listen steht.
 */
export const PORTAL_OPEN_WRITES: readonly string[] = [
  'POST /api/me/change-requests',
  'POST /api/me/change-requests/:id/withdraw',
  'POST /api/me/announcements/:id/ack',
  'POST /api/me/announcements/:id/attachments/:fileId/sign',
  'POST /api/me/surveys/:id/responses',
  'POST /api/me/documents',
  'POST /api/me/documents/:id/download',
];

/**
 * Schreibende Portalrouten der Abwesenheitserfassung (Antrag, Rueckzug,
 * Krankmeldung). Gesperrt sind sie schon, weil sie nicht in
 * PORTAL_OPEN_WRITES stehen; die Liste haelt fest, dass das Absicht ist, und
 * verhindert, dass sie bei einem Merge in die offene Liste rutschen.
 */
export const PORTAL_ABSENCE_WRITES: readonly string[] = [
  'POST /api/me/leave-requests',
  'POST /api/me/leave-requests/:id/cancel',
  'POST /api/me/sick-notes',
];

/** Schreibende Anfrage (alles ausser GET/HEAD) an /api/me, die nicht in PORTAL_OPEN_WRITES steht, solange die Erfassung gesperrt ist. */
export function portalWriteBlocked(method: string, route: string): boolean {
  if (PORTAL_ABSENCE_CAPTURE) return false;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || !route.startsWith('/api/me/')) return false;
  return !PORTAL_OPEN_WRITES.includes(`${m} ${route}`);
}
