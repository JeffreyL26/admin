import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb, inTransaction } from '../db/db.js';
import { config } from '../config.js';
import { AppError, parse, unauthorized, badRequest } from './errors.js';
import { permissionsFor } from './permissions.js';
import { audit, auditStandalone } from './audit.js';
import { getSetting } from './settings.js';
import { licenseForRole } from './license.js';
import { portalAccessFor } from './portalAccess.js';
import { nextSessionsValidFrom } from './credentials.js';
import { comparePassword, hashPassword, setPasswordHashingLogger } from './passwordHashing.js';

// Liegen in credentials.ts (ohne config-Import, damit auch die
// Betreiberwerkzeuge sie nutzen); hier weiter erreichbar wie bisher.
export { generateInitialPassword, nextSessionsValidFrom } from './credentials.js';

/**
 * Sitzungsart eines Tokens. 'desktop' ist die HR-Administration in der
 * Desktop-App (Laufzeit config.desktopTokenTtl), 'portal' alles andere
 * (config.tokenTtl). Wirksam wird 'desktop' nur für Konten mit
 * role = 'admin' (sessionFor).
 */
export type SessionKind = 'desktop' | 'portal';

/** Rollen: 'admin' = HR-Administration (Desktop), 'mitarbeiter' = Web-Portal. */
export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  /** Verknüpftes Personalprofil (nur Mitarbeitenden-Accounts, sonst null). */
  employee_id: number | null;
  /**
   * Abgestufte Rechte innerhalb der HR-Administration. `null` bedeutet
   * Vollzugriff (siehe Migration 002_admin_roles) — nicht "keine Rechte".
   * Wie role und employee_id wird das Feld pro Request frisch geladen, damit
   * ein Rechteentzug sofort greift und nicht erst nach Tokenablauf.
   */
  admin_role_id?: number | null;
  /**
   * 0/1 (SQLite kennt kein Boolean). Solange 1, sperrt der globale Hook alles
   * außer /api/auth/me und /api/auth/password. Der Client kann daran die
   * Aufforderung zum Passwortwechsel erkennen.
   */
  must_change_password?: number;
  /**
   * Ausstellungszeitpunkt des Tokens in Unix-Sekunden (setzt @fastify/jwt).
   * Wird gegen users.sessions_valid_from geprüft, damit ein Passwortwechsel
   * bereits ausgestellte Tokens entwertet.
   */
  iat?: number;
  /**
   * Sitzungsart, signiert im Token. Der globale Hook übernimmt sie
   * unverändert (anders als Rolle und Profil steht sie nicht in users), damit
   * Verlängerung und Passwortwechsel dieselbe Art wieder ausstellen. Fehlt sie
   * (Token einer älteren Fassung), gilt 'portal'.
   */
  session?: SessionKind;
  /**
   * Beginn der Sitzung (Anmeldung oder Passwortwechsel) in Unix-Sekunden,
   * signiert im Token und bei jeder Verlängerung unverändert übernommen. Ab
   * hier zählt die Höchstdauer (config.sessionMax, config.desktopSessionMax).
   * Fehlt er (Token einer älteren Fassung), gilt das iat des Tokens.
   */
  auth_time?: number;
  /**
   * Ende der Sitzung (auth_time plus Höchstdauer), nur zur Auskunft für die
   * Clients: Läuft das Token bis dorthin, bringt eine Verlängerung nichts
   * mehr (packages/shared/src/session.ts). Der Server rechnet es jedes Mal
   * neu aus auth_time.
   */
  session_end?: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthUser;
    payload: AuthUser;
  }
}

declare module 'fastify' {
  /**
   * `config: { public: true }` ist die einzige Art, eine Route von der
   * Authentifizierung auszunehmen (ausgewertet im globalen Hook in server.ts).
   * Die Deklaration macht das Feld typsicher — ohne sie akzeptiert TypeScript
   * es nur zufällig, je nachdem welche Fastify-Überladung greift, und ein
   * Tippfehler ("publik") würde stillschweigend eine Route absichern, die
   * öffentlich sein sollte, oder umgekehrt.
   */
  interface FastifyContextConfig {
    public?: boolean;
  }
}

/**
 * Vergleichshash für nicht existierende Konten (Kostenfaktor 10 wie überall
 * sonst). Ohne ihn überspringt der Login bei unbekannter E-Mail den
 * bcrypt-Vergleich und antwortet messbar schneller (~4 ms statt ~65 ms) —
 * damit lässt sich die Liste gültiger Konten auslesen, ohne ein einziges
 * Passwort zu kennen. Der Vergleich läuft deshalb IMMER, auch ins Leere.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('ohrganize-nicht-vergeben', 10);

/**
 * Sitzungsart eines neuen Tokens. Die lange Desktop-Laufzeit gibt es nur für
 * die HR-Administration; ein Portal-Konto, das sich als Desktop ausgibt,
 * bekommt trotzdem ein Portal-Token. Gefragt wird mit der FRISCHEN Rolle aus
 * users, damit ein Rollenwechsel spätestens mit der nächsten Verlängerung
 * auch die Laufzeit kürzt.
 */
