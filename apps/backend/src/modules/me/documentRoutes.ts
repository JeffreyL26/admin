/**
 * Eigene Dokumente im Self-Service (/api/me/documents).
 *
 * Mitarbeitende sehen ALLE Dokumente ihres Personalprofils — auch die von der
 * Personalabteilung abgelegten (Verträge, Zeugnisse); das ist gewollt. Sie
 * dürfen zusätzlich eigene Nachweise hochladen, aber weder HR-Dokumentarten
 * erzeugen noch Versionen verketten noch löschen. Deshalb ist dieses Modul
 * bewusst KEINE Variante der Admin-Routen (modules/employees/documentRoutes.ts),
 * sondern eine eigene, engere Fläche.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { MeDocument } from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, notFound, parse } from '../../core/errors.js';
import { isValidIsoDate } from '../../core/dates.js';
import {
  deleteFileIfUnreferenced,
  signDownloadUrl,
  storeFileStream,
  type FileRecord,
} from '../../core/files.js';
import { requireEmployee } from './lib.js';

/**
 * Kategorien, die das Portal selbst vergeben darf. `vertrag` und `zeugnis`
 * sind HR-Dokumente mit Beweiswert — würde das Portal sie erzeugen dürfen,
 * könnten Mitarbeitende sich selbst einen "Vertrag" in die Akte legen.
 */
const PORTAL_CATEGORIES = ['bescheinigung', 'zertifikat', 'sonstiges'] as const;

/**
 * Zugelassene Dateitypen. Bewusst eng: nur Formate, die der Download als
 * Anhang ausliefert (core/files.ts setzt Content-Disposition: attachment),
 * kein HTML/SVG und nichts Ausführbares.
 */
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);

/**
 * Eigene Obergrenze — strenger als das globale 50-MB-Limit aus server.ts, das
 * für HR-Uploads gilt. Sie muss hier selbst geprüft werden, das globale Limit
 * greift dafür nicht.
 */
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/**
 * Grenzen für den Multipart-Parser dieser Route. Sie werden mit den in
 * server.ts registrierten Werten zusammengeführt — hier genannte Schlüssel
 * gewinnen, fehlende bleiben global. Vollständig aufgeführt sind sie trotzdem,
 * damit an dieser Stelle sichtbar ist, was für das Portal tatsächlich gilt:
 * die globalen Werte sind an HR-Uploads ausgerichtet (50 MB, 20 Felder), das
 * Portal ist bewusst enger.
 *
 * SICHERHEIT (DoS): `parts` ist der Grund, warum die Liste nicht auf
 * `fileSize` verkürzt werden darf. Ohne eigene Angabe setzt @fastify/multipart
 * dort 1000, und busboy puffert jedes Formularfeld vollständig, bevor die
 * Route es sieht — ein einziger angemeldeter Portal-Request konnte so mehrere
 * hundert MB Arbeitsspeicher belegen und den Serverprozess kippen, mit ihm das
 * Portal UND alle Desktop-Arbeitsplätze am selben Backend. Die Route braucht
 * real vier Felder (category, title, note, expiry_date) und genau eine Datei;
 * die Werte liegen bewusst knapp darüber.
 */
const UPLOAD_LIMITS = {
  fileSize: MAX_UPLOAD_BYTES,
  files: 1,
  parts: 12,
  fields: 10,
  fieldSize: 16 * 1024,
} as const;

/**
 * Eigene Feldgrenze, die VOR `UPLOAD_LIMITS.fields` greift (8 < 10).
 *
 * Warum nicht einfach die Parser-Grenze wirken lassen: Reißt sie, koppelt
 * @fastify/multipart den Request vom Parser ab, liefert einen unmittelbar
 * darauf folgenden Datei-Teil aber noch aus — und beendet dessen Stream nicht.
 * Der Upload unten wartet dann ewig auf Daten, die nie kommen: Der Request
 * antwortet nicht mehr, Verbindung und Dateihandle bleiben bis zum
 * `requestTimeout` (server.ts) belegt, und im Storage bleibt ein Fragment
 * liegen. Nachgestellt mit 11 Feldern, gefolgt von einer Datei.
 *
 * Der eigene Zähler bricht vorher sauber mit einer deutschen Meldung ab. Die
 * Parser-Grenzen bleiben als Rückversicherung stehen — sie dürfen aber NIE
 * zuerst greifen, deshalb die Zusicherung darunter.
 */
const MAX_FIELDS = 8;

// Beim Laden des Moduls prüfen statt im Betrieb zu hoffen: Wer MAX_FIELDS
// später hochsetzt, ohne UPLOAD_LIMITS.fields mitzuziehen, holt sich die oben
// beschriebene Hänger-Situation zurück.
if (MAX_FIELDS >= UPLOAD_LIMITS.fields) {
  throw new Error(
    'MAX_FIELDS muss kleiner als UPLOAD_LIMITS.fields sein — sonst greift die Grenze des Multipart-Parsers zuerst und der Upload kann hängen bleiben.',
  );
}

