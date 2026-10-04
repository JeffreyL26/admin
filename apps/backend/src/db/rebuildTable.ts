/**
 * Baut eine Tabelle neu auf, ohne dass alte Inhalte in ihren Seiten stehen
 * bleiben, und legt die Zeilen in Schlüsselreihenfolge ab. Innerhalb einer
 * Transaktion aufrufen.
 *
 * Wozu: Werden Zellen zwischen Seiten verschoben (Einfügen ausser der Reihe,
 * Umschreiben von Zeilen), bleiben Kopien in den unbelegten Lücken der Seiten
 * stehen; secure_delete erfasst diese Lücken nicht. Erst wenn die Seiten
 * selbst frei werden, nullt secure_delete sie ganz.
 *
 * Wie: alle Zeilen in eine temporäre Tabelle, die Tabelle mit DROP TABLE
 * entfernen (unter secure_delete werden dabei ALLE ihre Seiten genullt,
 * auch die Wurzel), mit ihrer gespeicherten Definition neu anlegen, die
 * Zeilen in rowid-Reihenfolge zurückschreiben, Indizes und Trigger wieder
 * anlegen und den AUTOINCREMENT-Zähler erhalten. NICHT mit DELETE FROM:
 * Bei eingeschalteten Fremdschlüsseln (im Dienst immer, in diesem
 * SQLite-Build sogar die Vorgabe) löscht SQLite Zeile für Zeile, die
 * Wurzelseite wird nie frei, und ein Rest in ihrer Lücke blieb stehen
 * (nachgestellt).
 *
 * Nur für Tabellen, deren rowid eine INTEGER PRIMARY KEY-Spalte ist: Die
 * Kopie über `SELECT *` trägt dann die rowid mit; eine verborgene rowid ginge
 * verloren und würde neu vergeben (WITHOUT ROWID-Tabellen haben keine). Und
 * nur für Tabellen, auf die kein Fremdschlüssel zeigt: Bei einer solchen
 * löste DROP TABLE die Kaskaden ihrer Kindtabellen aus. Beides prüft die
 * Funktion und verweigert sonst. Für eine solche Tabelle löscht DROP TABLE
 * auch bei eingeschalteten Fremdschlüsseln nicht vorher Zeile für Zeile
 * (sqlite3FkDropTable kehrt ohne Code zurück, solange keiner ihrer eigenen
 * Fremdschlüssel verzögert ist), es gibt nur die Seiten frei.
 *
 * Hängt an nichts ausser better-sqlite3 (kein db.js, kein config.ts).
 */
import type Database from 'better-sqlite3';
import { withSecureDelete } from './secureDelete.js';

const TEMP_COPY = '_table_rebuild_copy';

export function rebuildTableInKeyOrder(db: Database.Database, table: string): void {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const definition = db.prepare("SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  if (!definition) throw new Error(`Tabelle ${table} gibt es nicht.`);
  // rowid-Alias: genau eine Schlüsselspalte vom Typ INTEGER und kein Index
  // für den Primärschlüssel (den haben WITHOUT ROWID-Tabellen und jeder
  // andere Primärschlüssel, auch INTEGER PRIMARY KEY DESC).
  const keyColumns = db.prepare('SELECT type FROM pragma_table_info(?) WHERE pk > 0').all(table) as { type: string }[];
  const keyIndex = db.prepare("SELECT 1 AS x FROM pragma_index_list(?) WHERE origin = 'pk'").get(table);
  if (keyColumns.length !== 1 || keyColumns[0].type.toUpperCase() !== 'INTEGER' || keyIndex) {
    throw new Error(`Tabelle ${table} hat keine INTEGER PRIMARY KEY-Spalte als rowid; ihre rowids gingen beim Neuaufbau verloren.`);
  }
  const referenced = db
    .prepare(
      "SELECT 1 AS x FROM main.sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"table\" = ? COLLATE NOCASE",
    )
    .get(table);
  if (referenced) throw new Error(`Auf ${table} zeigen Fremdschlüssel; DROP TABLE löste deren Kaskaden aus.`);
  const extras = db
    .prepare("SELECT sql FROM main.sqlite_master WHERE tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid")
    .all(table) as { sql: string }[];
  const hasSequenceTable =
    db.prepare("SELECT 1 AS x FROM main.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== undefined;
  const sequence = hasSequenceTable
    ? (db.prepare('SELECT seq FROM main.sqlite_sequence WHERE name = ?').get(table) as { seq: number } | undefined)
    : undefined;

  withSecureDelete(db, () => {
    db.exec(`DROP TABLE IF EXISTS temp.${TEMP_COPY}`);
    db.exec(`CREATE TEMP TABLE ${TEMP_COPY} AS SELECT * FROM main.${quoted} ORDER BY rowid`);
    db.exec(`DROP TABLE main.${quoted}`);
    db.exec(definition.sql);
    // rowid der Kopie = Reihenfolge nach rowid der Tabelle (so eingefügt), ohne Sortierung.
    db.exec(`INSERT INTO main.${quoted} SELECT * FROM temp.${TEMP_COPY} ORDER BY rowid`);
    db.exec(`DROP TABLE temp.${TEMP_COPY}`);
    for (const extra of extras) db.exec(extra.sql);
    if (sequence) {
      // Das Einfügen setzt den Zähler auf die grösste rowid; vorher kann er höher gestanden haben.
      const updated = db.prepare('UPDATE main.sqlite_sequence SET seq = max(seq, ?) WHERE name = ?').run(sequence.seq, table);
      if (updated.changes === 0) db.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)').run(table, sequence.seq);
    }
  });
}
