import Database from 'better-sqlite3';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Das Backup-Skript (scripts/backup.ts, systemd-Timer) öffnet im laufenden
    // Betrieb eine zweite Verbindung auf dieselbe Datenbank. Kollidiert ein
    // WAL-Checkpoint mit deren Snapshot, soll er kurz warten statt sofort mit
    // SQLITE_BUSY zu scheitern — explizit gesetzt statt auf die Vorgabe von
    // better-sqlite3 zu vertrauen.
    db.pragma('busy_timeout = 5000');
    // synchronous = FULL statt der WAL-Vorgabe NORMAL: NORMAL überlebt zwar
    // einen Absturz des Prozesses, aber NICHT den Verlust der Stromversorgung
    // oder einen Hypervisor-Absturz — dabei können bereits BESTÄTIGTE
    // Transaktionen seit dem letzten Checkpoint verloren gehen, weil das WAL
    // nicht auf die Platte durchgeschrieben war. Für Personalstammdaten,
    // Abwesenheitsentscheide und Gehaltsänderungen ist das nicht hinnehmbar:
    // Es fehlte still genau das, was Nutzer zuletzt als gespeichert gesehen
    // haben. Der Preis ist ein fsync je Commit — bei dieser Datenmenge und
    // Schreibrate (einzelne Formularspeicherungen, kein Massenimport)
    // vernachlässigbar.
    db.pragma('synchronous = FULL');
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