function sessionFor(requested: SessionKind | undefined, role: string): SessionKind {
  return requested === 'desktop' && role === 'admin' ? 'desktop' : 'portal';
}

/** Höchstdauer einer Sitzung dieser Art ab ihrem Beginn (config.ts). */
function sessionMaxOf(session: SessionKind): number {
  return session === 'desktop' ? config.desktopSessionMax : config.sessionMax;
}

/**
 * Token ausstellen. Die Laufzeit hängt an der Sitzungsart und wird deshalb je
 * Token mitgegeben (sie ersetzt die Vorgabe aus der Registrierung in
 * server.ts); die Art steht als Claim `session` im Token. `authTime` ist der
 * Beginn der Sitzung: Das Token läuft nach seiner Laufzeit ab, spätestens aber
 * zum Ende der Sitzung (auth_time plus Höchstdauer). So endet jede Sitzung
 * nach der Höchstdauer, auch wenn das letzte Token kurz davor ausgestellt
 * wurde.
 */
function signToken(app: FastifyInstance, user: AuthUser, session: SessionKind, authTime: number): string {
  const iat = user.iat ?? Math.floor(Date.now() / 1000);
  const ttl = session === 'desktop' ? config.desktopTokenTtl : config.tokenTtl;
  const sessionEnd = authTime + sessionMaxOf(session);
  const expiresIn = Math.max(1, Math.min(ttl, sessionEnd - iat));
  return (
    app as FastifyInstance & { jwt: { sign: (p: AuthUser, o: { expiresIn: number }) => string } }
  ).jwt.sign({ ...user, iat, session, auth_time: authTime, session_end: sessionEnd }, { expiresIn });
}

/** Identität für das Token, aus einer users-Zeile (Login, Verlängerung). */
function identityOf(row: AuthUser): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    employee_id: row.employee_id ?? null,
    admin_role_id: row.admin_role_id ?? null,
    must_change_password: row.must_change_password ?? 0,
  };
}

/**
 * `iat` für ein neu auszustellendes Token: nie kleiner als die Sitzungssperre
 * des Kontos. Ohne diese Anhebung würde ein Login, der in dieselbe Sekunde
 * fällt wie ein administratives Zurücksetzen, sofort wieder mit
 * "Die Sitzung wurde beendet" abgewiesen. fast-jwt übernimmt ein im Payload
 * mitgegebenes `iat` und rechnet auch `exp` davon aus (verifiziert).
 */
function issueIat(sessionsValidFrom: number | null | undefined): number {
  const now = Math.floor(Date.now() / 1000);
  return sessionsValidFrom != null && sessionsValidFrom > now ? sessionsValidFrom : now;
}

// --------------------------------------------------------------------------
// Standard-Admin
// --------------------------------------------------------------------------

/**
 * Legt den Standard-Admin an, falls noch keine Benutzer existieren.
 *
 * Das Konto hat `admin_role_id = NULL` und damit Vollzugriff. Ein fest
 * verdrahtetes Passwort (früher 'hrmonic2026', nachzulesen in README, CLAUDE.md
 * und im gebündelten server.cjs) genügte deshalb für die vollständige
 * Übernahme der Personaldaten, sobald das Backend über einen Reverse-Proxy
 * erreichbar ist. Stattdessen:
 *   - ohne Vorgabe: Zufallspasswort, einmalige Ausgabe nach stdout und in eine
 *     Datei mit 0600 neben secret.key, Konto mit must_change_password = 1;
 *   - mit OHRGANIZE_INITIAL_ADMIN_PASSWORD: bewusste Betreibervorgabe (z. B. aus
 *     dem Konfigurationsmanagement oder für automatisierte Tests), dann ohne
 *     Wechselzwang — das Passwort ist nirgends veröffentlicht.
 */
