/**
 * Verschlüsselung der Datenbank im Ruhezustand.
 *
 * Die Datenbankdatei, ihr WAL und jede Kopie davon (Sicherung, Probelauf)
 * liegen verschlüsselt auf der Platte: SQLCipher-4-Format (AES-256, je Seite
 * ein HMAC) über better-sqlite3-multiple-ciphers, das im Projekt unter dem
 * Namen `better-sqlite3` installiert ist (npm-Alias, siehe package.json).
 *
 * Der Schlüssel steht in `<dataDir>/data.key`:
 *   - 64 Hex-Zeichen: der Schlüssel selbst (Vorgabe, wird beim ersten Start
 *     erzeugt). Er liegt dann NEBEN den Daten. Das schützt einzelne Dateien
 *     (eine kopierte ohrganize.db, ein Blob aus storage/, Reste auf der
 *     Platte), aber nicht den vollständig kopierten Ordner.
 *   - `extern:<absoluter Pfad>`: Verweis auf eine Schlüsseldatei außerhalb
 *     des Datenverzeichnisses. Dann sind Datenverzeichnis und Sicherung ohne
 *     diese Datei nicht lesbar, sie muss aber getrennt gesichert werden.
 * Ein Verweis in der Datei statt einer Umgebungsvariable, weil JEDER Prozess
 * den Schlüssel braucht, der das Datenverzeichnis kennt (Dienst, Sicherung,
 * Betreiberwerkzeuge), und nicht jeder dieselbe Umgebung bekommt.
 *
 * Diese Datei hängt bewusst NICHT an config.ts: Die Betreiberwerkzeuge
 * (scripts/toolkit.ts) dürfen es nicht importieren.
 *
 * POSIX-FALLE, bitte beim Erweitern beachten: Wer die Datenbankdatei mit
 * fs.openSync/closeSync anfasst, während in DIESEM Prozess eine Verbindung auf
 * sie offen ist, gibt beim close() alle fcntl-Sperren des Prozesses auf die
 * Datei frei, auch die von SQLite (gemessen unter Linux). Den Dateikopf deshalb
 * nur lesen, bevor eine Verbindung entsteht oder nachdem sie geschlossen ist.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { readFullSync } from '../core/fileRead.js';
import { errorText } from '../core/errorText.js';

export const DATA_KEY_FILE = 'data.key';
const EXTERNAL_PREFIX = 'extern:';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Die ersten 16 Byte jeder unverschlüsselten SQLite-Datei. */
const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

export interface DataKey {
  /** 64 Hex-Zeichen (32 Byte). */
  hex: string;
  /** Datei, aus der der Schlüssel gelesen wurde. */
  file: string;
  /** true, wenn data.key nur auf eine Datei außerhalb des Datenverzeichnisses verweist. */
  external: boolean;
}

export type DatabaseState = 'missing' | 'empty' | 'plaintext' | 'encrypted';

function readKeyText(file: string): string {
  // Windows-Editoren stellen eine BOM voran; sie ist kein Inhalt.
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
}

function parseKey(text: string, file: string): string {
  const hex = text.toLowerCase();
  if (!KEY_PATTERN.test(hex)) {
    throw new Error(
      `Die Schlüsseldatei ${file} enthält keinen gültigen Schlüssel (erwartet: 64 Hex-Zeichen). ` +
        'Bitte die Datei aus der Sicherung zurückspielen.',
    );
  }
  return hex;
}

/** Liest den Schlüssel des Datenverzeichnisses. Legt NIE einen an; `null` heißt: Es gibt keinen. */
export function readDataKey(dataDir: string): DataKey | null {
  const file = path.join(dataDir, DATA_KEY_FILE);
  if (!fs.existsSync(file)) return null;
  const text = readKeyText(file);
  if (!text.toLowerCase().startsWith(EXTERNAL_PREFIX)) {
    return { hex: parseKey(text, file), file, external: false };
  }
  const target = text.slice(EXTERNAL_PREFIX.length).trim();
  if (!path.isAbsolute(target)) {
    throw new Error(`${file} verweist auf "${target}". Erwartet wird ein absoluter Pfad hinter "${EXTERNAL_PREFIX}".`);
  }
  if (!fs.existsSync(target)) {
    throw new Error(
      `${file} verweist auf die Schlüsseldatei ${target}, und die fehlt. ` +
        'Ohne sie sind Datenbank und Dateiablage nicht lesbar. Bitte die Schlüsseldatei wieder ablegen.',
    );
  }
  return { hex: parseKey(readKeyText(target), target), file: target, external: true };
}

/**
 * Erzeugt `data.key` mit einem Zufallsschlüssel. Überschreibt nie: Existiert
 * die Datei inzwischen (zweiter Prozess), wird sie gelesen.
 *
 * Die Datei erscheint erst VOLLSTÄNDIG: Geschrieben und durchgeschrieben wird
 * eine Nachbardatei, die dann per Hardlink unter dem endgültigen Namen
 * eingehängt wird (scheitert mit EEXIST, wenn ein anderer Prozess schneller
 * war). Ein direktes Anlegen und Beschreiben liesse bei einem Absturz, einem
 * vollen Datenträger oder einem gleichzeitig lesenden Prozess eine leere
 * data.key zurück, und an der scheitert danach jeder Start.
 */
