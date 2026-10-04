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
import { withSecureDelete } from './secureDelete.js';
import { tableExists } from './tableExists.js';
import { errorText } from '../core/errorText.js';

export interface MigrateOptions {
  /** Empfängt Warnungen, die den Lauf nicht abbrechen (gescheitertes VACUUM). */
  onWarning?: (message: string) => void;
  /**
   * false: kein VACUUM nach Migrationen mit `vacuumAfter` und kein Vermerk
   * dafür. Nur für Wegwerfkopien (Probelauf in scripts/migrate-check.ts): Dort
   * kostete das VACUUM eine zweite volle Kopie (verschlüsselt im
   * Arbeitsspeicher, im Klartext in <dataDir>/.sqlite-tmp, configureConnection
   * in db/encryption.ts) für ein Ergebnis, das niemand liest.
   */
  vacuum?: boolean;
}

/**
 * Obergrenze der Nutzdaten für das VACUUM nach Migrationen, wenn seine Kopie
 * im Arbeitsspeicher entsteht (verschlüsselte Datenbank: temp_store = MEMORY,
 * weil SQLite die Kopie sonst unverschlüsselt in eine Hilfsdatei schreibt;
 * configureConnection in db/encryption.ts). Gemessen braucht es das
 * 1,5-Fache der Nutzdaten (62 MB Spitze für 41 MB). Die Hosting-Unit drosselt
 * ab MemoryHigh=512M und beendet ab MemoryMax=768M, bei rund 60 MB
 * Grundbedarf: (512 - 60) / 1,5 ergibt rund 300 MB, darunter bleibt das
 * VACUUM unter der Drosselung. Darüber wird es übersprungen (Warnung bei
 * jedem Start), statt den ersten Start zu drosseln oder den Dienst in einen
 * Neustart nach dem anderen zu schicken. Was die Migration selbst entfernt
 * hat, ist dann trotzdem genullt (secure_delete, siehe migrateDatabase).
 */
const VACUUM_IN_MEMORY_LIMIT_BYTES = 300 * 1024 * 1024;

/**
 * Derselbe Lauf auf einer BELIEBIGEN Datenbank, nicht nur auf der des
 * Prozesses. Das braucht der Probelauf vor einem Update
 * (scripts/migrate-check.ts): Er legt eine Kopie an und migriert die, um zu
 * sehen, ob es durchlaeuft, ohne die Kundendatenbank anzufassen. Rueckgabe
 * sind die Namen der angewendeten Migrationen, in der Reihenfolge, in der
 * sie liefen.
 */