export function ensureDefaultAdmin(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) return;

  const provided = config.initialAdminPassword;
  // 12 Zufallsbytes → 16 Zeichen base64url; base64url, damit sich das Passwort
  // aus einem Terminal-Log fehlerfrei kopieren lässt (keine Sonderzeichen, die
  // eine Shell interpretiert).
  const password = provided ?? crypto.randomBytes(12).toString('base64url');

  db.prepare(
    'INSERT INTO users (email, name, password_hash, must_change_password) VALUES (?, ?, ?, ?)',
  ).run('admin@ohrganize.de', 'HR Administrator', bcrypt.hashSync(password, 10), provided ? 0 : 1);

  if (provided) return;

  let fileHint = `Datei: ${config.initialPasswordPath}`;
  let fileWritten = true;
  try {
    // mode 0600 wie secret.key — die Datei steht im Datenverzeichnis, das auf
    // einem Server auch dem Backup-Agenten und dem Monitoring offensteht.
    fs.writeFileSync(config.initialPasswordPath, `${password}\n`, { mode: 0o600 });
  } catch (err) {
    fileWritten = false;
    fileHint = `Datei konnte nicht geschrieben werden (${String(err)}) — bitte JETZT notieren.`;
  }

  // Hosting: Das Passwort bleibt in der Datei, das Journal nennt nur den Weg
  // dorthin (config.quietInitialPassword). Ohne Datei hilft das niemandem,
  // dann steht es trotzdem hier.
  if (config.quietInitialPassword && fileWritten) {
    console.log(
      [
        '',
        '='.repeat(72),
        'oHRganize: Erstinbetriebnahme, Standard-Admin angelegt',
        '  Benutzer: admin@ohrganize.de',
        `  Passwort: steht in ${config.initialPasswordPath} (nur fuer den Dienstbenutzer lesbar)`,
        '  Abholen:  ohrganize-provision.sh passwort <kunde>',
        '  Das Passwort wird beim ersten Login zwingend geaendert; danach die Datei loeschen.',
        '='.repeat(72),
        '',
      ].join('\n'),
    );
    return;
  }

  // Bewusst console.log statt Logger: Der Logger existiert zu diesem Zeitpunkt
  // noch nicht (ensureDefaultAdmin läuft vor der Fastify-Instanz) und die
  // Ausgabe soll auch bei Loglevel 'warn' im Journal landen.
  console.log(
    [
      '',
      '='.repeat(72),
      'oHRganize: Erstinbetriebnahme — Standard-Admin angelegt',
      '  Benutzer: admin@ohrganize.de',
      `  Passwort: ${password}`,
      `  ${fileHint}`,
      '  Das Passwort wird beim ersten Login zwingend geändert; danach die Datei löschen.',
      '='.repeat(72),
      '',
    ].join('\n'),
  );
}

// --------------------------------------------------------------------------
// Login-Drosselung (M3)
// --------------------------------------------------------------------------

/** Gleitendes Fenster, in dem Fehlversuche gezählt werden. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Sperrschwelle je Konto — schützt das einzelne Konto vor Durchprobieren. */
const MAX_FAILURES_PER_EMAIL = 10;
/**
 * Sperrschwelle je IP. Bewusst deutlich höher: Hinter einem Firmen-NAT teilen
 * sich alle Arbeitsplätze eine IP, eine knappe Schwelle würde bei ein paar
 * vertippten Passwörtern das ganze Haus aussperren. Die IP-Schranke deckt den
 * Fall "viele verschiedene Konten von einer Quelle" ab — und begrenzt zugleich
 * die DoS-Wirkung: bcrypt rechnet ~65 ms je Versuch, im Worker-Pool
 * (core/passwordHashing.ts), dessen Warteschlange sonst alle Anmeldungen
 * aufhielte; im Ersatzbetrieb ohne Worker sogar im einzigen Node-Prozess.
 */
const MAX_FAILURES_PER_IP = 50;
/**
 * Ein Eintrag „in Arbeit“, dessen Anfrage nie aufgeräumt wurde, verfällt nach
 * dieser Zeit (der Vergleich bricht spätestens nach 15 s in den Ersatzbetrieb
 * ab, core/passwordHashing.ts).
 */
const IN_FLIGHT_STALE_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Fehlversuche als Zeitstempel je Schlüssel. Bewusst im Speicher und nicht in
 * der Datenbank: Es läuft genau ein Backend-Prozess (better-sqlite3), die
 * Sperre darf einen Neustart überleben müssen — ein Neustart ist kein
 * Angriffswerkzeug — und ein Schreibzugriff je Fehlversuch wäre selbst ein
 * DoS-Hebel.
 */
const loginFailures = new Map<string, number[]>();

/**
 * Kanonische Form einer E-Mail-Adresse. Konten werden ausschließlich
 * kleingeschrieben gespeichert (modules/admin/userRoutes.ts normalisiert schon
 * im Schema), `WHERE email = ?` vergleicht in SQLite aber binär. Ohne diese
 * Normalisierung scheitert „Max.Mustermann@Firma.de" am Login — und zählt
 * obendrein in die Drosselung.
 *
 * Bewusst eine eigene Funktion neben normalizedEmail(): Der Login hat die
 * Adresse nach `parse()` bereits als String vorliegen und darf sie nicht
 * anders normalisieren als die Drosselung, die aus dem rohen Body liest.
 * Sonst laufen Suchschlüssel und Zähler auseinander.
 */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedEmail(body: unknown): string | null {
  const value = (body as { email?: unknown } | null | undefined)?.email;
  return typeof value === 'string' && value.trim() ? normalizeEmail(value) : null;
}

/**
 * Schlüssel und zugehörige Schwelle für einen Login-Versuch. Die normalisierte
 * E-Mail ist der primäre Schlüssel (trifft den Angriff auf ein Konto auch
 * dann, wenn er aus einem Botnetz kommt), die IP der sekundäre.
 */
function throttleKeys(req: FastifyRequest): [string, number][] {
  const keys: [string, number][] = [];
  const email = normalizedEmail(req.body);
  if (email) keys.push([`email:${email}`, MAX_FAILURES_PER_EMAIL]);
  keys.push([`ip:${req.ip}`, MAX_FAILURES_PER_IP]);
  return keys;
}

