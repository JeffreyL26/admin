import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
  /** Eindeutig, sortierbar, z. B. "100_employees_core". Nummernkreis siehe migrate.ts. */
  name: string;
  sql: string;
  /**
   * Schritt in TypeScript nach `sql`, in derselben Transaktion des
   * Migrationslaufs (migrateDatabase). Für das, was sich in SQL nicht sauber
   * ausdrücken lässt, vor allem den Neuaufbau einer Tabelle ohne Reste
   * (db/rebuildTable.ts#rebuildTableInKeyOrder). Darf keine eigene
   * Transaktion beginnen und nichts ausserhalb der Datenbank tun.
   */
  run?: (db: BetterSqlite3.Database) => void;
  /**
   * Nach dem Commit einmal VACUUM ausführen (räumt ältere Reste aus freien
   * Bereichen der Datei). Jede Migration läuft unter secure_delete: Was DROP
   * TABLE und DELETE freigeben, ist ohnehin genullt. NICHT erfasst sind
   * Kopien in Seitenlücken beim Umschreiben an Ort und Stelle (DROP COLUMN,
   * UPDATE) und die Wurzelseite einer mit DELETE geleerten Tabelle; eine
   * Migration, die schutzwürdige Inhalte entfernt, baut die Tabelle deshalb
   * mit rebuildTableInKeyOrder neu auf (über `run`, Vorbild
   * 502_survey_anonymity). Dann hängt nichts am VACUUM, das ab 300 MB
   * Nutzdaten entfällt.
   */
  vacuumAfter?: boolean;
}