export function createDataKey(dataDir: string): DataKey {
  const file = path.join(dataDir, DATA_KEY_FILE);
  const hex = crypto.randomBytes(32).toString('hex');
  const tmp = path.join(dataDir, `${DATA_KEY_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.neu`);
  const existingKey = (err: unknown): DataKey => {
    const existing = readDataKey(dataDir);
    if (!existing) throw err;
    return existing;
  };
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, `${hex}\n`);
      // Durchschreiben, BEVOR irgendetwas mit diesem Schlüssel verschlüsselt
      // wird: Ein verschlüsselter Bestand ohne Schlüssel wäre verloren.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, file);
      removeQuietly(tmp);
      // Der Eintrag muss durchgeschrieben sein, BEVOR die Umstellung den Bestand
      // mit diesem Schlüssel verschlüsselt: Ein Stromausfall danach liesse sonst
      // einen verschlüsselten Bestand ohne data.key zurück (siehe auch den
      // Aufräumschritt in config.ts#hardenDataPermissions).
      fsyncDirectory(dataDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return existingKey(err);
      // Dateisysteme ohne Hardlinks (FAT, manche Netzlaufwerke): exklusiv kopieren.
      // Nicht atomar: Ein gleichzeitig lesender Prozess kann hier eine noch
      // leere Datei sehen und bricht dann mit Klartextmeldung ab (kein Verlust).
      try {
        fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') return existingKey(copyErr);
        throw copyErr;
      }
      const fd = fs.openSync(file, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fsyncDirectory(dataDir);
    }
  } finally {
    // Ein Rest ist unschädlich (config.ts räumt ihn auf); er darf einen schon
    // eingehängten Schlüssel nicht zum Fehler machen.
    removeQuietly(tmp);
  }
  return { hex, file, external: false };
}

/** Zustand einer Datenbankdatei, abgelesen an den ersten 16 Byte. */
export function databaseState(file: string): DatabaseState {
  if (!fs.existsSync(file)) return 'missing';
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(PLAINTEXT_HEADER.length);
    const read = readFullSync(fd, head, 0);
    if (read === 0) return 'empty';
    return read === head.length && head.equals(PLAINTEXT_HEADER) ? 'plaintext' : 'encrypted';
  } finally {
    fs.closeSync(fd);
  }
}

/** Verzeichnis für Hilfsdateien von SQLite, im Datenverzeichnis. */
export const SQLITE_TEMP_DIR = '.sqlite-tmp';

/**
 * Wohin SQLite seine Hilfsdateien legt (Sortierungen, temporäre Tabellen,
 * die Kopie eines VACUUM, das Umschlüsseln). SQLite3MC verschlüsselt sie
 * NICHT, nur die Datenbankdatei und ihr -wal: Ein VACUUM einer
 * verschlüsselten Datenbank legte eine Klartextkopie ihres Inhalts in die
 * Hilfsdatei (gemessen: 41 MB aus einer 82-MB-Datenbank).
 *
 * Deshalb hält eine Verbindung auf eine VERSCHLÜSSELTE Datenbank alles
 * Temporäre im Arbeitsspeicher (temp_store = MEMORY). Der Preis trifft nur
 * das VACUUM nach Migrationen (das 1,5-Fache der Nutzdaten, gemessen: 62 MB
 * Spitze für 41 MB; migrateDatabase begrenzt es); gewöhnliche Abfragen
 * sortieren wenige Zeilen.
 *
 * Eine Verbindung auf eine KLARTEXT-Datenbank legt sie dagegen in
 * `<dataDir>/.sqlite-tmp`: Dort liegt nichts, was nicht ohnehin im Klartext
 * auf der Platte steht, und das Umschlüsseln (die einzige Arbeit an einem
 * Klartextbestand, die viel Platz braucht) kostete im Arbeitsspeicher die
 * 1,3-fache Datenbankgrösse (gemessen), unter MemoryMax der Hosting-Unit der
 * Weg in den OOM-Killer. Im Datenverzeichnis gelten dieselben Rechte wie für
 * die Datenbank, im System-Temp nicht. Das Pragma temp_store_directory ist
 * prozessweit und gilt als veraltet; greift es nicht (Verzeichnis nicht
 * anlegbar, Pragma nicht einkompiliert), bleibt auch hier temp_store =
 * MEMORY, damit nichts im System-Temp landet.
 *
 * Ausserdem secure_delete = ON für JEDE Verbindung: Was gelöscht wird
 * (Zellen, frei werdende Seiten), überschreibt SQLite mit Nullen, statt es in
 * der Datei stehen zu lassen. Das gilt damit ohne Zutun jeder Stelle für
 * Umfragedaten (deren Anonymität darauf baut, surveyService.ts), für
 * gelöschte Personalprofile samt Kaskaden und für Migrationen. Kosten: ein
 * paar zusätzlich geschriebene Seiten je Löschung. NICHT erfasst sind Kopien,
 * die beim Verschieben von Zellen zwischen Seiten in deren Lücken bleiben
 * (siehe rebuildResponseTable und die Regel für Migrationen in CLAUDE.md).
 */
function configureConnection(db: Database.Database, dataDir: string, encrypted: boolean): Database.Database {
  db.pragma('secure_delete = ON');
  if (encrypted) {
    db.pragma('temp_store = MEMORY');
    return db;
  }
  const dir = path.join(dataDir, SQLITE_TEMP_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    db.pragma(`temp_store_directory = '${dir.replace(/'/g, "''")}'`);
    if (db.pragma('temp_store_directory', { simple: true }) === dir) return db;
  } catch {
    // Rückfall unten.
  }
  db.pragma('temp_store = MEMORY');
  return db;
}