/** Zählt die Fehlversuche im Fenster und räumt dabei alte Einträge weg. */
function countFailures(key: string, now: number): number {
  const list = loginFailures.get(key);
  if (!list) return 0;
  const fresh = list.filter((t) => t > now - LOGIN_WINDOW_MS);
  if (fresh.length === 0) loginFailures.delete(key);
  else loginFailures.set(key, fresh);
  return fresh.length;
}

function noteFailure(key: string, limit: number, now: number): void {
  const list = (loginFailures.get(key) ?? []).filter((t) => t > now - LOGIN_WINDOW_MS);
  list.push(now);
  // Nach oben deckeln: Mehr als die Schwelle muss nie gespeichert werden,
  // sonst wächst die Liste bei Dauerbeschuss unbegrenzt.
  loginFailures.set(key, list.slice(-limit));
}

/**
 * Nach erfolgreicher Anmeldung nur den KONTO-Zähler zurücksetzen, nicht den der
 * IP: Wer ein einziges gültiges Konto besitzt (z. B. ein eigenes Portal-Konto),
 * könnte sich sonst nach jedem Fehlversuchsblock durch einen echten Login
 * freischalten und die IP-Schranke beliebig oft umgehen. Der IP-Zähler läuft
 * über das gleitende Fenster von selbst aus.
 */
function clearFailuresForAccount(req: FastifyRequest): void {
  const email = normalizedEmail(req.body);
  if (email) loginFailures.delete(`email:${email}`);
}

/**
 * Zeitpunkt, unter dem ein laufender Versuch vorgemerkt ist (throttleLogin,
 * throttlePasswordChange). Seit der Vergleich im Worker-Pool läuft, liegt
 * zwischen Prüfung und Ergebnis ein `await`: Zählte erst das Ergebnis, kämen
 * beliebig viele GLEICHZEITIGE Versuche an der Schwelle vorbei, bevor der
 * erste als Fehlversuch zählt (ein Bündel von 100 parallelen Anfragen wären
 * 100 Rateversuche statt 10). Prüfen und Vormerken geschehen deshalb ohne
 * `await` dazwischen:
 * - beim KONTO als Fehlversuch (die Schwelle 10 gilt so auch für parallele
 *   Versuche; ein Erfolg leert den Zähler, ein Abbruch vor dem Vergleich,
 *   etwa ein ungültiger Body, nimmt den Vermerk zurück);
 * - bei der IP nur als „in Arbeit“ (loginsInFlight; zählt gegen dieselbe
 *   Schwelle, siehe throttleLogin), als Fehlversuch erst mit dem Ergebnis.
 */
const pendingAttemptAt = new WeakMap<FastifyRequest, number>();

/** Anmeldungen je IP-Schlüssel, die gerade in Arbeit sind (Zeitstempel). */
const loginsInFlight = new Map<string, number[]>();

function countInFlight(key: string, now: number): number {
  const list = loginsInFlight.get(key);
  if (!list) return 0;
  const fresh = list.filter((t) => t > now - IN_FLIGHT_STALE_MS);
  if (fresh.length === 0) loginsInFlight.delete(key);
  else loginsInFlight.set(key, fresh);
  return fresh.length;
}

function releaseInFlight(key: string, at: number): void {
  const list = loginsInFlight.get(key);
  if (!list) return;
  const index = list.indexOf(at);
  if (index !== -1) list.splice(index, 1);
  if (list.length === 0) loginsInFlight.delete(key);
}

/** Einen vorgemerkten Versuch aus der Liste eines Schlüssels entfernen. */
function withdrawFailure(key: string, at: number): void {
  const list = loginFailures.get(key);
  if (!list) return;
  const index = list.indexOf(at);
  if (index !== -1) list.splice(index, 1);
  if (list.length === 0) loginFailures.delete(key);
}

/**
 * preHandler der Login-Route: läuft VOR dem bcrypt-Vergleich im Handler. Das
 * ist kein Detail: Genau dieser Vergleich kostet die Rechenzeit (im Worker,
 * im Ersatzbetrieb im Event-Loop), eine Prüfung danach würde die DoS-Wirkung
 * nicht entschärfen. Der Versuch wird hier vorgemerkt (pendingAttemptAt).
 */
