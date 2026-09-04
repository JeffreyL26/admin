/**
 * Versionsabgleich zwischen Desktop-App und Backend.
 *
 * Im Einzelplatzbetrieb ist er überflüssig: Dort startet die App ihr Backend
 * selbst aus demselben Installer, beide Seiten können gar nicht auseinander
 * laufen. Im Serverbetrieb können sie es sehr wohl, und zwar in BEIDE
 * Richtungen — ein Arbeitsplatz, der ein Update übersprungen hat, ist zu alt;
 * eine App, die sich per Auto-Update selbst überholt hat, während das
 * Server-Update noch aussteht, ist zu neu. Ohne Abgleich scheitert das nicht
 * sauber, sondern schleichend: Ein Feld fehlt, eine Route antwortet anders,
 * und der Nutzer sieht eine halb funktionierende Maske statt einer Erklärung.
 *
 * Die Vergleichslogik steht bewusst hier und nicht je einmal im Backend und im
 * Client: Zwei Implementierungen desselben Vergleichs driften auseinander, und
 * ausgerechnet dieser entscheidet darüber, ob sich jemand anmelden kann.
 */

/** Header, mit dem die Desktop-App ihre Version mitschickt (Fastify liest
 *  Header ausschließlich kleingeschrieben — der Wert muss es deshalb sein). */
export const CLIENT_VERSION_HEADER = 'x-ohrganize-client-version';

/** Header, mit dem das Backend seine Version auf JEDER Antwort mitschickt. */
export const SERVER_VERSION_HEADER = 'x-ohrganize-server-version';

/**
 * Älteste App-Version, die das Backend bedient.
 *
 * NUR erhöhen, wenn eine API-Änderung ältere Apps tatsächlich bricht. Jede
 * Erhöhung sperrt alle Arbeitsplätze aus, die das Update noch nicht haben —
 * bis jemand vor Ort war. Additive Änderungen (neues Feld, neue Route) sind
 * kein Grund.
 */
export const MIN_CLIENT_VERSION = '1.0.0';

/**
 * Ältester Server, mit dem die App arbeitet. Gegenstück zu
 * MIN_CLIENT_VERSION für den Fall, dass die App dem Server vorausgeeilt ist.
 */
export const MIN_SERVER_VERSION = '1.0.0';

/** `1.2.3` → `[1, 2, 3]`. Vorabkennungen (`1.2.3-beta.1`) werden abgeschnitten. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** <0 wenn a älter ist, 0 bei gleich, >0 wenn a neuer ist. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Fail closed wie bei den Routen-Bereichen in core/permissions.ts: Eine
 * Version, die sich nicht lesen lässt, gilt als zu alt. Wer etwas
 * Unverständliches schickt, ist entweder defekt oder kein oHRganize — beides
 * ist kein Grund, ihn durchzulassen.
 */
export function isAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (!version || !parseVersion(version)) return false;
  return compareVersions(version, minimum) >= 0;
}
