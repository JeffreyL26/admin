import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import type { Request as CertificateVerifyRequest } from 'electron';
import { StartupError } from './startupError';

// ---------------------------------------------------------------------------
// Schlüssel-Pinning für den Server-Betrieb
// ---------------------------------------------------------------------------
// WARUM: Der Hersteller verwaltet die DNS-Zone <kunde>.ohrganize.com. Wer die
// Zone kontrolliert, kann den Namen umlenken und sich ein gültiges Zertifikat
// dafür ausstellen lassen — die normale Zertifikatsprüfung würde das nicht
// bemerken. Die HR-Desktop-App merkt sich deshalb zusätzlich den ÖFFENTLICHEN
// SCHLÜSSEL des Kunden-Servers und akzeptiert nur ihn. Damit ist der
// Administrationspfad gegen DNS- und Zertifikatsspiele immun — auch gegen die
// des Herstellers selbst.
//
// Was gepinnt wird: SHA-256 über die DER-kodierte SubjectPublicKeyInfo des
// BLATT-Zertifikats, Base64 — dieselbe Form wie HPKP („sha256/…“). Der
// Schlüssel überlebt Zertifikatserneuerungen, solange der Server sein
// Schlüsselpaar behält (Caddy: `reuse_private_keys`, siehe deploy/Caddyfile;
// certbot/nginx: `--reuse-key`, siehe deploy/README.md).
//
// Zwei Quellen, Konfiguration schlägt Gedächtnis:
//   1. Konfigurierte Pins — config.json `serverKeyPins` bzw. die
//      Umgebungsvariable OHRGANIZE_SERVER_KEY_PINS (kommagetrennt). Eine
//      Liste, damit vor einem geplanten Schlüsselwechsel der neue Pin schon
//      neben dem alten stehen kann.
//   2. Trust on first use — ohne Konfiguration merkt sich die App beim ersten
//      erfolgreichen Kontakt den Schlüssel in <userData>/server-pins.json
//      und warnt bei jedem späteren Wechsel.
//
// Das Pinning ergänzt die Kettenprüfung, es ersetzt sie nie: Auf beiden
// Pfaden (Node für die Start-Prüfung, Chromium für den Renderer) läuft zuerst
// die normale Validierung, der Pin-Vergleich kommt danach. Ein gültiges
// Zertifikat mit fremdem Schlüssel ist genau der Fall, den es zu erkennen gilt.
//
// Geltungsbereich: nur Server-Betrieb über https://. Das eingebettete Backend
// (http://127.0.0.1) und lokale Testadressen tragen kein TLS und werden nie
// gepinnt.

/**
 * Form eines Pins: sha256/<Base64 des 32-Byte-Hashes>. 32 Byte ergeben 43
 * Base64-Zeichen plus ein Füllzeichen — deshalb genau 44.
 */
export const PIN_PATTERN = /^sha256\/[A-Za-z0-9+/=]{44}$/;

/** Ablage der beim ersten Kontakt gemerkten Schlüssel, neben config.json. */
export const PIN_STORE_FILE = 'server-pins.json';

export type PinSource = 'configured' | 'learned';

/**
 * Welche der beiden Konfigurationsquellen wirksam ist. Die Umgebungsvariable
 * schlägt die Datei — wer nach einem Schlüsselwechsel den neuen Pin in
 * config.json einträgt, während die Variable gesetzt ist, ändert nichts; die
 * Meldung zur Abweichung muss deshalb die wirksame Quelle nennen.
 */
export type ConfiguredPinSource = 'env' | 'file';

export interface ConfiguredPins {
  pins: string[];
  from: ConfiguredPinSource;
}

export interface PinPolicy {
  /** Herkunft der API (Schema + Host + Port); Schlüssel im Speicher. */
  origin: string;
  /** Hostname für den Vergleich mit Chromiums Anfrage (klein, ohne IPv6-Klammern). */
  host: string;
  /** Erlaubte Pins. Leer nur beim allerersten Kontakt ohne Konfiguration. */
  pins: string[];
  /** Woher die Pins stammen; null = erster Kontakt, noch nichts bekannt. */
  source: PinSource | null;
  /** Bei source 'configured': ob die Umgebungsvariable oder config.json wirksam ist; sonst null. */
  configSource: ConfiguredPinSource | null;
  storePath: string;
  configPath: string;
}

