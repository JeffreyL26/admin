import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { config } from '../config.js';
import { AppError, parse, unauthorized, badRequest } from './errors.js';
import { permissionsFor } from './permissions.js';
import { audit } from './audit.js';
import { getSetting } from './settings.js';

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
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('hrmonic-nicht-vergeben', 10);

function signToken(app: FastifyInstance, user: AuthUser): Promise<string> {
  return Promise.resolve(
    (app as FastifyInstance & { jwt: { sign: (p: AuthUser) => string } }).jwt.sign(user),
  );
}

/**
 * Zeitpunkt, ab dem neu ausgestellte Tokens gelten sollen (Unix-SEKUNDEN).
 *
 * Warum +1 und nicht "jetzt": Das JWT-Feld `iat` hat nur Sekundenauflösung.
 * Setzte ein Passwortwechsel `sessions_valid_from` auf die LAUFENDE Sekunde,
 * bliebe jedes Token gültig, das in derselben Sekunde ausgestellt wurde
 * (der Hook prüft `iat < sessions_valid_from`) — und zwar für die volle
 * Token-Laufzeit. "Anmelden, Passwort wechseln, altes Token weiterbenutzen"
 * funktionierte damit nachweislich. Erst die nächste Sekunde ist eindeutig
 * größer als jedes bereits ausgestellte `iat`.
 *
 * Damit dabei niemand ausgesperrt wird, tragen frisch ausgestellte Tokens
 * ausdrücklich dieses `iat` (siehe issueIat) statt der laufenden Sekunde.
 */