async function throttleLogin(req: FastifyRequest): Promise<void> {
  const now = Date.now();
  const keys = throttleKeys(req);
  for (const [key, limit] of keys) {
    if (countFailures(key, now) < limit) continue;
    // Nur loggen, nicht auditieren: Ein Audit-Eintrag je abgewiesenem Versuch
    // wäre ein unbegrenzter Schreibpfad für einen Angreifer.
    req.log.warn(
      { ip: req.ip, email: normalizedEmail(req.body), key },
      'Anmeldung gesperrt: zu viele Fehlversuche',
    );
    throw new AppError(
      429,
      'TOO_MANY_REQUESTS',
      'Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es in einigen Minuten erneut.',
    );
  }
  // Laufende Anmeldungen einer IP zählen gegen ihre Schwelle mit: Fehlversuche
  // plus laufende Vergleiche bleiben unter MAX_FAILURES_PER_IP. Sonst liefen
  // in einem Bündel paralleler Anfragen beliebig viele Vergleiche an, bevor der
  // erste als Fehlversuch zählt (gemessen mit einer reinen Obergrenze von 100
  // gleichzeitigen: rund 150 Rateversuche je Fenster statt 50). Eine laufende
  // Anmeldung ist dabei kein Fehlversuch: Sie belegt die Schwelle nur, solange
  // sie läuft, und ein Erfolg hinterlässt nichts. Hinter einem Firmen-NAT
  // trifft das erst mehr als 50 GLEICHZEITIG laufende Anmeldungen; bei rund 30
  // Vergleichen je Sekunde wären das mehr als 50 Klicks binnen zwei Sekunden.
  // Die Antwort richtet sich danach, was die Schwelle füllt: Überwiegen die
  // laufenden Anmeldungen, hilft ein neuer Versuch gleich danach; überwiegen
  // die Fehlversuche, steht die Sperre kurz bevor, und erst das Fenster hilft.
  const ipKey = `ip:${req.ip}`;
  const ipFailures = countFailures(ipKey, now);
  const ipInFlight = countInFlight(ipKey, now);
  if (ipFailures + ipInFlight >= MAX_FAILURES_PER_IP) {
    const concurrent = ipInFlight > ipFailures;
    req.log.warn(
      { ip: req.ip, failures: ipFailures, inFlight: ipInFlight },
      concurrent ? 'Anmeldung gesperrt: zu viele gleichzeitige Versuche' : 'Anmeldung gesperrt: zu viele Fehlversuche',
    );
    throw new AppError(
      429,
      'TOO_MANY_REQUESTS',
      concurrent
        ? 'Zu viele gleichzeitige Anmeldeversuche. Bitte versuchen Sie es gleich noch einmal.'
        : 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es in einigen Minuten erneut.',
    );
  }
  const email = normalizedEmail(req.body);
  if (email) noteFailure(`email:${email}`, MAX_FAILURES_PER_EMAIL, now);
  const list = loginsInFlight.get(ipKey) ?? [];
  list.push(now);
  loginsInFlight.set(ipKey, list);
  pendingAttemptAt.set(req, now);
}

/**
 * Fehlversuchs-Schlüssel für den Passwortwechsel — gleiche Mechanik und Map
 * wie beim Login, aber pro Konto-ID: Die Route ist nur angemeldet erreichbar,
 * der Absender ist also bereits ein konkretes Konto (bzw. dessen abgegriffenes
 * Token, das das Passwort selbst nicht kennt). Ohne Schranke ließe sich das
 * aktuelle Passwort unbegrenzt durchprobieren und der bcrypt-Vergleich als
 * DoS gegen alle Arbeitsplätze samt Portal missbrauchen (er belegt den
 * Worker-Pool, den auch jede Anmeldung braucht).
 */
function pwChangeKey(userId: number): string {
  return `pwchange:${userId}`;
}

/**
 * preHandler von PUT /api/auth/password: läuft wie throttleLogin VOR dem
 * bcrypt-Vergleich im Handler — eine Prüfung danach würde die DoS-Wirkung
 * nicht entschärfen. Der globale Auth-Hook (onRequest) ist zu diesem
 * Zeitpunkt bereits gelaufen, req.user ist also gesetzt.
 */
async function throttlePasswordChange(req: FastifyRequest): Promise<void> {
  const now = Date.now();
  const key = pwChangeKey(req.user.id);
  if (countFailures(key, now) < MAX_FAILURES_PER_EMAIL) {
    // Vorab als Fehlversuch zählen, wie beim Login (pendingAttemptAt).
    noteFailure(key, MAX_FAILURES_PER_EMAIL, now);
    pendingAttemptAt.set(req, now);
    return;
  }
  req.log.warn({ userId: req.user.id }, 'Passwortwechsel gesperrt: zu viele Fehlversuche');
  throw new AppError(
    429,
    'TOO_MANY_REQUESTS',
    'Zu viele fehlgeschlagene Versuche. Bitte versuchen Sie es in einigen Minuten erneut.',
  );
}

// --------------------------------------------------------------------------
// Passwortregeln (S9)
// --------------------------------------------------------------------------

const MIN_PASSWORD_CHARS = 12;
/**
 * bcrypt verarbeitet nur die ersten 72 Byte und schneidet den Rest STILL ab —
 * eine 200 Zeichen lange Passphrase wäre also nicht sicherer als ihre ersten
 * 72 Byte, und niemand erführe davon. Gemessen in BYTE, nicht in Zeichen:
 * Umlaute belegen zwei, Emoji bis zu vier.
 */
const MAX_PASSWORD_BYTES = 72;

