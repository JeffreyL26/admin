import { getDb } from './db.js';
import { allMigrations } from './migrations/index.js';

/**
 * Migrationen sind TypeScript-Module mit SQL-Strings (kein Datei-Glob), damit
 * das Backend als einzelnes esbuild-Bundle in der Desktop-App laufen kann,
 * ohne .sql-Dateien mitkopieren zu müssen.
 *
 * Nummernkreise pro Modul (parallel konfliktfrei erweiterbar):
 *   0xx Core · 1xx Personal · 2xx Abwesenheit · 3xx Leistung · 4xx Vergütung · 5xx Kommunikation
 */
export function migrate(): void {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const pending = allMigrations
    .filter((m) => !applied.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(m.name);
    })();
  }
}
