import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { permits, type AdminArea } from '@ohrganize/shared';
import { config } from '../config.js';
import { getDb, inTransaction } from '../db/db.js';
import { audit } from './audit.js';
import { permissionsFor } from './permissions.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from './errors.js';

export interface FileRecord {
  id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

/**
 * Alle Spalten, die auf `files.id` zeigen — plus der Rechtebereich, zu dem die
 * jeweilige Fachtabelle gehört. Diese Liste ist die Rückwärts-Auflösung
 * `file_id -> Fachbereich` und damit die Grundlage von zwei Dingen:
 *
 *  1. der Autorisierung beim Signieren (siehe `assertMayReadFile`) und
 *  2. der Prüfung, ob eine Datei überhaupt noch gebraucht wird
 *     (siehe `deleteFileIfUnreferenced`).
 *
 * WICHTIG: Wer eine neue Spalte mit `REFERENCES files(id)` anlegt, MUSS sie
 * hier eintragen. Fehlt sie, passiert zweierlei — beides still:
 * die Datei ist über POST /api/files/:id/sign für jedes Admin-Konto lesbar
 * (sie gilt als "keinem Bereich zugeordnet"), und der Aufräumer hält sie für
 * unreferenziert und löscht den Blob unter der Fachtabelle weg.
 * Gegenprobe: `grep -rn "REFERENCES files(id)" src/db/migrations`.
 */
const FILE_REFERENCES: ReadonlyArray<readonly [string, string, AdminArea]> = [
  ['employees', 'photo_file_id', 'personal'],
  ['contracts', 'document_file_id', 'personal'],
  ['documents', 'file_id', 'personal'],
  ['sick_notes', 'certificate_file_id', 'abwesenheit'],
  ['training_registrations', 'certificate_file_id', 'leistung'],
  ['freelancer_invoices', 'file_id', 'verguetung'],
  ['certificates', 'file_id', 'verguetung'],
  ['announcement_attachments', 'file_id', 'kommunikation'],
  ['candidates', 'photo_file_id', 'recruiting'],
  ['applications', 'cv_file_id', 'recruiting'],
  ['hr_templates', 'file_id', 'verwaltung'],
];

/**
 * UNION (nicht UNION ALL) über alle referenzierenden Spalten: liefert je
 * Fachbereich höchstens eine Zeile. Der Parameter heißt bewusst benannt
 * (`@file_id`), damit er nur einmal gebunden werden muss, obwohl er elfmal
 * vorkommt.
 */
const FILE_AREAS_SQL = FILE_REFERENCES.map(
  ([table, column, area]) => `SELECT '${area}' AS area FROM ${table} WHERE ${column} = @file_id`,
).join('\n       UNION ');

/** Gleiche Liste, nur als Existenzfrage — für den Lösch-Pfad. */
const FILE_REFERENCED_SQL = `${FILE_REFERENCES.map(
  ([table, column]) => `SELECT 1 AS referenced FROM ${table} WHERE ${column} = @file_id`,
).join('\n       UNION ALL ')}\n       LIMIT 1`;

/**
 * Dateiendung für den Namen im Storage. Nur Buchstaben und Ziffern, sonst leer.
 *
 * Der Rest des Namens ist eine UUID, aber die Endung kommt ungefiltert vom
 * Client und landet im Schreibpfad. Ungeprüft wäre das auf einem
 * Windows-Server ein stiller Datenverlust: `nachweis.pdf:x` schreibt den
 * Inhalt in einen NTFS-Alternate-Data-Stream, die sichtbare Datei hat 0 Byte,
 * `fs.existsSync` meldet trotzdem `true` — und beim ersten Backup bzw. Kopieren
 * ist der Inhalt weg. Ein NUL-Byte im Namen lässt `fs` mit
 * ERR_INVALID_ARG_VALUE abbrechen (500 auf einer Upload-Route).
 */
function safeExtension(originalName: string): string {
  const m = path.extname(originalName).match(/^\.[A-Za-z0-9]{1,15}$/);
  return m ? m[0].toLowerCase() : '';
}

function insertFileRow(
  originalName: string,
  storedName: string,
  mimeType: string,
  sizeBytes: number,
  sha256: string,
  uploadedBy?: number,
): FileRecord {
  const info = getDb()
    .prepare(
      `INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(originalName, storedName, mimeType, sizeBytes, sha256, uploadedBy ?? null);
  return getFileRecord(Number(info.lastInsertRowid));
}

/**
 * Schreibt eine eben angelegte Datei physisch auf den Datenträger durch.
 *
 * Ohne diesen Schritt liegt der Inhalt nach dem Schreiben nur im
 * Schreib-Cache des Betriebssystems, während der files-Datensatz über die
 * Datenbank (WAL, synchronous = FULL) bereits dauerhaft ist. Ein Stromausfall
 * dazwischen erzeugt genau die Reihenfolge, die der Nutzer nicht reparieren
 * kann: Der Datensatz existiert, der Blob fehlt — der Download antwortet für
 * immer mit „Dateiinhalt fehlt im Storage". Umgekehrt ist ein Blob ohne
 * Datensatz nur unerreichbarer Müll (dieselbe Abwägung wie in
 * deleteFileIfUnreferenced).
 *
 * Geöffnet wird mit 'r+' und nicht 'r': Windows verlangt für
 * FlushFileBuffers ein Handle mit Schreibrecht.
 *
 * Nicht abgedeckt: der Verzeichniseintrag selbst (auf POSIX bräuchte es dafür
 * einen zweiten fsync auf den Storage-Ordner). Der offene Rest ist damit
 * „Datei existiert nicht" statt „Datei existiert leer" — und das ist der
 * Fall, den der Aufräumpfad ohnehin verträgt.
 */
function syncToDisk(target: string): void {
  const fd = fs.openSync(target, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Asynchrone Fassung von syncToDisk für den Upload-Pfad (kein blockierter Event-Loop). */
async function syncToDiskAsync(target: string): Promise<void> {
  const handle = await fs.promises.open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Persistiert einen Buffer im Storage und legt den files-Eintrag an.
 *
 * Für bereits im Speicher erzeugte Inhalte (generierte Bescheinigungen, Seed).
 * Für Uploads aus dem Netz `storeFileStream` benutzen — dort ist die Größe
 * fremdbestimmt und `writeFileSync` würde den Event-Loop für die gesamte
 * Schreibdauer blockieren.
 */
export function storeFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  uploadedBy?: number,
): FileRecord {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const storedName = `${crypto.randomUUID()}${safeExtension(originalName)}`;
  const target = path.join(config.storageDir, storedName);
  // mode 0o600: Der Storage enthält Personalakten, Gehaltsbescheinigungen und
  // AU-Bescheinigungen. Auf einem Mehrbenutzer-Server darf sie außer dem
  // Dienstkonto niemand lesen. (Wirkt nur beim Neuanlegen — Bestandsdateien
  // repariert der chmod-Lauf beim Start, siehe config.ts.)
  fs.writeFileSync(target, buffer, { mode: 0o600 });
  // Durchschreiben, BEVOR insertFileRow den Datensatz anlegt (siehe syncToDisk).
  syncToDisk(target);
  return insertFileRow(originalName, storedName, mimeType, buffer.length, sha256, uploadedBy);
}

/**
 * Persistiert einen Upload-Stream im Storage und legt den files-Eintrag an.
 *
 * Der Inhalt wird nie vollständig gepuffert: Die SHA-256-Summe entsteht als
 * Durchlaufstufe zwischen Quelle und Zieldatei. Das hält den Speicherbedarf
 * konstant (statt Dateigröße × gleichzeitige Uploads) und den Event-Loop frei.
 */
export async function storeFileStream(
  source: Readable,
  originalName: string,
  mimeType: string,
  uploadedBy?: number,
): Promise<FileRecord> {
  const storedName = `${crypto.randomUUID()}${safeExtension(originalName)}`;
  const target = path.join(config.storageDir, storedName);
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;

  // Transform statt 'data'-Listener: So bleibt der Gegendruck der Zieldatei
  // erhalten, ein langsames Dateisystem staut also bis zum Socket zurück.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });

  // 'wx' statt 'w': Eine vorhandene Datei wird nie überschrieben (die UUID
  // sollte kollisionsfrei sein — falls doch nicht, ist ein Fehler besser als
  // ein zerstörter Bestand). mode 0o600 wie in storeFile.
  const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });

  try {
    await pipeline(source, meter, out);
    // Erst durchschreiben, dann den Datensatz anlegen (siehe syncToDisk).
    // Schlägt der fsync fehl, ist die Datei nicht verlässlich gespeichert —
    // dann soll der Upload scheitern, statt eine Zeile ohne Inhalt zu
    // hinterlassen; das Aufräumen übernimmt derselbe catch-Zweig.
    await syncToDiskAsync(target);
  } catch (err) {
    // Abgebrochener Upload darf keine halbe Datei im Storage hinterlassen.
    fs.rmSync(target, { force: true });
    // Reißt eine Multipart-Grenze (z. B. `fields` aus server.ts), koppelt
    // @fastify/multipart den Request vom Parser ab; der Datei-Stream endet
    // dann vorzeitig und `pipeline` wirft ERR_STREAM_PREMATURE_CLOSE.
    // Ohne diese Übersetzung kommt beim Client ein nacktes 500 „Interner
    // Serverfehler" an (verifiziert mit 21 Formularfeldern auf
    // POST /api/files) und im Log liegt ein Stacktrace — obwohl es eine
    // ganz normale Eingabegrenze ist. Ein 500 lädt zudem zum Wiederholen
    // ein und vervielfacht so die Last. Dasselbe gilt, wenn der Client die
    // Verbindung mitten im Upload abbricht.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED') {
      throw badRequest(
        'Der Upload wurde abgebrochen. Bitte prüfen Sie, ob genau eine Datei und nicht zu ' +
          'viele Formularfelder gesendet wurden, und versuchen Sie es erneut.',
      );
    }
    throw err;
  }
  return insertFileRow(
    originalName,
    storedName,
    mimeType,
    sizeBytes,
    hash.digest('hex'),
    uploadedBy,
  );
}

export function getFileRecord(id: number): FileRecord {
  const row = getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
  if (!row) throw notFound('Datei nicht gefunden');
  return row;
}

/**
 * Löscht Datensatz und Blob — aber nur, wenn keine Fachtabelle mehr auf die
 * Datei zeigt. Rückgabe: `true`, wenn tatsächlich gelöscht wurde.
 *
 * Gedacht für Lösch-Pfade der Fachmodule (Dokument, Vertrag, Bescheinigung …):
 * Erst die eigene Zeile löschen, dann diese Funktion mit der `file_id` rufen.
 * Ohne sie bleibt „Gelöschtes" über eine signierte URL abrufbar — DSGVO
 * Art. 17 wäre damit nur vorgetäuscht.
 */
export function deleteFileIfUnreferenced(fileId: number): boolean {
  // Referenzprüfung und DELETE gehören in dieselbe Transaktion, sonst kann
  // zwischen beidem eine neue Referenz entstehen (z. B. eine zweite
  // Dokumentversion, die denselben Blob verknüpft).
  const storedName = inTransaction(() => {
    const db = getDb();
    const referenced = db.prepare(FILE_REFERENCED_SQL).get({ file_id: fileId }) as
      | { referenced: number }
      | undefined;
    if (referenced) return null;
    const row = db.prepare('SELECT stored_name FROM files WHERE id = ?').get(fileId) as
      | { stored_name: string }
      | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    return row.stored_name;
  });
  if (!storedName) return false;
  // Der Blob wird bewusst ERST NACH dem Commit entfernt: Ein übrig gebliebener
  // Blob ohne Datensatz ist unerreichbarer Müll, ein Datensatz ohne Blob ist
  // ein Fehler vor den Augen der Nutzer („Dateiinhalt fehlt im Storage").
  fs.rmSync(path.join(config.storageDir, storedName), { force: true });
  return true;
}

/**
 * Kurzlebige signierte Download-URL — funktioniert für Desktop- und
 * Web-Client identisch, ohne dass der Download-Request selbst einen
 * Auth-Header braucht (z. B. für <img src> oder Betriebssystem-Viewer).
 *
 * Die Signatur bindet NUR file_id und Ablaufzeit, keine Nutzeridentität. Die
 * URL ist damit ein Bearer-Token auf genau diese Datei — wer sie hat, kommt
 * bis zum Ablauf ohne Anmeldung an den Inhalt. Deshalb gehört die
 * Autorisierung an die Stelle, an der signiert wird (siehe
 * `assertMayReadFile`), und die Laufzeit bleibt kurz.
 */
export function signDownloadUrl(fileId: number): string {
  const expires = Date.now() + downloadTtlMs();
  const sig = crypto
    .createHmac('sha256', config.secret)
    .update(`${fileId}.${expires}`)
    .digest('hex');
  return `/api/files/${fileId}/download?expires=${expires}&sig=${sig}`;
}

/**
 * Obergrenze für die Gültigkeit signierter Links: 60 Sekunden.
 *
 * Der Link steht im Query-String und landet damit im Access-Log jedes
 * Reverse-Proxys (nginx `$request`). Eine Kopie des Logs ist damit eine Kopie
 * der Zugriffsrechte auf jede in diesem Zeitraum verlinkte Datei — und
 * Listen-Endpunkte (Recruiting, Verzeichnis) erzeugen eine signierte URL je
 * Zeile. Die Deckelung steht hier und nicht nur in config.ts, damit sie eine
 * versehentlich großzügige Konfiguration überlebt.
 */
function downloadTtlMs(): number {
  return Math.min(config.downloadUrlTtlMs, 60_000);
}

/**
 * Der mime_type kommt beim Upload ungeprüft vom Client (Multipart-Header) und
 * geht beim Download als Content-Type wieder hinaus. Header-Injection ist
 * durch Fastify ausgeschlossen, aber ein leerer oder missgebildeter Wert im
 * Content-Type lädt Browser zum Sniffen ein. Alles, was nicht wie
 * „typ/subtyp“ aussieht, wird deshalb als generischer Binärstrom ausgeliefert
 * — die Prüfung sitzt an der Auslieferung, damit sie auch Bestandszeilen
 * trifft, die vor ihr gespeichert wurden.
 */
function plausibleMimeType(mime: string): string {
  return /^[\w!#$&^.+-]{1,64}\/[\w!#$&^.+-]{1,64}$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

/**
 * Wirft 403, wenn das Konto die Datei nicht lesen darf.
 *
 * Warum diese Prüfung nicht in permissions.ts passieren kann: Der Fachbereich
 * hängt nicht an der Route, sondern an der Datei. `files.id` ist AUTOINCREMENT
 * und damit durchzählbar — ohne diese Auflösung kommt jedes Admin-Konto mit
 * irgendeinem Recht an JEDE Datei: Entgeltbescheinigungen, Verträge,
 * AU-Bescheinigungen, Bewerbungsunterlagen. Genau das konnte die ausgelieferte
 * Rolle „HR-Sachbearbeitung" (verguetung: 'kein').
 *
 * Verlangt wird 'lesen', nicht 'bearbeiten': Signieren ist fachlich ein
 * Lesevorgang (POST nur, damit der Link nicht im Query-String steht). Mit
 * 'bearbeiten' könnte eine Nur-Lese-Rolle gar nichts mehr herunterladen.
 */
export function assertMayReadFile(req: FastifyRequest, fileId: number): void {
  // Nur für die HR-Administration. Portal-Konten (role 'mitarbeiter') haben
  // keine admin_role_id — `permissionsFor(undefined)` würde ihnen VOLLZUGRIFF
  // zusprechen. Heute erreicht kein Portal-Konto diese Funktion (der Hook in
  // server.ts lässt sie nur an /api/me/* und /api/auth/*), aber die Falle wäre
  // beim ersten Self-Service-Aufruf still zugeschnappt. Self-Service prüft
  // Eigentum am Datensatz, nicht Bereichsrechte (siehe modules/me/).
  if (req.user.role !== 'admin') {
    throw forbidden('Dieser Bereich ist der HR-Administration vorbehalten');
  }
  const areas = getDb().prepare(FILE_AREAS_SQL).all({ file_id: fileId }) as { area: AdminArea }[];
  if (areas.length > 0) {
    const permissions = permissionsFor(req.user.admin_role_id);
    // Mehrfachverwendung (z. B. ein Blob an Dokument UND Vertrag): Ein
    // ausreichendes Recht genügt — die Datei ist über den erlaubten Bereich
    // ohnehin sichtbar.
    if (areas.some((r) => permits(permissions[r.area], 'lesen'))) return;
    throw forbidden('Für diese Datei haben Sie keine Berechtigung.');
  }
  // Noch mit keiner Fachtabelle verknüpft: der Upload-Flow. Zwischen
  // POST /api/files und dem Anlegen der Metadaten muss der Client die eigene
  // Datei signieren dürfen (Vorschau) — aber wirklich nur die eigene.
  const own = getDb()
    .prepare('SELECT 1 AS ok FROM files WHERE id = ? AND uploaded_by = ?')
    .get([fileId, req.user.id]) as { ok: number } | undefined;
  if (!own) throw forbidden('Für diese Datei haben Sie keine Berechtigung.');
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/files', async (req) => {
    const data = await req.file();
    if (!data) throw badRequest('Keine Datei übertragen');
    const record = await storeFileStream(data.file, data.filename, data.mimetype, req.user.id);
    // Über dem Limit bricht busboy den Stream ab und markiert ihn als
    // `truncated` — der Stream endet regulär, wir bekämen also stillschweigend
    // eine halbe Datei. Deshalb hier prüfen und wieder aufräumen.
    if (data.file.truncated) {
      deleteFileIfUnreferenced(record.id);
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Die Datei ist zu groß');
    }
    if (record.size_bytes === 0) {
      deleteFileIfUnreferenced(record.id);
      throw badRequest('Die Datei ist leer');
    }
    return { file: record };
  });

  app.post('/api/files/:id/sign', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const record = getFileRecord(id);
    // permissions.ts lässt diese Route bewusst durch — die Autorisierung
    // braucht die Datei und kann deshalb nur hier stattfinden.
    assertMayReadFile(req, id);
    // Der signierte Link darf in keinem Cache landen (Browser, Proxy): Wer ihn
    // hat, kommt bis zum Ablauf ohne Anmeldung an die Datei.
    reply.header('Cache-Control', 'no-store, private');
    // Der Zugriff auf eine Personalakte ist nachvollziehbar zu machen — der
    // Download selbst ist öffentlich signiert und hinterlässt keine Spur mehr.
    audit(req, 'file.sign', 'file', id, { original_name: record.original_name });
    return { url: signDownloadUrl(id) };
  });

  app.get('/api/files/:id/download', { config: { public: true } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { expires, sig } = req.query as { expires?: unknown; sig?: unknown };
    if (typeof expires !== 'string' || typeof sig !== 'string' || !expires) {
      throw unauthorized('Download-Link ist ungültig');
    }
    // Format VOR dem Vergleich prüfen: crypto.timingSafeEqual wirft bei
    // unterschiedlicher Bufferlänge einen RangeError — auf der einzigen
    // öffentlichen Datenroute wäre das ein 500 samt Stacktrace je Fehlversuch.
    // Ein Längenvergleich reicht dafür nicht ('ä'.repeat(64) hat length 64,
    // aber byteLength 128); die Hex-Prüfung fixiert beides zugleich. Sie
    // fängt außerdem ein doppeltes ?sig=a&sig=b ab (dann ist sig ein Array).
    if (!/^[0-9a-f]{64}$/.test(sig)) throw unauthorized('Download-Link ist ungültig');
    if (Number(expires) < Date.now()) throw unauthorized('Download-Link ist abgelaufen');
    const expected = crypto
      .createHmac('sha256', config.secret)
      .update(`${id}.${expires}`)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
      throw unauthorized('Download-Link ist ungültig');
    }
    const record = getFileRecord(id);
    const filePath = path.join(config.storageDir, record.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('Dateiinhalt fehlt im Storage');
    reply
      .header('Content-Type', plausibleMimeType(record.mime_type))
      // nosniff gehört an die Route selbst, nicht nur in die Proxy-Konfigs
      // (deploy/): Im eingebetteten Desktop-Betrieb gibt es keinen Proxy, der
      // den Header ergänzt — ohne ihn dürfte der Browser den (clientseitig
      // gemeldeten) Content-Type wegraten.
      .header('X-Content-Type-Options', 'nosniff')
      // Personaldaten gehören in keinen Zwischenspeicher: 'private' hält sie
      // aus gemeinsam genutzten Proxy-Caches, 'no-store' auch aus dem
      // Browser-Cache des Arbeitsplatzes.
      .header('Cache-Control', 'no-store, private')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(record.original_name)}`,
      );
    return reply.send(fs.createReadStream(filePath));
  });
}