/** Nur die Felder aus @ohrganize/shared MeDocument — keine internen Spalten. */
const ME_DOC_SELECT = `
  SELECT d.id, d.category, d.title, d.note, d.expiry_date, d.version, d.source, d.created_at,
         f.original_name, f.mime_type, f.size_bytes
  FROM documents d
  JOIN files f ON f.id = d.file_id`;

const uploadMetaSchema = z.object({
  category: z.enum(PORTAL_CATEGORIES, {
    errorMap: () => ({ message: 'Bitte wählen Sie eine gültige Kategorie' }),
  }),
  title: z.string().trim().min(1, 'Titel ist Pflicht').max(300),
  note: z.string().trim().max(2000).optional(),
  expiry_date: z
    .string()
    .refine(isValidIsoDate, { message: 'Datum muss im Format YYYY-MM-DD vorliegen' })
    .optional(),
});

/** "text/plain; charset=utf-8" → "text/plain" (Browser hängen Parameter an). */
function normalizeMime(mimetype: string): string {
  return mimetype.split(';')[0]!.trim().toLowerCase();
}

/** Leere Formularfelder verhalten sich wie nicht gesendete Felder. */
function optionalField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * @fastify/multipart meldet überschrittene Grenzen mit englischem Text und
 * Status 413 ("reach fields limit"). Diese Meldungen werden dem Nutzer direkt
 * angezeigt (Konvention: API-Fehler sind deutsch), deshalb hier übersetzen.
 * Alles Unbekannte bleibt unverändert und läuft in den globalen Handler.
 */
function translateMultipartError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'FST_REQ_FILE_TOO_LARGE':
      return badRequest(`Die Datei ist zu groß (maximal ${MAX_UPLOAD_MB} MB)`);
    case 'FST_FILES_LIMIT':
      return badRequest('Bitte laden Sie nur eine Datei je Dokument hoch');
    case 'FST_FIELDS_LIMIT':
    case 'FST_PARTS_LIMIT':
      return badRequest('Das Formular enthält zu viele Felder');
    case 'FST_PROTO_VIOLATION':
      return badRequest('Das Formular enthält einen unzulässigen Feldnamen');
    default:
      return err;
  }
}