/** Auskunft für den Renderer (Einstellungsseite), siehe preload `app.serverPin()`. */
export interface ServerPinInfo {
  /** API-Herkunft; null im Einzelplatz- und Dev-Betrieb (kein Pinning). */
  origin: string | null;
  /** Beim Start beobachteter Serverschlüssel (sha256/…). */
  pin: string | null;
  source: PinSource | null;
  /** Aus config.json bzw. Umgebung; leer bei Trust on first use. */
  configuredPins: string[];
  /** Datei der gemerkten Schlüssel — der Ort, den die IT bei einem geplanten Wechsel leert. */
  storePath: string | null;
}

/**
 * Pin eines Zertifikats (PEM-Text oder DER-Bytes).
 *
 * Bewusst über X509Certificate und nicht über `PeerCertificate.pubkey`: Das
 * Feld enthält NICHT die SubjectPublicKeyInfo, sondern je nach Schlüsseltyp
 * den nackten Schlüssel (bei EC den rohen Punkt) — der Hash darüber passt zu
 * keiner openssl-Pipeline und zu keinem Pin aus der Konfiguration.
 */
export function computeSpkiPin(certificate: string | Buffer): string {
  const spki = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  return `sha256/${createHash('sha256').update(spki).digest('base64')}`;
}

function validatePins(entries: unknown[], where: string): string[] {
  return entries.map((entry) => {
    const value = typeof entry === 'string' ? entry.trim() : entry;
    if (typeof value !== 'string' || !PIN_PATTERN.test(value)) {
      throw new StartupError(
        `Ein Eintrag in "serverKeyPins" (${where}) ist ungültig: ${JSON.stringify(entry)}.\n\n` +
          `Erwartet wird die Prüfsumme des öffentlichen Serverschlüssels in der Form\n` +
          `sha256/<44 Zeichen Base64>, z. B. sha256/kIuR7Ya7pc91O5luZwyUQaq5mO9v7HMj4o39WO91qe8=\n\n` +
          `Den Wert liefert die IT, die den oHRganize-Server betreibt.`,
      );
    }
    return value;
  });
}

/**
 * Konfigurierte Pins: Umgebungsvariable schlägt config.json. null heißt
 * „nichts konfiguriert“ — dann greift Trust on first use. `from` hält fest,
 * welche Quelle gewonnen hat (siehe ConfiguredPinSource).
 */
export function readConfiguredPins(configValue: unknown, configPath: string): ConfiguredPins | null {
  const fromEnv = process.env.OHRGANIZE_SERVER_KEY_PINS?.trim();
  if (fromEnv) {
    const entries = fromEnv
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      return { pins: validatePins(entries, 'Umgebungsvariable OHRGANIZE_SERVER_KEY_PINS'), from: 'env' };
    }
  }

  if (configValue == null) return null;
  if (!Array.isArray(configValue)) {
    throw new StartupError(
      `"serverKeyPins" in ${configPath} muss eine Liste sein, z. B.\n` +
        `"serverKeyPins": ["sha256/kIuR7Ya7pc91O5luZwyUQaq5mO9v7HMj4o39WO91qe8="]`,
    );
  }
  if (configValue.length === 0) return null;
  return { pins: validatePins(configValue, configPath), from: 'file' };
}

type PinStore = Record<string, string>;

function corruptStoreError(storePath: string): StartupError {
  return new StartupError(
    `Die Datei mit den gemerkten Serverschlüsseln ist beschädigt:\n${storePath}\n\n` +
      `Bitte mit der IT klären und die Datei entfernen — beim nächsten Start merkt sich ` +
      `die App den Serverschlüssel neu.`,
  );
}

/**
 * Gemerkte Schlüssel lesen. Eine beschädigte Datei bricht den Start ab statt
 * still als leer zu gelten: Wer die Datei manipulieren kann, könnte sie zwar
 * ebenso löschen — aber ein stiller Neuanfang würde den Vorfall verbergen,
 * ein Abbruch mit Dateipfad macht ihn sichtbar.
 */
