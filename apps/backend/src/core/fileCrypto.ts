/**
 * Verschlüsselung der Datei-Blobs in storage/ (Verträge, Bescheinigungen,
 * AU-Nachweise, Bewerbungsunterlagen, Fotos).
 *
 * Format (Fassung 2, geschrieben wird nur sie):
 *   8 Byte Kennung "OHRGENC\x02" | 16 Byte Salz | 7 Byte Nonce-Präfix |
 *   Abschnitte zu je 64 KiB Klartext, jeder für sich AES-256-GCM mit
 *   eigenem 16-Byte-Prüfwert (der letzte kürzer, mindestens der Prüfwert)
 * Schlüssel je Datei per HKDF aus dem Schlüssel der Dateiablage und dem
 * Salz; Nonce je Abschnitt aus Präfix, Abschnittsnummer (4 Byte) und einem
 * Byte, das den letzten Abschnitt kennzeichnet; der Kopf ist in jedem
 * Abschnitt mit authentifiziert. Vertauschte, fehlende oder angehängte
 * Abschnitte fallen damit beim Prüfen auf (Aufbau wie Tinks
 * AES-GCM-HKDF-Streaming). Abschnitte statt eines Prüfwerts am Ende, weil
 * dann jeder Abschnitt geprüft ist, bevor er hinausgeht, und der Download in
 * einem Durchgang läuft.
 *
 * Fassung 1 ("OHRGENC\x01" | 12 Byte Nonce | Chiffrat | ein Prüfwert am
 * Ende, Schlüssel der Dateiablage direkt) bleibt lesbar; sie braucht zum
 * Ausliefern zwei Durchgänge (erst prüfen, dann senden).
 *
 * Eine Datei OHNE Kennung gilt als Klartext aus der Zeit vor der Umstellung
 * und wird unverändert ausgeliefert; `encryptBlobInPlace` stellt sie um. Der
 * Zustand steht bewusst in der Datei und nicht in der Datenbank: Umbenennen
 * der Datei und UPDATE der Zeile wären zwei Schritte, zwischen denen ein
 * Absturz beide auseinanderlaufen ließe.
 *
 * Rein und ohne config.ts, damit Tests und Werkzeuge es nutzen können.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Readable, Transform } from 'node:stream';
import { readFullSync } from './fileRead.js';

const MAGIC_V1 = Buffer.from('OHRGENC\x01', 'latin1');
const MAGIC_V2 = Buffer.from('OHRGENC\x02', 'latin1');
const MAGIC_BYTES = 8;
/** Gemeinsamer Anfang beider Kennungen; das letzte Byte nennt die Fassung. */
const MAGIC_PREFIX = MAGIC_V2.subarray(0, MAGIC_BYTES - 1);
const TAG_BYTES = 16;
const CIPHER = 'aes-256-gcm';

const V1_NONCE_BYTES = 12;
const V1_HEADER_BYTES = MAGIC_BYTES + V1_NONCE_BYTES;
const V1_VERIFY_CHUNK = 1024 * 1024;

const V2_SALT_BYTES = 16;
const V2_PREFIX_BYTES = 7;
const V2_HEADER_BYTES = MAGIC_BYTES + V2_SALT_BYTES + V2_PREFIX_BYTES;
/** Klartext je Abschnitt (Fassung 2). */
export const BLOB_CHUNK_BYTES = 64 * 1024;
const V2_SEALED_CHUNK = BLOB_CHUNK_BYTES + TAG_BYTES;

/** So viele Bytes vom Dateianfang braucht die Einordnung. */
const HEAD_BYTES = Math.max(V1_HEADER_BYTES, V2_HEADER_BYTES);

/**
 * Arbeitsverzeichnis der Umstellung als Unterordner von storage/: gleiches
 * Dateisystem wie die Dateien (ein Umbenennen über Mountgrenzen scheitert mit
 * EXDEV), und kein Upload kann so heissen (gespeicherte Namen sind Dateien
 * der Form <uuid><endung> direkt in storage/). Die Sicherung lässt ihn aus.
 */
export const STORAGE_CONVERSION_DIR = '.umstellung';

