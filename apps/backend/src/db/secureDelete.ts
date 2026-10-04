/**
 * secure_delete = ON: SQLite überschreibt gelöschte Zellen und jede frei
 * werdende Seite mit Nullen. Jede Verbindung über openDatabase hat es gesetzt
 * (configureConnection in db/encryption.ts); das ist die eigentliche
 * Garantie.
 *
 * Hängt an nichts (kein db.js, kein config.ts), damit auch migrateDatabase
 * und die Betreiberwerkzeuge es nutzen dürfen.
 */
import type Database from 'better-sqlite3';

/**
 * Bricht ab, wenn die Verbindung secure_delete nicht auf ON hat. Für Stellen,
 * deren Zweck daran hängt (Umfragedaten) und die nur über openDatabase
 * geöffnete Verbindungen bekommen sollten: Ein Lesen kostet weniger als
 * Setzen und Zurückstellen bei jedem Aufruf, und eine an configureConnection
 * vorbei geöffnete Verbindung fällt laut auf statt still Reste zu lassen.
 * (FAST, Wert 2, nullt frei werdende Seiten nicht und genügt nicht.)
 */
export function assertSecureDelete(db: Database.Database): void {
  if (db.pragma('secure_delete', { simple: true }) !== 1) {
    throw new Error('Diese Verbindung löscht ohne secure_delete; sie muss über openDatabase geöffnet sein (db/encryption.ts).');
  }
}

/**
 * Führt fn mit secure_delete = ON aus und stellt den vorigen Wert danach
 * wieder her. Für Funktionen, die auf BELIEBIGEN Verbindungen laufen
 * (migrateDatabase, rebuildTableInKeyOrder, die Füllung der -shm).
 */
export function withSecureDelete<T>(db: Database.Database, fn: () => T): T {
  const previous = db.pragma('secure_delete', { simple: true }) as number;
  db.pragma('secure_delete = ON');
  try {
    return fn();
  } finally {
    // 2 heisst FAST und lässt sich nur als Wort setzen.
    db.pragma(`secure_delete = ${previous === 2 ? 'FAST' : previous}`);
  }
}
