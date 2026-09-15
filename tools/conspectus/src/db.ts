/**
 * Register des Anbieters: eine SQLite-Datei AUSSERHALB des Repositories.
 *
 * Warum aussen: Im Register stehen Kundennamen, Hostadressen, Lizenznummern
 * und Rechnungsbezuege. Im Repository waere das eine Frage der Zeit, bis es
 * in einem Commit landet; in einem synchronisierten Ordner (OneDrive) eine
 * Frage der Zeit, bis es auf einem fremden Geraet liegt oder eine
 * halbgeschriebene SQLite-Datei synchronisiert wird. Beides weist dieses
 * Modul deshalb AKTIV zurueck, statt darauf zu vertrauen, dass niemand den
 * falschen Pfad setzt.
 *
 * Der Pfad kommt aus OHRGANIZE_CONSPECTUS_DIR und ist Pflicht: Eine Vorgabe
 * im Heimatverzeichnis waere bequem und genau deshalb falsch, weil dann
 * niemand mehr weiss, wo das Register eigentlich liegt und ob es gesichert
 * wird.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { SCHEMA, SPAETERE_SPALTEN } from './schema.js';

export class ConspectusError extends Error {}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Verzeichnis des Registers. Prueft den Pfad, legt ihn an und gibt den
 * aufgeloesten Pfad zurueck.
 */
export function registerDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.OHRGANIZE_CONSPECTUS_DIR ?? '').trim();
  if (!raw) {
    throw new ConspectusError(
      'OHRGANIZE_CONSPECTUS_DIR ist nicht gesetzt.\n' +
        'Das Register gehoert ausserhalb des Repositories und ausserhalb synchronisierter\n' +
        'Ordner, zum Beispiel:\n' +
        '  Linux:   export OHRGANIZE_CONSPECTUS_DIR=/var/lib/ohrganize-anbieter\n' +
        '  Windows: setx OHRGANIZE_CONSPECTUS_DIR C:\\ohrganize-anbieter',
    );
  }
  const dir = path.resolve(raw);
  // Zweimal pruefen: vor dem Anlegen, damit ein abgewiesener Pfad kein
  // Verzeichnis hinterlaesst (etwa im Repository), und nach dem Anlegen noch
  // einmal aufgeloest, weil realpathSync Symlinks folgt und genau ein Symlink
  // in ein synchronisiertes Verzeichnis sonst uebersehen wuerde.
  assertOutsideRepo(dir);
  assertNotSynced(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(dir);
  assertOutsideRepo(real);
  assertNotSynced(real);
  return real;
}

function assertOutsideRepo(dir: string): void {
  const rel = path.relative(repoRoot, dir);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) {
    throw new ConspectusError(
      `Das Register darf nicht im Repository liegen (${dir}).\n` +
        'Dort stuenden Kundennamen, Hostadressen und Lizenznummern eine\n' +
        'Unachtsamkeit von einem Commit entfernt. Bitte einen Pfad ausserhalb\n' +
        'waehlen.',
    );
  }
}

function assertNotSynced(dir: string): void {
  const lower = dir.toLowerCase();
  for (const marker of ['onedrive', 'dropbox', 'google drive', 'googledrive', 'icloud']) {
    if (lower.includes(marker)) {
      throw new ConspectusError(
        `Das Register darf nicht in einem synchronisierten Ordner liegen (${dir} enthaelt "${marker}").\n` +
          'Eine SQLite-Datei im WAL-Modus wird dabei halb synchronisiert und landet\n' +
          'ausserdem auf jedem verbundenen Geraet. Bitte einen lokalen Pfad waehlen\n' +
          'und ihn in die Datensicherung aufnehmen.',
      );
    }
  }
}

export interface Register {
  db: Database.Database;
  dir: string;
  /** $DIR/lizenzen: ausgestellte Dateien, je Kunde ein Unterordner. */
  licenseDir: string;
}

let cached: Register | null = null;

export function openRegister(env: NodeJS.ProcessEnv = process.env): Register {
  if (cached) return cached;
  const dir = registerDir(env);
  const file = path.join(dir, 'conspectus.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  for (const { tabelle, spalte, typ } of SPAETERE_SPALTEN) {
    try {
      db.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${typ}`);
    } catch (err) {
      // "duplicate column name" heisst: schon da. Alles andere ist ein Fehler.
      if (!String((err as Error).message).includes('duplicate column name')) throw err;
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows kennt nur das Read-only-Bit; die Rechte haengen dort an den ACLs.
  }
  const licenseDir = path.join(dir, 'lizenzen');
  fs.mkdirSync(licenseDir, { recursive: true, mode: 0o700 });
  cached = { db, dir, licenseDir };
  return cached;
}

/** Nur fuer Tests: naechster Aufruf oeffnet neu. */
export function resetRegisterCache(): void {
  cached?.db.close();
  cached = null;
}