/**
 * Was in einer Datei der Dateiablage liegt. `damaged`: Kennung vorhanden,
 * aber die Grösse kann zu keiner vollständigen Datei gehören (abgeschnitten)
 * oder die Fassung der Kennung ist unbekannt.
 * Die einzige Einordnung für Download, Umstellung, status.cjs und Sicherung.
 */
export type BlobKind = 'plaintext' | 'v1' | 'v2' | 'damaged';

/** Abschnitte einer Datei in Fassung 2; `null`, wenn die Grösse nicht passen kann. */
function v2Layout(size: number): { count: number; lastLength: number } | null {
  const body = size - V2_HEADER_BYTES;
  if (body < TAG_BYTES) return null;
  const count = Math.ceil(body / V2_SEALED_CHUNK);
  const lastLength = body - (count - 1) * V2_SEALED_CHUNK;
  return lastLength >= TAG_BYTES ? { count, lastLength } : null;
}

function classify(size: number, head: Buffer): BlobKind {
  if (head.length < MAGIC_BYTES) return 'plaintext';
  const magic = head.subarray(0, MAGIC_BYTES);
  if (magic.equals(MAGIC_V1)) return size >= V1_HEADER_BYTES + TAG_BYTES ? 'v1' : 'damaged';
  if (magic.equals(MAGIC_V2)) return v2Layout(size) ? 'v2' : 'damaged';
  // Dieselbe Kennung, aber eine Fassung, die dieser Stand nicht kennt (etwa
  // eine neuere nach einem Zurück auf eine ältere Programmfassung, oder ein
  // gekipptes Bit im letzten Kennungsbyte): keine Klartextdatei. Als Klartext
  // lieferte der Download das Chiffrat mit 200 aus, und die Umstellung packte es
  // ein zweites Mal ein.
  if (magic.subarray(0, MAGIC_BYTES - 1).equals(MAGIC_PREFIX)) return 'damaged';
  return 'plaintext';
}

function kindOfFd(fd: number): { kind: BlobKind; size: number } {
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
  return { kind: classify(size, head.subarray(0, readFullSync(fd, head, 0))), size };
}

/** Einordnung einer Datei; liest nur ihren Anfang. */
export function blobKind(file: string): BlobKind {
  const fd = fs.openSync(file, 'r');
  try {
    return kindOfFd(fd).kind;
  } finally {
    fs.closeSync(fd);
  }
}

/** true, wenn die Datei die Kennung der Verschlüsselung trägt (auch beschädigt). */
export function isEncryptedBlob(file: string): boolean {
  return blobKind(file) !== 'plaintext';
}

/**
 * So lange gilt eine leere oder abgeschnittene Datei als Upload, der gerade
 * geschrieben wird (storageEncryptionState, encryptStoredFiles in files.ts).
 */
export const UPLOAD_IN_FLIGHT_MS = 120_000;

export type StorageEncryptionState = 'empty' | 'encrypted' | 'mixed' | 'plaintext';

/**
 * Verschlüsselungsstand eines storage/-Verzeichnisses (Arbeitsverzeichnis
 * der Umstellung ausgenommen). `status.cjs` und die Sicherung melden damit
 * Klartextdateien, die die Umstellung nicht erfasst hat, und abgeschnittene
 * Dateien, statt nur den Zustand der Datenbank.
 */
export function storageEncryptionState(dir: string): {
  state: StorageEncryptionState;
  plaintext: number;
  damaged: number;
  unreadable: number;
  total: number;
} {
  let plaintext = 0;
  let damaged = 0;
  let unreadable = 0;
  let total = 0;
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      let kind: BlobKind;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
        kind = blobKind(file);
      } catch (err) {
        // Zwischen Auflisten und Öffnen gelöscht: gehört nicht mehr dazu.
        // Nicht zu öffnen (Rechte, Windows-Sperre): zählen, nicht abbrechen;
        // status.cjs und damit provision.sh brauchen eine Auskunft.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        total++;
        unreadable++;
        continue;
      }
      total++;
      // Ein Upload, der gerade geschrieben wird, sieht abgeschnitten aus (oder
      // ist noch leer); in den letzten zwei Minuten geänderte Dateien zählen
      // deshalb nicht als beschädigt oder Klartext.
      const inFlight = Date.now() - stat.mtimeMs < UPLOAD_IN_FLIGHT_MS && (kind === 'damaged' || stat.size === 0);
      if (inFlight) continue;
      if (kind === 'plaintext') plaintext++;
      else if (kind === 'damaged') damaged++;
    }
  }
  const state: StorageEncryptionState =
    total === 0 ? 'empty' : plaintext === 0 ? 'encrypted' : plaintext === total ? 'plaintext' : 'mixed';
  return { state, plaintext, damaged, unreadable, total };
}