/** Kennung am Anfang jedes Rollback-Journals (sqlite3 pager.c, aJournalMagic). */
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

/**
 * Liegen die Seiten in einem Rollback-Journal im Klartext oder verschlüsselt?
 * `none`: kein gültiges Journal oder nichts zurückzuspielen.
 *
 * Aufbau (pager.c): Kopf mit Kennung, Satzzahl, Prüfsummen-Startwert,
 * Sektor- und Seitengrösse, aufgefüllt auf die Sektorgrösse; danach Sätze aus
 * Seitennummer, Seite und Prüfsumme. SQLite bildet die Prüfsumme über die
 * Seite, wie SQLite sie sieht, also über den KLARTEXT; SQLite3MC legt die
 * Seite im Journal eines verschlüsselten Bestands aber verschlüsselt ab.
 * Stimmt die Prüfsumme über die rohen Bytes, ist der Satz Klartext. Seite 1
 * entscheidet zusätzlich eindeutig: Im Klartext beginnt sie mit
 * "SQLite format 3", verschlüsselt mit dem Salz.
 *
 * Ein Journal kann aus mehreren Segmenten bestehen (je ein Kopf an einer
 * Sektorgrenze); gelesen werden sie wie von SQLite: Satzzahl 0 heisst "dieses
 * Segment ist leer", nicht "Ende", und 0xffffffff "ohne Sync geschrieben,
 * Sätze bis zum Dateiende". Sektor- und Seitengrösse stehen im ersten Kopf.
 */
