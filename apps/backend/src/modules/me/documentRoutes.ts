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
import type { MeDocument } from '@hrmonic/shared';
import { getDb } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, notFound, parse } from '../../core/errors.js';
import { isValidIsoDate } from '../../core/dates.js';
import { signDownloadUrl, storeFile } from '../../core/files.js';
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

/** Nur die Felder aus @hrmonic/shared MeDocument — keine internen Spalten. */
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
    let upload: { buffer: Buffer; filename: string; mime_type: string } | null = null;

    // Ein Durchlauf über alle Teile, weil die Reihenfolge in einem FormData
    // dem Client gehört: Metadaten dürfen vor ODER nach der Datei stehen.
    // Der Datei-Stream wird sofort gepuffert, sonst blockiert er den Parser.
    for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })) {
      if (part.type === 'file') {
        if (upload) throw badRequest('Bitte laden Sie nur eine Datei je Dokument hoch');
        const mimeType = normalizeMime(part.mimetype);
        // Typprüfung VOR dem Puffern — ungültige Uploads kosten so kein RAM.
        if (!ALLOWED_MIME_TYPES.has(mimeType)) {
          throw badRequest(
            'Dieser Dateityp wird nicht unterstützt. Erlaubt sind PDF, PNG, JPEG und einfache Textdateien.',
          );
        }
        let buffer: Buffer;
        try {
          buffer = await part.toBuffer();
        } catch (err) {
          // Oberhalb des Limits bricht busboy den Stream ab und wirft einen
          // englischen Fehler — hier in die eigene deutsche Meldung übersetzen.
          if (part.file.truncated) {
            throw badRequest(`Die Datei ist zu groß (maximal ${MAX_UPLOAD_MB} MB)`);
          }
          throw err;
        }
        if (buffer.length === 0) throw badRequest('Die Datei ist leer');
        upload = { buffer, filename: part.filename, mime_type: mimeType };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    if (!upload) throw badRequest('Es wurde keine Datei übertragen');
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
      title: optionalField(fields.title) ?? upload.filename,
      note: optionalField(fields.note),
      expiry_date: optionalField(fields.expiry_date),
    });

    const file = storeFile(upload.buffer, upload.filename, upload.mime_type, req.user.id);
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
    // Kein Audit-Eintrag: der Blick in die eigene Akte ist keine Änderung
    // (die HR-Signaturroute /api/files/:id/sign verfährt ebenso).
    return { url: signDownloadUrl(row.file_id) };
  });
};
