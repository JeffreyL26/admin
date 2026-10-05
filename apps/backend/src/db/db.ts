import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { convertDatabaseAtRest, openDatabase, readDataKey, type DataKey } from './encryption.js';
import { clearWalAndIndex, measureWalFramesBeyondFirstSegment, walIndexHasFurtherSegments } from './walIndex.js';

let db: Database.Database | null = null;
let cachedKey: DataKey | null = null;
let openedEncrypted = false;
/** Hatte die -shm beim Öffnen dieser Verbindung weitere Abschnitte (walIndexHasFurtherSegments)? */
let walIndexLeftOverAtOpen = false;

export function getDb(): Database.Database {
  if (!db) {
    // Verschlüsselt im Ruhezustand (db/encryption.ts): Eine neue Datenbank
    // entsteht verschlüsselt, eine verschlüsselte wird mit data.key geöffnet,
    // ein Klartextbestand bleibt lesbar, bis der Dienststart ihn umstellt
    // (encryptDatabaseAtRest).
    const opened = openDatabase(config.dbPath, { dataDir: config.dataDir, createKey: true });
    db = opened.db;
    openedEncrypted = opened.encrypted;
    if (opened.key) cachedKey = opened.key;
    db.pragma('journal_mode = WAL');
    // Jetzt, direkt nach dem Öffnen, sagt die Grösse der -shm etwas: Als erste
    // Verbindung auf der Datenbank hat diese sie eben gekürzt (restartStaleWalIndex).
    walIndexLeftOverAtOpen = walIndexHasFurtherSegments(db);
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

/**
 * Seitencache der Dienstverbindung in KiB (negativ = Grösse statt
 * Seitenzahl). Die Vorgabe dieses SQLite-Builds sind 16 MB; jede Seite
 * ausserhalb muss SQLCipher erneut lesen, entschlüsseln und prüfen, denn der
 * Cache des Betriebssystems hält nur Chiffrat. Gemessen bei 2000 Personen und
 * sechs Jahren Historie (167 MB): Portal-Kalender 38 statt 130 ms,
 * Abrechnungsliste 35 statt 320 ms. 64 MB passen unter MemoryHigh=512M der
 * Hosting-Unit.
 */
const SERVICE_PAGE_CACHE_KIB = 64 * 1024;

/**
 * Vergrössert den Seitencache, ERST NACH den Migrationen (server.ts): Das
 * VACUUM nach einer Migration liest jede Seite durch diesen Cache, und seine
 * Obergrenze (VACUUM_IN_MEMORY_LIMIT_BYTES in migrateDatabase.ts) ist mit
 * dem kleinen Vorgabecache gerechnet. Klartextseiten liegen ohnehin im
 * Prozessspeicher, mit dem grösseren Cache nur länger.
 */
export function enlargePageCache(): void {
  getDb().pragma(`cache_size = -${SERVICE_PAGE_CACHE_KIB}`);
}

export function closeDb(): void {
  if (walRetry) {
    clearTimeout(walRetry);
    walRetry = null;
  }
  db?.close();
  db = null;
  openedEncrypted = false;
  // Offenes bleibt im Vermerk (WAL_INDEX_FILL_FILE) für den nächsten Start.
  walIndexFillOwed = 0;
  walMark = null;
}

/** Führt fn in einer Transaktion aus (Rollback bei Exception). */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

let walRetry: NodeJS.Timeout | null = null;
let walRetryRemaining = 0;
const WAL_RETRY_MS = 1_000;
/** Zehn Minuten sekündlich: länger hält keine Sicherung (VACUUM INTO) ihren Lesestand. */
const WAL_RETRY_LIMIT = 600;
/**
 * Danach minütlich, höchstens eine Stunde lang; dann gibt die Wiederholung
 * auf, und der Vermerk bleibt für den nächsten Start oder die nächste
 * Teilnahme liegen. Ohne Ende wiederholte sie etwa eine Füllung, die an einer
 * vollen Platte scheitert, jede Minute samt ihrem Schreibaufwand.
 */
const WAL_RETRY_SLOW_MS = 60_000;
const WAL_RETRY_SLOW_LIMIT = 60;

/**
 * Höchste Frame-Nummer, bis zu der die Seitenliste der -shm noch Seiten eines
 * schutzwürdigen Schreibvorgangs nennen kann, soweit sie über den ersten
 * Abschnitt hinausreicht; 0, wenn nichts offen ist. Gemerkt nach dem Commit
 * (measureWalFramesBeyondFirstSegment), abgetragen erst, wenn die Füllung
 * gelungen ist: Scheitert sie, bleibt sie offen und der nächste Versuch holt
 * sie nach. Damit sie einen Neustart übersteht, steht sie zusätzlich in
 * WAL_INDEX_FILL_FILE (restartStaleWalIndex).
 */
let walIndexFillOwed = 0;

/**
 * Vermerk im Datenverzeichnis, dass -wal und -shm noch Spuren eines
 * schutzwürdigen Schreibvorgangs tragen: die offene Füllung als Text (0, wenn
 * nur das Leeren aussteht). Er liegt, solange etwas offen ist: geschrieben,
 * sobald ein Leeren scheitert oder eine Füllung offen wird, entfernt, sobald
 * das Leeren gelungen ist. Beides ist selten (ein Leser hält das Leeren auf),
 * im Normalfall kostet eine Teilnahme hier nichts. So übersteht das Offene
 * einen Neustart, einen Absturz und das Ende der Wiederholung
 * (restartStaleWalIndex): Die Verbindung, die beim Beenden schliesst, ist
 * nicht die letzte, solange die Sicherung liest, und schreibt das -wal dann
 * nicht zurück (nachgestellt). Ein Fehler beim Schreiben oder Entfernen
 * bricht nichts ab: Dann übersteht das Offene einen Neustart nicht, oder es
 * wird nach einem Neustart einmal zu viel geleert.
 */
const WAL_INDEX_FILL_FILE = '.shm-fuellung-offen';
/** Inhalt des liegenden Vermerks; null, wenn keiner liegt, NaN, wenn einer liegt, dessen Inhalt nicht zählt. */
let walMark: number | null = null;

function writeWalMark(): void {
  try {
    fs.writeFileSync(path.join(config.dataDir, WAL_INDEX_FILL_FILE), `${walIndexFillOwed}\n`, { mode: 0o600 });
    walMark = walIndexFillOwed;
  } catch {
    // siehe WAL_INDEX_FILL_FILE
  }
}

function owe(frames: number): void {
  if (frames <= walIndexFillOwed) return;
  walIndexFillOwed = frames;
  writeWalMark();
}

/** Die Füllung ist gelungen; ob auch das Leeren danach gelang, meldet clearWalAndIndex. */
function filled(): void {
  walIndexFillOwed = 0;
}

/** -wal und -shm sind geleert: nichts mehr offen. */
function settled(): void {
  walIndexFillOwed = 0;
  if (walMark === null) return;
  try {
    fs.rmSync(path.join(config.dataDir, WAL_INDEX_FILL_FILE), { force: true });
    walMark = null;
  } catch {
    // siehe WAL_INDEX_FILL_FILE
  }
}

/**
 * Beim Dienststart (server.ts): Was der vorige Prozess offen liess
 * (WAL_INDEX_FILL_FILE), wird nachgeholt. Geleert wird immer: Die Frames
 * stehen noch im -wal, auch wenn SQLite die -shm beim Öffnen neu aufgebaut
 * hat. Gefüllt wird nur, wenn die -shm noch steht, wie der vorige Prozess sie
 * liess. Das tut sie nur, wenn SQLite sie beim Öffnen nicht zurückgesetzt
 * hat, weil eine andere Verbindung (eine Sicherung) sie offen hielt; das
 * zeigt die Grösse der -shm, gemessen DIREKT beim Öffnen in getDb (später
 * wüchse sie schon durch ein VACUUM dieses Prozesses). Entschieden wird am
 * Vermerk, nicht an der Grösse allein: Eine grosse -shm ohne Vermerk (eine
 * frühere Füllung, eine grosse Transaktion) löst nichts aus. Nur der Dienst
 * ruft das auf, nicht die Sicherung, die ebenfalls getDb benutzt, aber nicht
 * schreiben soll.
 */
export function restartStaleWalIndex(): void {
  getDb();
  const file = path.join(config.dataDir, WAL_INDEX_FILL_FILE);
  let frames = 0;
  try {
    frames = Number.parseInt(fs.readFileSync(file, 'utf8'), 10) || 0;
  } catch {
    return; // kein Vermerk
  }
  walMark = Number.NaN; // liegt; sein Inhalt wird gleich neu geschrieben, falls nötig
  if (walIndexLeftOverAtOpen) owe(frames);
  clearWalSoon({ measure: false });
}

/** Offene Füllung der -shm-Seitenliste, nur lesend (für den Test). */
export function walIndexFillPending(): number {
  return walIndexFillOwed;
}

/**
 * Leert das -wal (samt Seitenliste der -shm, clearWalAndIndex), sobald es
 * geht, ohne den Dienst warten zu lassen.
 *
 * Für Schreibvorgänge, deren Reihenfolge nicht im -wal stehen bleiben darf
 * (Umfrageteilnahme, modules/communication/surveyService.ts). Ein TRUNCATE-
 * Checkpoint wartet sonst über den busy_timeout (5 s, je Phase) auf jeden
 * Leser, und das synchron: Hielt die Sicherung gerade ihren Lesestand
 * (VACUUM INTO), stand für diese Zeit jede Anfrage der Instanz. Hier ohne
 * Warten; ist ein Leser aktiv, folgt sekündlich ein neuer Versuch im
 * Hintergrund, bis es gelingt (ein Nachholer zur Zeit; jeder neue Aufruf
 * gibt ihm wieder volle WAL_RETRY_LIMIT Versuche, damit eine spätere
 * Teilnahme nicht vom Rest einer früheren abhängt), danach eine Stunde lang
 * minütlich. Was
 * dabei offen ist, steht im Vermerk WAL_INDEX_FILL_FILE: closeDb bricht die
 * Wiederholung ab, und die schliessende Verbindung schreibt das -wal nur
 * zurück, wenn sie die letzte ist, also gerade nicht, solange die Sicherung
 * liest; dann holt der nächste Start es nach (restartStaleWalIndex).
 *
 * `measure: false` für Schreibvorgänge, deren Frames nichts verraten, etwa
 * den Neuaufbau beim Umfrageende (er schreibt jede Seite der Tabelle frisch):
 * Dann wird nur geleert, eine noch offene Füllung früherer Teilnahmen
 * bleibt, und es entsteht keine neue, die so gross wäre wie der Neuaufbau.
 */
export function clearWalSoon(options: { measure?: boolean } = {}): void {
  if (db && options.measure !== false) owe(measureWalFramesBeyondFirstSegment(db));
  const attempt = (): boolean => {
    if (!db) return true;
    let done = false;
    try {
      done = clearWalAndIndex(db, walIndexFillOwed, filled);
    } catch {
      done = false;
    }
    if (done) settled();
    else if (walMark !== walIndexFillOwed) writeWalMark();
    return done;
  };
  if (attempt()) return;
  walRetryRemaining = WAL_RETRY_LIMIT + WAL_RETRY_SLOW_LIMIT;
  if (walRetry) return;
  const retry = (): void => {
    walRetry = null;
    if (attempt() || --walRetryRemaining <= 0) return;
    walRetry = setTimeout(retry, walRetryRemaining > WAL_RETRY_SLOW_LIMIT ? WAL_RETRY_MS : WAL_RETRY_SLOW_MS);
    walRetry.unref();
  };
  walRetry = setTimeout(retry, WAL_RETRY_MS);
  walRetry.unref();
}

/**
 * Stellt einen Klartextbestand einmalig auf Verschlüsselung um. Rückgabe:
 * `true`, wenn umgestellt wurde. Ablauf, Vermerk und Prüfung:
 * db/encryption.ts#convertDatabaseAtRest.
 *
 * Nur der Dienststart ruft das auf (server.ts), und zwar VOR dem ersten
 * Datenbankzugriff. Sicherung und Betreiberwerkzeuge stellen bewusst nicht
 * um: Sie laufen neben dem Dienst, und die Umstellung braucht die Datei
 * exklusiv.
 */
export function encryptDatabaseAtRest(): boolean {
  // Bei offener Verbindung den Dateikopf NICHT lesen (POSIX-Falle in
  // db/encryption.ts); der Zustand steht dann ohnehin fest.
  if (db) {
    if (openedEncrypted) return false;
    throw new Error('encryptDatabaseAtRest muss vor dem ersten Datenbankzugriff laufen.');
  }
  const key = convertDatabaseAtRest(config.dbPath, config.dataDir);
  if (!key) return false;
  cachedKey = key;
  return true;
}

/**
 * true, wenn die Datenbank verschlüsselt geöffnet ist. Erst dann schreibt die
 * Dateiablage verschlüsselt und stellt den Altbestand um (core/files.ts):
 * Solange die Datenbank im Klartext liegt (Umstellung gescheitert oder noch
 * nicht gelaufen), kann ein Zurück auf eine ältere Fassung sie noch lesen, und
 * dann müssen es auch die Dateien sein.
 */
export function isDatabaseEncrypted(): boolean {
  getDb();
  return openedEncrypted;
}

/**
 * Schlüssel dieses Datenverzeichnisses, `null` solange es keinen gibt (ein
 * Klartextbestand vor dem ersten Dienststart). Die Dateiablage leitet ihren
 * Schlüssel daraus ab (core/files.ts).
 */
export function dataKey(): DataKey | null {
  if (!cachedKey) cachedKey = readDataKey(config.dataDir);
  return cachedKey;
}
