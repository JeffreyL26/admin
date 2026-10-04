/**
 * Bausteine zum Leeren von -wal und -shm nach einem schutzwürdigen
 * Schreibvorgang (Umfrageteilnahme). Benutzt wird das allein über
 * db.ts#clearWalSoon, das die Buchführung (offene Füllung, Wiederholung)
 * hält; wer clearWalAndIndex direkt aufruft, umgeht sie. Hier liegt es
 * getrennt, damit der Test die Bausteine an eigenen Verbindungen prüfen kann.
 *
 * Hängt an nichts ausser better-sqlite3 (kein db.js, kein config.ts).
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { withSecureDelete } from './secureDelete.js';

/** Seitennummern im ersten Abschnitt der -shm (wal.c: HASHTABLE_NPAGE_ONE), in jedem weiteren 4096. */
export const WAL_INDEX_FIRST_SEGMENT_FRAMES = 4062;
/** Kopf einer -wal-Datei und Kopf je Frame (wal.c: WAL_HDRSIZE, WAL_FRAME_HDRSIZE). */
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;

/**
 * Leert -wal und Seitenliste der -shm ohne Warten; `true`, wenn es gelungen
 * ist.
 *
 * Ein TRUNCATE-Checkpoint leert das -wal, setzt in der (unverschlüsselten)
 * -shm aber nur den Kopf zurück: Die Seitennummern der Frames bleiben
 * stehen, bis ein neuer Frame denselben Abschnitt der Liste wieder beginnt
 * (gemessen: nach einer Teilnahme nannte sie die Seite der neuen Antwort).
 * SQLite beginnt einen Abschnitt neu, sobald sein erster Frame geschrieben
 * wird, und nullt ihn dabei ganz. Deshalb danach:
 *  - `fillFrames` bis 4062 (der Normalfall: die Frames lagen im ersten
 *    Abschnitt): Ein Schreibvorgang auf Seite 1 genügt (user_version auf
 *    seinen eigenen Wert; das Projekt benutzt user_version nicht). Übrig
 *    bleibt die Nummer 1, in der -shm wie im -wal; einen zweiten Checkpoint
 *    braucht das nicht, Seite 1 verrät nichts.
 *  - darüber (ein Leser hielt das Leeren lange auf, und der Schreibvorgang
 *    landete hinter Frame 4062): fillWalIndex schreibt `fillFrames` neue
 *    Seiten, damit jeder Abschnitt bis dorthin neu beginnt, meldet das über
 *    `onFilled` (ab hier ist nichts mehr offen, auch wenn der zweite
 *    Checkpoint gleich an einem Leser scheitert), und leert erneut.
 */
export function clearWalAndIndex(connection: Database.Database, fillFrames = 0, onFilled?: () => void): boolean {
  if (connection.inTransaction) return false;
  if (connection.pragma('journal_mode', { simple: true }) !== 'wal') return true;
  const timeout = connection.pragma('busy_timeout', { simple: true }) as number;
  connection.pragma('busy_timeout = 0');
  try {
    const checkpoint = () => (connection.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0]?.busy === 0;
    if (!checkpoint()) return false;
    if (fillFrames <= WAL_INDEX_FIRST_SEGMENT_FRAMES) {
      // Ohne Durchschreiben (synchronous OFF): Der Schreibvorgang setzt
      // user_version auf seinen eigenen Wert und dient nur der -shm. Ginge er
      // bei einem Stromausfall verloren, fehlte nichts; mit FULL kostete er
      // zwei fsyncs je Teilnahme (gemessen).
      const version = connection.pragma('user_version', { simple: true }) as number;
      const sync = connection.pragma('synchronous', { simple: true }) as number;
      connection.pragma('synchronous = OFF');
      try {
        connection.pragma(`user_version = ${version}`);
      } finally {
        connection.pragma(`synchronous = ${sync}`);
      }
      return true;
    }
    fillWalIndex(connection, fillFrames, connection.pragma('page_size', { simple: true }) as number);
    onFilled?.();
    return checkpoint();
  } finally {
    connection.pragma(`busy_timeout = ${timeout}`);
  }
}

/**
 * Wie weit das -wal gerade reicht, soweit über den ersten Abschnitt der
 * -shm hinaus; 0 sonst. Unmittelbar nach einem schutzwürdigen Commit
 * aufgerufen, sind dessen Frames die letzten, ihre Nummern also höchstens so
 * gross.
 *
 * Zuerst die Länge der -wal-Datei (ein stat): Sie fasst mindestens so viele
 * Frames, wie die laufende Generation hat. Passen höchstens 4062 hinein, kann
 * kein Frame hinter dem ersten Abschnitt liegen; das ist der Normalfall und
 * kostet keinen Checkpoint. Erst darüber misst ein PASSIVE-Checkpoint (wartet
 * nie) die Frames der laufenden Generation genau; nach einem Neubeginn des
 * -wal sind es weniger, als die Datei fasst (gemessen). Scheitert er, gilt
 * vorsichtig die Länge der Datei, auch wenn er nicht wirft, sondern `log = -1`
 * meldet (eine andere Verbindung hält gerade die Checkpoint-Sperre).
 *
 * Wirft nie (dann 0): Aufgerufen wird nach dem Commit einer Teilnahme, und ein
 * Fehler hier machte aus der gespeicherten Teilnahme eine Fehlerantwort (die
 * Wiederholung bekäme "bereits teilgenommen"). Scheitert schon das Lesen der
 * Verbindung, scheitert auch das Leeren gleich und wird wiederholt.
 */
