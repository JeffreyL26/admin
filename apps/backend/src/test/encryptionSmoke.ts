/**
 * Verschlüsselung im Ruhezustand (db/encryption.ts, core/fileCrypto.ts).
 *
 * Geprüft wird der heikle Weg: Ein Datenverzeichnis aus der Zeit VOR der
 * Verschlüsselung (Klartext-Datenbank im WAL-Modus, Klartext-Blob) wird beim
 * Start umgestellt, ohne dass ein Datensatz oder eine Datei verloren geht.
 * Dazu: neue Uploads, Download, Sicherung, Betreiberwerkzeuge, fehlender und
 * falscher Schlüssel, Schlüssel außerhalb des Datenverzeichnisses.
 *
 * Aufruf: tsx src/test/encryptionSmoke.ts (Teil von npm test).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-enc-'));
const dataDir = path.join(work, 'data');
const storageDir = path.join(dataDir, 'storage');
fs.mkdirSync(storageDir, { recursive: true });
const dbFile = path.join(dataDir, 'ohrganize.db');
// Auch bei einem Abbruch mitten im Test: Im Temp-Verzeichnis lägen sonst
// Datenbank und data.key liegen.
process.on('exit', () => {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows hält Dateien gelegentlich noch kurz; Reste im Tempverzeichnis sind unkritisch.
  }
});
// Die Betreiberwerkzeuge verweigern den Lauf als root (scripts/toolkit.ts,
// refuseRoot); deren Prüfungen entfallen dann, statt die Suite zu brechen.
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `: ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const DB_MARKER = 'GEHEIM-DATENSATZ-4711';
const BLOB_MARKER = 'KLARTEXT-BLOB-MARKER-0815';
const UPLOAD_MARKER = 'NEUER-UPLOAD-MARKER-2342';
const containsText = (file: string, text: string) => fs.existsSync(file) && fs.readFileSync(file).includes(text);

// ---------------------------------------------------------------------------
// 1. Bestand wie vor der Verschlüsselung anlegen: Klartext, WAL, ein Blob
// ---------------------------------------------------------------------------
const { migrateDatabase } = await import('../db/migrateDatabase.js');
const legacyBlob = Buffer.from(`%PDF-1.4 ${BLOB_MARKER} ${'x'.repeat(5000)}`);
{
  const legacy = new Database(dbFile);
  legacy.pragma('journal_mode = WAL');
  migrateDatabase(legacy);
  legacy
    .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'test.marker', 'test', 1, ?)")
    .run(JSON.stringify({ marker: DB_MARKER }));
  fs.writeFileSync(path.join(storageDir, 'altbestand.pdf'), legacyBlob);
  legacy
    .prepare(
      "INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256) VALUES ('Altvertrag.pdf', 'altbestand.pdf', 'application/pdf', ?, ?)",
    )
    .run(legacyBlob.length, crypto.createHash('sha256').update(legacyBlob).digest('hex'));
  legacy.close();
}
check('Ausgangslage: Datenbank liegt im Klartext vor', containsText(dbFile, DB_MARKER));

// ---------------------------------------------------------------------------
// 2. Dienststart stellt die Datenbank um
// ---------------------------------------------------------------------------
process.env.OHRGANIZE_DATA_DIR = dataDir;
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

const { buildServer } = await import('../server.js');
const { closeDb, getDb } = await import('../db/db.js');
const { databaseState, openDatabase, readDataKey, encryptDatabaseFile, DATA_KEY_FILE } = await import('../db/encryption.js');
const { encryptStoredFiles } = await import('../core/files.js');
const { migrateDatabase: migrateAgain } = await import('../db/migrateDatabase.js');
const {
  BlobIntegrityError,
  blobKind,
  encryptBlobInPlace,
  encryptBuffer,
  encryptingStream,
  isEncryptedBlob,
  openBlob,
  storageKeyFrom,
} = await import('../core/fileCrypto.js');
const { firstAdminLogin } = await import('./adminSession.js');

const app = await buildServer();
const keyFile = path.join(dataDir, DATA_KEY_FILE);

check('Datenbank ist nach dem Start verschlüsselt', databaseState(dbFile) === 'encrypted', databaseState(dbFile));
check('data.key angelegt (64 Hex-Zeichen)', /^[0-9a-f]{64}\s*$/.test(fs.readFileSync(keyFile, 'utf8')));
check('Kein Klartext mehr in ohrganize.db', !containsText(dbFile, DB_MARKER));
check('Kein Klartext im WAL', !containsText(`${dbFile}-wal`, DB_MARKER));
check('Kein Journal der Umstellung übrig', !fs.existsSync(`${dbFile}-journal`) || fs.statSync(`${dbFile}-journal`).size === 0);
const sqliteTmp = path.join(dataDir, '.sqlite-tmp');
check(
  'Umschlüsseln des Klartextbestands: Hilfsdatei im Datenverzeichnis statt im System-Temp',
  fs.existsSync(sqliteTmp) && getDb().pragma('temp_store_directory', { simple: true }) === sqliteTmp,
  getDb().pragma('temp_store_directory', { simple: true }),
);
// SQLite verschlüsselt Hilfsdateien nicht (ein VACUUM schrieb eine
// Klartextkopie hinein): Verbindungen auf eine verschlüsselte Datenbank
// halten Temporäres im Arbeitsspeicher (2 = MEMORY).
// secure_delete für jede Verbindung über openDatabase: Gelöschtes (auch über
// Kaskaden, etwa ein gelöschtes Personalprofil) wird mit Nullen überschrieben.
check('Dienstverbindung: secure_delete an', getDb().pragma('secure_delete', { simple: true }) === 1, getDb().pragma('secure_delete', { simple: true }));
check(
  'Verschlüsselte Datenbank: Hilfsdateien nur im Arbeitsspeicher',
  getDb().pragma('temp_store', { simple: true }) === 2,
  getDb().pragma('temp_store', { simple: true }),
);
check(
  'data.key ohne Reste ihres Anlegens',
  !fs.readdirSync(dataDir).some((n) => n.startsWith(`${DATA_KEY_FILE}.`)),
  fs.readdirSync(dataDir),
);
const marker = getDb().prepare("SELECT details FROM audit_log WHERE action = 'test.marker'").get() as
  | { details: string }
  | undefined;
check('Bestandsdaten sind nach der Umstellung lesbar', marker?.details.includes(DB_MARKER) === true, marker);
check(
  'Journalmodus ist wieder WAL',
  getDb().pragma('journal_mode', { simple: true }) === 'wal',
  getDb().pragma('journal_mode', { simple: true }),
);

const { auth } = await firstAdminLogin(app, check);

const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('API-Antworten tragen Cache-Control: no-store', me.headers['cache-control'] === 'no-store', me.headers['cache-control']);

// ---------------------------------------------------------------------------
// 3. Dateiablage: Altbestand lesbar, neue Uploads verschlüsselt, Umstellung
// ---------------------------------------------------------------------------
async function download(fileId: number): Promise<Buffer> {
  const sign = await app.inject({ method: 'POST', url: `/api/files/${fileId}/sign`, headers: auth });
  const res = await app.inject({ method: 'GET', url: sign.json().url });
  return res.rawPayload;
}

const legacyId = (getDb().prepare("SELECT id FROM files WHERE stored_name = 'altbestand.pdf'").get() as { id: number }).id;
// Der Altbestand hat keinen Bezug zu einer Fachtabelle; signieren darf ihn nur, wer ihn hochgeladen hat.
getDb().prepare('UPDATE files SET uploaded_by = (SELECT id FROM users LIMIT 1) WHERE id = ?').run(legacyId);
check('Klartext-Altbestand wird vor der Umstellung unverändert ausgeliefert', (await download(legacyId)).equals(legacyBlob));

const boundary = '----ohrganizeEncBoundary';
const uploadBody = `%PDF-1.4 ${UPLOAD_MARKER} ${'y'.repeat(70000)}`;
const upload = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Neu.pdf"\r\nContent-Type: application/pdf\r\n\r\n${uploadBody}\r\n--${boundary}--\r\n`,
  ),
});
check('Upload angenommen', upload.statusCode === 200, upload.json());
const uploaded = upload.json().file as { id: number; stored_name: string; size_bytes: number; sha256: string };
const uploadedPath = path.join(storageDir, uploaded.stored_name);
check('Neuer Upload liegt verschlüsselt im Storage', isEncryptedBlob(uploadedPath) && !containsText(uploadedPath, UPLOAD_MARKER));
check(
  'Größe und Prüfsumme beschreiben den Klartext',
  uploaded.size_bytes === Buffer.byteLength(uploadBody) &&
    uploaded.sha256 === crypto.createHash('sha256').update(uploadBody).digest('hex'),
  uploaded,
);
check('Download liefert den Klartext des Uploads', (await download(uploaded.id)).toString() === uploadBody);

const { storeFile } = await import('../core/files.js');
const generated = storeFile(Buffer.from(''), 'leer.txt', 'text/plain');
check('Leere Datei: verschlüsselt gespeichert', isEncryptedBlob(path.join(storageDir, generated.stored_name)));

// Ein Upload mit der Endung, die früher die Zwischendateien trugen, ist ein
// ganz normaler Upload und muss die Umstellung überstehen.
const oddBody = `%PDF-1.4 ungewoehnliche Endung ${'z'.repeat(500)}`;
const odd = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bericht.verschluesseln"\r\nContent-Type: application/pdf\r\n\r\n${oddBody}\r\n--${boundary}--\r\n`,
  ),
});
const oddFile = odd.json().file as { id: number; stored_name: string };
// Rest eines abgebrochenen Laufs liegt im Arbeitsverzeichnis neben storage/.
const conversionDir = path.join(storageDir, '.umstellung');
fs.mkdirSync(conversionDir, { recursive: true });
fs.writeFileSync(path.join(conversionDir, 'altbestand.pdf'), 'abgebrochener Lauf');
const converted = await encryptStoredFiles();
check('Umstellung der Dateiablage: genau der Altbestand', converted.encrypted === 1 && converted.failed === 0, converted);
check(
  'Upload mit Endung .verschluesseln übersteht die Umstellung',
  fs.existsSync(path.join(storageDir, oddFile.stored_name)) && (await download(oddFile.id)).toString() === oddBody,
  oddFile,
);
const legacyPath = path.join(storageDir, 'altbestand.pdf');
check('Altbestand liegt jetzt verschlüsselt im Storage', isEncryptedBlob(legacyPath) && !containsText(legacyPath, BLOB_MARKER));
check('Altbestand wird nach der Umstellung identisch ausgeliefert', (await download(legacyId)).equals(legacyBlob));
check('Arbeitsverzeichnis der Umstellung aufgeräumt', !fs.existsSync(conversionDir));
const totalChanges = () => (getDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n;
const changesBefore = totalChanges();
const again = await encryptStoredFiles();
check('Zweiter Lauf stellt nichts mehr um', again.encrypted === 0 && again.failed === 0, again);
check('Zweiter Lauf schreibt keine Fingerabdrücke neu', totalChanges() === changesBefore, totalChanges() - changesBefore);
const checkedNames = () =>
  (getDb().prepare('SELECT name FROM _storage_checked').all() as { name: string }[]).map((r) => r.name);
const storageFiles = () => fs.readdirSync(storageDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
check(
  'Jede geprüfte Datei steht mit Fingerabdruck in der Datenbank',
  checkedNames().length === storageFiles().length && checkedNames().includes('altbestand.pdf'),
  { checked: checkedNames().length, files: storageFiles().length },
);
{
  const lateKey = storageKeyFrom(fs.readFileSync(keyFile, 'utf8').trim());
  // Neu zurückgelegt: eine Klartextdatei und eine Datei der ersten Fassung.
  const latePlain = path.join(storageDir, 'spaeter-zurueckgelegt.pdf');
  fs.writeFileSync(latePlain, `%PDF-1.4 ${BLOB_MARKER} spaeter`);
  const v1Body = Buffer.from(`Fassung-1 im Bestand ${'w'.repeat(200_000)}`);
  const v1Nonce = crypto.randomBytes(12);
  const v1Cipher = crypto.createCipheriv('aes-256-gcm', lateKey, v1Nonce);
  const lateV1 = path.join(storageDir, 'fassung1-im-bestand');
  fs.writeFileSync(
    lateV1,
    Buffer.concat([Buffer.from('OHRGENC\x01', 'latin1'), v1Nonce, v1Cipher.update(v1Body), v1Cipher.final(), v1Cipher.getAuthTag()]),
  );
  const late = await encryptStoredFiles();
  const v1Back = await readAll(await openBlob(lateV1, () => lateKey));
  check(
    'Zurückgelegte Dateien werden umgestellt (Klartext und Fassung 1 auf Fassung 2)',
    late.encrypted === 2 &&
      late.failed === 0 &&
      blobKind(latePlain) === 'v2' &&
      !containsText(latePlain, BLOB_MARKER) &&
      blobKind(lateV1) === 'v2' &&
      v1Back.data.equals(v1Body),
    { late, plain: blobKind(latePlain), v1: blobKind(lateV1) },
  );
  fs.rmSync(latePlain);
  fs.rmSync(lateV1);

  // Kopie mit erhaltenen Zeitstempeln über eine schon geprüfte Datei, wie
  // Copy-Item, Explorer oder robocopy unter Windows (dort bleibt sogar die
  // ctime der Quelle; eine Zeitmarke liesse diese Datei liegen).
  const legacySource = path.join(work, 'altbestand-aus-alter-sicherung.pdf');
  fs.writeFileSync(legacySource, legacyBlob);
  const longAgo = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(legacySource, longAgo, longAgo);
  fs.copyFileSync(legacySource, legacyPath);
  const copied = await encryptStoredFiles();
  check(
    'Über eine geprüfte Datei kopierter Klartext (alte Zeitstempel) wird umgestellt',
    copied.encrypted === 1 && blobKind(legacyPath) === 'v2' && (await download(legacyId)).equals(legacyBlob),
    { copied, kind: blobKind(legacyPath) },
  );

  // Überschrieben an Ort und Stelle (dieselbe Datei-ID, nur Inhalt neu).
  fs.writeFileSync(legacyPath, legacyBlob);
  const overwritten = await encryptStoredFiles();
  check(
    'An Ort und Stelle mit Klartext überschriebene Datei wird umgestellt',
    overwritten.encrypted === 1 && blobKind(legacyPath) === 'v2' && (await download(legacyId)).equals(legacyBlob),
    { overwritten, kind: blobKind(legacyPath) },
  );

  // Eine Datei, die dauerhaft scheitert (Fassung 1 mit falschem Prüfwert),
  // bekommt keinen Eintrag und kommt bei jedem Lauf wieder dran; alle
  // anderen bleiben vermerkt.
  const broken = path.join(storageDir, 'dauerhaft-kaputt');
  const brokenNonce = crypto.randomBytes(12);
  const brokenCipher = crypto.createCipheriv('aes-256-gcm', lateKey, brokenNonce);
  const brokenBytes = Buffer.concat([
    Buffer.from('OHRGENC\x01', 'latin1'),
    brokenNonce,
    brokenCipher.update(Buffer.from('kaputt')),
    brokenCipher.final(),
    Buffer.alloc(16),
  ]);
  fs.writeFileSync(broken, brokenBytes);
  const firstFail = await encryptStoredFiles();
  const secondFail = await encryptStoredFiles();
  check(
    'Dauerhaft scheiternde Datei: ohne Eintrag, bei jedem Lauf erneut versucht, die übrigen bleiben vermerkt',
    firstFail.failed === 1 &&
      secondFail.failed === 1 &&
      secondFail.encrypted === 0 &&
      !checkedNames().includes('dauerhaft-kaputt') &&
      checkedNames().length === storageFiles().length - 1 &&
      fs.readFileSync(broken).equals(brokenBytes),
    { firstFail, secondFail, checked: checkedNames().length, files: storageFiles().length },
  );
  fs.rmSync(broken);
  const cleared = await encryptStoredFiles();
  check('Nach dem Entfernen der kaputten Datei ist alles vermerkt', cleared.failed === 0 && checkedNames().length === storageFiles().length, {
    cleared,
  });
}

// Beschädigte Dateien. Der Upload oben hat zwei Abschnitte (64 KiB und den
// Rest). Ein beschädigter ANFANG wird vor dem ersten Byte erkannt; ein
// beschädigter späterer Abschnitt bricht den Strom ab, hinausgegangen ist
// dann nur Geprüftes.
async function rawDownload(fileId: number) {
  const sign = await app.inject({ method: 'POST', url: `/api/files/${fileId}/sign`, headers: auth });
  return app.inject({ method: 'GET', url: sign.json().url });
}
async function readAll(stream: NodeJS.ReadableStream): Promise<{ data: Buffer; error: unknown }> {
  const parts: Buffer[] = [];
  try {
    for await (const chunk of stream) parts.push(chunk as Buffer);
    return { data: Buffer.concat(parts), error: null };
  } catch (error) {
    return { data: Buffer.concat(parts), error };
  }
}
const storageKey = storageKeyFrom(fs.readFileSync(keyFile, 'utf8').trim());
{
  const original = fs.readFileSync(uploadedPath);
  const damaged = Buffer.from(original);
  damaged[31 + 100] ^= 0xff;
  fs.writeFileSync(uploadedPath, damaged);
  const res = await rawDownload(uploaded.id);
  check(
    'Beschädigter Anfang: Fehlerantwort statt Inhalt',
    res.statusCode === 500 && !res.rawPayload.toString().includes(UPLOAD_MARKER) && res.json().error?.code === 'INTERNAL_ERROR',
    { status: res.statusCode, head: res.rawPayload.toString().slice(0, 80) },
  );
  check('Beschädigter Anfang: kein Anhang-Kopf', res.headers['content-disposition'] === undefined, res.headers['content-disposition']);

  const tail = Buffer.from(original);
  tail[tail.length - 1] ^= 0xff;
  fs.writeFileSync(uploadedPath, tail);
  const partial = await readAll(await openBlob(uploadedPath, () => storageKey));
  check(
    'Beschädigter späterer Abschnitt: Strom bricht ab, ausgeliefert ist nur der geprüfte erste Abschnitt',
    partial.error instanceof BlobIntegrityError && partial.data.equals(Buffer.from(uploadBody).subarray(0, 64 * 1024)),
    { error: String(partial.error), delivered: partial.data.length },
  );
  const midDownload = await Promise.race([
    rawDownload(uploaded.id).then(
      (r) => (r.rawPayload.equals(Buffer.from(uploadBody)) ? 'vollständig' : `abgebrochen nach ${r.rawPayload.length} Byte`),
      () => 'abgebrochen',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('hängt'), 10_000)),
  ]);
  check('Beschädigter späterer Abschnitt: Download bricht ab statt vollständig zu wirken', midDownload.startsWith('abgebrochen'), midDownload);

  // Abgeschnitten auf Kennung plus wenige Bytes: beschädigt, nicht Klartext.
  fs.writeFileSync(uploadedPath, original.subarray(0, 12));
  const short = await rawDownload(uploaded.id);
  check('Abgeschnittener Blob: Fehlerantwort', short.statusCode === 500, { status: short.statusCode, body: short.rawPayload.toString().slice(0, 80) });

  // Unlesbar (Verzeichnis statt Datei): Fehler im einheitlichen Schema, ohne Anhang-Kopf.
  fs.rmSync(uploadedPath);
  fs.mkdirSync(uploadedPath);
  const unreadable = await rawDownload(uploaded.id);
  check(
    'Unlesbare Datei: Fehlerschema ohne Anhang-Kopf',
    unreadable.statusCode === 500 && unreadable.headers['content-disposition'] === undefined && unreadable.json().error !== undefined,
    { status: unreadable.statusCode, disposition: unreadable.headers['content-disposition'] },
  );
  fs.rmdirSync(uploadedPath);
  fs.writeFileSync(uploadedPath, original);
  check('Nach dem Zurücklegen wieder lesbar', (await download(uploaded.id)).toString() === uploadBody);
}

// Alle drei Schreibwege (Speicher, Upload-Strom, Umstellung) an den Grenzen
// der Abschnitte, jeweils zurückgelesen über openBlob.
{
  const blobDir = path.join(work, 'abschnitte');
  const blobTmp = path.join(blobDir, '.umstellung');
  fs.mkdirSync(blobTmp, { recursive: true });
  const failed: string[] = [];
  for (const size of [0, 1, 65_535, 65_536, 65_537, 131_072, 200_001]) {
    const plain = crypto.randomBytes(size);
    const viaBuffer = path.join(blobDir, `speicher-${size}`);
    fs.writeFileSync(viaBuffer, encryptBuffer(storageKey, plain));
    const viaStream = path.join(blobDir, `strom-${size}`);
    const pieces = Array.from({ length: Math.ceil(size / 10_000) }, (_, k) => plain.subarray(k * 10_000, (k + 1) * 10_000));
    await streamPipeline(Readable.from(pieces, { objectMode: false }), encryptingStream(storageKey), fs.createWriteStream(viaStream));
    const inPlace = path.join(blobDir, `umstellung-${size}`);
    fs.writeFileSync(inPlace, plain);
    await encryptBlobInPlace(inPlace, storageKey, blobTmp);
    for (const file of [viaBuffer, viaStream, inPlace]) {
      const back = await readAll(await openBlob(file, () => storageKey));
      if (back.error || !back.data.equals(plain) || blobKind(file) !== 'v2') failed.push(path.basename(file));
    }
  }
  check('Abschnitte: alle Schreibwege und Grössen kommen unverändert zurück', failed.length === 0, failed);

  // Fehlender letzter Abschnitt (abgeschnitten genau an einer Grenze): Der
  // vorletzte trägt nicht das Schlusskennzeichen, die Prüfung scheitert.
  const cut = path.join(blobDir, 'speicher-200001');
  const whole = fs.readFileSync(cut);
  fs.writeFileSync(cut, whole.subarray(0, 31 + 3 * (64 * 1024 + 16)));
  const truncated = await readAll(await openBlob(cut, () => storageKey));
  check('Abschnitte: an einer Grenze abgeschnittene Datei fällt auf', truncated.error instanceof BlobIntegrityError, String(truncated.error));
  check('Abschnitte: status zählt eine zu kurze Datei als beschädigt', (() => {
    const shortFile = path.join(blobDir, 'kurz');
    fs.writeFileSync(shortFile, whole.subarray(0, 20));
    return blobKind(shortFile) === 'damaged';
  })());

  // Fassung 1 (ein Prüfwert am Ende) bleibt lesbar.
  const v1Plain = Buffer.from(`Fassung-1-Inhalt ${'v'.repeat(3000)}`);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', storageKey, nonce);
  const v1File = path.join(blobDir, 'fassung1');
  fs.writeFileSync(v1File, Buffer.concat([Buffer.from('OHRGENC\x01', 'latin1'), nonce, cipher.update(v1Plain), cipher.final(), cipher.getAuthTag()]));
  const v1Back = await readAll(await openBlob(v1File, () => storageKey));
  check('Fassung 1 bleibt lesbar', blobKind(v1File) === 'v1' && v1Back.error === null && v1Back.data.equals(v1Plain), String(v1Back.error));
  // Fassung 1 mit falschem Prüfwert: Die Umstellung wirft und lässt die Datei, wie sie ist.
  const v1Bad = path.join(blobDir, 'fassung1-kaputt');
  const badBytes = fs.readFileSync(v1File);
  badBytes[badBytes.length - 1] ^= 0xff;
  fs.writeFileSync(v1Bad, badBytes);
  let badError: unknown = null;
  try {
    await encryptBlobInPlace(v1Bad, storageKey, blobTmp);
  } catch (err) {
    badError = err;
  }
  check(
    'Fassung 1 mit falschem Prüfwert: Umstellung bricht ab, Datei unverändert',
    badError instanceof BlobIntegrityError && fs.readFileSync(v1Bad).equals(badBytes) && fs.readdirSync(blobTmp).length === 0,
    String(badError),
  );
  const upgraded = await encryptBlobInPlace(v1File, storageKey, blobTmp);
  const v1After = await readAll(await openBlob(v1File, () => storageKey));
  check('Fassung 1 wird auf Fassung 2 umgeschrieben, Inhalt gleich', upgraded && blobKind(v1File) === 'v2' && v1After.data.equals(v1Plain));

  // Erst eingreifen, wenn die Umstellung liest und schreibt (ihre
  // Zwischendatei existiert); vorher träfe der Eingriff nur das Öffnen.
  const conversionUnderway = async (file: string) => {
    const tmp = path.join(blobTmp, path.basename(file));
    for (let i = 0; i < 100_000 && !fs.existsSync(tmp); i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // Während der Umstellung gelöscht: Die Datei bleibt weg (vorher legte das
  // Umbenennen sie wieder an, verschlüsselt und ohne Datensatz).
  const vanishing = path.join(blobDir, 'wird-geloescht');
  fs.writeFileSync(vanishing, crypto.randomBytes(8 * 1024 * 1024));
  const pending = encryptBlobInPlace(vanishing, storageKey, blobTmp).then(
    () => null,
    (err: unknown) => err as NodeJS.ErrnoException,
  );
  await conversionUnderway(vanishing);
  fs.rmSync(vanishing);
  const vanishedError = await pending;
  check(
    'Während der Umstellung gelöschte Datei entsteht nicht wieder',
    vanishedError?.code === 'ENOENT' && !fs.existsSync(vanishing) && fs.readdirSync(blobTmp).length === 0,
    { error: String(vanishedError), exists: fs.existsSync(vanishing), tmp: fs.readdirSync(blobTmp) },
  );

  // Während der Umstellung verändert: Das Original bleibt, wie es jetzt ist.
  const growing = path.join(blobDir, 'waechst');
  fs.writeFileSync(growing, crypto.randomBytes(8 * 1024 * 1024));
  const growingPending = encryptBlobInPlace(growing, storageKey, blobTmp).then(
    () => null,
    (err: unknown) => err as NodeJS.ErrnoException,
  );
  await conversionUnderway(growing);
  fs.appendFileSync(growing, 'nachgeschrieben');
  const grownError = await growingPending;
  check(
    'Während der Umstellung veränderte Datei bleibt unverändert liegen (nächster Lauf)',
    grownError instanceof Error &&
      grownError.code !== 'ENOENT' &&
      blobKind(growing) === 'plaintext' &&
      fs.readFileSync(growing).subarray(-15).toString() === 'nachgeschrieben' &&
      fs.readdirSync(blobTmp).length === 0,
    { error: String(grownError), kind: blobKind(growing) },
  );
}

// Ein Upload, der gerade beginnt, ist eine leere Datei: Die Umstellung lässt
// sie ohne Eintrag liegen; eine alte leere Datei stellt sie um.
{
  const emptyUpload = path.join(storageDir, 'upload-beginnt');
  fs.writeFileSync(emptyUpload, '');
  const fresh = await encryptStoredFiles();
  const skippedFresh =
    fresh.encrypted === 0 && fresh.failed === 0 && fs.statSync(emptyUpload).size === 0 && !checkedNames().includes('upload-beginnt');
  const longAgo = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(emptyUpload, longAgo, longAgo);
  const old = await encryptStoredFiles();
  check(
    'Leere Datei: frisch übersprungen (Upload in Arbeit), alt umgestellt',
    skippedFresh && old.encrypted === 1 && blobKind(emptyUpload) === 'v2' && checkedNames().includes('upload-beginnt'),
    { fresh, old, kind: blobKind(emptyUpload) },
  );
  fs.rmSync(emptyUpload);
  await encryptStoredFiles();
  check('Eintrag einer gelöschten Datei fällt weg', !checkedNames().includes('upload-beginnt'));
}

const fileRows = (getDb().prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
await app.close();
getDb().pragma('wal_checkpoint(TRUNCATE)');
closeDb();

// ---------------------------------------------------------------------------
// 4. Betreiberwerkzeuge und Sicherung gegen den verschlüsselten Bestand
// ---------------------------------------------------------------------------
function runTool(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join('src/scripts', script), ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, OHRGANIZE_DATA_DIR: dataDir, ...env },
  });
}

if (runningAsRoot) console.log('- Betreiberwerkzeuge und Sicherung übersprungen (Lauf als root).');
if (!runningAsRoot) {
const status = runTool('status.ts', ['--data-dir', dataDir, '--json']);
let statusJson: { counts?: { files?: number }; encryption?: { database?: string; key?: string; storage?: string } } = {};
try {
  statusJson = JSON.parse(status.stdout);
} catch {
  // bleibt leer, der Check unten meldet es
}
check('status liest den verschlüsselten Bestand', status.status === 0 && statusJson.counts?.files === fileRows, status.stderr || status.stdout);
check(
  'status meldet den Verschlüsselungszustand',
  statusJson.encryption?.database === 'encrypted' &&
    statusJson.encryption?.key === 'internal' &&
    statusJson.encryption?.storage === 'encrypted',
  statusJson.encryption,
);
fs.writeFileSync(path.join(storageDir, 'klartext-rest.pdf'), 'unverschluesselter Rest');
const mixed = runTool('status.ts', ['--data-dir', dataDir, '--json']);
let mixedJson: { encryption?: { storage?: string; storage_plaintext_files?: number } } = {};
try {
  mixedJson = JSON.parse(mixed.stdout);
} catch {
  // bleibt leer, der Check meldet es
}
check(
  'status meldet Klartextdateien in storage/',
  mixedJson.encryption?.storage === 'mixed' && mixedJson.encryption?.storage_plaintext_files === 1,
  mixedJson.encryption,
);
fs.rmSync(path.join(storageDir, 'klartext-rest.pdf'));

// Vermerk der Umstellung: status meldet ihn (provision.sh check liest das Feld).
const statusMark = path.join(dataDir, 'umstellung-pruefung-gescheitert.txt');
fs.writeFileSync(statusMark, 'Probe');
const marked = runTool('status.ts', ['--data-dir', dataDir, '--json']);
const markedText = runTool('status.ts', ['--data-dir', dataDir]);
fs.rmSync(statusMark);
let markedJson: { encryption?: { conversion_marker?: number } } = {};
try {
  markedJson = JSON.parse(marked.stdout);
} catch {
  // bleibt leer, der Check meldet es
}
check(
  'status meldet den Vermerk der Umstellung (JSON und Text)',
  markedJson.encryption?.conversion_marker === 1 && /Pruefung NICHT bestanden/.test(markedText.stdout),
  { json: markedJson.encryption, text: markedText.stdout.slice(0, 400) },
);
check('status ohne Vermerk: conversion_marker 0', (statusJson.encryption as { conversion_marker?: number } | undefined)?.conversion_marker === 0, statusJson.encryption);

// Zwischendateien einer laufenden Umstellung gehören nicht zum Bestand.
const conversionLeftover = path.join(storageDir, '.umstellung');
fs.mkdirSync(conversionLeftover, { recursive: true });
fs.writeFileSync(path.join(conversionLeftover, 'zwischendatei'), 'halb geschrieben');
const withLeftover = runTool('status.ts', ['--data-dir', dataDir, '--json']);
let leftoverJson: { storage?: { files?: number } } = {};
try {
  leftoverJson = JSON.parse(withLeftover.stdout);
} catch {
  // bleibt leer, der Check meldet es
}
fs.rmSync(conversionLeftover, { recursive: true, force: true });
check(
  'status zählt Zwischendateien der Umstellung nicht als Dateien',
  leftoverJson.storage?.files === fs.readdirSync(storageDir, { withFileTypes: true }).filter((e) => e.isFile()).length,
  { status: leftoverJson.storage, files: fs.readdirSync(storageDir) },
);

const migrateCheck = runTool('migrate-check.ts', ['--db', dbFile]);
check('migrate-check läuft auf einer verschlüsselten Kopie', migrateCheck.status === 0, migrateCheck.stderr || migrateCheck.stdout);

const reset = runTool('admin-reset.ts', ['--data-dir', dataDir, '--email', 'admin@ohrganize.de']);
check('admin-reset schreibt in den verschlüsselten Bestand', reset.status === 0, reset.stderr || reset.stdout);

// Eine abgeschnittene, alte Datei muss im MANIFEST stehen (vorher trug unter
// Linux jede Kopie die Uhrzeit des Kopierens und galt als Upload in Arbeit).
const damagedBlob = path.join(storageDir, 'abgeschnitten');
fs.writeFileSync(damagedBlob, Buffer.concat([Buffer.from('OHRGENC\x02', 'latin1'), Buffer.alloc(10)]));
const longAgoDamaged = new Date('2020-01-01T00:00:00Z');
fs.utimesSync(damagedBlob, longAgoDamaged, longAgoDamaged);
const backupOut = path.join(work, 'backups');
const backup = runTool('backup.ts', ['--out', backupOut, '--quiet']);
fs.rmSync(damagedBlob);
check('Sicherung läuft durch', backup.status === 0, backup.stderr || backup.stdout);
const backupDir = fs.existsSync(backupOut)
  ? fs.readdirSync(backupOut).filter((n) => n.startsWith('ohrganize-')).map((n) => path.join(backupOut, n))[0]
  : undefined;
if (backupDir) {
  const backupDb = path.join(backupDir, 'ohrganize.db');
  check('Sicherung: Datenbank verschlüsselt', databaseState(backupDb) === 'encrypted' && !containsText(backupDb, DB_MARKER));
  check('Sicherung: data.key und secret.key enthalten', fs.existsSync(path.join(backupDir, DATA_KEY_FILE)) && fs.existsSync(path.join(backupDir, 'secret.key')));
  check('Sicherung: Blobs verschlüsselt', !containsText(path.join(backupDir, 'storage', 'altbestand.pdf'), BLOB_MARKER));
  check('Sicherung: MANIFEST nennt data.key', containsText(path.join(backupDir, 'MANIFEST.txt'), 'data.key'));
  check(
    'Sicherung: MANIFEST nennt eine abgeschnittene Datei (Kopie mit erhaltenen Zeitstempeln)',
    containsText(path.join(backupDir, 'MANIFEST.txt'), '1 abgeschnitten und nicht lesbar') &&
      fs.statSync(path.join(backupDir, 'storage', 'abgeschnitten')).mtimeMs === longAgoDamaged.getTime(),
  );
  // Restore-Probe: Die Sicherung öffnet für sich genommen (Schlüssel liegt daneben).
  const restored = openDatabase(backupDb, { readonly: true, fileMustExist: true }).db;
  const row = restored.prepare("SELECT details FROM audit_log WHERE action = 'test.marker'").get() as { details: string };
  check('Sicherung: mit ihrem eigenen data.key lesbar', row.details.includes(DB_MARKER));
  check('Sicherung: keine -wal/-shm neben der Kopie', !fs.existsSync(`${backupDb}-wal`) && !fs.existsSync(`${backupDb}-shm`));
  restored.close();
} else {
  check('Sicherungsordner gefunden', false, backup.stderr || backup.stdout);
}
}

// ---------------------------------------------------------------------------
// 5. Fehlender und falscher Schlüssel, Schlüssel außerhalb
// ---------------------------------------------------------------------------
function copyOfDataDir(name: string): string {
  const target = path.join(work, name);
  fs.mkdirSync(target);
  fs.copyFileSync(dbFile, path.join(target, 'ohrganize.db'));
  return target;
}
function messageOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const noKey = copyOfDataDir('ohne-schluessel');
const missing = messageOf(() => openDatabase(path.join(noKey, 'ohrganize.db'), { createKey: true }));
check('Fehlender Schlüssel: klare Meldung statt neuem Schlüssel', missing.includes('Schlüssel fehlt') && !fs.existsSync(path.join(noKey, DATA_KEY_FILE)), missing);
if (!runningAsRoot) {
  const statusNoKey = runTool('status.ts', ['--data-dir', noKey, '--json']);
  check('Werkzeug ohne Schlüssel bricht mit Erklärung ab', statusNoKey.status === 1 && statusNoKey.stderr.includes('Schlüssel fehlt'), statusNoKey.stderr);
}

const wrongKey = copyOfDataDir('falscher-schluessel');
fs.writeFileSync(path.join(wrongKey, DATA_KEY_FILE), crypto.randomBytes(32).toString('hex'));
const wrong = messageOf(() => openDatabase(path.join(wrongKey, 'ohrganize.db')));
check('Falscher Schlüssel: klare Meldung', wrong.includes('nicht öffnen'), wrong);

const badKey = copyOfDataDir('kaputter-schluessel');
fs.writeFileSync(path.join(badKey, DATA_KEY_FILE), 'kein schluessel');
check('Unlesbare Schlüsseldatei: klare Meldung', messageOf(() => readDataKey(badKey)).includes('64 Hex-Zeichen'));

// Schlüssel außerhalb: data.key verweist auf eine Datei in einem anderen Ordner.
const external = copyOfDataDir('extern');
fs.cpSync(storageDir, path.join(external, 'storage'), { recursive: true });
fs.copyFileSync(path.join(dataDir, 'secret.key'), path.join(external, 'secret.key'));
const vault = path.join(work, 'tresor');
fs.mkdirSync(vault);
const vaultKey = path.join(vault, 'kunde.key');
fs.copyFileSync(keyFile, vaultKey);
fs.writeFileSync(path.join(external, DATA_KEY_FILE), `﻿extern:${vaultKey}\r\n`);
const viaPointer = readDataKey(external);
check('Verweis auf Schlüssel außerhalb wird gelesen (mit BOM und CRLF)', viaPointer?.external === true && viaPointer.file === vaultKey, viaPointer);
const externalDb = openDatabase(path.join(external, 'ohrganize.db'), { readonly: true }).db;
check('Bestand mit Schlüssel außerhalb öffnet', (externalDb.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n === fileRows);
externalDb.close();

if (!runningAsRoot) {
const externalBackupOut = path.join(work, 'backups-extern');
const externalBackup = runTool('backup.ts', ['--out', externalBackupOut, '--quiet'], { OHRGANIZE_DATA_DIR: external });
check('Sicherung mit Schlüssel außerhalb läuft durch', externalBackup.status === 0, externalBackup.stderr || externalBackup.stdout);
const externalBackupDir = fs.existsSync(externalBackupOut)
  ? fs.readdirSync(externalBackupOut).filter((n) => n.startsWith('ohrganize-')).map((n) => path.join(externalBackupOut, n))[0]
  : undefined;
if (externalBackupDir) {
  const pointer = fs.readFileSync(path.join(externalBackupDir, DATA_KEY_FILE), 'utf8');
  check('Sicherung enthält nur den Verweis, nicht den Schlüssel', pointer.includes('extern:') && !pointer.includes(viaPointer!.hex));
  check('Sicherung ohne secret.key, wenn der Schlüssel außerhalb liegt', !fs.existsSync(path.join(externalBackupDir, 'secret.key')));
  const manifest = fs.readFileSync(path.join(externalBackupDir, 'MANIFEST.txt'), 'utf8');
  check(
    'MANIFEST nennt nur, was die Sicherung enthält',
    manifest.includes(`Zuerst die Schlüsseldatei wieder ablegen: ${vaultKey}`) &&
      !manifest.includes('cp -a secret.key') &&
      !manifest.includes('Copy-Item secret.key'),
    manifest,
  );
  fs.rmSync(vaultKey);
  const unreadable = messageOf(() => openDatabase(path.join(externalBackupDir, 'ohrganize.db'), { readonly: true }));
  check('Diese Sicherung ist ohne die Schlüsseldatei nicht lesbar', unreadable.includes('fehlt'), unreadable);
} else {
  check('Sicherungsordner (Schlüssel außerhalb) gefunden', false, externalBackup.stderr || externalBackup.stdout);
}
}

// Verweis ohne absoluten Pfad wird abgewiesen.
fs.writeFileSync(path.join(badKey, DATA_KEY_FILE), 'extern:kunde.key');
check('Verweis mit relativem Pfad: klare Meldung', messageOf(() => readDataKey(badKey)).includes('absoluter Pfad'));

// Neue Datenbank ohne Vorbestand entsteht verschlüsselt.
const fresh = path.join(work, 'frisch');
fs.mkdirSync(fresh);
const freshDb = openDatabase(path.join(fresh, 'ohrganize.db'), { createKey: true });
freshDb.db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('frisch-geheim')");
freshDb.db.close();
check(
  'Neue Datenbank entsteht verschlüsselt, Schlüssel wird angelegt',
  freshDb.encrypted && databaseState(path.join(fresh, 'ohrganize.db')) === 'encrypted' && fs.existsSync(path.join(fresh, DATA_KEY_FILE)),
);
// Werkzeuge erzeugen nie einen Schlüssel.
const toolFresh = path.join(work, 'werkzeug');
fs.mkdirSync(toolFresh);
openDatabase(path.join(toolFresh, 'ohrganize.db')).db.close();
check('Ohne createKey entsteht kein Schlüssel', !fs.existsSync(path.join(toolFresh, DATA_KEY_FILE)));

// ---------------------------------------------------------------------------
// 6. Umstellung wartet auf eine andere offene Verbindung
// ---------------------------------------------------------------------------
{
  const busyDir = path.join(work, 'belegt');
  fs.mkdirSync(busyDir);
  const busyDb = path.join(busyDir, 'ohrganize.db');
  const seedDb = new Database(busyDb);
  seedDb.pragma('journal_mode = WAL');
  seedDb.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('belegt-geheim')");
  seedDb.close();
  // Zweiter Prozess hält die Datenbank im WAL-Modus 1,5 Sekunden offen, wie
  // ein Werkzeug oder eine Sicherung beim Dienststart.
  const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const holder = spawn(
    process.execPath,
    [
      '-e',
      "const D=require(process.argv[1]);const d=new D(process.argv[2]);d.pragma('journal_mode = WAL');" +
        "d.prepare('SELECT count(*) FROM t').get();console.log('bereit');setTimeout(()=>{d.close();process.exit(0)},1500)",
      modulePath,
      busyDb,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Halteprozess meldet sich nicht')), 15_000);
    holder.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('bereit')) {
        clearTimeout(timer);
        resolve();
      }
    });
    holder.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Halteprozess beendet vor "bereit" (Code ${code})`));
    });
  });
  const started = Date.now();
  let message = '';
  try {
    encryptDatabaseFile(busyDb, busyDir);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  const waited = Date.now() - started;
  await new Promise((resolve) => holder.once('exit', resolve));
  const reopened = message ? null : openDatabase(busyDb, { readonly: true }).db;
  const value = reopened ? (reopened.prepare('SELECT v FROM t').get() as { v: string }).v : null;
  reopened?.close();
  check(
    'Umstellung wartet auf eine offene Verbindung und gelingt danach',
    message === '' && waited >= 500 && databaseState(busyDb) === 'encrypted' && value === 'belegt-geheim',
    { message, waited, state: databaseState(busyDb), value },
  );
}

// ---------------------------------------------------------------------------
// 7. Migration 502 räumt die alten Umfragezeilen auch aus der Datei
// ---------------------------------------------------------------------------
{
  const surveyDb = path.join(work, 'umfrage.db');
  const m = new Database(surveyDb);
  migrateAgain(m);
  // Stand vor 502 nachbauen: alte Tabelle mit Zeitstempel und fortlaufender ID.
  m.pragma('foreign_keys = OFF');
  m.exec(`DROP TABLE survey_responses;
    CREATE TABLE survey_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      answers TEXT NOT NULL);
    ALTER TABLE survey_participations ADD COLUMN participated_at TEXT NOT NULL DEFAULT '';
    INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (1, 'Probe', '2026-01-01', '2026-12-31', 'laufend');`);
  const r = m.prepare("INSERT INTO survey_responses (survey_id, submitted_at, answers) VALUES (1, ?, '[]')");
  const p = m.prepare('INSERT INTO survey_participations (survey_id, employee_id, participated_at) VALUES (1, ?, ?)');
  for (let i = 1; i <= 50; i++) {
    r.run(`ALTZEIT-${i}`);
    p.run(i, `TEILZEIT-${i}`);
  }
  m.prepare("DELETE FROM _migrations WHERE name IN ('502_survey_anonymity', '503_survey_response_ids')").run();
  m.close();
  const m2 = new Database(surveyDb);
  m2.pragma('foreign_keys = OFF');
  const applied = migrateAgain(m2);
  const kept = (m2.prepare('SELECT count(*) AS n FROM survey_responses').get() as { n: number }).n;
  const maxId = (m2.prepare('SELECT max(id) AS m FROM survey_responses').get() as { m: number }).m;
  const index = m2.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'idx_survey_responses_survey'").get();
  m2.close();
  check(
    'Migration 502 entfernt die alten Zeitstempel auch aus der Datei (VACUUM)',
    applied.includes('502_survey_anonymity') && kept === 50 && !containsText(surveyDb, 'ALTZEIT-') && !containsText(surveyDb, 'TEILZEIT-'),
    { applied, kept, alt: containsText(surveyDb, 'ALTZEIT-'), teil: containsText(surveyDb, 'TEILZEIT-') },
  );
  check(
    'Migration 503: Antwort-IDs im Bereich neuer Antworten (unter 2^48), kein Index auf survey_id',
    applied.includes('503_survey_response_ids') && maxId < 2 ** 48 && index === undefined,
    { applied, maxId, index },
  );
}
// Dasselbe OHNE VACUUM (übersprungen, weil zu gross, oder gescheitert):
// Migrationen laufen unter secure_delete, entfernte Zeitstempel sind trotzdem weg.
{
  const surveyDb = path.join(work, 'umfrage-ohne-vacuum.db');
  const m = new Database(surveyDb);
  m.pragma('journal_mode = DELETE');
  migrateAgain(m);
  m.pragma('foreign_keys = OFF');
  m.exec(`DROP TABLE survey_responses;
    CREATE TABLE survey_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      answers TEXT NOT NULL);
    ALTER TABLE survey_participations ADD COLUMN participated_at TEXT NOT NULL DEFAULT '';
    INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (1, 'Probe', '2026-01-01', '2026-12-31', 'laufend');`);
  const r = m.prepare("INSERT INTO survey_responses (survey_id, submitted_at, answers) VALUES (?, ?, '[]')");
  const p = m.prepare('INSERT INTO survey_participations (survey_id, employee_id, participated_at) VALUES (1, ?, ?)');
  const e = m.prepare("INSERT INTO employees (id, first_name, last_name) VALUES (?, 'Probe', ?)");
  for (let i = 1; i <= 300; i++) {
    e.run(i, `Person ${i}`);
    r.run(1, `ALTZEIT-${i}`);
    p.run(i, `TEILZEIT-${i}`);
  }
  // Verwaist, wie ohne Fremdschlüssel entstanden: Teilnahmen von Personen und
  // eine Antwort einer Umfrage, die es nicht gibt.
  for (let i = 1001; i <= 1020; i++) p.run(i, `TEILZEIT-${i}`);
  r.run(77, 'ALTZEIT-verwaist');
  m.prepare("DELETE FROM _migrations WHERE name IN ('502_survey_anonymity', '503_survey_response_ids')").run();
  // Mit Fremdschlüsseln wie im Dienst (in diesem SQLite-Build ohnehin die
  // Vorgabe): Verwaiste Zeilen dürfen den Lauf nicht abbrechen.
  m.pragma('foreign_keys = ON');
  let migrateError: unknown = null;
  let applied: string[] = [];
  try {
    applied = migrateAgain(m, { vacuum: false });
  } catch (err) {
    migrateError = err;
  }
  const participations = (m.prepare('SELECT count(*) AS n FROM survey_participations').get() as { n: number }).n;
  const responses = (m.prepare('SELECT count(*) AS n FROM survey_responses').get() as { n: number }).n;
  const fkProblems = m.prepare('PRAGMA foreign_key_check').all().length;
  const sequence = (m.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'survey_participations'").get() as { seq: number } | undefined)?.seq;
  m.close();
  check('Migration 502: AUTOINCREMENT-Zähler der Teilnahmen bleibt erhalten (auch über verworfene Zeilen hinaus)', sequence === 320, sequence);
  check(
    'Migration 502/503 ohne VACUUM: keine alten Zeitstempel in der Datei (secure_delete, Neuaufbau)',
    applied.includes('502_survey_anonymity') && !containsText(surveyDb, 'ALTZEIT-') && !containsText(surveyDb, 'TEILZEIT-'),
    { applied, alt: containsText(surveyDb, 'ALTZEIT-'), teil: containsText(surveyDb, 'TEILZEIT-'), error: String(migrateError) },
  );
  check(
    'Migration 502 mit Fremdschlüsseln: verwaiste Zeilen brechen den Lauf nicht ab und fallen weg, alle gültigen bleiben',
    migrateError === null && participations === 300 && responses === 300 && fkProblems === 0,
    { error: String(migrateError), participations, responses, fkProblems },
  );
}

// ---------------------------------------------------------------------------
// 8. Eine vorher geöffnete Verbindung schreibt nach der Umstellung nicht hinein
// ---------------------------------------------------------------------------
{
  const staleDir = path.join(work, 'alt-verbindung');
  fs.mkdirSync(staleDir);
  const staleDb = path.join(staleDir, 'ohrganize.db');
  const seed = new Database(staleDb);
  seed.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('eins'), ('zwei')");
  seed.close();
  // Ein Werkzeug öffnet die Klartextdatei und liest, schreibt aber erst nach
  // der Umstellung, wenn der Dienst sie verschlüsselt im WAL-Modus offen hat.
  // So entstand bei Kopie plus Umbenennen die Beschädigung.
  const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const stale = spawn(
    process.execPath,
    [
      '-e',
      "const D=require(process.argv[1]);const d=new D(process.argv[2],{timeout:2000});d.prepare('SELECT count(*) FROM t').get();" +
        "console.log('bereit');process.stdin.once('data',()=>{let r;try{d.prepare(\"INSERT INTO t VALUES ('alt')\").run();r='geschrieben'}" +
        "catch(e){r='abgewiesen '+e.code}console.log('ERGEBNIS '+r);try{d.close()}catch{}process.exit(0)})",
      modulePath,
      staleDb,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let staleOut = '';
  stale.stdout.on('data', (d: Buffer) => (staleOut += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Werkzeug meldet sich nicht')), 15_000);
    stale.stdout.on('data', () => staleOut.includes('bereit') && (clearTimeout(timer), resolve()));
    stale.once('exit', () => (clearTimeout(timer), reject(new Error('Werkzeug vorzeitig beendet'))));
  });
  encryptDatabaseFile(staleDb, staleDir);
  const service = openDatabase(staleDb, { dataDir: staleDir }).db;
  service.pragma('journal_mode = WAL');
  service.prepare("INSERT INTO t VALUES ('dienst')").run();
  const exited = new Promise((resolve) => stale.once('exit', resolve));
  stale.stdin.write('los\n');
  await exited;
  const rows = (service.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
  const integrity = service.pragma('integrity_check', { simple: true });
  service.close();
  check(
    'Vorher geöffnete Verbindung wird abgewiesen, verschlüsselte Datenbank bleibt intakt',
    /ERGEBNIS abgewiesen/.test(staleOut) && rows === 3 && integrity === 'ok',
    { staleOut: staleOut.trim(), rows, integrity },
  );
}

// ---------------------------------------------------------------------------
// 9. Liegengebliebenes Journal wird vor dem Öffnen zurückgespielt
// ---------------------------------------------------------------------------
// Klartext: wie nach einem Abbruch der Umstellung (Journal ohne Schlüssel
// zurückspielen). Verschlüsselt: wie nach einem Abbruch in einem schon
// verschlüsselten Bestand im Journalmodus DELETE; ohne Schlüssel zurück-
// gespielt, verwürfe SQLite dieses Journal und ließe die halbe Transaktion
// stehen.
for (const encrypted of [false, true]) {
  const hotDir = path.join(work, encrypted ? 'journal-verschluesselt' : 'journal');
  fs.mkdirSync(hotDir);
  const source = path.join(hotDir, 'quelle.db');
  const crashed = path.join(hotDir, 'ohrganize.db');
  const a = openDatabase(source, { dataDir: hotDir, createKey: encrypted }).db;
  a.pragma('journal_mode = DELETE');
  a.pragma('cache_size = 5');
  a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = a.prepare('INSERT INTO t (v) VALUES (?)');
  a.transaction(() => {
    for (let i = 0; i < 2000; i++) insert.run(`vorher-${i}-${'x'.repeat(200)}`);
  })();
  // Absturz mitten in einer Transaktion nachbilden: Datei und Journal kopieren,
  // während die Änderungen schon teilweise in der Datei stehen.
  a.exec('BEGIN');
  a.prepare("UPDATE t SET v = 'nachher'").run();
  fs.copyFileSync(source, crashed);
  fs.copyFileSync(`${source}-journal`, `${crashed}-journal`);
  a.exec('ROLLBACK');
  a.close();
  const hotBefore = fs.statSync(`${crashed}-journal`).size;
  const reopened = openDatabase(crashed, { dataDir: hotDir, readonly: true });
  const changed = (reopened.db.prepare("SELECT count(*) AS n FROM t WHERE v = 'nachher'").get() as { n: number }).n;
  const total = (reopened.db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
  const integrity = reopened.db.pragma('integrity_check', { simple: true });
  reopened.db.close();
  check(
    `Liegengebliebenes Journal (${encrypted ? 'verschlüsselter Bestand' : 'Klartextbestand'}) wird auch für eine lesende Verbindung zurückgespielt`,
    hotBefore > 0 &&
      reopened.encrypted === encrypted &&
      changed === 0 &&
      total === 2000 &&
      integrity === 'ok' &&
      !(fs.existsSync(`${crashed}-journal`) && fs.statSync(`${crashed}-journal`).size > 0),
    { hotBefore, encrypted: reopened.encrypted, changed, total, integrity },
  );
}

// ---------------------------------------------------------------------------
// 10. Scheiterndes Schreiben des Schlüssels hinterlässt keine leere data.key
// ---------------------------------------------------------------------------
{
  const keyDir = path.join(work, 'schluessel-abbruch');
  fs.mkdirSync(keyDir);
  const { createDataKey } = await import('../db/encryption.js');
  const originalWrite = fs.writeSync;
  (fs as { writeSync: typeof fs.writeSync }).writeSync = (() => {
    throw Object.assign(new Error('Kein Platz'), { code: 'ENOSPC' });
  }) as typeof fs.writeSync;
  let failedWrite = false;
  try {
    createDataKey(keyDir);
  } catch {
    failedWrite = true;
  } finally {
    (fs as { writeSync: typeof fs.writeSync }).writeSync = originalWrite;
  }
  check(
    'Abbruch beim Schreiben des Schlüssels: keine data.key, keine Reste',
    failedWrite && fs.readdirSync(keyDir).length === 0,
    fs.readdirSync(keyDir),
  );
  const created = createDataKey(keyDir);
  check('Danach entsteht der Schlüssel normal', /^[0-9a-f]{64}$/.test(created.hex) && fs.readdirSync(keyDir).join(',') === DATA_KEY_FILE);
}

// ---------------------------------------------------------------------------
// 11. VACUUM nach einer Migration: scheitert ohne Startabbruch, wird nachgeholt
// ---------------------------------------------------------------------------
{
  const vacDb = path.join(work, 'vacuum.db');
  const m = new Database(vacDb);
  migrateAgain(m);
  m.exec("CREATE TABLE IF NOT EXISTS _vacuum_pending (since TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO _vacuum_pending DEFAULT VALUES;");
  // VACUUM scheitern lassen (wie bei vollem Datenträger oder Speichermangel):
  // Hülle um die Verbindung, deren exec('VACUUM') wirft.
  const failingVacuum = new Proxy(m, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          if (sql === 'VACUUM') throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const warnings: string[] = [];
  let threw = false;
  try {
    migrateAgain(failingVacuum, { onWarning: (w) => warnings.push(w) });
  } catch {
    threw = true;
  }
  const stillPending = m.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = '_vacuum_pending'").get() !== undefined;
  // Der Probelauf (vacuum: false) lässt Vermerk und VACUUM in Ruhe.
  migrateAgain(m, { vacuum: false, onWarning: (w) => warnings.push(w) });
  const untouchedByProbe = m.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = '_vacuum_pending'").get() !== undefined;
  migrateAgain(m, { onWarning: (w) => warnings.push(w) });
  const pendingAfter = m.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = '_vacuum_pending'").get() !== undefined;
  m.close();
  check(
    'Gescheitertes VACUUM: kein Abbruch, Warnung, Vermerk bleibt; nächster Lauf holt es nach',
    !threw && warnings.length === 1 && stillPending && untouchedByProbe && !pendingAfter,
    { threw, warnings, stillPending, untouchedByProbe, pendingAfter },
  );
}
// VACUUM im Arbeitsspeicher (verschlüsselte Datenbank) nur bis zur
// Obergrenze: darüber endgültig übersprungen, mit einer Warnung, Vermerk weg.
{
  const bigVacDb = path.join(work, 'vacuum-gross.db');
  const m = new Database(bigVacDb);
  migrateAgain(m);
  m.exec("CREATE TABLE IF NOT EXISTS _vacuum_pending (since TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO _vacuum_pending DEFAULT VALUES;");
  let vacuumRan = false;
  const huge = new Proxy(m, {
    get(target, prop) {
      if (prop === 'pragma') {
        return (source: string, options?: { simple?: boolean }) => {
          if (source === 'temp_store') return 2;
          if (source === 'page_count') return 1_000_000; // 4 GB bei 4 KiB je Seite
          return target.pragma(source, options);
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          if (sql === 'VACUUM') vacuumRan = true;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const warnings: string[] = [];
  migrateAgain(huge, { onWarning: (w) => warnings.push(w) });
  const stillPending = m.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = '_vacuum_pending'").get() !== undefined;
  migrateAgain(huge, { onWarning: (w) => warnings.push(w) });
  m.close();
  check(
    'VACUUM im Arbeitsspeicher über der Obergrenze: übersprungen, eine Warnung, Vermerk weg, keine weitere Warnung',
    !vacuumRan && !stillPending && warnings.length === 1 && warnings[0].includes('übersprungen'),
    { vacuumRan, stillPending, warnings },
  );
}

// ---------------------------------------------------------------------------
// 12. Umfrage: Die Lage der Antworten in der Datei verrät die Reihenfolge nicht
// ---------------------------------------------------------------------------
// Klartextdatei, damit die Seite roh lesbar ist. SQLite legt neue Zellen in
// Einfügereihenfolge ab; nach Lage sortiert ergab das vorher genau die
// Reihenfolge der Teilnahmen.
{
  const orderDb = path.join(work, 'reihenfolge.db');
  const m = new Database(orderDb);
  m.pragma('secure_delete = ON'); // wie jede Verbindung über openDatabase
  m.pragma('journal_mode = DELETE');
  m.pragma('foreign_keys = OFF'); // Teilnahmen ohne Personalprofile
  migrateAgain(m, { vacuum: false });
  m.exec("INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (7, 'Probe', '2026-01-01', '2026-12-31', 'laufend')");
  const { storeAnonymousResponse } = await import('../modules/communication/surveyService.js');
  const count = 12;
  const label = (i: number) => `antwort-teilnahme-${String(i).padStart(2, '0')}`;
  for (let i = 1; i <= count; i++) {
    m.transaction(() => {
      m.prepare('INSERT INTO survey_participations (survey_id, employee_id) VALUES (7, ?)').run(1000 + i);
      storeAnonymousResponse(m, 7, JSON.stringify([{ question_id: 1, value: label(i) }]));
    })();
  }
  const root = (m.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'survey_responses'").get() as { rootpage: number }).rootpage;
  const pageSize = m.pragma('page_size', { simple: true }) as number;
  const stored = (m.prepare('SELECT count(*) AS n FROM survey_responses WHERE survey_id = 7').get() as { n: number }).n;
  m.close();
  const raw = fs.readFileSync(orderDb);
  const page = raw.subarray((root - 1) * pageSize, root * pageSize);
  const offsets = Array.from({ length: page.readUInt16BE(3) }, (_, k) => page.readUInt16BE(8 + 2 * k));
  const physical = [...offsets]
    .sort((a, b) => b - a)
    .map((offset) => Number(/teilnahme-(\d+)/.exec(page.subarray(offset, offset + 200).toString('latin1'))?.[1]));
  const inOrder = Array.from({ length: count }, (_, k) => k + 1).join(',');
  check(
    'Umfrage: Lage der Antworten in der Datei verrät die Reihenfolge der Teilnahmen nicht',
    page[0] === 0x0d && stored === count && physical.length === count && physical.join(',') !== inOrder,
    { physical },
  );
  const text = raw.toString('latin1');
  const copies = Array.from({ length: count }, (_, k) => text.split(label(k + 1)).length - 1);
  check('Umfrage: keine Reste früherer Stände in der Datei', copies.every((n) => n === 1), copies);
}
// Grosse Umfrage über viele Seiten: Neu geschrieben wird nur die
// Nachbarschaft der neuen Antwort, nicht die ganze Umfrage. Gemessen wird je
// Blattseite von Tabelle und Index, ob die zuletzt eingefügte Zelle zur
// jüngsten Teilnahme gehört (bei einfachem Einfügen: 12 von 24 und 4 von 6
// Seiten; zufällig: etwa eine Seite von so vielen, wie Zellen darauf liegen).
{
  const { pageOrderLeaks } = await import('./pageOrder.js');
  const { storeAnonymousResponse } = await import('../modules/communication/surveyService.js');
  const bigDb = path.join(work, 'umfrage-gross.db');
  const m = new Database(bigDb);
  m.pragma('secure_delete = ON'); // wie jede Verbindung über openDatabase
  m.pragma('journal_mode = MEMORY');
  m.pragma('synchronous = OFF');
  m.pragma('foreign_keys = OFF');
  migrateAgain(m, { vacuum: false });
  m.exec(
    "INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (7, 'Gross', '2026-01-01', '2026-12-31', 'laufend'), (8, 'Daneben', '2026-01-01', '2026-12-31', 'laufend')",
  );
  const total = 1500;
  for (let i = 1; i <= total; i++) {
    m.transaction(() => storeAnonymousResponse(m, i % 5 === 0 ? 8 : 7, JSON.stringify([{ question_id: 1, value: `teilnahme-${i}` }])))();
  }
  const stored = (m.prepare('SELECT count(*) AS n FROM survey_responses').get() as { n: number }).n;
  const leaks = pageOrderLeaks(m, bigDb);
  m.close();
  check(
    'Umfrage (1500 Antworten, viele Seiten): Lage verrät die Reihenfolge nicht (einen Index gibt es seit 503 nicht mehr)',
    stored === total && leaks.table[1] > 10 && leaks.table[0] <= 4 && leaks.index === null,
    { stored, leaks },
  );
}

// ---------------------------------------------------------------------------
// 13. -wal leeren, ohne den Dienst warten zu lassen
// ---------------------------------------------------------------------------
// Ein Leser hält seinen Stand (wie die Sicherung während VACUUM INTO). Der
// Checkpoint darf dann nicht blockieren, muss es aber nachholen.
{
  const { clearWalSoon } = await import('../db/db.js');
  const walFile = `${dbFile}-wal`;
  const insertMarker = () =>
    getDb()
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (NULL, 'test.wal', 'test', 1)")
      .run();
  insertMarker();
  const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const keyPragma = `key = "x'${fs.readFileSync(keyFile, 'utf8').trim()}'"`;
  const reader = spawn(
    process.execPath,
    [
      '-e',
      "const D=require(process.argv[1]);const d=new D(process.argv[2]);d.pragma(\"cipher = 'sqlcipher'\");d.pragma('legacy = 4');" +
        "d.pragma(process.argv[3]);d.exec('BEGIN');d.prepare('SELECT count(*) FROM audit_log').get();" +
        "console.log('bereit');setTimeout(()=>{d.exec('COMMIT');d.close();process.exit(0)},2500)",
      modulePath,
      dbFile,
      keyPragma,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Leser meldet sich nicht')), 15_000);
    reader.stdout.on('data', (d: Buffer) => d.toString().includes('bereit') && (clearTimeout(timer), resolve()));
    reader.once('exit', (code) => (clearTimeout(timer), reject(new Error(`Leser beendet vor "bereit" (Code ${code})`))));
  });
  insertMarker();
  const started = Date.now();
  clearWalSoon();
  const waited = Date.now() - started;
  const walWhileReading = fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
  await new Promise((resolve) => reader.once('exit', resolve));
  // Auf den Nachholer warten, ohne feste Frist zu raten (langsame Maschine,
  // Virenscanner): abfragen, bis im -wal höchstens noch der Frame von Seite 1
  // steht (clearWalAndIndex), höchstens 20 s.
  const walSize = () => (fs.existsSync(walFile) ? fs.statSync(walFile).size : 0);
  const oneFrame = 32 + 24 + (getDb().pragma('page_size', { simple: true }) as number);
  for (let waitedMs = 0; walSize() > oneFrame && waitedMs < 20_000; waitedMs += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const walAfter = walSize();
  // Seitenliste der -shm (erste Hash-Tabelle ab Byte 136): Nach dem Leeren
  // steht dort nur noch Seite 1, nicht die Seiten des letzten Schreibvorgangs.
  // In einem eigenen Prozess gelesen: Ein close() auf die -shm in DIESEM
  // Prozess höbe unter POSIX die Sperren der offenen Verbindung auf.
  const shmRead = spawnSync(
    process.execPath,
    [
      '-e',
      "const b=require('fs').readFileSync(process.argv[1]);const a=[];for(let i=0;i<64;i++)a.push(b.readUInt32LE(136+4*i));console.log(a.join(','))",
      `${dbFile}-shm`,
    ],
    { encoding: 'utf8' },
  );
  const pageList = shmRead.stdout.trim();
  closeDb();
  check(
    '-wal leeren: kein Warten auf den Leser, danach nachgeholt (übrig höchstens der Frame von Seite 1)',
    waited < 1_000 && walWhileReading > oneFrame && walAfter <= oneFrame,
    { waited, walWhileReading, walAfter, oneFrame },
  );
  check(
    '-shm nennt danach keine Seiten des letzten Schreibvorgangs (nur Seite 1)',
    pageList === ['1', ...Array<string>(63).fill('0')].join(','),
    pageList || shmRead.stderr,
  );
}
// Reichte das -wal über den ersten Abschnitt der -shm hinaus (über 4062
// Frames, etwa weil ein Leser das Leeren lange aufhielt), müssen auch die
// weiteren Abschnitte neu beginnen: Danach nennt keiner mehr eine Seite des
// Bestands, nur Seite 1 und neue Seiten der Füllung.
{
  const { clearWalAndIndex, measureWalFramesBeyondFirstSegment } = await import('../db/walIndex.js');
  // Messung: Bei kleinem -wal (unter 4062 Frames) nur ein stat, kein
  // Checkpoint; wirft nie, auch wenn jedes Pragma scheitert.
  {
    const smallDir = path.join(work, 'wal-klein');
    fs.mkdirSync(smallDir);
    const small = openDatabase(path.join(smallDir, 'ohrganize.db'), { dataDir: smallDir, createKey: true }).db;
    small.pragma('journal_mode = WAL');
    small.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')");
    const pragmas: string[] = [];
    const recording = new Proxy(small, {
      get(target, prop) {
        if (prop === 'pragma') {
          return (source: string, options?: { simple?: boolean }) => {
            pragmas.push(source);
            return target.pragma(source, options);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const measuredSmall = measureWalFramesBeyondFirstSegment(recording);
    const broken = new Proxy(small, {
      get(target, prop) {
        if (prop === 'pragma') {
          return () => {
            throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    let measuredBroken: unknown;
    try {
      measuredBroken = measureWalFramesBeyondFirstSegment(broken);
    } catch (err) {
      measuredBroken = err;
    }
    small.close();
    check(
      'Messung nach dem Commit: kleines -wal ohne Checkpoint, scheiternde Pragmas ohne Wurf',
      measuredSmall === 0 && !pragmas.some((p) => p.startsWith('wal_checkpoint')) && measuredBroken === 0,
      { measuredSmall, pragmas, measuredBroken: String(measuredBroken) },
    );
  }
  const bigWalDir = path.join(work, 'wal-gross');
  fs.mkdirSync(bigWalDir);
  const bigWalDb = path.join(bigWalDir, 'ohrganize.db');
  const conn = openDatabase(bigWalDb, { dataDir: bigWalDir, createKey: true }).db;
  conn.pragma('journal_mode = WAL');
  conn.pragma('wal_autocheckpoint = 0');
  conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = conn.prepare('INSERT INTO t (v) VALUES (?)');
  // Rund 5000 Seiten in kleinen Transaktionen: über 4062 Frames im -wal.
  for (let batch = 0; batch < 50; batch++) {
    conn.transaction(() => {
      for (let i = 0; i < 100; i++) insert.run('w'.repeat(3500));
    })();
  }
  const pagesBefore = conn.pragma('page_count', { simple: true }) as number;
  // Grosses -wal: gemessen wird über den PASSIVE-Checkpoint.
  const framesBefore = measureWalFramesBeyondFirstSegment(conn);
  // Hält eine andere Verbindung die Checkpoint-Sperre, meldet PASSIVE
  // log = -1, ohne zu werfen (nachgestellt): Dann gilt die Länge der Datei.
  const busyCheckpoint = new Proxy(conn, {
    get(target, prop) {
      if (prop === 'pragma') {
        return (source: string, options?: { simple?: boolean }) =>
          source === 'wal_checkpoint(PASSIVE)' ? [{ busy: 1, log: -1, checkpointed: -1 }] : target.pragma(source, options);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const measuredBusy = measureWalFramesBeyondFirstSegment(busyCheckpoint);
  check('Messung bei gesperrtem Checkpoint (log = -1): Länge der Datei statt 0', measuredBusy > 4062, { measuredBusy });
  // Scheitert die Füllung (hier: die Hilfstabelle lässt sich nicht anlegen,
  // wie bei SQLITE_BUSY oder SQLITE_FULL), meldet clearWalAndIndex nichts als
  // erledigt: Die offene Füllung bleibt für den nächsten Versuch stehen.
  let filled = false;
  const failingFill = new Proxy(conn, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          if (sql.startsWith('CREATE TABLE _wal_index_fill')) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  let fillError: unknown = null;
  try {
    clearWalAndIndex(failingFill, framesBefore, () => {
      filled = true;
    });
  } catch (err) {
    fillError = err;
  }
  check(
    'Gescheiterte Füllung der -shm: Fehler kommt an, nichts als erledigt gemeldet',
    fillError !== null && !filled,
    { fillError: String(fillError), filled },
  );
  // Der nächste Versuch mit derselben offenen Zahl füllt, obwohl das -wal
  // inzwischen geleert ist.
  const cleared = clearWalAndIndex(conn, framesBefore, () => {
    filled = true;
  });
  const shmDump = spawnSync(
    process.execPath,
    [
      '-e',
      // Abschnitt 0 ab Byte 136 mit 4062 Einträgen, jeder weitere ab 32768 * k mit 4096.
      "const b=require('fs').readFileSync(process.argv[1]);const s=new Set();" +
        'for(let i=0;i<4062;i++)s.add(b.readUInt32LE(136+4*i));' +
        'for(let k=1;k*32768<b.length;k++)for(let i=0;i<4096;i++)s.add(b.readUInt32LE(k*32768+4*i));' +
        'console.log([...s].join(","))',
      `${bigWalDb}-shm`,
    ],
    { encoding: 'utf8' },
  );
  const listed = shmDump.stdout.trim().split(',').map(Number);
  const fromBestand = listed.filter((page) => page > 1 && page <= pagesBefore);
  const walLeft = fs.statSync(`${bigWalDb}-wal`).size;
  conn.close();
  check(
    'Großes -wal (über 4062 Frames): alle Abschnitte der -shm neu, keine Seite des Bestands mehr genannt, -wal leer',
    framesBefore > 4062 && cleared && filled && fromBestand.length === 0 && listed.length > 1 && walLeft === 0,
    { framesBefore, cleared, filled, fromBestand: fromBestand.slice(0, 10), fromBestandCount: fromBestand.length, walLeft, error: shmDump.stderr },
  );
}
// Verdrahtung in clearWalSoon (Dienstverbindung): gemessen nach dem Commit,
// offen gehalten über einen gescheiterten Versuch, abgetragen erst nach
// gelungener Füllung.
{
  const { clearWalSoon, walIndexFillPending } = await import('../db/db.js');
  const conn = getDb();
  conn.pragma('wal_autocheckpoint = 0');
  conn.exec('CREATE TABLE _test_wal_bulk (v TEXT)');
  const bulk = conn.prepare('INSERT INTO _test_wal_bulk (v) VALUES (?)');
  for (let batch = 0; batch < 50; batch++) {
    conn.transaction(() => {
      for (let i = 0; i < 100; i++) bulk.run('w'.repeat(3500));
    })();
  }
  // Die Füllung scheitert zuerst: Ihre Hilfstabelle gibt es schon.
  conn.exec('CREATE TABLE _wal_index_fill (b BLOB)');
  const pendingBefore = walIndexFillPending();
  clearWalSoon();
  const pendingAfterFailure = walIndexFillPending();
  conn.exec('DROP TABLE _wal_index_fill');
  for (let waitedMs = 0; walIndexFillPending() > 0 && waitedMs < 20_000; waitedMs += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const pendingAfter = walIndexFillPending();
  const walAfterFill = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0;
  // Ohne Messung (Neuaufbau beim Umfrageende): Ein ebenso grosses -wal wird
  // nur geleert, ohne neue offene Füllung.
  for (let batch = 0; batch < 50; batch++) {
    conn.transaction(() => {
      for (let i = 0; i < 100; i++) bulk.run('v'.repeat(3500));
    })();
  }
  clearWalSoon({ measure: false });
  const pendingWithoutMeasure = walIndexFillPending();
  const walWithoutMeasure = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0;
  conn.exec('DROP TABLE _test_wal_bulk');
  conn.pragma('wal_autocheckpoint = 1000');
  closeDb();
  check(
    'clearWalSoon: offene Füllung gemessen, über einen gescheiterten Versuch gehalten, nach gelungener Füllung abgetragen',
    pendingBefore === 0 && pendingAfterFailure > 4062 && pendingAfter === 0 && walAfterFill === 0,
    { pendingBefore, pendingAfterFailure, pendingAfter, walAfterFill },
  );
  check(
    'clearWalSoon ohne Messung (Neuaufbau): grosses -wal geleert, keine neue offene Füllung',
    pendingWithoutMeasure === 0 && walWithoutMeasure <= 32 + 24 + 4096,
    { pendingWithoutMeasure, walWithoutMeasure },
  );
}
// Neustart mit offener Füllung: Der Vermerk (.shm-fuellung-offen) übersteht
// ihn; restartStaleWalIndex holt die Füllung nach, aber nur, wenn die -shm
// noch steht (eine andere Verbindung hielt sie offen). Eine grosse -shm ohne
// Vermerk löst nichts aus, ein Vermerk neben einer zurückgesetzten -shm fällt
// ohne Füllung weg.
{
  const { clearWalSoon, restartStaleWalIndex, walIndexFillPending } = await import('../db/db.js');
  const fillMark = path.join(dataDir, '.shm-fuellung-offen');
  const segmentOne = () =>
    spawnSync(
      process.execPath,
      [
        '-e',
        "const f=process.argv[1];if(!require('fs').existsSync(f)){console.log('');process.exit(0)}const b=require('fs').readFileSync(f);const s=[];if(b.length>32768)for(let i=0;i<4096;i++){const v=b.readUInt32LE(32768+4*i);if(v)s.push(v)}console.log(s.join(','))",
        `${dbFile}-shm`,
      ],
      { encoding: 'utf8' },
    )
      .stdout.trim()
      .split(',')
      .filter(Boolean)
      .map(Number);

  // a) Füllung offen, weil ein Leser das Leeren aufhält; der Dienst endet.
  const holder = openDatabase(dbFile, { dataDir }).db;
  holder.exec('BEGIN');
  holder.prepare('SELECT count(*) FROM sqlite_master').get();
  const conn = getDb();
  conn.pragma('wal_autocheckpoint = 0');
  conn.exec('CREATE TABLE _test_shm_neustart (v TEXT)');
  const bulk = conn.prepare('INSERT INTO _test_shm_neustart (v) VALUES (?)');
  for (let batch = 0; batch < 50; batch++) {
    conn.transaction(() => {
      for (let i = 0; i < 100; i++) bulk.run('n'.repeat(3500));
    })();
  }
  clearWalSoon();
  const markWritten = fs.existsSync(fillMark) && Number(fs.readFileSync(fillMark, 'utf8')) > 4062;
  closeDb(); // der Dienst endet mit offener Füllung; holder hält -shm und -wal
  holder.exec('COMMIT');
  const before = segmentOne();
  getDb(); // neuer Prozess: nicht die erste Verbindung, die -shm bleibt
  restartStaleWalIndex();
  const after = segmentOne();
  // Seite 1 schreibt jede Schemaänderung, auch die Füllung selbst; sie verrät nichts.
  const stillListed = after.filter((page) => page > 1 && before.includes(page));
  const markGoneAfterFill = !fs.existsSync(fillMark) && walIndexFillPending() === 0;
  check(
    'Neustart mit offener Füllung und stehender -shm: Vermerk übersteht ihn, Füllung nachgeholt, Vermerk weg',
    markWritten && before.length > 0 && stillListed.length === 0 && markGoneAfterFill,
    { markWritten, before: before.length, stillListed: stillListed.slice(0, 10), markGoneAfterFill },
  );

  // b) Grosse -shm ohne Vermerk (eben gefüllt): Ein weiterer Neustart neben
  //    derselben fremden Verbindung füllt nicht erneut.
  closeDb();
  const beforeB = segmentOne();
  getDb();
  restartStaleWalIndex();
  const afterB = segmentOne();
  check(
    'Neustart mit grosser -shm, aber ohne Vermerk: keine Füllung',
    beforeB.length > 0 && afterB.join(',') === beforeB.join(',') && walIndexFillPending() === 0,
    { beforeB: beforeB.length, afterB: afterB.length },
  );

  // c) Vermerk, aber die -shm wurde zurückgesetzt (alle Verbindungen zu, der
  //    Neustart ist die erste): Der Vermerk fällt weg, gefüllt wird nicht.
  getDb().exec('DROP TABLE _test_shm_neustart');
  getDb().pragma('wal_autocheckpoint = 1000');
  closeDb();
  holder.close();
  fs.writeFileSync(fillMark, '9999\n');
  getDb();
  restartStaleWalIndex();
  const markGoneWithoutFill = !fs.existsSync(fillMark) && walIndexFillPending() === 0 && segmentOne().length === 0;
  closeDb();
  check('Vermerk neben zurückgesetzter -shm: fällt weg, keine Füllung', markGoneWithoutFill, {
    mark: fs.existsSync(fillMark),
    pending: walIndexFillPending(),
  });

  // d) Nur das Leeren steht aus (ein Leser hält, das -wal reicht nicht über
  //    den ersten Abschnitt), und der Dienst endet: Die schliessende
  //    Verbindung ist nicht die letzte und schreibt das -wal nicht zurück.
  //    Der Vermerk (Inhalt 0) übersteht das, der nächste Start leert.
  const reader = openDatabase(dbFile, { dataDir }).db;
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM sqlite_master').get();
  getDb().exec('CREATE TABLE _test_leeren_offen (v TEXT)');
  getDb().prepare('INSERT INTO _test_leeren_offen (v) VALUES (?)').run('offen');
  clearWalSoon();
  const markForClear = fs.existsSync(fillMark) ? fs.readFileSync(fillMark, 'utf8').trim() : null;
  closeDb();
  reader.exec('COMMIT'); // bleibt offen: Der neue Start ist nicht die erste Verbindung
  const walFileD = `${dbFile}-wal`;
  const walBeforeRestart = fs.existsSync(walFileD) ? fs.statSync(walFileD).size : 0;
  getDb();
  restartStaleWalIndex();
  const pageSizeD = getDb().pragma('page_size', { simple: true }) as number;
  const walAfterRestart = fs.existsSync(walFileD) ? fs.statSync(walFileD).size : 0;
  const markGoneAfterClear = !fs.existsSync(fillMark);
  getDb().exec('DROP TABLE _test_leeren_offen');
  closeDb();
  reader.close();
  check(
    'Offenes Leeren übersteht einen Neustart neben einem Leser: Vermerk 0, der Start leert, Vermerk weg',
    markForClear === '0' && walBeforeRestart > 32 + 24 + pageSizeD && walAfterRestart <= 32 + 24 + pageSizeD && markGoneAfterClear,
    { markForClear, walBeforeRestart, walAfterRestart, markGoneAfterClear },
  );
}
// Umfragedaten auf einer Verbindung ohne secure_delete: laut abgewiesen, statt
// still Reste zu hinterlassen.
{
  const { storeAnonymousResponse } = await import('../modules/communication/surveyService.js');
  const plain = new Database(':memory:');
  plain.pragma('secure_delete = OFF');
  migrateAgain(plain, { vacuum: false });
  plain.exec("INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (3, 'Ohne', '2026-01-01', '2026-12-31', 'laufend')");
  let rejected: unknown = null;
  try {
    plain.transaction(() => storeAnonymousResponse(plain, 3, '[]'))();
  } catch (err) {
    rejected = err;
  }
  const stored = (plain.prepare('SELECT count(*) AS n FROM survey_responses').get() as { n: number }).n;
  plain.close();
  check(
    'Antwort auf einer Verbindung ohne secure_delete wird abgewiesen, nichts gespeichert',
    rejected instanceof Error && /secure_delete/.test(rejected.message) && stored === 0,
    { rejected: String(rejected), stored },
  );
}

// ---------------------------------------------------------------------------
// 14. Abbruch im Commit der Umstellung: erste Seite schon verschlüsselt,
//     Journal mit Klartextseiten. Entschieden wird erst nach dem Zurückspielen.
// ---------------------------------------------------------------------------
{
  const { settledDatabaseState } = await import('../db/encryption.js');
  const crashDir = path.join(work, 'abbruch-im-commit');
  fs.mkdirSync(crashDir);
  const source = path.join(crashDir, 'quelle.db');
  const crashed = path.join(crashDir, 'ohrganize.db');
  const a = new Database(source);
  a.pragma('journal_mode = DELETE');
  a.pragma('cache_size = 5');
  a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = a.prepare('INSERT INTO t (v) VALUES (?)');
  a.transaction(() => {
    for (let i = 0; i < 2000; i++) insert.run(`vorher-${i}-${'x'.repeat(200)}`);
  })();
  a.exec('BEGIN');
  a.exec('CREATE TABLE zusatz (x)'); // Seite 1 gleich zu Beginn ins Journal
  a.prepare("UPDATE t SET v = 'nachher'").run();
  fs.copyFileSync(source, crashed);
  fs.copyFileSync(`${source}-journal`, `${crashed}-journal`);
  a.exec('ROLLBACK');
  a.close();
  // Wie nach dem Schreiben der verschlüsselten ersten Seite: Salz statt Kopf.
  const fd = fs.openSync(crashed, 'r+');
  fs.writeSync(fd, crypto.randomBytes(16), 0, 16, 0);
  fs.closeSync(fd);
  const before = databaseState(crashed);
  const settled = settledDatabaseState(crashed, crashDir);
  const reopened = new Database(crashed, { readonly: true });
  const changed = (reopened.prepare("SELECT count(*) AS n FROM t WHERE v = 'nachher'").get() as { n: number }).n;
  reopened.close();
  check(
    'Abbruch im Commit: vor dem Zurückspielen "verschlüsselt", danach Klartext wie vorher (die Umstellung fällt nicht aus)',
    before === 'encrypted' && settled === 'plaintext' && changed === 0,
    { before, settled, changed },
  );
}

// ---------------------------------------------------------------------------
// 15. Vermerk der Umstellung: entsteht vorher, entscheidet nach dem Zustand
// ---------------------------------------------------------------------------
{
  const { encryptDatabaseAtRest } = await import('../db/db.js');
  const { CONVERSION_FAILED_FILE, ConversionVerificationError, convertDatabaseAtRest } = await import('../db/encryption.js');
  const attempt = (fn: () => unknown): unknown => {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  const plaintextDir = (name: string): { dir: string; db: string; mark: string } => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir);
    const db = path.join(dir, 'ohrganize.db');
    const seed = new Database(db);
    seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('vermerk-probe')");
    seed.close();
    return { dir, db, mark: path.join(dir, CONVERSION_FAILED_FILE) };
  };

  // a) Vermerk neben einer verschlüsselten, gesunden Datenbank (Absturz
  //    zwischen Commit und Prüfung): erneut geprüft, Vermerk fällt weg.
  const mainMark = path.join(dataDir, CONVERSION_FAILED_FILE);
  fs.writeFileSync(mainMark, 'Probe');
  const healthy = attempt(() => encryptDatabaseAtRest());
  check(
    'Vermerk neben gesunder verschlüsselter Datenbank: Prüfung besteht, Start läuft, Vermerk weg',
    healthy === null && !fs.existsSync(mainMark),
    String(healthy),
  );
  closeDb();

  // b) Vermerk neben einer beschädigten verschlüsselten Datenbank: kein Start,
  //    bei jedem Versuch, Vermerk bleibt.
  const broken = path.join(work, 'vermerk-beschaedigt');
  fs.mkdirSync(broken);
  const brokenDb = path.join(broken, 'ohrganize.db');
  {
    const made = openDatabase(brokenDb, { dataDir: broken, createKey: true }).db;
    made.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = made.prepare('INSERT INTO t (v) VALUES (?)');
    made.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run('x'.repeat(300));
    })();
    made.close();
    const bytes = fs.readFileSync(brokenDb);
    bytes[4096 * 20 + 100] ^= 0xff;
    fs.writeFileSync(brokenDb, bytes);
  }
  const brokenMark = path.join(broken, CONVERSION_FAILED_FILE);
  fs.writeFileSync(brokenMark, 'Probe');
  const refused = [attempt(() => convertDatabaseAtRest(brokenDb, broken)), attempt(() => convertDatabaseAtRest(brokenDb, broken))];
  check(
    'Vermerk neben beschädigter verschlüsselter Datenbank: jeder Start bricht ab, Vermerk bleibt',
    refused.every((err) => err instanceof ConversionVerificationError) && fs.existsSync(brokenMark),
    refused.map(String),
  );

  // c) Vermerk neben einem Klartextbestand (Sicherung von vorher
  //    zurückgespielt, auch von Hand): Vermerk fällt weg, umgestellt wird.
  const restored = plaintextDir('vermerk-klartext');
  fs.writeFileSync(restored.mark, 'Probe');
  const restoredKey = attempt(() => convertDatabaseAtRest(restored.db, restored.dir));
  check(
    'Vermerk neben Klartextbestand: fällt weg, Umstellung läuft',
    restoredKey === null && databaseState(restored.db) === 'encrypted' && !fs.existsSync(restored.mark),
    { error: String(restoredKey), state: databaseState(restored.db), mark: fs.existsSync(restored.mark) },
  );

  // d) Lässt sich der Vermerk nicht anlegen, wird nicht umgestellt: Fehler
  //    ohne Startabbruch, Bestand unverändert im Klartext, kein Schlüssel.
  const unwritable = plaintextDir('vermerk-nicht-schreibbar');
  const originalOpen = fs.openSync;
  (fs as { openSync: typeof fs.openSync }).openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
    if (String(file) === unwritable.mark) throw Object.assign(new Error('Kein Platz'), { code: 'ENOSPC' });
    return (originalOpen as (...args: unknown[]) => number)(file, ...rest);
  }) as typeof fs.openSync;
  let unwritableError: unknown;
  try {
    unwritableError = attempt(() => convertDatabaseAtRest(unwritable.db, unwritable.dir));
  } finally {
    (fs as { openSync: typeof fs.openSync }).openSync = originalOpen;
  }
  check(
    'Vermerk nicht anlegbar: keine Umstellung, gewöhnlicher Fehler, Klartext unverändert, kein Schlüssel',
    unwritableError instanceof Error &&
      !(unwritableError instanceof ConversionVerificationError) &&
      databaseState(unwritable.db) === 'plaintext' &&
      !fs.existsSync(path.join(unwritable.dir, DATA_KEY_FILE)),
    String(unwritableError),
  );

  // e) Schaden schon VOR der Umstellung (falsch gezählte Freiliste, mit der
  //    die bisherige Fassung lief): bleibt Klartext, läuft weiter, kein Vermerk.
  const damaged = plaintextDir('vorher-beschaedigt');
  {
    const filler = new Database(damaged.db);
    filler.exec("CREATE TABLE f (v TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO f SELECT printf('%0300d', i) FROM n; DELETE FROM f WHERE rowid > 1000;");
    filler.close();
    const bytes = fs.readFileSync(damaged.db);
    bytes.writeUInt32BE(bytes.readUInt32BE(36) + 5, 36);
    fs.writeFileSync(damaged.db, bytes);
  }
  const damagedError = attempt(() => convertDatabaseAtRest(damaged.db, damaged.dir));
  check(
    'Schaden schon vor der Umstellung: gewöhnlicher Fehler, bleibt Klartext, kein Vermerk, kein Schlüssel',
    damagedError instanceof Error &&
      !(damagedError instanceof ConversionVerificationError) &&
      /schon vor der Umstellung/.test(damagedError.message) &&
      databaseState(damaged.db) === 'plaintext' &&
      !fs.existsSync(damaged.mark) &&
      !fs.existsSync(path.join(damaged.dir, DATA_KEY_FILE)),
    String(damagedError),
  );

  // f) Vermerk neben verschlüsselter Datenbank, deren Schlüssel fehlt: kein
  //    Start, und die Meldung nennt den fehlenden Schlüssel (nicht "Prüfung
  //    nicht bestanden, Sicherung zurückspielen").
  const keyless = path.join(work, 'vermerk-ohne-schluessel');
  fs.mkdirSync(keyless);
  const keylessDb = path.join(keyless, 'ohrganize.db');
  {
    const made = openDatabase(keylessDb, { dataDir: keyless, createKey: true }).db;
    made.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')");
    made.close();
  }
  fs.rmSync(path.join(keyless, DATA_KEY_FILE));
  fs.writeFileSync(path.join(keyless, CONVERSION_FAILED_FILE), 'Probe');
  const keylessError = attempt(() => convertDatabaseAtRest(keylessDb, keyless));
  check(
    'Vermerk neben verschlüsselter Datenbank ohne Schlüssel: kein Start, Meldung nennt den fehlenden Schlüssel',
    keylessError instanceof ConversionVerificationError &&
      /Schlüssel fehlt/.test(keylessError.message) &&
      !/besteht die Prüfung nicht/.test(keylessError.message) &&
      fs.existsSync(path.join(keyless, CONVERSION_FAILED_FILE)),
    String(keylessError),
  );

  // g) Ohne die Sperre der Datei bleibt ein Vermerk neben einem Klartextbestand
  //    unangetastet: Er kann zu einer Umstellung gehören, die ein anderer
  //    Prozess gerade ausführt. Hier hält ein zweiter Prozess die Datei
  //    exklusiv, länger als die Frist der Umstellung (hier 300 ms). Ein eigener
  //    Prozess, weil das Lesen des Dateikopfs in DIESEM Prozess unter POSIX
  //    die Sperre einer Verbindung hier aufhöbe.
  const locked = plaintextDir('vermerk-fremde-sperre');
  fs.writeFileSync(locked.mark, 'Vermerk eines anderen Prozesses');
  const lockHolder = spawn(
    process.execPath,
    [
      '-e',
      "const D=require(process.argv[1]);const d=new D(process.argv[2]);d.pragma('journal_mode = DELETE');" +
        "d.pragma('locking_mode = EXCLUSIVE');d.exec('BEGIN EXCLUSIVE; COMMIT');console.log('bereit');" +
        'setTimeout(()=>{d.close();process.exit(0)},14000)',
      createRequire(import.meta.url).resolve('better-sqlite3'),
      locked.db,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Sperrprozess meldet sich nicht')), 15_000);
    lockHolder.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('bereit')) {
        clearTimeout(timer);
        resolve();
      }
    });
    lockHolder.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Sperrprozess beendet vor "bereit" (Code ${code})`));
    });
  });
  const lockedError = attempt(() => convertDatabaseAtRest(locked.db, locked.dir, { waitMs: 300 }));
  lockHolder.kill();
  await new Promise((resolve) => lockHolder.once('exit', resolve));
  check(
    'Fremde Sperre: Umstellung scheitert gewöhnlich, der Vermerk des anderen Prozesses bleibt unverändert',
    lockedError instanceof Error &&
      !(lockedError instanceof ConversionVerificationError) &&
      fs.readFileSync(locked.mark, 'utf8') === 'Vermerk eines anderen Prozesses' &&
      databaseState(locked.db) === 'plaintext',
    String(lockedError),
  );
}

// ---------------------------------------------------------------------------
// 15b. Umfrageende: Neuaufbau der Antworttabelle räumt die Kopien aus der Datei
// ---------------------------------------------------------------------------
// Klartextdatei, damit sie roh lesbar ist. Gemischte Längen wie im Betrieb:
// Beim Verschieben zwischen Seiten blieben Kopien in Seitenlücken stehen.
{
  const { markResponseTableRebuild, rebuildResponseTable, storeAnonymousResponse } = await import(
    '../modules/communication/surveyService.js'
  );
  const rebuildDb = path.join(work, 'umfrage-neuaufbau.db');
  const m = new Database(rebuildDb);
  m.pragma('secure_delete = ON'); // wie jede Verbindung über openDatabase
  m.pragma('journal_mode = DELETE');
  m.pragma('foreign_keys = OFF');
  migrateAgain(m, { vacuum: false });
  m.exec("INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (9, 'Neuaufbau', '2026-01-01', '2026-12-31', 'laufend')");
  const total = 1200;
  const label = (i: number) => `neuaufbau-antwort-${String(i).padStart(4, '0')}-`;
  for (let i = 1; i <= total; i++) {
    const filler = 'y'.repeat(i % 7 === 0 ? 3000 : i % 3 === 0 ? 600 : 80);
    m.transaction(() => storeAnonymousResponse(m, 9, JSON.stringify([{ question_id: 1, value: `${label(i)}${filler}` }])))();
  }
  m.close();
  // Dazu gezielt Reste, wie sie das Verschieben von Zellen hinterlässt:
  // Kopien in der unbelegten Lücke von Tabellenseiten (zwischen den Zeigern
  // und dem Zelleninhalt), roh in die Datei geschrieben.
  const raw = fs.readFileSync(rebuildDb);
  const pageSize = raw.readUInt16BE(16) === 1 ? 65536 : raw.readUInt16BE(16);
  let planted = 0;
  for (let offset = 0; offset < raw.length && planted < 40; offset += pageSize) {
    const header = offset === 0 ? 100 : 0;
    if (raw[offset + header] !== 0x0d || !raw.subarray(offset, offset + pageSize).includes('neuaufbau-antwort-')) continue;
    const cells = raw.readUInt16BE(offset + header + 3);
    const contentStart = raw.readUInt16BE(offset + header + 5) || 65536;
    const ghost = Buffer.from(`geisterkopie-${String(planted).padStart(2, '0')}-`);
    const gapStart = offset + header + 8 + 2 * cells;
    if (offset + contentStart - gapStart < ghost.length) continue;
    ghost.copy(raw, gapStart);
    planted++;
  }
  fs.writeFileSync(rebuildDb, raw);
  const copiesOf = () => {
    const text = fs.readFileSync(rebuildDb).toString('latin1');
    return {
      labels: Array.from({ length: total }, (_, k) => text.split(label(k + 1)).length - 1),
      ghosts: text.split('geisterkopie-').length - 1,
    };
  };
  const before = copiesOf();
  const m2 = new Database(rebuildDb);
  const intact = m2.pragma('integrity_check', { simple: true });
  const secureDeleteBefore = m2.pragma('secure_delete', { simple: true });
  m2.transaction(() => markResponseTableRebuild(m2))();
  rebuildResponseTable(m2);
  const rows = (m2.prepare('SELECT count(*) AS n FROM survey_responses').get() as { n: number }).n;
  const pendingLeft = m2.prepare("SELECT 1 AS x FROM _survey_rebuild_state WHERE key = 'pending'").get() !== undefined;
  const secureDelete = m2.pragma('secure_delete', { simple: true });
  m2.close();
  const after = copiesOf();
  check(
    'Umfrageende: Neuaufbau der Tabelle räumt Kopien aus Seitenlücken (jede Antwort genau einmal), Vermerk weg',
    planted > 0 &&
      before.ghosts === planted &&
      intact === 'ok' &&
      after.ghosts === 0 &&
      after.labels.every((n) => n === 1) &&
      rows === total &&
      !pendingLeft &&
      secureDelete === secureDeleteBefore,
    { planted, ghostsBefore: before.ghosts, ghostsAfter: after.ghosts, duplicates: after.labels.filter((n) => n !== 1).length, rows, pendingLeft },
  );
}
// Kleine Umfrage (Wurzelseite = einzige Seite) mit eingeschalteten
// Fremdschlüsseln wie im Dienst: Ein blosses DELETE FROM gäbe die Wurzel nie
// frei, ein Rest in ihrer Lücke bliebe stehen. Der Neuaufbau entfernt die
// Tabelle und legt sie neu an.
{
  const { rebuildResponseTable } = await import('../modules/communication/surveyService.js');
  const { rebuildTableInKeyOrder } = await import('../db/rebuildTable.js');
  const smallDb = path.join(work, 'umfrage-klein.db');
  const m = new Database(smallDb);
  m.pragma('journal_mode = DELETE');
  migrateAgain(m, { vacuum: false });
  m.exec("INSERT INTO surveys (id, title, date_from, date_to, status) VALUES (5, 'Klein', '2026-01-01', '2026-12-31', 'laufend')");
  const insert = m.prepare('INSERT INTO survey_responses (id, survey_id, answers) VALUES (?, 5, ?)');
  for (let i = 1; i <= 8; i++) insert.run(i * 1000, `kleine-antwort-${i}`);
  const root = (m.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'survey_responses'").get() as { rootpage: number }).rootpage;
  const pageSize = m.pragma('page_size', { simple: true }) as number;
  m.close();
  const raw = fs.readFileSync(smallDb);
  const offset = (root - 1) * pageSize;
  const rootType = raw[offset];
  Buffer.from('wurzel-geisterkopie').copy(raw, offset + 8 + 2 * raw.readUInt16BE(offset + 3));
  fs.writeFileSync(smallDb, raw);
  const m2 = new Database(smallDb);
  m2.pragma('foreign_keys = ON');
  rebuildResponseTable(m2);
  const rows = (m2.prepare('SELECT count(*) AS n FROM survey_responses WHERE survey_id = 5').get() as { n: number }).n;
  // Auf survey_responses zeigt kein Fremdschlüssel; auf surveys schon: Dort verweigert der Helfer.
  let refused: unknown = null;
  try {
    m2.transaction(() => rebuildTableInKeyOrder(m2, 'surveys'))();
  } catch (err) {
    refused = err;
  }
  const surveysLeft = (m2.prepare('SELECT count(*) AS n FROM surveys').get() as { n: number }).n;
  m2.close();
  check(
    'Neuaufbau einer kleinen Tabelle mit Fremdschlüsseln: kein Rest in der Wurzelseite, alle Zeilen da',
    rootType === 0x0d && rows === 8 && !containsText(smallDb, 'wurzel-geisterkopie'),
    { rootType, rows, rest: containsText(smallDb, 'wurzel-geisterkopie') },
  );
  check(
    'Neuaufbau verweigert eine Tabelle, auf die Fremdschlüssel zeigen (Kaskaden)',
    refused instanceof Error && /Fremdschlüssel/.test(refused.message) && surveysLeft === 1,
    { refused: String(refused), surveysLeft },
  );
  // Tabellen ohne INTEGER PRIMARY KEY als rowid: verborgene rowid, anderer
  // Primärschlüssel, WITHOUT ROWID. Ihre rowids gingen verloren: verweigert.
  const odd = new Database(':memory:');
  odd.exec(`CREATE TABLE verborgen (v TEXT); INSERT INTO verborgen VALUES ('a');
    CREATE TABLE textschluessel (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE ohne_rowid (k INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID;
    CREATE TABLE absteigend (k INTEGER PRIMARY KEY DESC, v TEXT);
    CREATE TABLE richtig (k INTEGER PRIMARY KEY, v TEXT); INSERT INTO richtig VALUES (7, 'b');`);
  const outcome = (name: string) => {
    try {
      odd.transaction(() => rebuildTableInKeyOrder(odd, name))();
      return 'neu aufgebaut';
    } catch (err) {
      return /INTEGER PRIMARY KEY/.test(String(err)) ? 'verweigert' : String(err);
    }
  };
  const outcomes = ['verborgen', 'textschluessel', 'ohne_rowid', 'absteigend', 'richtig'].map(outcome);
  const kept = odd.prepare('SELECT k, v FROM richtig').get() as { k: number; v: string };
  odd.close();
  check(
    'Neuaufbau nur für Tabellen mit INTEGER PRIMARY KEY als rowid',
    outcomes.join(',') === 'verweigert,verweigert,verweigert,verweigert,neu aufgebaut' && kept.k === 7 && kept.v === 'b',
    { outcomes, kept },
  );
}
// Neuaufbau nur, wenn seit dem letzten Antworten hinzukamen; eine Umfrage,
// die ohne Beenden über date_to hinaus läuft, löst ihn ebenfalls aus.
{
  const survey = await import('../modules/communication/surveyService.js');
  const db = getDb();
  db.exec('DELETE FROM _survey_rebuild_state');
  const markedWithoutAnswers = db.transaction(() => survey.markResponseTableRebuild(db))();
  db.exec("INSERT INTO surveys (title, date_from, date_to, status) VALUES ('Ausgelaufen', '2020-01-01', '2020-01-31', 'laufend')");
  const expiredId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  db.transaction(() => survey.storeAnonymousResponse(db, expiredId, '[]'))();
  const writtenAfterAnswer = survey.responsesWrittenSinceRebuild(db);
  const rebuiltForExpired = survey.rebuildForExpiredSurveys();
  const writtenAfterRebuild = survey.responsesWrittenSinceRebuild(db);
  const rebuiltAgain = survey.rebuildForExpiredSurveys();
  // Neue Antworten (etwa einer anderen Umfrage): dieselbe ausgelaufene
  // Umfrage löst keinen zweiten Neuaufbau aus.
  db.transaction(() => survey.storeAnonymousResponse(db, expiredId, '[]'))();
  const rebuiltAfterNewAnswer = survey.rebuildForExpiredSurveys();
  db.prepare('DELETE FROM surveys WHERE id = ?').run(expiredId);
  closeDb();
  check(
    'Neuaufbau nur nach neuen Antworten; ausgelaufene, nicht beendete Umfrage löst ihn aus, einmal',
    markedWithoutAnswers === false &&
      writtenAfterAnswer &&
      rebuiltForExpired &&
      !writtenAfterRebuild &&
      rebuiltAgain === false &&
      rebuiltAfterNewAnswer === false,
    { markedWithoutAnswers, writtenAfterAnswer, rebuiltForExpired, writtenAfterRebuild, rebuiltAgain, rebuiltAfterNewAnswer },
  );
}
// Nachholen beim Start des Moduls: Ein vermerkter Neuaufbau läuft, der Vermerk fällt weg.
{
  const { markResponseTableRebuild, retryResponseTableRebuild } = await import('../modules/communication/surveyService.js');
  // Wie nach einer Antwort (storeAnonymousResponse): sonst gäbe es nichts neu aufzubauen.
  getDb().exec("INSERT OR IGNORE INTO _survey_rebuild_state (key) VALUES ('written')");
  getDb().transaction(() => markResponseTableRebuild(getDb()))();
  const pending = () =>
    getDb().prepare("SELECT 1 AS x FROM _survey_rebuild_state WHERE key = 'pending'").get() !== undefined;
  // Erst scheitern lassen: Eine temporäre View mit dem Namen der Hilfstabelle
  // bricht den Neuaufbau ab (DROP TABLE trifft eine View). Warnung, Vermerk bleibt.
  getDb().exec('CREATE TEMP VIEW _table_rebuild_copy AS SELECT 1 AS x');
  const failedWarnings: string[] = [];
  retryResponseTableRebuild((w) => failedWarnings.push(w));
  const keptAfterFailure = pending();
  getDb().exec('DROP VIEW temp._table_rebuild_copy');
  const warnings: string[] = [];
  retryResponseTableRebuild((w) => warnings.push(w));
  const pendingLeft = pending();
  closeDb();
  check(
    'Gescheiterter Neuaufbau beim Start: Warnung, Vermerk bleibt',
    failedWarnings.length === 1 && failedWarnings[0].includes('erneut gescheitert') && keptAfterFailure,
    { failedWarnings, keptAfterFailure },
  );
  check('Vermerkter Neuaufbau wird beim Start nachgeholt', !pendingLeft && warnings.length === 0, { pendingLeft, warnings });
}

// ---------------------------------------------------------------------------
// 16. VACUUM nach einer Migration im WAL-Modus, während ein Leser seinen Stand
//     hält: Der Checkpoint ist blockiert; danach steht nur er aus, nicht das
//     VACUUM, und ein späterer Lauf holt nur ihn nach.
// ---------------------------------------------------------------------------
{
  const walDb = path.join(work, 'vacuum-wal.db');
  const m = new Database(walDb);
  m.pragma('journal_mode = WAL');
  m.pragma('busy_timeout = 0');
  migrateAgain(m, { vacuum: false });
  m.exec(
    "CREATE TABLE IF NOT EXISTS _vacuum_pending (since TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO _vacuum_pending DEFAULT VALUES; " +
      "INSERT INTO audit_log (action, entity) VALUES ('test.leser', 'test');",
  );
  const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const reader = spawn(
    process.execPath,
    [
      '-e',
      "const D=require(process.argv[1]);const d=new D(process.argv[2]);d.exec('BEGIN');d.prepare('SELECT count(*) FROM audit_log').get();" +
        "console.log('bereit');setTimeout(()=>{d.exec('COMMIT');d.close();process.exit(0)},3000)",
      modulePath,
      walDb,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Leser meldet sich nicht')), 15_000);
    reader.stdout.on('data', (d: Buffer) => d.toString().includes('bereit') && (clearTimeout(timer), resolve()));
    reader.once('exit', (code) => (clearTimeout(timer), reject(new Error(`Leser beendet vor "bereit" (Code ${code})`))));
  });
  const exists = (name: string) => m.prepare('SELECT 1 AS x FROM sqlite_master WHERE name = ?').get(name) !== undefined;
  let vacuums = 0;
  const counting = new Proxy(m, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          if (sql === 'VACUUM') vacuums++;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const warnings: string[] = [];
  migrateAgain(counting, { onWarning: (w) => warnings.push(w) });
  const whileReading = { vacuum: exists('_vacuum_pending'), checkpoint: exists('_vacuum_checkpoint_pending') };
  await new Promise((resolve) => reader.once('exit', resolve));
  migrateAgain(counting, { onWarning: (w) => warnings.push(w) });
  const after = { vacuum: exists('_vacuum_pending'), checkpoint: exists('_vacuum_checkpoint_pending') };
  m.close();
  check(
    'VACUUM im WAL-Modus neben einem Leser: Warnung, nur der Checkpoint steht aus; nach dem Leser nachgeholt, ohne zweites VACUUM',
    warnings.length === 1 &&
      warnings[0].includes('Checkpoint') &&
      !whileReading.vacuum &&
      whileReading.checkpoint &&
      !after.vacuum &&
      !after.checkpoint &&
      vacuums === 1,
    { warnings, whileReading, after, vacuums },
  );
}

if (failures > 0) {
  console.error(`${failures} Checks zur Verschlüsselung fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Checks zur Verschlüsselung bestanden.');
