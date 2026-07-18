import Database from 'better-sqlite3';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/** Führt fn in einer Transaktion aus (Rollback bei Exception). */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
