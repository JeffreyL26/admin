import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { LICENSE_FILE_NAME } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { DATA_KEY_FILE } from './db/encryption.js';

// Variantenpruefung beim Start: OHRGANIZE_VARIANT (env-Datei des Betreibers)
// muss zur einkompilierten Variante passen. Ein falsch gesetzter Symlink im
// Hosting (Programmverzeichnis einer anderen Ausgabe) faellt so sofort auf,
// statt still mit fremdem Funktionsumfang zu laufen. Ohne die Variable
// (Desktop-Embedding, Dev-Betrieb) gilt die einkompilierte Variante.
const variantEnv = process.env.OHRGANIZE_VARIANT?.trim();
if (variantEnv && variantEnv !== VARIANT.id) {
  throw new Error(
    `OHRGANIZE_VARIANT ist auf "${variantEnv}" gesetzt, dieses Programm ist aber die Variante "${VARIANT.id}" ` +
      `(${VARIANT.label}). Bitte das Release der richtigen Variante einsetzen oder die env-Datei korrigieren.`,
  );
}

// Datenverzeichnis: im Dev-Betrieb ./data neben dem Backend, im Desktop-Betrieb
// wird OHRGANIZE_DATA_DIR von Electron auf app.getPath('userData') gesetzt.
const dataDir = process.env.OHRGANIZE_DATA_DIR
  ? path.resolve(process.env.OHRGANIZE_DATA_DIR)
  : path.resolve(import.meta.dirname ?? process.cwd(), '../../..', 'apps/backend/data');

// mode 0o700 statt des Node-Defaults 0o755: Im Datenverzeichnis liegen die
// komplette Personalakte (ohrganize.db), jeder hochgeladene Dateiinhalt und das
// Signatur-Secret. Auf einem gemeinsam genutzten Kundenserver hätte 0o755 jedem
// lokalen Konto (Webserver-User, Monitoring-Agent, Praktikant mit Shell)
// Lesezugriff auf Gehälter und AU-Bescheinigungen gegeben.
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const storageDir = path.join(dataDir, 'storage');
fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });

const dbPath = path.join(dataDir, 'ohrganize.db');
const secretPath = path.join(dataDir, 'secret.key');
/** Schlüssel der Verschlüsselung im Ruhezustand (db/encryption.ts): Datenbank und Dateiablage. */
const dataKeyPath = path.join(dataDir, DATA_KEY_FILE);
/** Ablage des generierten Initialpassworts (siehe core/auth.ts, ensureDefaultAdmin). */
const initialPasswordPath = path.join(dataDir, 'initial-admin-password.txt');
/** Signierte Lizenzdatei des Anbieters (Prüfung und Zustand: core/license.ts). */
const licensePath = path.join(dataDir, LICENSE_FILE_NAME);

/**
 * Die Lizenz wird nur geprüft, wenn ein Datenverzeichnis ausdrücklich gesetzt
 * ist — also auf jedem Server, in jeder installierten Desktop-App und in den
 * Smoke-Tests. Ohne die Variable läuft das Backend gegen apps/backend/data:
 * das Entwicklungsverzeichnis, dieselbe Grenze, an der auch seed.ts den
 * Produktivbetrieb erkennt. Dort wäre eine Lizenzpflicht nur Reibung.
 */
const licenseEnforced = Boolean(process.env.OHRGANIZE_DATA_DIR);

/**
 * Prüfschlüssel aus der Umgebung — ausschließlich für Tests, die mit einem
 * eigenen Schlüsselpaar signieren (src/test/smoke.ts). Im Betrieb bleibt die
 * Variable leer; dann gelten allein die eingebauten Schlüssel aus
 * core/licenseKeys.ts. Wer sie auf einem Kundensystem setzt, hat denselben
 * Zugriff, mit dem er auch den Quelltext ändern könnte — sie öffnet nichts,
 * was nicht ohnehin offen wäre, wird aber beim Start als Warnung protokolliert
 * (weiter unten, sobald die Warnliste existiert).
 */