export const meDocumentRoutes: FastifyPluginAsync = async (app) => {
  // --------------------------------------------------------------- Liste ---
  // Eine einzige Abfrage mit JOIN auf files (kein N+1 je Dokument).
  app.get('/api/me/documents', async (req) => {
    const emp = requireEmployee(req);
    const documents = getDb()
      .prepare(`${ME_DOC_SELECT} WHERE d.employee_id = ? ORDER BY d.created_at DESC, d.id DESC`)
      .all(emp.id) as MeDocument[];
    return { documents };
  });

  // -------------------------------------------------------------- Upload ---
  app.post('/api/me/documents', async (req, reply) => {
    const emp = requireEmployee(req);
    if (!req.isMultipart()) {
      throw badRequest('Es wurde keine Datei übertragen (multipart/form-data erwartet)');
    }

    const fields: Record<string, string> = {};
    let fieldCount = 0;
    let file: FileRecord | null = null;
    let filename = '';

    try {
      // Ein Durchlauf über alle Teile, weil die Reihenfolge in einem FormData
      // dem Client gehört: Metadaten dürfen vor ODER nach der Datei stehen.
      // Der Datei-Stream muss sofort verbraucht werden, sonst blockiert er den
      // Parser — er wandert direkt in den Storage, nie vollständig in den RAM.
      for await (const part of req.parts({ limits: UPLOAD_LIMITS })) {
        if (part.type === 'file') {
          // Greift heute nicht mehr (limits.files = 1 bricht vorher ab), bleibt
          // als Rückversicherung stehen, falls das Limit je gelockert wird.
          if (file) throw badRequest('Bitte laden Sie nur eine Datei je Dokument hoch');
          const mimeType = normalizeMime(part.mimetype);
          // Typprüfung VOR dem Speichern — ungültige Uploads kosten so keinen
          // Platz auf dem Datenträger.
          if (!ALLOWED_MIME_TYPES.has(mimeType)) {
            throw badRequest(
              'Dieser Dateityp wird nicht unterstützt. Erlaubt sind PDF, PNG, JPEG und einfache Textdateien.',
            );
          }
          filename = part.filename;
          file = await storeFileStream(part.file, part.filename, mimeType, req.user.id);
          // Oberhalb des Limits bricht busboy den Stream ab und markiert ihn als
          // `truncated` — der Stream endet regulär, gespeichert wäre also
          // stillschweigend ein Fragment. Deshalb hier prüfen; das Aufräumen
          // übernimmt der catch-Zweig.
          if (part.file.truncated) {
            throw badRequest(`Die Datei ist zu groß (maximal ${MAX_UPLOAD_MB} MB)`);
          }
          if (file.size_bytes === 0) throw badRequest('Die Datei ist leer');
        } else if (typeof part.value === 'string') {
          // Gezählt werden empfangene Teile, nicht verschiedene Feldnamen:
          // Sonst käme man mit 1000-mal demselben Namen an dieser Grenze
          // vorbei und liefe doch in die des Parsers (Begründung bei
          // MAX_FIELDS).
          if (++fieldCount > MAX_FIELDS) throw badRequest('Das Formular enthält zu viele Felder');
          fields[part.fieldname] = part.value;
        }
      }

      if (!file) throw badRequest('Es wurde keine Datei übertragen');
      // Versionierung ist HR-Sache: aus dem Portal darf niemand ein bestehendes
      // Dokument ablösen (das wäre auch ein Weg an der Kategorie-Whitelist vorbei).
      if (optionalField(fields.supersedes_id) !== undefined) {
        throw badRequest(
          'Neue Versionen bestehender Dokumente legt die Personalabteilung an. Bitte laden Sie das Dokument ohne Bezug auf eine Vorversion hoch.',
        );
      }
      const meta = parse(uploadMetaSchema, {
        category: optionalField(fields.category),
        // Ohne Titel ist der Dateiname die beste Beschreibung.
        title: optionalField(fields.title) ?? filename,
        note: optionalField(fields.note),
        expiry_date: optionalField(fields.expiry_date),
      });

      // employee_id kommt IMMER aus dem eigenen Profil, nie aus dem Request;
      // version/reminder_days bleiben auf den Spalten-Defaults, supersedes_id NULL.
      const info = getDb()
        .prepare(
          `INSERT INTO documents (employee_id, file_id, category, title, note, expiry_date,
                                  source, uploaded_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, 'portal', ?)`,
        )
        .run(
          emp.id,
          file.id,
          meta.category,
          meta.title,
          meta.note ?? null,
          meta.expiry_date ?? null,
          req.user.id,
        );
      const id = Number(info.lastInsertRowid);
      audit(req, 'create', 'document', id, {
        employee_id: emp.id,
        category: meta.category,
        title: meta.title,
        file_id: file.id,
        source: 'portal',
        self_service: true,
      });
      reply.status(201);
      return { document: getDb().prepare(`${ME_DOC_SELECT} WHERE d.id = ?`).get(id) as MeDocument };
    } catch (err) {
      // Die Datei liegt schon im Storage, sobald ihr Teil gelesen ist — die
      // Metadaten können danach noch scheitern (falsche Kategorie, fehlender
      // Titel, zu große Datei). Ohne dieses Aufräumen sammelt der Storage bei
      // jedem Fehlversuch einen Blob an, den nichts mehr referenziert und den
      // niemand je zu Gesicht bekommt — angemeldete Nutzer könnten den
      // Datenträger damit gezielt vollschreiben.
      // `deleteFileIfUnreferenced` prüft alle Fachtabellen und lässt die Datei
      // stehen, falls der INSERT oben doch schon durchlief.
      if (file) deleteFileIfUnreferenced(file.id);
      throw translateMultipartError(err);
    }
  });

  // ------------------------------------------------------------ Download ---
  app.post('/api/me/documents/:id/download', async (req, reply) => {
    const emp = requireEmployee(req);
    const id = Number((req.params as { id: string }).id);
    // ERST Eigentum prüfen, DANN signieren: signDownloadUrl() bindet nur
    // file_id und Ablaufzeit, es steckt KEINE Nutzerprüfung in der Signatur.
    // Die URL ist damit praktisch ein Bearer-Token auf diese Datei.
    const row = getDb()
      .prepare('SELECT file_id FROM documents WHERE id = ? AND employee_id = ?')
      .get([id, emp.id]) as { file_id: number } | undefined;
    // Bewusst 404 statt 403: ein 403 würde verraten, dass es das fremde
    // Dokument gibt.
    if (!row) throw notFound('Dokument nicht gefunden');
    // Der signierte Link darf in keinem Cache landen (Browser, Proxy) —
    // wer ihn hat, kommt bis zum Ablauf ohne Anmeldung an die Datei.
    reply.header('Cache-Control', 'no-store');
    // Kein Audit-Eintrag: der Blick in die eigene Akte ist keine Änderung und
    // keine Auskunft an Dritte. (Die HR-Signaturroute /api/files/:id/sign
    // auditiert dagegen sehr wohl — dort greift jemand auf eine FREMDE
    // Personalakte zu, und das muss nachvollziehbar bleiben.)
    return { url: signDownloadUrl(row.file_id) };
  });
};