function journalContent(journal: string): 'none' | 'plaintext' | 'encrypted' {
  const fd = fs.openSync(journal, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(28);
    if (readFullSync(fd, header, 0) < header.length || !header.subarray(0, 8).equals(JOURNAL_MAGIC)) return 'none';
    const sectorSize = header.readUInt32BE(20);
    const pageSize = header.readUInt32BE(24);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || sectorSize < 32 || sectorSize > 65536) {
      return 'none';
    }
    const recordSize = pageSize + 8;
    const record = Buffer.alloc(recordSize);
    let verdict: 'none' | 'plaintext' = 'none';
    let headerOffset = 0;
    while (headerOffset + header.length <= size) {
      if (readFullSync(fd, header, headerOffset) < header.length || !header.subarray(0, 8).equals(JOURNAL_MAGIC)) break;
      const checksumInit = header.readUInt32BE(12);
      const first = headerOffset + sectorSize;
      const available = Math.max(0, Math.floor((size - first) / recordSize));
      const nRec = header.readUInt32BE(8);
      const records = nRec === 0xffffffff ? available : Math.min(nRec, available);
      for (let i = 0; i < records; i++) {
        if (readFullSync(fd, record, first + i * recordSize) < recordSize) return verdict;
        const pageNumber = record.readUInt32BE(0);
        const page = record.subarray(4, 4 + pageSize);
        let checksum = checksumInit;
        for (let k = pageSize - 200; k > 0; k -= 200) checksum = (checksum + page[k]) >>> 0;
        if (checksum !== record.readUInt32BE(4 + pageSize)) return 'encrypted';
        if (pageNumber === 1) return page.subarray(0, PLAINTEXT_HEADER.length).equals(PLAINTEXT_HEADER) ? 'plaintext' : 'encrypted';
        verdict = 'plaintext';
      }
      if (nRec === 0xffffffff) break;
      // Nächster Kopf an der nächsten Sektorgrenze hinter den Sätzen.
      const end = first + records * recordSize;
      headerOffset = Math.ceil(end / sectorSize) * sectorSize;
      if (headerOffset <= first - sectorSize) break;
    }
    return verdict;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Spielt ein liegengebliebenes Rollback-Journal zurück, bevor der Zustand der
 * Datei bestimmt wird: ein Journal mit Klartextseiten OHNE Schlüssel, eines
 * mit verschlüsselten Seiten MIT Schlüssel (journalContent).
 *
 * Ohne Schlüssel, weil ein Abbruch des Umschlüsselns (Stromausfall, SIGKILL)
 * ein Journal mit den ursprünglichen Klartextseiten hinterlässt; ist der
 * Abbruch im Commit passiert, ist die erste Seite der Datei aber schon
 * verschlüsselt. Mit Schlüssel geöffnet spielt SQLite3MC dieses Journal nicht
 * zurück und meldet nur SQLITE_NOTADB; ohne Schlüssel spielt SQLite es roh
 * zurück, und der Klartextbestand ist vollständig wieder da (gemessen unter
 * Linux: 40 Abbrüche im letzten Viertel, davon 12 mit schon verschlüsselter
 * erster Seite, alle ohne Verlust).
 *
 * Mit Schlüssel, weil das Journal eines bereits verschlüsselten Bestands
 * (Wechsel in den WAL-Modus nach der Umstellung, eine Kopie im Journalmodus
 * DELETE) verschlüsselte Seiten trägt: Ohne Schlüssel stimmen deren
 * Prüfsummen nicht, SQLite hält das Journal für leer, löscht es und lässt die
 * halbe Transaktion in der Datei stehen (gemessen: integrity_check ok, Inhalt
 * falsch). Fehlt der Schlüssel dann, bleibt das Journal liegen, und das
 * reguläre Öffnen meldet den fehlenden Schlüssel.
 */
function rollBackHotJournal(file: string, dataDir: string): void {
  const journal = `${file}-journal`;
  let size: number;
  try {
    size = fs.statSync(journal).size;
  } catch {
    // Kein Journal, oder eine andere Verbindung hat es eben mit ihrem Commit
    // entfernt (zwischen einer Prüfung auf Existenz und dem stat): nichts
    // zurückzuspielen. Jeder andere Grund zeigt sich beim regulären Öffnen.
    return;
  }
  if (size === 0) return;
  let content: ReturnType<typeof journalContent>;
  let key: DataKey | null = null;
  try {
    content = journalContent(journal);
    if (content === 'none') return;
    if (content === 'encrypted') {
      key = readDataKey(dataDir);
      if (!key) return;
    }
  } catch {
    return; // Das reguläre Öffnen danach meldet den Grund.
  }
  let db: Database.Database;
  try {
    db = new Database(file, { fileMustExist: true });
  } catch {
    return;
  }
  try {
    if (key) applyKey(db, key.hex);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch {
    // Ohne Schlüssel gelesen meldet ein verschlüsselter Bestand SQLITE_NOTADB;
    // zurückgespielt ist trotzdem. Eine andere Verbindung, die das Journal
    // gerade schreibt, meldet SQLITE_BUSY; dann war es nicht liegengeblieben.
  } finally {
    if (db.open) db.close();
  }
}

/**
 * Zustand einer Datenbankdatei NACH dem Zurückspielen eines liegengebliebenen
 * Journals. Wer vor dem Öffnen entscheidet (encryptDatabaseAtRest), braucht
 * genau das: Nach einem Abbruch im Commit der Umstellung ist die erste Seite
 * schon verschlüsselt, der Bestand nach dem Zurückspielen aber Klartext. Nur
 * ohne offene Verbindung auf die Datei aufrufen (POSIX-Falle oben).
 */
export function settledDatabaseState(file: string, dataDir: string = path.dirname(file)): DatabaseState {
  rollBackHotJournal(file, dataDir);
  return databaseState(file);
}

/**
 * Das installierte SQLite-Modul kann nicht verschlüsseln (ein gleichnamiges
 * Fremdmodul, etwa nach `npm install` statt `npm ci`). Der Dienst startet dann
 * nicht, auch nicht auf einem Klartextbestand: Er liesse sonst Datenbank und
 * neue Dateien still unverschlüsselt.
 */
export class CipherUnavailableError extends Error {
  constructor() {
    super(
      'Das installierte SQLite-Modul kann nicht verschlüsseln. Erwartet wird better-sqlite3-multiple-ciphers ' +
        'unter dem Namen better-sqlite3 (npm-Alias in package.json). Bitte "npm ci" im Programmverzeichnis ausführen.',
    );
    this.name = 'CipherUnavailableError';
  }
}

function cipherAvailable(db: Database.Database): boolean {
  const cipher = db.pragma("cipher = 'sqlcipher'");
  return Array.isArray(cipher) && cipher.length > 0;
}

/** Wirft CipherUnavailableError, bevor eine Umstellung Schlüssel oder Vermerk anlegt. */
function assertCipherAvailable(): void {
  const probe = new Database(':memory:');
  try {
    if (!cipherAvailable(probe)) throw new CipherUnavailableError();
  } finally {
    probe.close();
  }
}

/** Setzt Verfahren und Schlüssel auf einer frisch geöffneten Verbindung. */
function applyKey(db: Database.Database, hex: string, verb: 'key' | 'rekey' = 'key'): void {
  if (!cipherAvailable(db)) {
    db.close();
    throw new CipherUnavailableError();
  }
  db.pragma('legacy = 4');
  // hex ist auf [0-9a-f]{64} geprüft (parseKey bzw. randomBytes).
  db.pragma(`${verb} = "x'${hex}'"`);
}

export interface OpenOptions {
  /** Verzeichnis mit data.key; Vorgabe ist das Verzeichnis der Datenbankdatei. */
  dataDir?: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Fehlt die Datenbank noch, darf ein Schlüssel erzeugt werden (nur der Dienst, nie ein Werkzeug). */
  createKey?: boolean;
}

export interface OpenedDatabase {
  db: Database.Database;
  encrypted: boolean;
  /** Schlüssel, mit dem geöffnet wurde; `null` bei einer Klartextdatenbank. */
  key: DataKey | null;
}

/**
 * Öffnet eine Datenbank passend zu ihrem Zustand: eine Klartextdatei ohne,
 * eine verschlüsselte mit Schlüssel, eine neue verschlüsselt, sobald ein
 * Schlüssel vorhanden ist oder erzeugt werden darf.
 *
 * Für einen verschlüsselten Bestand wird NIE ein Schlüssel erzeugt: Ein neuer
 * Schlüssel öffnet ihn nicht, und stillschweigend eine leere Datenbank
 * daneben anzulegen hieße, den Verlust erst beim Blick in die Anwendung zu
 * bemerken.
 */
export function openDatabase(file: string, options: OpenOptions = {}): OpenedDatabase {
  const dataDir = options.dataDir ?? path.dirname(file);
  rollBackHotJournal(file, dataDir);
  const state = databaseState(file);
  // Nur gesetzte Schalter weitergeben: better-sqlite3 weist `undefined` ab.
  const sqliteOptions: Database.Options = {};
  if (options.readonly !== undefined) sqliteOptions.readonly = options.readonly;
  if (options.fileMustExist !== undefined) sqliteOptions.fileMustExist = options.fileMustExist;

  if (state === 'plaintext') {
    return { db: configureConnection(new Database(file, sqliteOptions), dataDir, false), encrypted: false, key: null };
  }

  if (state === 'encrypted') {
    const key = readDataKey(dataDir);
    if (!key) {
      throw new Error(
        `Die Datenbank ${file} ist verschlüsselt, aber der Schlüssel fehlt (erwartet: ${path.join(dataDir, DATA_KEY_FILE)}). ` +
          'Ohne ihn sind die Daten nicht lesbar. Bitte data.key aus derselben Sicherung zurückspielen wie die Datenbank.',
      );
    }
    const db = new Database(file, sqliteOptions);
    applyKey(db, key.hex);
    configureConnection(db, dataDir, true);
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (err) {
      db.close();
      if ((err as { code?: string }).code !== 'SQLITE_NOTADB') throw err;
      throw new Error(
        `Die Datenbank ${file} lässt sich mit dem Schlüssel aus ${key.file} nicht öffnen. ` +
          'Entweder gehört der Schlüssel zu einem anderen Datenbestand, oder die Datei ist beschädigt. ' +
          'Bitte Datenbank und data.key aus derselben Sicherung zurückspielen.',
      );
    }
    return { db, encrypted: true, key };
  }

  // 'missing' oder 'empty': neue Datenbank.
  const key = readDataKey(dataDir) ?? (options.createKey && !options.fileMustExist ? createDataKey(dataDir) : null);
  const db = new Database(file, sqliteOptions);
  if (!key) return { db: configureConnection(db, dataDir, false), encrypted: false, key: null };
  applyKey(db, key.hex);
  return { db: configureConnection(db, dataDir, true), encrypted: true, key };
}

/**
 * Die Datenbank ist verschlüsselt, ihre Prüfung danach aber gescheitert oder
 * nie zu Ende gelaufen. Der Dienst darf dann nicht starten (server.ts): Es
 * gibt keinen Klartextstand mehr, auf dem er weiterlaufen könnte.
 */
export class ConversionVerificationError extends Error {}

/**
 * Vermerk im Datenverzeichnis: Die Umstellung hat begonnen, und die
 * verschlüsselte Datenbank hat ihre Prüfung noch nicht bestanden. Angelegt
 * VOR dem Umschlüsseln, entfernt erst nach bestandener Prüfung, damit jeder
 * Abbruch dazwischen einen Vermerk hinterlässt (Absturz oder Stromausfall
 * zwischen Commit und Prüfung, gescheiterte Prüfung). Ein Vermerk, der erst
 * NACH einer gescheiterten Prüfung geschrieben würde, fehlte genau dann, wenn
 * auch sein Schreiben scheitert (volle Platte), und der nächste Start liefe
 * ungeprüft weiter. Geschrieben und entfernt unter der Sperre der Umstellung
 * (encryptDatabaseFile), ausgewertet von convertDatabaseAtRest, gemeldet von
 * status.cjs. Ausserhalb der Sperre entfernt ihn nur convertDatabaseAtRest,
 * und zwar nach einer eigenen bestandenen Prüfung der verschlüsselten Datei
 * oder wenn es keine Datenbank gibt; beides kann den Vermerk einer laufenden
 * Umstellung nicht treffen (sie hält die Datei, die Prüfung scheitert dann
 * mit SQLITE_BUSY). Nach einem Fehler ergänzt es den Grund im Vermerk.
 */
export const CONVERSION_FAILED_FILE = 'umstellung-pruefung-gescheitert.txt';

/** Wie lange die Umstellung auf andere Verbindungen wartet, bevor sie es beim nächsten Start erneut versucht. */
export const CONVERSION_WAIT_MS = 10_000;

/** Für den Test: eine kürzere Frist als CONVERSION_WAIT_MS. */
export interface ConversionOptions {
  waitMs?: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
}

/** Ergebnis von quick_check für eine Meldung: höchstens drei Zeilen (ein Schaden kann Hunderte melden). */
function checkText(result: unknown): string {
  const lines = String(result).split('\n');
  return lines.slice(0, 3).join('; ') + (lines.length > 3 ? ` (und ${lines.length - 3} weitere Zeilen)` : '');
}

/**
 * Wiederholt `fn`, solange SQLite "belegt" meldet, bis `deadline`. Nötig für
 * den Wechsel des Journalmodus: Dort wartet SQLite nicht von selbst
 * (busy_timeout greift nicht), und ein Werkzeug, das die Datenbank gerade für
 * eine Sekunde offen hat, liesse die Umstellung sonst sofort scheitern.
 */
function retryWhileBusy<T>(deadline: number, fn: () => T): T {
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(200, Math.max(0, deadline - Date.now())));
    }
  }
}