export function measureWalFramesBeyondFirstSegment(connection: Database.Database): number {
  try {
    if (connection.pragma('journal_mode', { simple: true }) !== 'wal') return 0;
    const capacity = walFrameCapacity(`${connection.name}-wal`, connection.pragma('page_size', { simple: true }) as number);
    if (capacity <= WAL_INDEX_FIRST_SEGMENT_FRAMES) return 0;
    let frames = capacity;
    try {
      const log = (connection.pragma('wal_checkpoint(PASSIVE)') as { log: number }[])[0]?.log;
      if (typeof log === 'number' && log >= 0) frames = log;
    } catch {
      // bleibt bei der Länge der Datei
    }
    return frames > WAL_INDEX_FIRST_SEGMENT_FRAMES ? frames : 0;
  } catch {
    return 0;
  }
}

/** Grösse eines Abschnitts der -shm-Datei (wal.c: WALINDEX_PGSZ). */
const WAL_INDEX_BLOCK_BYTES = 32 * 1024;

/**
 * true, wenn die -shm weitere Abschnitte hat (grösser als einer ist). Nur
 * UNMITTELBAR nach dem Öffnen der ersten Verbindung eines Prozesses
 * aussagekräftig (db.ts#getDb): Ist sie die erste auf der Datenbank, kürzt
 * SQLite die -shm dabei; hat sie danach noch weitere Abschnitte, hält eine
 * andere Verbindung (eine Sicherung) sie offen, und sie steht, wie der
 * vorige Prozess sie liess. Später sagt die Grösse nichts mehr: SQLite
 * verkleinert die -shm nie, auch nicht nach einem TRUNCATE-Checkpoint, also
 * wüchse sie schon durch ein VACUUM dieses Prozesses (gemessen). Ein stat,
 * die Datei wird nicht geöffnet.
 */
export function walIndexHasFurtherSegments(connection: Database.Database): boolean {
  try {
    return fs.statSync(`${connection.name}-shm`).size > WAL_INDEX_BLOCK_BYTES;
  } catch {
    return false;
  }
}

/** Frames, die in die -wal-Datei passen (0, wenn sie fehlt). */
function walFrameCapacity(walFile: string, pageSize: number): number {
  let size: number;
  try {
    size = fs.statSync(walFile).size;
  } catch {
    return 0;
  }
  return Math.max(0, Math.floor((size - WAL_HEADER_BYTES) / (pageSize + WAL_FRAME_HEADER_BYTES)));
}

/**
 * Schreibt in EINER Transaktion mindestens `frames` verschiedene Seiten
 * (Nullfüllung einer Hilfstabelle, im selben Commit wieder gelöscht), damit
 * jeder bis dahin benutzte Abschnitt der -shm-Seitenliste neu beginnt. Unter
 * secure_delete, weil SQLite eine im selben Commit wieder freigegebene Seite
 * sonst gar nicht schreibt. Je Seite eine volle Seite Nutzlast, mehr als eine
 * Überlaufseite fasst, also mindestens so viele Seiten wie Frames. Die
 * Seiten kommen aus der Freiliste oder hängen sich an die Datei an und sind
 * danach frei: Die Datei wächst um bis zu diese Zahl Seiten, die später
 * wiederverwendet werden. `frames` ist die Lage des schutzwürdigen Commits
 * (measureWalFramesBeyondFirstSegment), nicht die Länge der Datei; gross wird
 * es nur, wenn ein Leser das Leeren lange aufhielt, während viel geschrieben
 * wurde.
 */
function fillWalIndex(connection: Database.Database, frames: number, pageSize: number): void {
  // SQLite begrenzt ein Blob auf 1 GB; grössere Füllungen in Teilen.
  const chunk = 256 * 1024 * 1024;
  withSecureDelete(connection, () =>
    connection.transaction(() => {
      connection.exec('CREATE TABLE _wal_index_fill (b BLOB)');
      const insert = connection.prepare('INSERT INTO _wal_index_fill (b) VALUES (zeroblob(?))');
      for (let remaining = frames * pageSize; remaining > 0; remaining -= chunk) insert.run(Math.min(remaining, chunk));
      connection.exec('DROP TABLE _wal_index_fill');
    })(),
  );
}
