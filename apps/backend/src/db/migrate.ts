import { config } from '../config.js';
import { getDb } from './db.js';
import { migrateDatabase } from './migrateDatabase.js';

export { migrateDatabase };

/**
 * Migrationen sind TypeScript-Module mit SQL-Strings (kein Datei-Glob), damit
 * das Backend als einzelnes esbuild-Bundle in der Desktop-App laufen kann,
 * ohne .sql-Dateien mitkopieren zu müssen.
 *
 * Nummernkreise pro Modul (parallel konfliktfrei erweiterbar):
 *   0xx Core · 1xx Personal · 2xx Abwesenheit · 3xx Leistung · 4xx Vergütung · 5xx Kommunikation
 */
export function migrate(): void {
  // Warnungen landen im Journal, sobald der Logger steht (server.ts).
  migrateDatabase(getDb(), { onWarning: (message) => config.startupWarnings.push(message) });
}