export function readPinStore(storePath: string): PinStore {
  if (!fs.existsSync(storePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    throw corruptStoreError(storePath);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corruptStoreError(storePath);
  }
  const store: PinStore = {};
  for (const [origin, pin] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw corruptStoreError(storePath);
    store[origin] = pin;
  }
  return store;
}

/**
 * Schlüssel für eine Herkunft merken (Trust on first use). Modus 0600: Nur
 * der Anwender selbst soll die Datei ändern können; unter Windows greift das
 * Bit nicht, dort schützt das Benutzerprofil (%APPDATA%) die Datei.
 */
export function rememberPin(storePath: string, origin: string, pin: string): void {
  const store = readPinStore(storePath);
  store[origin] = pin;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** Hostname wie Chromium ihn meldet: klein, IPv6 ohne eckige Klammern. */
function canonicalHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Entscheidet für eine https-Basis-URL, welche Pins gelten. Konfigurierte
 * Pins haben Vorrang vor gemerkten; ein gemerkter Schlüssel wird dabei nicht
 * gelöscht, nur nicht befragt.
 */
export function resolvePinPolicy(
  apiBase: string,
  configured: ConfiguredPins | null,
  storePath: string,
  configPath: string,
): PinPolicy {
  const url = new URL(apiBase);
  const base = {
    origin: url.origin,
    host: canonicalHost(url.hostname),
    storePath,
    configPath,
    configSource: null as ConfiguredPinSource | null,
  };
  if (configured && configured.pins.length > 0) {
    return { ...base, pins: configured.pins, source: 'configured', configSource: configured.from };
  }
  const remembered = readPinStore(storePath)[url.origin];
  if (remembered) return { ...base, pins: [remembered], source: 'learned' };
  return { ...base, pins: [], source: null };
}

/**
 * Der Server hat sich mit einem anderen Schlüssel ausgewiesen als erwartet.
 * Trägt `.code`, damit describeConnectionFailure in main.ts den Fehler wie
 * jeden anderen Verbindungsfehler lesen kann; main.ts fängt ihn aber vorher
 * ab und zeigt die ausführliche Meldung aus pinMismatchMessage.
 */
export class PinMismatchError extends Error {
  readonly code = 'OHRGANIZE_PIN_MISMATCH';

  constructor(
    readonly policy: PinPolicy,
    readonly observed: string,
  ) {
    super(`Serverschlüssel ${observed} passt nicht zu ${policy.pins.join(', ')}`);
    this.name = 'PinMismatchError';
  }
}

export function pinMismatchMessage(policy: PinPolicy, observed: string): string {
  const assessment =
    `Das kann ein bewusster Zertifikatswechsel der IT sein — oder ein fremder Server. ` +
    `Bitte vor der Anmeldung mit der IT klären.`;
  if (policy.source === 'learned') {
    return (
      `Der Server ${policy.origin} weist sich mit einem anderen Schlüssel aus als beim ersten Kontakt ` +
      `(gespeichert: ${policy.pins[0]}, jetzt: ${observed}).\n\n` +
      `${assessment}\n\n` +
      `Wenn der Wechsel beabsichtigt war, kann die gespeicherte Prüfsumme in\n${policy.storePath}\nentfernt werden.`
    );
  }
  // Nur die WIRKSAME Quelle nennen: Wer den neuen Pin in die Datei schreibt,
  // während die Variable gesetzt ist, bekäme sonst dieselbe Meldung erneut,
  // ohne zu erfahren, warum.
  const where =
    policy.configSource === 'env'
      ? `in der Umgebungsvariable OHRGANIZE_SERVER_KEY_PINS eingetragen werden. ` +
        `Sie ist auf diesem Rechner gesetzt und schlägt "serverKeyPins" in\n${policy.configPath}\n` +
        `— ein Eintrag dort bleibt wirkungslos, solange die Variable gesetzt ist.`
      : `unter "serverKeyPins" in\n${policy.configPath}\neingetragen werden.`;
  return (
    `Der Server ${policy.origin} weist sich mit einem anderen Schlüssel aus als in der Konfiguration hinterlegt ` +
    `(erwartet: ${policy.pins.join(', ')}, jetzt: ${observed}).\n\n` +
    `${assessment}\n\n` +
    `Wenn der Wechsel beabsichtigt war, muss der neue Schlüssel ${where}`
  );
}

/** Sucht in einer Fehlerkette (err → cause …) nach dem Pin-Fehler. */
export function findPinMismatch(err: unknown): PinMismatchError | null {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current instanceof PinMismatchError) return current;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Agent für die Start-Prüfung in Node (assertReachable in main.ts).
 *
 * Reihenfolge in checkServerIdentity: Node ruft die Funktion überhaupt erst
 * auf, wenn die Zertifikatskette gültig ist. Dann zuerst der normale
 * Namensabgleich (tls.checkServerIdentity) — die Standardprüfung wird
 * ersetzt, nicht übersprungen —, dann der Pin.
 *
 * rejectUnauthorized steht EXPLIZIT auf true, nicht auf Node-Standard: Der
 * Standard folgt der Umgebungsvariable NODE_TLS_REJECT_UNAUTHORIZED, die
 * IT-Abteilungen hinter abfangenden Proxys gern maschinenweit auf 0 setzen.
 * Mit 0 würde Node eine ungültige Kette durchlassen (checkServerIdentity
 * liefe dann gar nicht, der Pin bliebe unbeobachtet) und einen Fehler aus
 * checkServerIdentity — unsere Pin-Abweichung — nicht mehr zum Abbruch der
 * Verbindung machen: Die Start-Prüfung liefe leer, der Renderer sähe später
 * nur „Failed to fetch“ statt der Meldung zum Schlüsselwechsel.
 *
 * maxCachedSessions 0: Bei einer wiederaufgenommenen TLS-Sitzung ruft Node
 * checkServerIdentity NICHT auf. Ein Agent ohne Sitzungsspeicher stellt
 * sicher, dass jede Verbindung geprüft wird.
 */
export function createPinningAgent(policy: PinPolicy, onObserved: (pin: string) => void): https.Agent {
  return new https.Agent({
    keepAlive: false,
    maxCachedSessions: 0,
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) => {
      const nameError = tls.checkServerIdentity(host, cert);
      if (nameError) return nameError;

      let observed: string;
      try {
        observed = computeSpkiPin(cert.raw);
      } catch (err) {
        return Object.assign(
          new Error(`Serverzertifikat nicht lesbar: ${err instanceof Error ? err.message : String(err)}`),
          { code: 'OHRGANIZE_CERT_UNREADABLE' },
        );
      }
      onObserved(observed);
      if (policy.pins.length > 0 && !policy.pins.includes(observed)) {
        return new PinMismatchError(policy, observed);
      }
      return undefined;
    },
  });
}

/**
 * Zertifikatsprüfung für Chromium (session.setCertificateVerifyProc) — der
 * Pfad, über den der Renderer mit dem Server spricht.
 *
 * Rückgabewerte an Chromium: -3 „nimm dein eigenes Ergebnis“, -2 „abgelehnt“.
 * Für fremde Hosts und für alles, was Chromium selbst schon ablehnt, bleibt
 * es bei -3: Die Kettenprüfung und ihre konkreten Fehlercodes bleiben
 * unangetastet. Auch ein passender Pin antwortet mit -3 statt 0 — 0 würde
 * Chromiums Certificate-Transparency-Prüfung abschalten, und es gibt keinen
 * Grund, an einem gültigen Ergebnis etwas zu ändern. Nur ein fremder
 * Schlüssel hinter gültiger Kette bekommt -2.
 *
 * Chromium speichert die Entscheidung je Zertifikat; da sie deterministisch
 * ist, stört das nicht. Die Richtlinie wird über einen Getter gelesen, weil
 * sie beim ersten Kontakt erst nach der Start-Prüfung feststeht.
 */
export function createCertificateVerifyProc(
  getPolicy: () => PinPolicy | null,
): (request: CertificateVerifyRequest, callback: (result: number) => void) => void {
  return (request, callback) => {
    const policy = getPolicy();
    if (!policy || canonicalHost(request.hostname) !== policy.host) {
      callback(-3);
      return;
    }
    // Chromium hat die Kette bereits abgelehnt: dabei bleibt es, samt Code.
    if (request.errorCode !== 0) {
      callback(-3);
      return;
    }
    // Kein Pin bekannt, obwohl der API-Host angefragt wird — darf nach der
    // Start-Prüfung nicht vorkommen. Fail closed.
    if (policy.pins.length === 0) {
      callback(-2);
      return;
    }
    let observed: string;
    try {
      observed = computeSpkiPin(request.certificate.data);
    } catch {
      callback(-2);
      return;
    }
    if (policy.pins.includes(observed)) {
      callback(-3);
      return;
    }
    console.error(
      `[oHRganize] Serverschlüssel von ${policy.origin} passt nicht (${observed} statt ${policy.pins.join(', ')}) — Verbindung abgelehnt.`,
    );
    callback(-2);
  };
}
