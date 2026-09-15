/**
 * Migrationslauf auf einer BELIEBIGEN Datenbank.
 *
 * Diese Datei haengt bewusst an NICHTS ausser den Migrationen selbst: kein
 * db.js, kein config.ts. Sonst legte schon der Import eines Betreiberwerkzeugs
 * (scripts/migrate-check.ts) Verzeichnisse und ein secret.key an, und zwar mit
 * den Rechten des aufrufenden Kontos. Der Probelauf vor einem Update braucht
 * genau diesen Lauf auf einer KOPIE, ohne die Kundendatenbank anzufassen.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { allMigrations } from './migrations/index.js';

/**
 * Derselbe Lauf auf einer BELIEBIGEN Datenbank, nicht nur auf der des
 * Prozesses. Das braucht der Probelauf vor einem Update
 * (scripts/migrate-check.ts): Er legt eine Kopie an und migriert die, um zu
 * sehen, ob es durchlaeuft, ohne die Kundendatenbank anzufassen. Rueckgabe
 * sind die Namen der angewendeten Migrationen, in der Reihenfolge, in der
 * sie liefen.
 */
export function migrateDatabase(db: BetterSqlite3.Database): string[] {
  const known = new Set(allMigrations.map((m) => m.name));

  // Der GESAMTE Lauf steckt in EINER Transaktion, die mit BEGIN IMMEDIATE
  // startet, inklusive CREATE TABLE _migrations und dem Lesen des
  // applied-Sets.
  //
  // Wogegen das schützt: Im Serverbetrieb können zwei Prozesse gleichzeitig
  // starten (Dienst-Neustart und ein manuell angestoßenes Skript, Dienst und
  // Seed, zwei systemd-Restarts nach einem Absturz). Vorher wurde das
  // applied-Set außerhalb jeder Transaktion gelesen und jede Migration einzeln
  // in einer DEFERRED-Transaktion ausgeführt: DEFERRED holt die Schreibsperre
  // erst beim ersten Schreibbefehl. Beide Prozesse lasen also dasselbe leere
  // Set, beide hielten dieselbe Migration für ausstehend, und der zweite
  // scheiterte an CREATE TABLE (die Migrations-SQL benutzt bewusst kein
  // IF NOT EXISTS), mit halb angewendetem Schema als Ergebnis.
  // IMMEDIATE holt die Schreibsperre sofort beim BEGIN; der zweite Prozess
  // wartet den busy_timeout ab (better-sqlite3: 5 s Vorgabe) und liest danach
  // den fertigen Stand. Alles-oder-nichts gilt jetzt für den gesamten Lauf:
  // Bricht eine Migration ab, bleibt die Datenbank auf dem Stand davor.
  const done: string[] = [];
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    const applied = new Set(
      (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
    );

    // Downgrade-Sperre: Enthält _migrations Namen, die dieser Build gar nicht
    // kennt, wurde die Datenbank von einer NEUEREN Version migriert. Bisher
    // lief die ältere Version dann stillschweigend gegen das neuere Schema
    // weiter, mit Spalten, die sie nicht kennt, und Annahmen, die nicht mehr
    // gelten (im Zweifel: falsche Daten statt Fehlermeldung). Migrationen sind
    // nicht rückwärtskompatibel, deshalb hier hart abbrechen: der Start
    // scheitert, systemd meldet den Dienst als fehlerhaft, und die IT spielt
    // die neuere Version oder ein Backup zurück (docs/inbetriebnahme.md).
    const unknown = [...applied].filter((name) => !known.has(name)).sort();
    if (unknown.length > 0) {
      throw new Error(
        'Die Datenbank wurde bereits von einer neueren oHRganize-Version migriert. ' +
          `Unbekannte Migrationen: ${unknown.join(', ')}. ` +
          'Diese Version darf nicht gegen dieses Schema laufen. Bitte die neuere ' +
          'Version wieder einspielen oder ein Backup zurückspielen (siehe docs/inbetriebnahme.md).',
      );
    }

    const pending = allMigrations
      .filter((m) => !applied.has(m.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const m of pending) {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(m.name);
      done.push(m.name);
    }
  }).immediate();
  return done;
}