export function nextSessionsValidFrom(): number {
  return Math.floor(Date.now() / 1000) + 1;
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
 *   - mit HRMONIC_INITIAL_ADMIN_PASSWORD: bewusste Betreibervorgabe (z. B. aus
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
  ).run('admin@hrmonic.de', 'HR Administrator', bcrypt.hashSync(password, 10), provided ? 0 : 1);

  if (provided) return;

  let fileHint = `Datei: ${config.initialPasswordPath}`;
  try {
    // mode 0600 wie secret.key — die Datei steht im Datenverzeichnis, das auf
    // einem Server auch dem Backup-Agenten und dem Monitoring offensteht.
    fs.writeFileSync(config.initialPasswordPath, `${password}\n`, { mode: 0o600 });
  } catch (err) {
    fileHint = `Datei konnte nicht geschrieben werden (${String(err)}) — bitte JETZT notieren.`;
  }

  // Bewusst console.log statt Logger: Der Logger existiert zu diesem Zeitpunkt
  // noch nicht (ensureDefaultAdmin läuft vor der Fastify-Instanz) und die
  // Ausgabe soll auch bei Loglevel 'warn' im Journal landen.
  console.log(
    [
      '',
      '='.repeat(72),
      'HRMONIC: Erstinbetriebnahme — Standard-Admin angelegt',
      '  Benutzer: admin@hrmonic.de',
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
 * die DoS-Wirkung: bcryptjs rechnet synchron ~65 ms und blockiert dabei den
 * einzigen Node-Prozess samt Portal und allen Desktop-Arbeitsplätzen.
 */
const MAX_FAILURES_PER_IP = 50;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Fehlversuche als Zeitstempel je Schlüssel. Bewusst im Speicher und nicht in
 * der Datenbank: Es läuft genau ein Backend-Prozess (better-sqlite3), die
 * Sperre darf einen Neustart überleben müssen — ein Neustart ist kein
 * Angriffswerkzeug — und ein Schreibzugriff je Fehlversuch wäre selbst ein
 * DoS-Hebel.
 */
const loginFailures = new Map<string, number[]>();

function normalizedEmail(body: unknown): string | null {
  const value = (body as { email?: unknown } | null | undefined)?.email;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
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
 * preHandler der Login-Route: läuft VOR dem bcrypt-Vergleich im Handler. Das
 * ist kein Detail — genau dieser Vergleich blockiert den Event-Loop, eine
 * Prüfung danach würde die DoS-Wirkung nicht entschärfen.
 */
async function throttleLogin(req: FastifyRequest): Promise<void> {
  const now = Date.now();
  for (const [key, limit] of throttleKeys(req)) {
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
}

/**
 * Fehlversuchs-Schlüssel für den Passwortwechsel — gleiche Mechanik und Map
 * wie beim Login, aber pro Konto-ID: Die Route ist nur angemeldet erreichbar,
 * der Absender ist also bereits ein konkretes Konto (bzw. dessen abgegriffenes
 * Token, das das Passwort selbst nicht kennt). Ohne Schranke ließe sich das
 * aktuelle Passwort unbegrenzt durchprobieren und der bcrypt-Vergleich als
 * Event-Loop-DoS gegen alle Arbeitsplätze samt Portal missbrauchen.
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
  if (countFailures(pwChangeKey(req.user.id), Date.now()) < MAX_FAILURES_PER_EMAIL) return;
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
    'hrmonic',
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
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref?.();
  app.addHook('onClose', async () => clearInterval(cleanup));

  app.post(
    '/api/auth/login',
    { config: { public: true }, preHandler: throttleLogin },
    async (req) => {
      const body = parse(
        z.object({ email: z.string().email(), password: z.string().min(1) }),
        req.body,
      );
      const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(body.email) as
        | (AuthUser & { password_hash: string; sessions_valid_from: number | null })
        | undefined;

      // Immer vergleichen — auch gegen den Dummy-Hash, wenn es das Konto nicht
      // gibt (siehe DUMMY_PASSWORD_HASH: sonst verrät die Antwortzeit, welche
      // E-Mail-Adressen existieren).
      const passwordMatches = bcrypt.compareSync(
        body.password,
        row?.password_hash ?? DUMMY_PASSWORD_HASH,
      );

      if (!row || !passwordMatches) {
        const now = Date.now();
        for (const [key, limit] of throttleKeys(req)) noteFailure(key, limit, now);
        req.log.warn(
          { ip: req.ip, email: normalizedEmail(req.body) },
          'Anmeldung fehlgeschlagen',
        );
        // Audit ohne req.user (core/audit.ts verträgt das) — im Serverbetrieb
        // ist das die einzige dauerhafte Spur eines Angriffsversuchs.
        audit(req, 'login_fehlgeschlagen', 'user', row?.id, {
          email: normalizedEmail(req.body),
          ip: req.ip,
        });
        throw unauthorized('E-Mail oder Passwort ist falsch');
      }

      clearFailuresForAccount(req);
      const user: AuthUser = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        employee_id: row.employee_id ?? null,
        admin_role_id: row.admin_role_id ?? null,
        must_change_password: row.must_change_password ?? 0,
      };
      // iat ausdrücklich setzen: liegt sessions_valid_from (z. B. durch ein
      // administratives Zurücksetzen in derselben Sekunde) in der Zukunft,
      // wäre ein Token mit der laufenden Sekunde sofort wieder ungültig.
      const token = await signToken(app, {
        ...user,
        iat: issueIat(row.sessions_valid_from),
      });
      audit(req, 'login', 'user', row.id, { ip: req.ip });
      // Die Rechte reisen mit der Antwort, damit die Oberfläche gesperrte
      // Bereiche gar nicht erst anbietet. Sie sind reine Anzeigehilfe — die
      // Durchsetzung passiert ausschließlich im Hook (core/permissions.ts).
      return { token, user, permissions: permissionsFor(user.admin_role_id) };
    },
  );

  app.get('/api/auth/me', async (req) => ({
    user: req.user,
    permissions: permissionsFor(req.user.admin_role_id),
  }));

  app.put('/api/auth/password', { preHandler: throttlePasswordChange }, async (req) => {
    const body = parse(
      // Regeln bewusst nicht im Schema — siehe assertPasswordAcceptable.
      z.object({ currentPassword: z.string(), newPassword: z.string() }),
      req.body,
    );
    const db = getDb();
    const row = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(req.user.id) as
      | { email: string; password_hash: string }
      | undefined;
    // Auch hier gegen den Dummy-Hash vergleichen, damit ein zwischenzeitlich
    // gelöschtes Konto nicht an der Antwortzeit erkennbar ist. Asynchrone
    // bcrypt-API: compareSync würde die volle Rechenzeit (~65 ms) am Stück im
    // einzigen Node-Prozess verbringen — bcryptjs zerlegt die Arbeit asynchron
    // in Event-Loop-Häppchen, dazwischen kommen andere Requests zum Zug.
    const currentMatches = await bcrypt.compare(
      body.currentPassword,
      row?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!row || !currentMatches) {
      // Nur der falsche aktuelle Passwort-Versuch zählt — Verstöße gegen die
      // Passwortregeln weiter unten sperrten sonst legitime Nutzer aus, die
      // mehrfach an der Richtlinie scheitern.
      noteFailure(pwChangeKey(req.user.id), MAX_FAILURES_PER_EMAIL, Date.now());
      req.log.warn({ userId: req.user.id }, 'Passwortwechsel fehlgeschlagen');
      // Wie beim Login: im Serverbetrieb die einzige dauerhafte Spur, wenn
      // jemand mit einem abgegriffenen Token das Passwort durchprobiert.
      audit(req, 'passwortwechsel_fehlgeschlagen', 'user', req.user.id, { ip: req.ip });
      throw badRequest('Das aktuelle Passwort ist falsch');
    }
    loginFailures.delete(pwChangeKey(req.user.id));
    assertPasswordAcceptable(body.newPassword, row.email);
    if (await bcrypt.compare(body.newPassword, row.password_hash)) {
      throw badRequest('Das neue Passwort muss sich vom bisherigen unterscheiden');
    }
    const newHash = await bcrypt.hash(body.newPassword, 10);

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
    const info = db
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0, sessions_valid_from = ? WHERE id = ? AND password_hash = ?',
      )
      .run(newHash, validFrom, req.user.id, row.password_hash);
    if (info.changes === 0) {
      // Die Zeile hat sich zwischenzeitlich geändert — das eben geprüfte
      // "aktuelle Passwort" ist damit nicht mehr das aktuelle.
      throw badRequest('Das aktuelle Passwort ist falsch');
    }
    audit(req, 'passwort_geaendert', 'user', req.user.id);

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
    return { ok: true, token: await signToken(app, user) };
  });
}
