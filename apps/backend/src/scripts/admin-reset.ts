/**
 * Passwort eines Kontos zuruecksetzen, wenn niemand mehr hineinkommt.
 *
 *   node apps/backend/dist/admin-reset.cjs --data-dir /var/lib/ohrganize/musterfirma \
 *        --email admin@ohrganize.de
 *
 * Setzt ein Zufallspasswort, erzwingt den Wechsel beim naechsten Login
 * (`must_change_password = 1`) und macht alle laufenden Sitzungen ungueltig
 * (`sessions_valid_from`): Wer bis eben mit dem alten Passwort angemeldet war,
 * fliegt heraus, denn beim Zuruecksetzen weiss niemand, warum es noetig wurde.
 * Geschrieben ueber dieselbe Funktion wie das Zuruecksetzen in der
 * Benutzerverwaltung (core/credentials.ts); als Aussteller gilt der Betreiber
 * mit Vollzugriff, er hat die Datenbank ohnehin in der Hand.
 *
 * Das neue Passwort erscheint GENAU EINMAL auf stdout und wird nirgends
 * gespeichert. Der Vorgang steht im `audit_log` mit `user_id NULL` (es gibt
 * keinen angemeldeten Benutzer, der ihn ausgeloest haette) und nennt den
 * Systembenutzer, der das Werkzeug ausgefuehrt hat.
 *
 * Die Instanz darf dabei laufen: SQLite im WAL-Modus laesst den Schreibvorgang
 * zu, und der Dienst liest Rolle und Sitzungsgueltigkeit bei jedem Request neu.
 *
 * Kein Import von config.ts (siehe toolkit.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { storeIssuedPassword } from '../core/credentials.js';
import { dataDirFrom, fail, parseArgs, refuseRoot, variantBanner } from './toolkit.js';

const { values } = parseArgs(process.argv.slice(2));
refuseRoot(
  'runuser -u ohrganize -- node /opt/ohrganize/apps/backend/dist/admin-reset.cjs --data-dir <pfad> --email <adresse>',
);
const paths = dataDirFrom(values['data-dir'], 'apps/backend/dist/admin-reset.cjs');
const email = (values.email ?? '').trim().toLowerCase();
if (!email) fail('--email fehlt. Beispiel: --email admin@ohrganize.de');
if (!fs.existsSync(paths.db)) fail(`${paths.db} existiert nicht (Instanz noch nie gestartet?).`);

const db = new Database(paths.db, { fileMustExist: true });

// storeIssuedPassword schreibt auch den Aussteller (Migration 005). Laeuft das
// Werkzeug nach einem Update vor dem ersten Start, fehlt die Spalte noch.
const userColumns = db.pragma('table_info(users)') as { name: string }[];
if (!userColumns.some((c) => c.name === 'credentials_issuer_rights')) {
  db.close();
  fail('Die Datenbank hat ausstehende Migrationen. Instanz einmal starten (oder migrate-check), dann erneut.');
}

const user = db.prepare('SELECT id, email, name, role FROM users WHERE lower(email) = ?').get(email) as
  | { id: number; email: string; name: string; role: string }
  | undefined;
if (!user) {
  const known = (db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY email").all() as {
    email: string;
  }[]).map((r) => r.email);
  db.close();
  fail(
    `Kein Konto mit der Adresse "${email}".` +
      (known.length > 0 ? ` Vorhandene Administrationskonten: ${known.join(', ')}` : ''),
  );
}

const operator = os.userInfo().username;

let password = '';
db.transaction(() => {
  password = storeIssuedPassword(db, user.id, null);
  db.prepare(
    "INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'user.password_reset', 'user', ?, ?)",
  ).run(
    user.id,
    JSON.stringify({
      email: user.email,
      via: 'admin-reset',
      system_user: operator,
      sessions_invalidated: true,
    }),
  );
}).immediate();

db.close();

console.log('');
console.log('='.repeat(72));
console.log(variantBanner());
console.log('Passwort zurueckgesetzt');
console.log(`  Konto:    ${user.email} (${user.name}, Rolle ${user.role})`);
console.log(`  Passwort: ${password}`);
console.log('  Es wird beim naechsten Login zwingend geaendert.');
console.log('  Alle bestehenden Sitzungen dieses Kontos sind ungueltig.');
console.log('  Das Passwort steht in keiner Datei. Jetzt weitergeben, dann dieses Fenster schliessen.');
console.log('='.repeat(72));
console.log('');