const licensePublicKeyOverride = (process.env.OHRGANIZE_LICENSE_PUBLIC_KEY ?? '').trim() || null;

function chmodQuiet(target: string, mode: number): void {
  try {
    if (fs.existsSync(target)) fs.chmodSync(target, mode);
  } catch {
    // Bewusst kein harter Fehler: Auf Windows kennt chmod nur das
    // Read-only-Bit, auf Netz-/OneDrive-Laufwerken schlägt es ganz fehl. Die
    // Rechte sind dort Sache der NTFS-ACLs (siehe Deploy-Doku). Ein Server
    // darf daran nicht scheitern — die Absicherung ist eine Verbesserung,
    // keine Startbedingung.
  }
}

/**
 * Zieht die Rechte im Datenverzeichnis idempotent nach.
 *
 * Warum zusätzlich zum `mode` oben: `mode` wirkt ausschließlich beim
 * NEUanlegen. Jede Bestandsinstallation hat ihr Verzeichnis mit 0o755 und die
 * SQLite-Dateien mit 0o644 angelegt und bliebe sonst dauerhaft für jeden
 * lokalen Benutzer lesbar — ein Update würde die Lücke nicht schließen.
 * Deshalb einmal beim Start (Bestand) und noch einmal nach `migrate()`
 * (dann existieren db/-wal/-shm auch bei einer frischen Installation).
 */
export function hardenDataPermissions(): void {
  chmodQuiet(dataDir, 0o700);
  chmodQuiet(storageDir, 0o700);
  // Zwischendateien von createDataKey (db/encryption.ts), die ein Absturz
  // zwischen Einhängen und Löschen zurückliess: Sie tragen den Schlüssel im
  // Klartext und überlebten sonst auch einen späteren Umzug nach aussen. Nur
  // ältere als zehn Minuten: Diese Funktion läuft in JEDEM Prozess, der
  // config.ts lädt (auch in der Sicherung), und eine frische Datei kann die
  // gerade entstehende eines anderen Prozesses sein. Und nur, solange data.key
  // selbst steht: Fehlt es nach einem Stromausfall, kann die Zwischendatei die
  // einzige Kopie des Schlüssels sein (sie bleibt dann für den Betreiber liegen).
  try {
    const cutoff = Date.now() - 10 * 60_000;
    const names = fs.existsSync(dataKeyPath) ? fs.readdirSync(dataDir) : [];
    for (const name of names) {
      if (!name.startsWith(`${DATA_KEY_FILE}.`) || !name.endsWith('.neu')) continue;
      const leftover = path.join(dataDir, name);
      if (fs.statSync(leftover).mtimeMs < cutoff) fs.rmSync(leftover, { force: true });
    }
  } catch {
    // Nicht kritisch; der nächste Start versucht es erneut.
  }
  // -wal/-shm enthalten dieselben Nutzdaten wie die Datenbank selbst.
  for (const file of [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    secretPath,
    dataKeyPath,
    initialPasswordPath,
    licensePath,
  ]) {
    chmodQuiet(file, 0o600);
  }
}