/**
 * Regeln für ein neues Passwort. Bewusst als eigene Prüfung mit badRequest
 * statt als zod-Constraint: `parse()` fasst Schemafehler zur generischen
 * Meldung "Eingabedaten sind ungültig" zusammen, hier soll aber jede Regel
 * ihren eigenen deutschen Satz an den Client liefern.
 *
 * Die Ablehnliste ersetzt keine Passwortrichtlinie. Sie fängt genau die
 * Muster ab, die erfahrungsgemäß vergeben werden, sobald ein Wechsel
 * erzwungen wird: Produktname, Firmenname, E-Mail-Lokalteil, Tastenfolge.
 */
function assertPasswordAcceptable(newPassword: string, email: string): void {
  if (newPassword.length < MIN_PASSWORD_CHARS) {
    throw badRequest(`Das neue Passwort muss mindestens ${MIN_PASSWORD_CHARS} Zeichen lang sein`);
  }
  if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) {
    throw badRequest(
      'Das neue Passwort ist zu lang (höchstens 72 Byte; Umlaute zählen doppelt, Emoji vierfach)',
    );
  }

  const value = newPassword.toLowerCase();
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  const forbidden = [
    'ohrganize',
    'passwort',
    'password',
    '123456',
    'qwertz',
    'qwerty',
    String(getSetting('companyName')).toLowerCase(),
    localPart,
  ].filter((t) => t.length >= 4);

  if (forbidden.some((token) => value.includes(token))) {
    throw badRequest(
      'Dieses Passwort ist zu leicht zu erraten. Es darf weder den Produkt- oder Firmennamen ' +
        'noch den Anfang Ihrer E-Mail-Adresse oder eine gängige Tastenfolge enthalten.',
    );
  }
}