export function migrateDatabase(db: BetterSqlite3.Database, options: MigrateOptions = {}): string[] {
  const { onWarning, vacuum = true } = options;
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
  //
  // Unter secure_delete: Was eine Migration löscht (DROP TABLE, DELETE),
  // überschreibt SQLite dabei mit Nullen, statt es in freien Seiten und
  // Zellenlücken stehen zu lassen. NICHT erfasst sind Kopien, die beim
  // Verschieben von Zellen zwischen Seiten in deren Lücken bleiben (DROP
  // COLUMN, UPDATE, Einfügen ausser der Reihe); eine Migration, die dabei
  // schutzwürdige Inhalte entfernt, baut die Tabelle danach mit
  // rebuildTableInKeyOrder neu auf (DROP TABLE und frisch befüllen, Vorbild
  // 502_survey_anonymity). Dann ist das VACUUM
  // danach (vacuumAfter) für ihre eigenen Daten nicht nötig und räumt nur
  // noch ältere Reste weg; fällt es aus (zu gross, gescheitert), sind die
  // Daten der Migration trotzdem weg (nachgestellt mit 502/503: ohne VACUUM
  // keine alten Zeitstempel in der Datei, encryptionSmoke.ts Abschnitt 7).
  // Migrationen, die nichts löschen oder umschreiben, kostet es kaum etwas.
  const done: string[] = [];
  withSecureDelete(db, () => db.transaction(() => {
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
      m.run?.(db);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(m.name);
      done.push(m.name);
    }
    // Ausstehendes VACUUM im selben Commit vermerken: Scheitert es nach dem
    // Commit, holt es jeder spätere Start nach.
    if (vacuum && pending.some((m) => m.vacuumAfter)) {
      db.exec("CREATE TABLE IF NOT EXISTS _vacuum_pending (since TEXT NOT NULL DEFAULT (datetime('now')))");
      db.prepare('INSERT INTO _vacuum_pending DEFAULT VALUES').run();
    }
  }).immediate());

  // VACUUM geht nicht innerhalb einer Transaktion, deshalb erst nach dem
  // Commit. Es darf den Start nicht verhindern (Platz, Speicher, eine andere
  // Verbindung hält die Datenbank): Das Schema ist fertig migriert, nur die
  // entfernten Inhalte stehen dann weiter in freien Seiten, bis ein späterer
  // Start das VACUUM schafft. Erst danach fällt der Vermerk weg.
  const vacuumPending =
    vacuum &&
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_vacuum_pending'").get();
  if (vacuumPending) {
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const usedBytes =
      ((db.pragma('page_count', { simple: true }) as number) - (db.pragma('freelist_count', { simple: true }) as number)) *
      pageSize;
    if (db.pragma('temp_store', { simple: true }) === 2 && usedBytes > VACUUM_IN_MEMORY_LIMIT_BYTES) {
      // Endgültig: Die Grösse ändert sich nicht von selbst, und an diesem
      // VACUUM hängt keine Zusicherung (die Daten der Migrationen selbst sind
      // genullt, siehe oben). Eine Warnung bei jedem Start sagte nichts Neues.
      db.exec('DROP TABLE _vacuum_pending');
      onWarning?.(
        `VACUUM nach einer Migration übersprungen: Die Datenbank hält ${Math.round(usedBytes / 1048576)} MB Nutzdaten, ` +
          `der Neuaufbau im Arbeitsspeicher ist bis ${VACUUM_IN_MEMORY_LIMIT_BYTES / 1048576} MB vorgesehen. ` +
          'Was die Migrationen entfernt haben, ist genullt; ältere Reste stehen weiter in freien Bereichen der verschlüsselten Datei.',
      );
      return done;
    }
    let vacuumed = false;
    try {
      db.exec('VACUUM');
      vacuumed = true;
      // Im WAL-Modus landet das VACUUM nur im -wal; in der Datenbankdatei
      // stehen die alten Seiten, bis ein Checkpoint sie überschreibt. Hält ein
      // Leser (Sicherung) seinen Stand, meldet der Checkpoint busy, ohne zu
      // werfen: Dann steht nur noch der Checkpoint aus, nicht das VACUUM
      // (_vacuum_checkpoint_pending, unten), und der nächste Start holt nur
      // ihn nach.
      if (checkpointTruncate(db)) db.exec('DROP TABLE _vacuum_pending');
      else {
        db.transaction(() => {
          db.exec('DROP TABLE _vacuum_pending');
          db.exec(`CREATE TABLE IF NOT EXISTS ${CHECKPOINT_PENDING} (x INTEGER PRIMARY KEY CHECK (x = 1))`);
          db.exec(`INSERT OR IGNORE INTO ${CHECKPOINT_PENDING} (x) VALUES (1)`);
        })();
        onWarning?.(checkpointWarning);
      }
    } catch (err) {
      onWarning?.(
        vacuumed
          ? `Nach dem VACUUM einer Migration ist der Vermerk nicht fortgeschrieben (${errorText(err)}); der nächste Start wiederholt das VACUUM.`
          : 'VACUUM nach einer Migration ist gescheitert; entfernte Daten stehen bis zum nächsten erfolgreichen ' +
              `Versuch noch in freien Seiten der Datenbankdatei. Der nächste Start versucht es erneut (${errorText(err)}).`,
      );
    }
    return done;
  }
  // Nur der Checkpoint nach einem gelungenen VACUUM steht aus.
  if (vacuum && tableExists(db, CHECKPOINT_PENDING)) {
    try {
      if (checkpointTruncate(db)) db.exec(`DROP TABLE ${CHECKPOINT_PENDING}`);
      else onWarning?.(checkpointWarning);
    } catch (err) {
      onWarning?.(`${checkpointWarning} (${errorText(err)})`);
    }
  }
  return done;
}

/** Vermerk: Das VACUUM nach einer Migration ist gelungen, sein Checkpoint steht aus. */
const CHECKPOINT_PENDING = '_vacuum_checkpoint_pending';

const checkpointWarning =
  'Nach dem VACUUM einer Migration ist der Checkpoint blockiert (eine andere Verbindung liest noch); bis er gelingt, ' +
  'stehen entfernte Daten noch in freien Seiten der Datenbankdatei. Der nächste Start holt nur den Checkpoint nach.';

/** TRUNCATE-Checkpoint; true, wenn er durchkam (oder kein WAL im Spiel ist). */
function checkpointTruncate(db: BetterSqlite3.Database): boolean {
  if (db.pragma('journal_mode', { simple: true }) !== 'wal') return true;
  const [result] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
  return !result?.busy;
}