// Das JWT-/Signatur-Secret wird pro Installation generiert und persistiert,
// damit Sitzungen und signierte Download-URLs Neustarts überleben.
function loadOrCreateSecret(): string {
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

/**
 * Meldungen, die beim Start über den Fastify-Logger ausgegeben werden.
 * config.ts läuft, bevor es einen Logger gibt — deshalb sammeln statt loggen.
 */
const startupWarnings: string[] = [];

if (licensePublicKeyOverride) {
  startupWarnings.push(
    'OHRGANIZE_LICENSE_PUBLIC_KEY ist gesetzt: Lizenzdateien werden gegen diesen Schlüssel ' +
      'statt gegen die eingebauten geprüft. Das ist eine Testeinstellung und gehört auf kein ' +
      'Produktivsystem.',
  );
}

// Standard 127.0.0.1 (Desktop-Embedding). Für den Server-Deploy hinter
// einem Reverse-Proxy OHRGANIZE_HOST setzen (z. B. 0.0.0.0 im Container).
const host = process.env.OHRGANIZE_HOST ?? '127.0.0.1';
/** Adressen, bei denen das Backend ausschließlich lokal erreichbar ist. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const boundToLoopbackOnly = LOOPBACK_HOSTS.has(host);

function readCorsOrigins(): string[] {
  const raw = (process.env.OHRGANIZE_CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // "null" wird aktiv herausgefiltert: Es ist kein Origin einer bestimmten
  // Seite, sondern der Sammelwert JEDES opaken Kontexts — sandboxed <iframe>,
  // data:-URL, redirect-verschleierte Anfragen, file://. Steht "null" in der
  // Whitelist, darf faktisch jede fremde Seite mit Anmeldedaten des Portals
  // auf die API zugreifen; die Liste wäre so durchlässig wie `origin: true`.
  // Das früher in docs/web-portal.md dokumentierte Rezept
  // "https://musterfirma.ohrganize.com,null" ist genau dieser Fall.
  const cleaned = raw.filter((o) => o.toLowerCase() !== 'null');
  if (cleaned.length < raw.length) {
    startupWarnings.push(
      'OHRGANIZE_CORS_ORIGIN enthielt den Wert "null" — er wurde ignoriert. "null" ist die ' +
        'Herkunft jedes opaken Kontexts (sandboxed iframe, data:, file://) und würde die ' +
        'Origin-Liste wirkungslos machen. Der Desktop-Client meldet sich mit einem eigenen ' +
        'Schema (ohrganize://app); dieses gehört bei Bedarf ausdrücklich in die Liste.',
    );
  }
  return cleaned;
}

const corsOrigins = readCorsOrigins();

// Fail closed: Sobald das Backend nicht mehr nur auf der Loopback-Adresse
// lauscht, ist es aus dem Netz erreichbar. `origin: true` reflektiert dann
// (verifiziert an @fastify/cors 10) JEDE anfragende Herkunft samt
// Access-Control-Allow-Credentials — jede beliebige Webseite könnte im Browser
// einer angemeldeten HR-Kraft Personaldaten auslesen. Früher fiel die
// Konfiguration hier still auf `true` zurück; lieber gar nicht starten, als
// unbemerkt offen stehen.
if (!boundToLoopbackOnly && corsOrigins.length === 0) {
  throw new Error(
    [
      `OHRGANIZE_HOST ist auf "${host}" gesetzt — das Backend wäre damit über das Netz erreichbar,`,
      'aber OHRGANIZE_CORS_ORIGIN ist leer. Ohne Origin-Liste würde CORS jede fremde Herkunft',
      'zulassen. Bitte die erlaubten Herkünfte kommasepariert setzen, z. B.:',
      '  OHRGANIZE_CORS_ORIGIN=https://musterfirma.ohrganize.com,ohrganize://app',
      'Die Desktop-App gehört mit in die Liste: Sie sendet die Herkunft "ohrganize://app".',
      'Fehlt der Eintrag, kommt aus der HR-Administration keine einzige Anfrage durch.',
      'Der Wert "null" ist nicht zulässig (er erlaubt faktisch jede Herkunft).',
      'Für den reinen Ein-Rechner-Betrieb OHRGANIZE_HOST weglassen oder auf 127.0.0.1 setzen.',
    ].join('\n'),
  );
}

// Ohne Origin-Liste bleibt CORS offen. Das ist ausschließlich der lokale Fall:
// Das Backend hängt dann an 127.0.0.1, und der eingebettete Desktop-Renderer
// lädt heute noch über file:// und sendet damit Origin "null".
//
// ABHÄNGIGKEIT: Der Desktop-Client wird parallel auf ein eigenes Schema
// (ohrganize://app statt file://) umgestellt. Danach sendet auch der Renderer
// eine benannte Herkunft und kann in einem Server-Deploy regulär in
// OHRGANIZE_CORS_ORIGIN aufgenommen werden. Bis dahin gilt: OHRGANIZE_CORS_ORIGIN
// niemals auf einem Arbeitsplatz setzen — das eingebettete Backend erbt die
// Variable und würde den eigenen Renderer aussperren.
const corsOrigin: boolean | string[] = corsOrigins.length > 0 ? corsOrigins : true;

// Token-Laufzeiten in Sekunden, je Sitzungsart (core/auth.ts, sessionFor).
//
// Portal (OHRGANIZE_TOKEN_TTL, Vorgabe 1h): Frühere 12h waren im reinen
// Einzelplatzbetrieb vertretbar; im Serverbetrieb ist ein abgegriffenes Token
// einen halben Arbeitstag gültig. Das Portal verlängert nur bei Aktivität,
// die Laufzeit begrenzt also auch serverseitig die Sitzung nach Leerlauf.
//
// Desktop (OHRGANIZE_DESKTOP_TOKEN_TTL, Vorgabe 3d): Die App verlängert nach
// zehn Minuten, solange sie läuft, und hält das Token nur bis zum Schließen
// (sessionStorage). Die Laufzeit zählt also nur, während der Rechner schläft
// (Mittag, Nacht, Wochenende); drei Tage überbrücken ein Wochenende.
//
// Beide Clients lesen die Laufzeit aus dem Token (exp - iat) und verlängern
// bei kurzer Laufzeit spätestens nach der halben (packages/shared/src/
// session.ts); eine Untergrenze braucht es hier deshalb nicht.
//
// Format: Sekundenzahl oder "30m", "1h", "8h", "7d". Fail closed statt still
// zu ignorieren: @fastify/jwt verstand einen unbekannten Wert und auch "0" als
// Token ganz OHNE Ablauf und eine nackte Zahl als Millisekunden. Deshalb wird
// hier selbst in Sekunden umgerechnet und als Zahl weitergegeben.
const TOKEN_TTL_PATTERN = /^(\d+|\d+(?:\.\d+)?\s*(?:s|m|h|d))$/i;
const TTL_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function readTokenTtl(name: string, fallback: string): number {
  const raw = (process.env[name] ?? '').trim() || fallback;
  const match = TOKEN_TTL_PATTERN.test(raw) ? /^([\d.]+)\s*([smhd]?)$/i.exec(raw) : null;
  const seconds = match ? Math.floor(Number(match[1]) * TTL_UNIT_SECONDS[(match[2] || 's').toLowerCase()]) : 0;
  if (!(seconds >= 1)) {
    throw new Error(
      `${name}="${raw}" ist ungültig. Erlaubt sind eine Sekundenzahl ` +
        'oder Angaben wie "30m", "1h", "8h", "7d" (mindestens eine Sekunde).',
    );
  }
  return seconds;
}

const tokenTtl = readTokenTtl('OHRGANIZE_TOKEN_TTL', '1h');
const desktopTokenTtl = readTokenTtl('OHRGANIZE_DESKTOP_TOKEN_TTL', '3d');

// Höchstdauer einer Sitzung ab der Anmeldung, je Sitzungsart (core/auth.ts,
// Claim auth_time). Die Verlängerung (POST /api/auth/refresh) stellt danach
// kein Token mehr aus, und jedes Token läuft spätestens zu diesem Zeitpunkt
// ab. Ohne die Grenze hielte ein abgegriffenes Token eine Sitzung beliebig
// lange offen, solange es jemand verlängert; die Abmeldung des Portals nach
// Leerlauf geschieht nur im Browser. Portal 6h: ein Arbeitstag am Stück. Desktop
// 5d: Die App bleibt bis zum Schließen angemeldet, auch über ein Wochenende
// mit schlafendem Rechner; nach fünf Tagen ist eine neue Anmeldung fällig.
// Gleiches Format wie die Laufzeiten; ein Wert unter der Laufzeit kürzt auch
// sie.
const sessionMax = readTokenTtl('OHRGANIZE_SESSION_MAX', '6h');
const desktopSessionMax = readTokenTtl('OHRGANIZE_DESKTOP_SESSION_MAX', '5d');

/**
 * Optionales Initialpasswort für den Standard-Admin (nur bei der allerersten
 * Inbetriebnahme ausgewertet, siehe core/auth.ts). Ist die Variable gesetzt,
 * übernimmt oHRganize den Wert unverändert und verlangt KEINEN sofortigen
 * Wechsel — die Verantwortung liegt dann bewusst beim Betreiber
 * (Provisionierung per Konfigurationsmanagement, automatisierte Tests).
 * Ohne die Variable wird ein Zufallspasswort erzeugt und ein Wechsel erzwungen.
 */
const initialAdminPassword = (process.env.OHRGANIZE_INITIAL_ADMIN_PASSWORD ?? '').trim() || null;

/**
 * Im Hosting hat das Initialpasswort nichts im Journal zu suchen: Dort liest
 * es jeder mit Journalzugriff, im Mehrkundenbetrieb also der Betreiber samt
 * Monitoring und Logversand, und es bleibt dort stehen, bis die Rotation es
 * abraeumt. Mit OHRGANIZE_QUIET_INITIAL_PASSWORD=1 nennt der Start nur den
 * Pfad der Datei (0600 im Datenverzeichnis); der Betreiber holt das Passwort
 * mit `provision.sh passwort <kunde>` und loescht die Datei danach.
 *
 * Laesst sich die Datei nicht schreiben, steht das Passwort trotzdem im
 * Journal: Ein Konto, dessen Passwort niemand kennt, waere schlimmer.
 */
const quietInitialPassword = ['1', 'true'].includes(
  (process.env.OHRGANIZE_QUIET_INITIAL_PASSWORD ?? '').trim().toLowerCase(),
);

// Bestandsinstallationen sofort nachziehen (die Datenbank wird erst später
// geöffnet; server.ts ruft die Funktion nach migrate() ein zweites Mal auf).
hardenDataPermissions();

export const config = {
  /** Einkompilierte Variante (Land x Edition), siehe packages/shared/src/variants. */
  variant: VARIANT,
  dataDir,
  storageDir,
  dbPath,
  secretPath,
  dataKeyPath,
  initialPasswordPath,
  licensePath,
  licenseEnforced,
  licensePublicKeyOverride,
  host,
  /** true, wenn das Backend ausschließlich lokal erreichbar ist. */
  boundToLoopbackOnly,
  port: Number(process.env.OHRGANIZE_PORT ?? 3001),
  corsOrigin,
  secret: loadOrCreateSecret(),
  /** Laufzeit von Portal-Tokens in Sekunden (OHRGANIZE_TOKEN_TTL). */
  tokenTtl,
  /** Laufzeit von Desktop-Tokens in Sekunden (OHRGANIZE_DESKTOP_TOKEN_TTL). */
  desktopTokenTtl,
  /** Höchstdauer einer Portal-Sitzung ab Anmeldung in Sekunden (OHRGANIZE_SESSION_MAX). */
  sessionMax,
  /** Höchstdauer einer Desktop-Sitzung ab Anmeldung in Sekunden (OHRGANIZE_DESKTOP_SESSION_MAX). */
  desktopSessionMax,
  initialAdminPassword,
  quietInitialPassword,
  startupWarnings,
  // Gültigkeit signierter Download-Links. Von 5 Minuten auf 60 Sekunden
  // gesenkt (Audit S7): Der Link steht im Query-String und landet damit im
  // Access-Log jedes Reverse-Proxys — eine Kopie des Logs wäre sonst minutenlang
  // ein anmeldefreier Zugang zu jeder in dieser Zeit verlinkten Datei.
  // core/files.ts deckelt zusätzlich auf 60 s, damit eine großzügigere
  // Konfiguration die Grenze nicht wieder aufhebt; ein KLEINERER Wert hier
  // gewinnt weiterhin.
  downloadUrlTtlMs: 60 * 1000,
};