/** Verschlüsselter Blob, der sich nicht prüfen lässt: beschädigt, abgeschnitten oder fremder Schlüssel. */
export class BlobIntegrityError extends Error {
  constructor(file: string, reason: string) {
    super(
      `Die Datei ${path.basename(file)} lässt sich nicht entschlüsseln (${reason}). Sie ist beschädigt ` +
        'oder gehört zu einem anderen Schlüssel als dem dieses Datenverzeichnisses.',
    );
    this.name = 'BlobIntegrityError';
  }
}

/** Schlüssel der Dateiablage, abgeleitet aus dem Schlüssel des Datenverzeichnisses (64 Hex-Zeichen). */
export function storageKeyFrom(dataKeyHex: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(dataKeyHex, 'hex'), Buffer.alloc(0), 'ohrganize/storage/v1', 32),
  );
}

/** Schlüssel einer Datei in Fassung 2. */
function fileKey(storageKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', storageKey, salt, 'ohrganize/storage/v2/datei', 32));
}

function chunkNonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, V2_PREFIX_BYTES);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/** Schreibt eine Datei in Fassung 2: der Kopf einmal, dann Abschnitt für Abschnitt. */
class ChunkSealer {
  readonly header: Buffer;
  private readonly key: Buffer;
  private readonly prefix: Buffer;
  private index = 0;

  constructor(storageKey: Buffer) {
    const salt = crypto.randomBytes(V2_SALT_BYTES);
    this.prefix = crypto.randomBytes(V2_PREFIX_BYTES);
    this.header = Buffer.concat([MAGIC_V2, salt, this.prefix]);
    this.key = fileKey(storageKey, salt);
  }

  /** Versiegelt den nächsten Abschnitt (höchstens BLOB_CHUNK_BYTES Klartext). */
  seal(plain: Buffer, last: boolean): Buffer {
    const cipher = crypto.createCipheriv(CIPHER, this.key, chunkNonce(this.prefix, this.index++, last));
    cipher.setAAD(this.header);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
}

/** Verschlüsselt einen Inhalt, der bereits im Speicher liegt. */
export function encryptBuffer(key: Buffer, plain: Buffer): Buffer {
  const sealer = new ChunkSealer(key);
  const parts = [sealer.header];
  let offset = 0;
  do {
    const end = Math.min(offset + BLOB_CHUNK_BYTES, plain.length);
    parts.push(sealer.seal(plain.subarray(offset, end), end >= plain.length));
    offset = end;
  } while (offset < plain.length);
  return Buffer.concat(parts);
}

/** Durchlaufstufe für Uploads: Klartext hinein, Dateiformat heraus. */
export function encryptingStream(key: Buffer): Transform {
  const sealer = new ChunkSealer(key);
  let pending: Buffer = Buffer.alloc(0);
  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!headerSent) {
        this.push(sealer.header);
        headerSent = true;
      }
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      // Einen vollen Abschnitt erst abgeben, wenn danach noch Daten kommen:
      // Erst dann steht fest, dass er nicht der letzte ist.
      while (pending.length > BLOB_CHUNK_BYTES) {
        this.push(sealer.seal(pending.subarray(0, BLOB_CHUNK_BYTES), false));
        pending = pending.subarray(BLOB_CHUNK_BYTES);
      }
      callback();
    },
    flush(callback) {
      if (!headerSent) this.push(sealer.header);
      this.push(sealer.seal(pending, true));
      callback();
    },
  });
}

