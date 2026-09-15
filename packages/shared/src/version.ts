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

/**
 * FALLE waehrend einer Beta: Seit die Ordnung Vorabkennungen kennt, ist
 * `1.1.0-beta.1` AELTER als `1.1.0`. Solange eine Beta derselben Nummer im
 * Umlauf sein soll, muss die Mindestversion also auf die Beta zeigen
 * (`1.1.0-beta.1`), sonst sperrt der Server genau die Arbeitsplaetze aus, die
 * die Beta testen. Bei einer Beta mit hoeherer Nummer als der Mindestversion
 * (Mindestens 1.0.0, Beta 1.1.0-beta.1) stellt sich die Frage nicht.
 */

// ---------------------------------------------------------------------------
// Kanal
// ---------------------------------------------------------------------------

/**
 * Auslieferungskanaele. Der Kanal ist KEINE eigene Angabe, sondern eine
 * Funktion der Version: `1.2.0` ist stable, `1.2.0-beta.1` ist beta. Damit
 * kann ein Release nicht im falschen Kanal landen, weil jemand ein Feld
 * vergessen hat.
 */
export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  stable: 'Stabil',
  beta: 'Beta',
};

/** Jede Version mit Vorabkennung gilt als beta, gleich wie die Kennung heisst. */
export function channelOf(version: string): Channel {
  return parseVersion(version)?.pre ? 'beta' : 'stable';
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Vergleich
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  /** Haupt-, Neben- und Fehlerkorrekturnummer. */
  core: [number, number, number];
  /** Vorabkennung ohne Bindestrich (`beta.1`), sonst null. */
  pre: string | null;
}

/** `1.2.3-beta.1` -> `{ core: [1, 2, 3], pre: 'beta.1' }`; null bei fremder Form. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/**
 * Semver-Ordnung der Vorabkennung: Zahlen numerisch, alles andere
 * alphabetisch, Zahlen vor Text; sind alle gemeinsamen Teile gleich, gewinnt
 * die laengere Kennung (`beta.1.1 > beta.1`).
 */
function comparePre(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const d = Number(l) - Number(r);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** Anzeigeform: `1.0.0-beta.1` → „BETA 1.0.0", `1.0.1` → „Version 1.0.1". Maschinenlesbar bleibt Semver. */
export function formatVersion(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-([a-zA-Z]+)[.\d-]*)?/.exec(version.trim());
  if (!match) return version;
  const [, core, tag] = match;
  return tag ? `${tag.toUpperCase()} ${core}` : `Version ${core}`;
}

/**
 * <0 wenn a aelter ist, 0 bei gleich, >0 wenn a neuer ist. Semver-Ordnung
 * einschliesslich Vorabkennung: `1.1.0-beta.1 < 1.1.0 < 1.1.1`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  // Eine Vorabversion ist aelter als die fertige Version derselben Nummer.
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return comparePre(left.pre, right.pre);
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
