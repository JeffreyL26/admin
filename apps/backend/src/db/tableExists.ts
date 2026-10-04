/**
 * true, wenn es im Schema `main` eine Tabelle dieses Namens gibt. Für
 * Vermerke, die als Tabelle angelegt werden (Migrationen, Umfragen).
 *
 * Hängt an nichts ausser better-sqlite3 (kein db.js, kein config.ts).
 */
import type Database from 'better-sqlite3';

export function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
