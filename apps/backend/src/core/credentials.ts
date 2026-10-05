/**
 * Ausgegebene Passwörter: die EINZIGE Stelle, die ein Passwort erzeugt und
 * speichert, das jemand anderes als die Person hinter dem Konto im Klartext
 * bekommt (Konto anlegen, Passwort zurücksetzen, Betreiberwerkzeug
 * `admin-reset`).
 *
 * Wer ein Passwort ausgibt, kennt es, bis die Person es selbst ändert, und
 * kann nicht nachweisen, dass sie das getan hat: Ein eigens angelegtes Konto
 * ändert sein Passwort auch selbst. Deshalb merkt sich das Konto die RECHTE
 * der ausgebenden Person zum Zeitpunkt der Ausgabe
 * (`users.credentials_issuer_rights`). Später erhält das Konto mehr Rechte nur,
 * wenn diese Person sie auch hatte (core/accountRights.ts,
 * `assertCredentialsCover`); sonst muss das Passwort vorher jemand neu
 * ausgeben, der sie hat.
 *
 * Kein Import von db.js und config.ts: Die Betreiberwerkzeuge
 * (scripts/toolkit.ts) schreiben über dieselbe Funktion und dürfen beides nicht
 * laden. Die Datenbank kommt deshalb als Parameter.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import { ADMIN_AREAS, PERMISSION_LEVELS, type AdminPermissions, type PermissionLevel } from '@ohrganize/shared';
import { hashPassword } from './passwordHashing.js';

/**
 * Zeitpunkt, ab dem neu ausgestellte Tokens gelten sollen (Unix-SEKUNDEN).
 *
 * Warum +1 und nicht "jetzt": Das JWT-Feld `iat` hat nur Sekundenauflösung.
 * Setzte ein Passwortwechsel `sessions_valid_from` auf die LAUFENDE Sekunde,
 * bliebe jedes Token gültig, das in derselben Sekunde ausgestellt wurde
 * (der Hook prüft `iat < sessions_valid_from`), und zwar für die volle
 * Token-Laufzeit. "Anmelden, Passwort wechseln, altes Token weiterbenutzen"
 * funktionierte damit nachweislich. Erst die nächste Sekunde ist eindeutig
 * größer als jedes bereits ausgestellte `iat`.
 *
 * Damit dabei niemand ausgesperrt wird, tragen frisch ausgestellte Tokens
 * ausdrücklich dieses `iat` (siehe issueIat in auth.ts) statt der laufenden
 * Sekunde.
 */
export function nextSessionsValidFrom(): number {
  return Math.floor(Date.now() / 1000) + 1;
}

/**
 * Erstpasswort: 12 zufällige Bytes (96 Bit) als base64url, 16 Zeichen, in
 * jeder Umgebung ohne Kodierungsfragen weiterzugeben (keine Zeichen, die eine
 * Shell interpretiert). Es wird nur gehasht gespeichert und genau einmal
 * ausgegeben; erraten lässt es sich nicht, und die Zeit bis zum erzwungenen
 * Wechsel ist kurz.
 */
export function generateInitialPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/** Erstpasswort samt Hash, vorab erzeugt (prepareIssuedPassword). */
export interface PreparedPassword {
  password: string;
  hash: string;
}

/**
 * Erstpasswort erzeugen und im Worker-Pool hashen (core/passwordHashing.ts),
 * ohne den Event-Loop für ~65 ms zu blockieren. Für Routen: VOR den
 * maßgeblichen Prüfungen aufrufen und das Ergebnis an storeIssuedPassword
 * geben. So liegt zwischen Rechteprüfung und Schreiben kein await, und beides
 * bleibt wie bisher ein ununterbrochener Ablauf (auch innerhalb einer
 * Transaktion). Billige Vorprüfungen davor sind erwünscht: Eine abgewiesene
 * Anfrage soll keinen bcrypt-Lauf im gemeinsamen Worker-Pool kosten; gelten
 * muss aber die Wiederholung nach dem await.
 */
export async function prepareIssuedPassword(): Promise<PreparedPassword> {
  const password = generateInitialPassword();
  return { password, hash: await hashPassword(password, 10) };
}

/**
 * Neues Passwort für ein bestehendes Konto erzeugen und speichern: Wechsel
 * beim nächsten Login erzwingen, alle laufenden Sitzungen entwerten (wer ein
 * Passwort neu ausgibt, weiß selten, warum es nötig wurde) und die Rechte der
 * ausgebenden Person festhalten. `issuerRights` null heißt Vollzugriff: ein
 * Konto ohne Admin-Rolle oder der Betreiber, der ohnehin die Datenbank in der
 * Hand hat. Liefert das Passwort im Klartext, genau einmal; es darf weder ins
 * Audit-Log noch in ein Log.
 *
 * `prepared` kommt aus prepareIssuedPassword (Routen); ohne ihn wird synchron
 * gehasht (Betreiberwerkzeuge, die keinen Event-Loop mit anderen teilen).
 */
export function storeIssuedPassword(
  db: Database.Database,
  userId: number,
  issuerRights: AdminPermissions | null,
  prepared?: PreparedPassword,
): string {
  const password = prepared?.password ?? generateInitialPassword();
  const hash = prepared?.hash ?? bcrypt.hashSync(password, 10);
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, sessions_valid_from = ?,
       credentials_issuer_rights = ? WHERE id = ?`,
  ).run([
    hash,
    nextSessionsValidFrom(),
    issuerRights === null ? null : JSON.stringify(issuerRights),
    userId,
  ]);
  return password;
}

/**
 * Gespeicherte Rechte der ausgebenden Person lesen. null heißt Vollzugriff
 * (siehe oben; so auch alle Konten aus der Zeit vor der Spalte). Ein Bereich,
 * den es bei der Ausgabe noch nicht gab, zählt als `kein`: Die Person hatte
 * ihn damals nicht.
 */
export function parseIssuerRights(raw: string | null): AdminPermissions | null {
  if (raw === null) return null;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Unlesbar heißt: nichts nachweisbar, also keine Rechte.
  }
  return Object.fromEntries(
    ADMIN_AREAS.map((a) => {
      const level = parsed[a];
      return [a, (PERMISSION_LEVELS as readonly unknown[]).includes(level) ? (level as PermissionLevel) : 'kein'];
    }),
  ) as AdminPermissions;
}
