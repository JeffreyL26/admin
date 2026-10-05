import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { parse, conflict, notFound } from '../../core/errors.js';
import { audit, auditStandalone } from '../../core/audit.js';
import { storeFile, signDownloadUrl, assertMayReadFile, deleteFileIfUnreferenced } from '../../core/files.js';
import { getAllSettings } from '../../core/settings.js';
import { CERTIFICATE_KIND_LABELS, type CertificateKind } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { getEmployee } from './lib.js';
import { certificateTemplateFor } from './certificates/index.js';

// Vorlage und Arten kommen aus dem Land der Variante, nicht aus einer festen
// Liste in dieser Datei (certificates/, Registry je Land).
const template = certificateTemplateFor(VARIANT.country);

const certificateSchema = z.object({
  employee_id: z.number().int().positive(),
  kind: z.enum(template.kinds as unknown as [CertificateKind, ...CertificateKind[]]),
  period: z.string().trim().min(4, 'Jahr bzw. Zeitraum ist Pflicht').max(50),
  note: z.string().trim().max(500).optional().nullable(),
});

export async function certificateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/compensation/certificates', async (req) => {
    const { employee_id, kind } = req.query as { employee_id?: string; kind?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (employee_id) {
      conditions.push('c.employee_id = ?');
      params.push(Number(employee_id));
    }
    if (kind) {
      conditions.push('c.kind = ?');
      params.push(kind);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const certificates = getDb()
      .prepare(
        `SELECT c.*, e.first_name, e.last_name FROM certificates c
         JOIN employees e ON e.id = c.employee_id
         ${where} ORDER BY c.created_at DESC, c.id DESC`,
      )
      .all(...params);
    return { certificates };
  });

  // Erstellen: generiert die HTML-Bescheinigung und legt sie via storeFile im
  // Backend-Storage ab (file_id) → Status 'erstellt'.
  app.post('/api/compensation/certificates', async (req, reply) => {
    const body = parse(certificateSchema, req.body);
    const employee = getEmployee(body.employee_id);
    const html = template.render(body.kind, body.period, employee, getAllSettings());
    const fileName = `${body.kind}_${employee.last_name.toLowerCase()}_${body.period.replace(/[^\w-]/g, '_')}.html`;
    // Die Datei liegt vor dem Datensatz auf der Platte (wie bei jedem Upload);
    // scheitert der Commit unten, bleibt höchstens ein unreferenzierter Blob.
    const file = storeFile(Buffer.from(html, 'utf8'), fileName, 'text/html; charset=utf-8', req.user.id);
    // Datensatz und Audit-Eintrag in einem Commit.
    const certificate = inTransaction(() => {
      const info = getDb()
        .prepare(
          `INSERT INTO certificates (employee_id, kind, period, file_id, status, note)
           VALUES (?, ?, ?, ?, 'erstellt', ?)`,
        )
        .run(body.employee_id, body.kind, body.period, file.id, body.note ?? null);
      audit(req, 'certificate.create', 'certificate', Number(info.lastInsertRowid), {
        employee_id: body.employee_id,
        kind: body.kind,
        period: body.period,
        file_id: file.id,
      });
      return getDb()
        .prepare('SELECT * FROM certificates WHERE id = ?')
        .get(Number(info.lastInsertRowid));
    });
    reply.status(201);
    return { certificate };
  });

  // Ausgabe: kurzlebige signierte Download-URL der abgelegten Datei.
  //
  // Fachlich ein Lesevorgang; POST steht hier nur, damit der signierte Link
  // nicht selbst in einem Query-String (und damit im Proxy-Log) landet.
  // core/permissions.ts führt die Route deshalb in READ_ONLY_POST_ROUTES —
  // sonst käme eine Rolle mit verguetung: 'lesen' an keine einzige
  // Bescheinigung heran, die sie einsehen darf.
  app.post('/api/compensation/certificates/:id/sign', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const certificate = getDb().prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | { file_id: number | null; employee_id: number; kind: string }
      | undefined;
    if (!certificate) throw notFound('Bescheinigung nicht gefunden');
    if (!certificate.file_id) throw conflict('Für diese Bescheinigung liegt keine Datei vor');
    // Zweite Stufe, unabhängig vom Routenpräfix: Die signierte URL ist bis zum
    // Ablauf ein anmeldefreier Vollzugriff auf die Datei. Wer sie ausstellt,
    // muss die Datei auch lesen dürfen — geprüft über den Fachbereich der
    // referenzierenden Tabelle (hier 'verguetung').
    assertMayReadFile(req, certificate.file_id);
    // Der Link darf in keinem Cache landen (Browser, Proxy).
    reply.header('Cache-Control', 'no-store, private');
    auditStandalone(req, 'certificate.sign', 'certificate', id, {
      employee_id: certificate.employee_id,
      kind: certificate.kind,
      file_id: certificate.file_id,
    });
    return { url: signDownloadUrl(certificate.file_id) };
  });

  // Statusverwaltung: erstellt → ausgehaendigt. Mit der Aushaendigung wandert
  // die Datei als Dokument an das Personalprofil (Kategorie 'bescheinigung',
  // sichtbar im Portal unter Dokumente); dieselbe file_id, keine Kopie.
  // Idempotent: Ein bereits verknuepftes Dokument wird nicht doppelt angelegt.
  app.post('/api/compensation/certificates/:id/status', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(z.object({ status: z.enum(['ausgehaendigt']) }), req.body);
    const db = getDb();
    const certificate = db.prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | { id: number; employee_id: number; kind: string; period: string; file_id: number | null; status: string }
      | undefined;
    if (!certificate) throw notFound('Bescheinigung nicht gefunden');
    if (certificate.status !== 'erstellt') {
      throw conflict(`Statuswechsel von „${certificate.status}" nach „${body.status}" ist nicht möglich`);
    }
    if (!certificate.file_id) throw conflict('Für diese Bescheinigung liegt keine Datei vor');
    const fileId = certificate.file_id;
    inTransaction(() => {
      db.prepare('UPDATE certificates SET status = ? WHERE id = ?').run(body.status, id);
      const existing = db
        .prepare('SELECT id FROM documents WHERE employee_id = ? AND file_id = ?')
        .get(certificate.employee_id, fileId) as { id: number } | undefined;
      let documentId: number;
      if (existing) {
        documentId = existing.id;
      } else {
        const label = CERTIFICATE_KIND_LABELS[certificate.kind as CertificateKind] ?? certificate.kind;
        const info = db
          .prepare(
            `INSERT INTO documents (employee_id, file_id, category, title, source, visibility, uploaded_by_user_id)
             VALUES (?, ?, 'bescheinigung', ?, 'hr', 'portal', ?)`,
          )
          .run(certificate.employee_id, fileId, `${label} ${certificate.period}`, req.user.id);
        documentId = Number(info.lastInsertRowid);
      }
      audit(req, 'certificate.handover', 'certificate', id, {
        employee_id: certificate.employee_id,
        kind: certificate.kind,
        old_status: certificate.status,
        new_status: body.status,
        document_id: documentId,
      });
    });
    return { certificate: db.prepare('SELECT * FROM certificates WHERE id = ?').get(id) };
  });

  app.delete('/api/compensation/certificates/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const certificate = getDb().prepare('SELECT * FROM certificates WHERE id = ?').get(id) as
      | { status: string; file_id: number | null }
      | undefined;
    if (!certificate) throw notFound('Bescheinigung nicht gefunden');
    if (certificate.status === 'ausgehaendigt') {
      throw conflict('Ausgehändigte Bescheinigungen können nicht gelöscht werden');
    }
    inTransaction(() => {
      getDb().prepare('DELETE FROM certificates WHERE id = ?').run(id);
      audit(req, 'certificate.delete', 'certificate', id);
    });
    // Auch die erzeugte Datei muss weg, sonst bliebe die gelöschte
    // Bescheinigung im Storage liegen und für das anlegende Konto signierbar
    // (Muster: core/files.ts deleteFileIfUnreferenced). Erst nach dem Commit,
    // weil ein Rollback den gelöschten Blob nicht zurückbrächte.
    if (certificate.file_id) deleteFileIfUnreferenced(certificate.file_id);
    reply.status(204);
  });
}