/**
 * Schreibt eine kleine Datei und schreibt sie samt Verzeichniseintrag durch:
 * Ohne das Durchschreiben des Verzeichnisses kann der Eintrag nach einem
 * Stromausfall fehlen (POSIX), obwohl das Umschlüsseln danach durchgeschrieben
 * ist. Unter Windows lässt sich ein Verzeichnis nicht öffnen; NTFS schreibt
 * den Eintrag mit der Datei.
 */
function writeDurably(file: string, text: string): void {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(file));
}

/** Schreibt die Einträge eines Verzeichnisses durch (POSIX); NTFS schreibt sie mit der Datei. */
function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // Manche Dateisysteme kennen kein fsync auf Verzeichnissen; die Datei selbst ist durchgeschrieben.
  } finally {
    if (dirFd !== null) fs.closeSync(dirFd);
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Bleibt die Datei liegen, entscheidet, wer sie findet (Vermerk: convertDatabaseAtRest; Zwischendatei: config.ts).
  }
}

/**
 * quick_check einer verschlüsselten Datenbank; 'ok' oder der Befund. Lässt
 * sie sich gar nicht öffnen (Schlüssel fehlt oder passt nicht), wirft es mit
 * der Meldung von openDatabase, die genau das sagt. Nur ohne offene
 * Verbindung auf die Datei aufrufen (POSIX-Falle oben).
 */