// --------------------------------------------------------------------------
// Routen
// --------------------------------------------------------------------------

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Aufräumen der Fehlversuchs-Map. unref(), damit weder Smoke-Tests noch das
  // eingebettete Desktop-Backend am Timer hängen bleiben.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, list] of loginFailures) {
      const fresh = list.filter((t) => t > now - LOGIN_WINDOW_MS);
      if (fresh.length === 0) loginFailures.delete(key);
      else loginFailures.set(key, fresh);
    }
    for (const key of [...loginsInFlight.keys()]) countInFlight(key, now);
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref?.();
  app.addHook('onClose', async () => clearInterval(cleanup));
  // Ausfall des Worker-Pools (Ersatzbetrieb) ins Journal statt auf stderr.
  setPasswordHashingLogger(app.log);

  app.post(
    '/api/auth/login',
    { config: { public: true }, preHandler: throttleLogin },
    async (req) => {
      // Vermerk aus throttleLogin: Die IP-Zählung „in Arbeit“ endet mit der
      // Anfrage, gleich wie sie ausgeht; ohne Vergleich (ungültiger Body)
      // war es kein Rateversuch, dann fällt auch der Vermerk beim Konto weg.
      const attemptAt = pendingAttemptAt.get(req);
      let compared = false;
      try {
        return await login(req, () => {
          compared = true;
        });
      } finally {
        if (attemptAt !== undefined) {
          releaseInFlight(`ip:${req.ip}`, attemptAt);
          const rawEmail = normalizedEmail(req.body);
          if (!compared && rawEmail) withdrawFailure(`email:${rawEmail}`, attemptAt);
        }
      }
    },
  );

  async function login(req: FastifyRequest, onCompared: () => void) {
    const body = parse(
      z.object({
        email: z.string().email(),
        password: z.string().min(1),
        // Sitzungsart (sessionFor); ältere Clients schicken nichts und
        // bekommen wie bisher ein Portal-Token.
        client: z.enum(['desktop', 'portal']).optional(),
      }),
      req.body,
    );
    // Derselbe Wert, den auch throttleKeys()/clearFailuresForAccount() aus
    // dem rohen Body bilden: Suchschlüssel, Drosselungszähler und die
    // Einträge in Log und Audit bleiben so deckungsgleich.
    const email = normalizeEmail(body.email);
    const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | (AuthUser & { password_hash: string; sessions_valid_from: number | null })
      | undefined;

    // Immer vergleichen, auch gegen den Dummy-Hash, wenn es das Konto nicht
    // gibt (siehe DUMMY_PASSWORD_HASH: sonst verrät die Antwortzeit, welche
    // E-Mail-Adressen existieren). Gerechnet wird im Worker-Pool, nicht im
    // Event-Loop (core/passwordHashing.ts).
    const passwordMatches = await comparePassword(
      body.password,
      row?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    onCompared();

    if (!row || !passwordMatches) {
      // Beim Konto zählt der Fehlversuch schon seit throttleLogin
      // (pendingAttemptAt), bei der IP erst jetzt, mit dem Ergebnis.
      noteFailure(`ip:${req.ip}`, MAX_FAILURES_PER_IP, Date.now());
      req.log.warn({ ip: req.ip, email }, 'Anmeldung fehlgeschlagen');
      // Audit ohne req.user (core/audit.ts verträgt das); im Serverbetrieb
      // ist das die einzige dauerhafte Spur eines Angriffsversuchs.
      auditStandalone(req, 'login_fehlgeschlagen', 'user', row?.id, { email, ip: req.ip });
      throw unauthorized('E-Mail oder Passwort ist falsch');
    }

    clearFailuresForAccount(req);
    const user = identityOf(row);
    // iat ausdrücklich setzen: liegt sessions_valid_from (z. B. durch ein
    // administratives Zurücksetzen in derselben Sekunde) in der Zukunft,
    // wäre ein Token mit der laufenden Sekunde sofort wieder ungültig.
    // Die Anmeldung beginnt die Sitzung (auth_time).
    const iat = issueIat(row.sessions_valid_from);
    const token = signToken(app, { ...user, iat }, sessionFor(body.client, row.role), iat);
    auditStandalone(req, 'login', 'user', row.id, { ip: req.ip });
    // Die Rechte reisen mit der Antwort, damit die Oberfläche gesperrte
    // Bereiche gar nicht erst anbietet. Sie sind reine Anzeigehilfe, die
    // Durchsetzung passiert ausschließlich im Hook (core/permissions.ts).
    // Der Lizenzzustand reist ebenfalls mit (Banner ohne Zusatzabfrage);
    // Portal-Konten bekommen nur, ob Änderungen gerade möglich sind.
    return {
      token,
      user,
      permissions: permissionsFor(user.admin_role_id),
      license: licenseForRole(user.role),
      // Portal-Konten: was die Fachrollen im Portal freigeben (Anzeigehilfe;
      // die Durchsetzung sitzt in den /api/me-Routen).
      portal: portalAccessFor(user.employee_id),
    };
  }

  app.get('/api/auth/me', async (req) => ({
    user: req.user,
    permissions: permissionsFor(req.user.admin_role_id),
    license: licenseForRole(req.user.role),
    portal: portalAccessFor(req.user.employee_id),
  }));

  /**
   * Sitzung verlängern: neues Token derselben Sitzungsart, ausgestellt aus der
   * frischen users-Zeile wie beim Login. Der globale Hook hat vorher alles
   * geprüft, was eine Sitzung beendet: Signatur, Ablauf, iat nicht vor
   * sessions_valid_from, Konto vorhanden, kein erzwungener Passwortwechsel
   * (die Route steht bewusst nicht in PASSWORD_CHANGE_ROUTES). Passwortwechsel,
   * administratives Zurücksetzen und Löschen des Kontos beenden damit auch
   * jede verlängerte Sitzung. Im Nur-Lese-Betrieb bleibt die Route offen
   * (LICENSE_OPEN_ROUTES), sonst würde der Ablauf der Lizenz alle abmelden.
   *
   * Höchstdauer: Der Beginn der Sitzung (auth_time) reist unverändert mit;
   * ist die Höchstdauer der (frisch bestimmten) Sitzungsart um, gibt es kein
   * neues Token mehr (401), und das letzte läuft spätestens dann ab
   * (signToken). Ohne die Grenze hielte ein abgegriffenes Token die Sitzung
   * beliebig lange offen.
   *
   * Kein Audit-Eintrag: Die Desktop-App verlängert nach zehn Minuten, das
   * Portal bei Aktivität alle paar Minuten. Das wären Dutzende Zeilen je
   * Sitzung und Tag ohne Aussage, und das Audit-Log der Systemverwaltung
   * würde unlesbar. Die Anmeldung bleibt protokolliert.
   */
  app.post('/api/auth/refresh', async (req) => {
    const row = getDb()
      .prepare(
        `SELECT id, email, name, role, employee_id, admin_role_id, must_change_password,
                sessions_valid_from
           FROM users WHERE id = ?`,
      )
      .get(req.user.id) as (AuthUser & { sessions_valid_from: number | null }) | undefined;
    if (!row) throw unauthorized('Nicht angemeldet oder Sitzung abgelaufen');
    const session = sessionFor(req.user.session, row.role);
    const iat = issueIat(row.sessions_valid_from);
    // Tokens einer älteren Fassung tragen keinen Beginn; dann zählt ihr iat.
    const authTime = req.user.auth_time ?? req.user.iat ?? iat;
    if (iat >= authTime + sessionMaxOf(session)) {
      throw unauthorized('Die Anmeldung ist abgelaufen. Bitte melden Sie sich erneut an.');
    }
    return { token: signToken(app, { ...identityOf(row), iat }, session, authTime) };
  });

  app.put('/api/auth/password', { preHandler: throttlePasswordChange }, async (req) => {
    let body: { currentPassword: string; newPassword: string };
    try {
      body = parse(
        // Regeln bewusst nicht im Schema, siehe assertPasswordAcceptable.
        z.object({ currentPassword: z.string(), newPassword: z.string() }),
        req.body,
      );
    } catch (err) {
      // Ungültiger Body: kein Rateversuch, den Vermerk zurücknehmen.
      const attemptAt = pendingAttemptAt.get(req);
      if (attemptAt !== undefined) withdrawFailure(pwChangeKey(req.user.id), attemptAt);
      throw err;
    }
    const db = getDb();
    const row = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(req.user.id) as
      | { email: string; password_hash: string }
      | undefined;
    // Auch hier gegen den Dummy-Hash vergleichen, damit ein zwischenzeitlich
    // gelöschtes Konto nicht an der Antwortzeit erkennbar ist. Vergleich und
    // Hash laufen im Worker-Pool (core/passwordHashing.ts). Die asynchrone API
    // von bcryptjs hülfe nicht: Sie gibt erst nach 100 ms Rechenzeit ab, ein
    // Vergleich (~65 ms) blockierte den Prozess also auch dort am Stück.
    const currentMatches = await comparePassword(
      body.currentPassword,
      row?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!row || !currentMatches) {
      // Nur der falsche aktuelle Passwort-Versuch zählt — Verstöße gegen die
      // Passwortregeln weiter unten sperrten sonst legitime Nutzer aus, die
      // mehrfach an der Richtlinie scheitern. Gezählt ist er schon seit
      // throttlePasswordChange (pendingAttemptAt); ein richtiges aktuelles
      // Passwort leert den Zähler unten wieder.
      req.log.warn({ userId: req.user.id }, 'Passwortwechsel fehlgeschlagen');
      // Wie beim Login: im Serverbetrieb die einzige dauerhafte Spur, wenn
      // jemand mit einem abgegriffenen Token das Passwort durchprobiert.
      auditStandalone(req, 'passwortwechsel_fehlgeschlagen', 'user', req.user.id, { ip: req.ip });
      throw badRequest('Das aktuelle Passwort ist falsch');
    }
    loginFailures.delete(pwChangeKey(req.user.id));
    assertPasswordAcceptable(body.newPassword, row.email);
    if (await comparePassword(body.newPassword, row.password_hash)) {
      throw badRequest('Das neue Passwort muss sich vom bisherigen unterscheiden');
    }
    const newHash = await hashPassword(body.newPassword, 10);

    // sessions_valid_from in Unix-SEKUNDEN (gleiche Einheit wie das JWT-Feld
    // iat). Alle älteren Tokens gelten damit ab sofort als ungültig — ein
    // Passwortwechsel wegen Verdacht auf Kompromittierung wäre sonst wirkungslos,
    // weil das abgegriffene Token bis zum Ablauf weiterläuft.
    // Zur Begründung des +1 (nextSessionsValidFrom) siehe dort: mit der
    // laufenden Sekunde überlebte ein Token, das in derselben Sekunde
    // ausgestellt wurde, den Wechsel.
    const validFrom = nextSessionsValidFrom();
    // TOCTOU-Schutz: Durch das asynchrone bcrypt liegen awaits zwischen dem
    // Lesen der users-Zeile und diesem UPDATE. Ein paralleler
    // Admin-Passwort-Reset (neuer Hash, must_change_password = 1) könnte
    // dazwischen laufen und würde hier kommentarlos überschrieben — der
    // Wechselzwang wäre ausgehebelt. Das UPDATE greift deshalb nur, wenn die
    // Zeile noch genau den Hash trägt, gegen den oben verglichen wurde.
    // Wechsel und Audit-Eintrag in EINER Transaktion (kein await darin).
    inTransaction(() => {
      const info = db
        .prepare(
          'UPDATE users SET password_hash = ?, must_change_password = 0, sessions_valid_from = ? WHERE id = ? AND password_hash = ?',
        )
        .run(newHash, validFrom, req.user.id, row.password_hash);
      if (info.changes === 0) {
        // Die Zeile hat sich zwischenzeitlich geändert: Das eben geprüfte
        // "aktuelle Passwort" ist damit nicht mehr das aktuelle.
        throw badRequest('Das aktuelle Passwort ist falsch');
      }
      audit(req, 'passwort_geaendert', 'user', req.user.id);
    });

    // Frisches Token mitliefern: Das alte ist durch sessions_valid_from soeben
    // entwertet worden. Clients, die es übernehmen, bleiben angemeldet; alle
    // anderen Sitzungen desselben Kontos sind ausgeloggt.
    // Das neue Token trägt ausdrücklich iat = validFrom, sonst würde es die
    // eigene Sperre verletzen (siehe nextSessionsValidFrom).
    const user: AuthUser = {
      id: req.user.id,
      email: row.email,
      name: req.user.name,
      role: req.user.role,
      employee_id: req.user.employee_id ?? null,
      admin_role_id: req.user.admin_role_id ?? null,
      must_change_password: 0,
      iat: validFrom,
    };
    // Dieselbe Sitzungsart wie das vorgelegte Token, samt ihrer Laufzeit. Wer
    // das aktuelle Passwort kennt, hat sich neu angemeldet: Die Sitzung
    // beginnt hier (auth_time).
    return { ok: true, token: signToken(app, user, sessionFor(req.user.session, req.user.role), validFrom) };
  });
}