async function readFully(handle: FileHandle, target: Buffer, position: number): Promise<number> {
  let read = 0;
  while (read < target.length) {
    const { bytesRead } = await handle.read(target, read, target.length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return read;
}

async function writeFully(handle: FileHandle, source: Buffer, position: number): Promise<number> {
  let written = 0;
  while (written < source.length) {
    const { bytesWritten } = await handle.write(source, written, source.length - written, position + written);
    written += bytesWritten;
  }
  return written;
}

/** Fassung 1, erster Durchgang: entschlüsselt ins Leere und prüft den Prüfwert. */
async function verifyBody(
  file: string,
  handle: FileHandle,
  key: Buffer,
  nonce: Buffer,
  tag: Buffer,
  start: number,
  end: number,
): Promise<void> {
  const decipher = crypto.createDecipheriv(CIPHER, key, nonce);
  decipher.setAuthTag(tag);
  const buffer = Buffer.alloc(Math.max(1, Math.min(V1_VERIFY_CHUNK, end - start)));
  let position = start;
  while (position < end) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (bytesRead === 0) throw new BlobIntegrityError(file, 'endet vorzeitig');
    decipher.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  try {
    decipher.final();
  } catch {
    throw new BlobIntegrityError(file, 'Prüfwert stimmt nicht');
  }
}

/**
 * Fassung 1: Ein einziger Prüfwert am Ende. GCM prüft erst dort; ein einziger
 * Durchgang gäbe beschädigte oder mit falschem Schlüssel gelesene Dateien als
 * vollständige Antwort mit Status 200 hinaus. Deshalb erst prüfen, dann
 * senden. Bei Erfolg gehört der Dateideskriptor dem zurückgegebenen Strom.
 */
async function openSingleTag(file: string, handle: FileHandle, size: number, head: Buffer, key: Buffer): Promise<Readable> {
  const nonce = Buffer.from(head.subarray(MAGIC_BYTES, V1_HEADER_BYTES));
  const tag = Buffer.alloc(TAG_BYTES);
  if ((await readFully(handle, tag, size - TAG_BYTES)) !== TAG_BYTES) {
    throw new BlobIntegrityError(file, 'endet vorzeitig');
  }
  const bodyEnd = size - TAG_BYTES;
  await verifyBody(file, handle, key, nonce, tag, V1_HEADER_BYTES, bodyEnd);
  const decipher = crypto.createDecipheriv(CIPHER, key, nonce);
  decipher.setAuthTag(tag);
  if (bodyEnd === V1_HEADER_BYTES) {
    // Leere Datei: kein Lesestrom, nur der geprüfte Abschluss.
    await handle.close();
    decipher.end();
    return decipher;
  }
  const source = handle.createReadStream({ start: V1_HEADER_BYTES, end: bodyEnd - 1, autoClose: true });
  // pipeline statt pipe: Ein Lesefehler der Quelle muss den Entschlüsselungs-
  // strom beenden, sonst hängt die Antwort.
  return pipeline(source, decipher, () => {});
}

/**
 * Fassung 2: Abschnitt für Abschnitt lesen, prüfen und erst dann abgeben.
 * Der erste Abschnitt wird VOR der Rückgabe geprüft, damit ein falscher
 * Schlüssel oder ein beschädigter Anfang eine Fehlerantwort ergibt, bevor
 * der Aufrufer Kopfzeilen setzt. Scheitert ein späterer Abschnitt, bricht
 * der Strom mit BlobIntegrityError ab; hinausgegangen ist bis dahin nur
 * Geprüftes. Bei Erfolg gehört der Dateideskriptor dem zurückgegebenen Strom.
 */
async function openChunked(file: string, handle: FileHandle, size: number, head: Buffer, storageKey: Buffer): Promise<Readable> {
  const header = Buffer.from(head.subarray(0, V2_HEADER_BYTES));
  const key = fileKey(storageKey, header.subarray(MAGIC_BYTES, MAGIC_BYTES + V2_SALT_BYTES));
  const prefix = header.subarray(MAGIC_BYTES + V2_SALT_BYTES);
  const layout = v2Layout(size);
  if (!layout) throw new BlobIntegrityError(file, 'zu kurz');
  const { count, lastLength } = layout;

  const readChunk = async (index: number): Promise<Buffer> => {
    const last = index === count - 1;
    const sealed = Buffer.alloc(last ? lastLength : V2_SEALED_CHUNK);
    if ((await readFully(handle, sealed, V2_HEADER_BYTES + index * V2_SEALED_CHUNK)) !== sealed.length) {
      throw new BlobIntegrityError(file, 'endet vorzeitig');
    }
    const decipher = crypto.createDecipheriv(CIPHER, key, chunkNonce(prefix, index, last));
    decipher.setAAD(header);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new BlobIntegrityError(file, 'Prüfwert stimmt nicht');
    }
  };

  const first = await readChunk(0);
  let next = 1;
  let closed = false;
  const stream = new Readable({
    read() {
      if (next >= count) return; // Das Ende ist schon gemeldet oder unterwegs.
      const index = next++;
      readChunk(index).then(
        (plain) => {
          if (plain.length > 0) this.push(plain);
          if (index === count - 1) this.push(null);
        },
        (err: unknown) => this.destroy(err instanceof Error ? err : new Error(String(err))),
      );
    },
    destroy(err, callback) {
      if (closed) return callback(err);
      closed = true;
      handle.close().then(
        () => callback(err),
        () => callback(err),
      );
    },
  });
  if (first.length > 0) stream.push(first);
  if (count === 1) stream.push(null);
  return stream;
}

/**
 * Lesestrom auf den KLARTEXT eines Blobs, egal ob die Datei verschlüsselt
 * ist (Fassung 1 oder 2) oder noch aus der Zeit davor stammt. Wirft, bevor
 * der Aufrufer Kopfzeilen gesetzt hat, wenn die Datei fehlt, keine Datei
 * ist, abgeschnitten ist oder ihr Anfang die Prüfung nicht besteht.
 *
 * Alle Lesevorgänge laufen über DENSELBEN Dateideskriptor: Die Umstellung im
 * Hintergrund ersetzt Dateien per Umbenennen, und zwei getrennte Öffnungen
 * könnten Teile verschiedener Fassungen paaren.
 *
 * `keyFor` wird nur für verschlüsselte Dateien aufgerufen: Ein Klartext-
 * Altbestand bleibt lesbar, auch wenn data.key unbrauchbar ist.
 */
export async function openBlob(file: string, keyFor: () => Buffer | null): Promise<Readable> {
  const handle = await fs.promises.open(file, 'r');
  let handedOver = false;
  try {
    const stat = await handle.stat();
    // Windows öffnet auch Verzeichnisse; sie gälten sonst als leere Klartextdatei.
    if (!stat.isFile()) {
      throw Object.assign(new Error(`${path.basename(file)} ist keine Datei.`), { code: 'EISDIR' });
    }
    const size = stat.size;
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const headRead = await readFully(handle, head, 0);
    const kind = classify(size, head.subarray(0, headRead));
    if (kind === 'damaged') throw new BlobIntegrityError(file, 'abgeschnitten oder unbekannte Fassung');
    if (kind === 'plaintext') {
      handedOver = true;
      return handle.createReadStream({ start: 0, autoClose: true });
    }
    const key = keyFor();
    if (!key) {
      throw new Error(`Die Datei ${path.basename(file)} ist verschlüsselt, aber der Schlüssel des Datenverzeichnisses fehlt.`);
    }
    const stream =
      kind === 'v2'
        ? await openChunked(file, handle, size, head, key)
        : await openSingleTag(file, handle, size, head, key);
    handedOver = true;
    return stream;
  } finally {
    if (!handedOver) await handle.close();
  }
}

/**
 * Stellt eine Datei auf Fassung 2 um: eine Klartextdatei und eine Datei der
 * ersten Fassung (deren Prüfwert dabei kontrolliert wird; scheitert er, bleibt
 * die Datei unverändert und die Funktion wirft BlobIntegrityError). Rückgabe:
 * `true`, wenn umgestellt wurde, `false`, wenn nichts zu tun war (Fassung 2
 * oder abgeschnitten).
 *
 * Geschrieben wird in `tmpDir` (STORAGE_CONVERSION_DIR in storage/, also
 * dasselbe Dateisystem), und erst nach dem Durchschreiben tritt die Datei per
 * Umbenennen an die Stelle des Originals. Eigenes Verzeichnis statt einer
 * Endung: Eine Endung als Kennzeichen kollidierte mit Endungen, die Uploads
 * tragen dürfen.
 *
 * Asynchron, Abschnitt für Abschnitt: Synchron blockierte eine grosse Datei
 * den Dienst für ihre ganze Dauer (gemessen: 420 ms bei 50 MiB), in der
 * Desktop-App samt Fenster, weil das Backend im Main-Prozess läuft.
 *
 * Weil der Dienst währenddessen weiterläuft, kann die Datei inzwischen
 * gelöscht sein (deleteFileIfUnreferenced; der Löschaufruf gelingt auch bei
 * geöffneter Datei). Ein Umbenennen ohne Prüfung legte sie dann wieder an,
 * verschlüsselt und ohne Datensatz, und jede Sicherung trüge sie weiter
 * (nachgestellt). Deshalb unmittelbar vor dem Umbenennen, ohne `await`
 * dazwischen, ein Vergleich mit dem Stand beim Öffnen: Fehlt die Datei, wirft
 * die Funktion ENOENT; ist sie eine andere oder verändert, wirft sie. In
 * beiden Fällen bleibt nichts zurück. Synchron, damit kein Löschen im selben
 * Prozess (auch synchron) zwischen Vergleich und Umbenennen fallen kann.
 */
export async function encryptBlobInPlace(file: string, key: Buffer, tmpDir: string): Promise<boolean> {
  const tmp = path.join(tmpDir, path.basename(file));
  const input = await fs.promises.open(file, 'r');
  let opened: fs.BigIntStats;
  try {
    opened = await input.stat({ bigint: true });
    const size = Number(opened.size);
    const headBuffer = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const head = headBuffer.subarray(0, await readFully(input, headBuffer, 0));
    const kind = classify(size, head);
    if (kind !== 'plaintext' && kind !== 'v1') return false;
    // Klartext: die ganze Datei. Fassung 1: das Chiffrat zwischen Kopf und
    // Prüfwert, beim Lesen entschlüsselt (GCM liefert je Block gleich viel
    // Klartext, die Abschnitte bleiben also 64 KiB).
    let start = 0;
    let length = size;
    let decipher: crypto.DecipherGCM | null = null;
    if (kind === 'v1') {
      const tag = Buffer.alloc(TAG_BYTES);
      await readFully(input, tag, size - TAG_BYTES);
      decipher = crypto.createDecipheriv(CIPHER, key, head.subarray(MAGIC_BYTES, V1_HEADER_BYTES));
      decipher.setAuthTag(tag);
      start = V1_HEADER_BYTES;
      length = size - V1_HEADER_BYTES - TAG_BYTES;
    }
    const sealer = new ChunkSealer(key);
    const output = await fs.promises.open(tmp, 'w', 0o600);
    try {
      let written = await writeFully(output, sealer.header, 0);
      const buffer = Buffer.alloc(BLOB_CHUNK_BYTES);
      let done = 0;
      for (;;) {
        const want = Math.min(BLOB_CHUNK_BYTES, length - done);
        const read = await readFully(input, buffer.subarray(0, want), start + done);
        if (read < want) throw new BlobIntegrityError(file, 'endet vorzeitig');
        done += read;
        // Letzter Abschnitt am Ende, auch wenn er genau voll ist.
        const last = done >= length;
        const plain = decipher ? decipher.update(buffer.subarray(0, read)) : buffer.subarray(0, read);
        if (last && decipher) {
          try {
            decipher.final();
          } catch {
            throw new BlobIntegrityError(file, 'Prüfwert stimmt nicht');
          }
        }
        written += await writeFully(output, sealer.seal(plain, last), written);
        if (last) break;
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  } finally {
    await input.close();
  }
  try {
    let current: fs.BigIntStats;
    try {
      current = fs.statSync(file, { bigint: true });
    } catch (err) {
      // Inzwischen gelöscht (unter Windows auch: Löschen noch nicht abgeschlossen).
      const code = (err as NodeJS.ErrnoException).code;
      throw code === 'ENOENT' || code === 'EPERM'
        ? Object.assign(new Error(`${file} wurde während der Umstellung gelöscht.`), { code: 'ENOENT' })
        : err;
    }
    if (current.ino !== opened.ino || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs) {
      throw new Error(`${file} wurde während der Umstellung verändert; der nächste Lauf stellt sie um.`);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}