function verifyEncryptedDatabase(file: string, dataDir: string): string {
  const opened = openDatabase(file, { dataDir, fileMustExist: true });
  try {
    const result = opened.db.pragma('quick_check', { simple: true });
    return result === 'ok' ? 'ok' : checkText(result);
  } catch (err) {
    // Belegt ist kein Befund über die Datei; der Aufrufer meldet es eigens.
    if (isBusy(err)) throw err;
    return errorText(err);
  } finally {
    opened.db.close();
  }
}

/**
 * Umstellung beim Dienststart samt Vermerk (CONVERSION_FAILED_FILE).
 * Rückgabe: der Schlüssel, wenn JETZT umgestellt wurde, sonst `null`. Nur
 * ohne offene Verbindung auf die Datei aufrufen (POSIX-Falle oben).
 *
 * Liegt ein Vermerk, entscheidet der Zustand der Datei:
 *  - verschlüsselt: Die Prüfung läuft erneut. Besteht sie, fällt der Vermerk
 *    weg (der Abbruch lag zwischen Commit und Prüfung, oder die Prüfung
 *    scheiterte an etwas Vorübergehendem); besteht sie nicht, startet der
 *    Dienst nicht, und zwar bei jedem Versuch, bis die Datei ersetzt ist.
 *    Lässt sich die Datei gar nicht öffnen (Schlüssel fehlt oder passt
 *    nicht), startet er ebenfalls nicht, mit genau dieser Meldung.
 *  - Klartext: Die Umstellung kam nie bis zum Commit, oder die Sicherung von
 *    vorher ist zurückgespielt (auch von Hand unter Windows). Umgestellt wird
 *    wie sonst; die Umstellung schreibt den Vermerk unter ihrer Sperre neu
 *    und entfernt ihn mit dem Erfolg. Hier wird er NICHT gelöscht: Ein
 *    zweiter Prozess, der gleichzeitig startet, sähe sonst den Vermerk einer
 *    laufenden Umstellung neben dem noch unverschlüsselten Bestand und
 *    löschte ihn.
 *  - keine Datenbank: Er gehört zu nichts mehr und fällt weg.
 *
 * Scheitert die Umstellung selbst, entscheidet ebenfalls der Zustand danach,
 * nicht die Art des Fehlers: Klartext heißt unverändert weiterlaufen (der
 * Fehler geht als gewöhnlicher Fehler hinaus), verschlüsselt heißt
 * ConversionVerificationError, denn auf einen Klartextstand kann der Dienst
 * dann nicht mehr zurück.
 */
export function convertDatabaseAtRest(
  file: string,
  dataDir: string = path.dirname(file),
  options: ConversionOptions = {},
): DataKey | null {
  const mark = path.join(dataDir, CONVERSION_FAILED_FILE);
  // Zustand erst NACH dem Zurückspielen eines liegengebliebenen Journals:
  // Nach einem Abbruch im Commit ist die erste Seite schon verschlüsselt, der
  // Bestand aber Klartext.
  const state = settledDatabaseState(file, dataDir);
  if (fs.existsSync(mark)) {
    if (state === 'encrypted') {
      let result: string;
      try {
        result = verifyEncryptedDatabase(file, dataDir);
      } catch (err) {
        // Nicht prüfbar: ohne Prüfung kein Start, aber auch kein Rat zum
        // Zurückspielen, wenn nur ein anderer Prozess die Datei hält oder der
        // Schlüssel fehlt (dann sagt openDatabase genau das).
        throw new ConversionVerificationError(
          isBusy(err)
            ? `Die Prüfung nach der Umstellung auf Verschlüsselung steht aus (Vermerk: ${mark}), und ein anderer Prozess hält die Datenbank gerade (${errorText(err)}). ` +
                'Der nächste Start prüft erneut; über den Zustand der Datei sagt das nichts.'
            : errorText(err),
        );
      }
      if (result !== 'ok') {
        throw new ConversionVerificationError(
          `Die Datenbank wurde auf Verschlüsselung umgestellt und besteht die Prüfung nicht (${result}; Vermerk: ${mark}). ` +
            'Bitte die Sicherung von vor dem Update vollständig zurückspielen; danach startet der Dienst wieder.',
        );
      }
      // Bleibt er liegen, prüft der nächste Start erneut und räumt dann.
      removeQuietly(mark);
      return null;
    }
    if (state !== 'plaintext') fs.rmSync(mark, { force: true });
  }
  if (state !== 'plaintext') return null;

  let key: DataKey;
  try {
    key = encryptDatabaseFile(file, dataDir, mark, options);
  } catch (err) {
    let after: DatabaseState | 'unbekannt' = 'unbekannt';
    try {
      after = settledDatabaseState(file, dataDir);
    } catch {
      // Unbekannt zählt wie verschlüsselt: lieber nicht starten als ungeprüft.
    }
    // Klartext: Den Vermerk hat encryptDatabaseFile unter der Sperre
    // behandelt (vor dem Umschlüsseln entfernt; scheiterte das Umschlüsseln
    // selbst, bleibt er, und die nächste Umstellung schreibt ihn neu).
    if (after === 'plaintext') throw err;
    const failure =
      err instanceof ConversionVerificationError
        ? err
        : new ConversionVerificationError(
            `Die Datenbank wurde verschlüsselt, danach ist die Umstellung gescheitert (${errorText(err)}). ` +
              'Bitte die Sicherung von vor dem Update vollständig zurückspielen.',
          );
    try {
      writeDurably(mark, `${new Date().toISOString()}\n${failure.message}\n`);
    } catch {
      // Der Vermerk vom Beginn liegt schon; nur der Grund fehlt darin.
    }
    throw failure;
  }
  return key;
}

