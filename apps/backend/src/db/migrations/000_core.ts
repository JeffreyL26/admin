import type { Migration } from './types.js';

export const coreMigrations: Migration[] = [
  {
    name: '000_core',
    sql: `
      -- HR-Administrator:innen (Login in die Desktop-App). Normale Mitarbeitende
      -- bekommen erst mit dem Web-Client eigene Accounts.
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Generische Key-Value-Einstellungen (JSON-Werte), z. B. Firmendaten,
      -- Verfallsfrist Resturlaub, DATEV-Berater-/Mandantennummer.
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Generischer Datei-Storage. Fachliche Metadaten (Kategorie, Mitarbeiter,
      -- Ablaufdatum, Versionierung) liegen in den Fachmodulen und referenzieren
      -- files.id. Dateien liegen ausschließlich im Backend-Storage.
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        uploaded_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Zentrales Audit-Log ("wer hat wann was warum geändert").
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
    `,
  },
];