/**
 * Stellt eine Klartext-Datenbank einmalig auf Verschlüsselung um, AN ORT UND
 * STELLE: `PRAGMA rekey` baut die Datei in einer einzigen Schreibtransaktion
 * mit Rollback-Journal neu auf.
 *
 * Warum nicht Kopie plus Umbenennen (die erste Fassung): Eine SQLite-Datei zu
 * ersetzen, die ein anderer Prozess offen hat, ist unter POSIX nicht sicher.
 * Ein Werkzeug, das die alte Datei vorher geöffnet hatte, fand danach das WAL
 * der neuen Datei über den Pfad, schrieb unverschlüsselte Seiten hinein und
 * beschädigte sie (gemessen unter Linux); dazu verlor das Lesen des
 * Dateikopfs die Sperre (siehe POSIX-Falle oben). An Ort und Stelle bleibt es
 * dieselbe Datei: SQLite sperrt selbst, andere Prozesse warten oder bekommen
 * SQLITE_BUSY, und eine Verbindung, die vorher geöffnet wurde, scheitert
 * danach mit SQLITE_NOTADB statt zu schreiben (gemessen unter Windows und
 * Linux).
 *
 * Absturzsicher über das Journal: Ein Abbruch an beliebiger Stelle hinterlässt
 * den unveränderten Klartextbestand oder ein Journal, das rollBackHotJournal
 * beim nächsten Öffnen zurückspielt; ein Abbruch nach dem Commit hinterlässt
 * den fertig verschlüsselten Bestand. Der Schlüssel wird VOR dem
 * Umschlüsseln durchgeschrieben (createDataKey).
 *
 * Vorher wird auf den Journalmodus DELETE gestellt: Das schreibt ein
 * Klartext-WAL zurück und entfernt es, und es gelingt nur, wenn keine andere
 * Verbindung die Datenbank im WAL-Modus offen hat. Platzbedarf: ein Journal
 * etwa in Grösse der Datenbank plus die Hilfsdatei des Neuaufbaus im
 * Datenverzeichnis.
 *
 * Danach hält die Verbindung die Datei EXKLUSIV gesperrt (locking_mode
 * EXCLUSIVE plus eine leere Schreibtransaktion), bis sie schliesst. Sonst
 * konnte ein anderer Prozess zwischen dem Wechsel nach DELETE und dem
 * Umschlüsseln (etwa während createDataKey durchschreibt) die Datei zurück in
 * den WAL-Modus stellen; die Sicherung tut das über getDb(). Das Umschlüsseln
 * landete dann im -wal, der Dateikopf blieb im Klartext, und jedes Öffnen
 * scheiterte mit SQLITE_NOTADB (nachgestellt). Auf andere Verbindungen
 * gewartet wird in beiden Schritten zusammen höchstens CONVERSION_WAIT_MS
 * (eine Frist): beim Journalmodus durch Wiederholen, weil SQLite dort nicht
 * selbst wartet, bei BEGIN EXCLUSIVE über busy_timeout mit dem Rest der Frist.
 * Danach wartet nichts mehr, die Datei gehört dieser Verbindung.
 *
 * VOR dem Umschlüsseln prüft quick_check den Klartextbestand: Ein Schaden,
 * mit dem die bisherige Fassung lief (etwa eine falsch gezählte Freiliste
 * nach einem alten Absturz), bestünde nach dem Umschlüsseln weiter, gälte
 * dann als gescheiterte Umstellung und hielte den Dienst an. So bleibt der
 * Bestand unverschlüsselt und der Dienst läuft weiter wie bisher; der Fehler
 * nennt den Grund. NACH dem Umschlüsseln prüft quick_check erneut; ein Befund
 * dort ist eine ConversionVerificationError, ebenso jeder Fehler der Prüfung.
 * Ob ein Fehler des Umschlüsselns selbst vor oder nach dessen Commit lag,
 * entscheidet der Aufrufer am Zustand der Datei (convertDatabaseAtRest).
 *
 * `mark` (CONVERSION_FAILED_FILE, nur vom Dienststart): Der Vermerk entsteht
 * erst, wenn die Sperre gehalten wird, und verschwindet, solange sie noch
 * gehalten wird: nach bestandener Prüfung, oder bei einem Abbruch, bevor das
 * Umschlüsseln begonnen hat. So kann kein zweiter Prozess dazwischen den
 * Vermerk einer laufenden Umstellung entfernen oder vorfinden, ohne dass er
 * stimmt. Lässt er sich nicht anlegen, wird nicht umgestellt (gewöhnlicher
 * Fehler): Ohne ihn liefe ein Neustart nach einer gescheiterten Prüfung
 * ungeprüft weiter. Scheitert die Prüfung, bleibt er liegen.
 */
export function encryptDatabaseFile(
  file: string,
  dataDir: string = path.dirname(file),
  mark?: string,
  options: ConversionOptions = {},
): DataKey {
  assertCipherAvailable();
  rollBackHotJournal(file, dataDir);
  const conn = configureConnection(new Database(file, { fileMustExist: true }), dataDir, false);
  try {
    const deadline = Date.now() + (options.waitMs ?? CONVERSION_WAIT_MS);
    conn.pragma('busy_timeout = 0');
    retryWhileBusy(deadline, () => {
      const mode = conn.pragma('journal_mode = DELETE', { simple: true });
      if (mode !== 'delete') {
        throw Object.assign(new Error('Die Datenbank wird gerade von einem anderen Prozess benutzt.'), {
          code: 'SQLITE_BUSY',
        });
      }
    });
    conn.pragma('locking_mode = EXCLUSIVE');
    conn.pragma(`busy_timeout = ${Math.max(0, deadline - Date.now())}`);
    conn.exec('BEGIN EXCLUSIVE; COMMIT');
    // Zwischen dem Wechsel nach DELETE und der Sperre hielt diese Verbindung
    // keine: Ein anderer Prozess (die Sicherung öffnet über getDb() im
    // WAL-Modus) konnte die Datei dort zurück in den WAL-Modus stellen, und das
    // Umschlüsseln landete im -wal. Jetzt gehört die Datei dieser Verbindung;
    // der Modus wird unter der Sperre erneut gesetzt und geprüft.
    if (conn.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
      throw new Error('Die Datenbank liess sich nicht auf den Journalmodus DELETE stellen.');
    }

    // Ab hier gehört die Datei dieser Verbindung.
    if (mark) writeDurably(mark, `${new Date().toISOString()}\nUmstellung auf Verschlüsselung begonnen, Prüfung steht aus.\n`);
    let key: DataKey;
    try {
      // quick_check statt integrity_check: Es erkennt beschädigte Seiten und
      // Strukturen, ohne jeden Index gegen seine Tabelle abzugleichen, und
      // hält den ersten Start kurz.
      const before = conn.pragma('quick_check', { simple: true });
      if (before !== 'ok') {
        throw new Error(
          `Die Datenbank besteht schon vor der Umstellung die Prüfung nicht (${checkText(before)}). ` +
            'Sie bleibt unverschlüsselt, bis der Schaden behoben ist (Sicherung zurückspielen oder die Datenbank reparieren lassen).',
        );
      }
      key = readDataKey(dataDir) ?? createDataKey(dataDir);
    } catch (err) {
      // Noch nichts umgeschlüsselt: Der Bestand ist Klartext, der Vermerk gehört zu nichts.
      if (mark) removeQuietly(mark);
      throw err;
    }
    applyKey(conn, key.hex, 'rekey');

    // Prüfen mit derselben Verbindung (sie trägt jetzt den Schlüssel und
    // hält weiter die Sperre). Die Datei ist ab hier verschlüsselt,
    // Temporäres also nur noch im Arbeitsspeicher (configureConnection).
    // Vorher den Seitencache leeren: Unter locking_mode EXCLUSIVE behält die
    // Verbindung ihn über den Commit hinaus, und eine Datenbank, die ganz
    // hineinpasst (Vorgabe etwa 16 MB), prüfte sonst nur den Cache, also den
    // Stand, den schon die Prüfung vorher sah; ein Schaden, der nur auf der
    // Platte steht, bliebe unentdeckt (nachgestellt).
    let check: unknown;
    try {
      conn.pragma('temp_store = MEMORY');
      conn.pragma('shrink_memory');
      check = conn.pragma('quick_check', { simple: true });
    } catch (err) {
      throw new ConversionVerificationError(
        `Die Datenbank wurde verschlüsselt, die Prüfung danach ist gescheitert (${errorText(err)}). ` +
          'Bitte die Sicherung von vor dem Update vollständig zurückspielen.',
      );
    }
    if (check !== 'ok') {
      throw new ConversionVerificationError(
        `Die Datenbank wurde verschlüsselt, besteht danach aber die Prüfung nicht (${checkText(check)}). ` +
          'Bitte die Sicherung von vor dem Update vollständig zurückspielen.',
      );
    }
    // Bleibt er liegen, prüft der nächste Start erneut und räumt dann.
    if (mark) removeQuietly(mark);
    return key;
  } finally {
    if (conn.open) conn.close();
  }
}

/**
 * Konsistente Kopie einer geöffneten Datenbank im laufenden Betrieb.
 *
 * `VACUUM INTO` statt `db.backup()`: Die Online-Backup-Schnittstelle öffnet
 * ihr Ziel ohne Schlüssel und lehnt eine verschlüsselte Quelle deshalb ab.
 * `VACUUM INTO` liest in einer Lesetransaktion (derselbe konsistente Stand)
 * und schreibt die Kopie mit dem Schlüssel der Quelle; eine Klartextquelle
 * ergibt eine Klartextkopie. Die Kopie steht im Journalmodus DELETE und
 * braucht kein -wal.
 */
export function copyDatabaseTo(db: Database.Database, target: string): void {
  db.prepare('VACUUM INTO ?').run(target);
}
