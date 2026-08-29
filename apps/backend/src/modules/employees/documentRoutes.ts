import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, notFound, parse } from '../../core/errors.js';
import { deleteFileIfUnreferenced } from '../../core/files.js';
import { documentBodySchema, documentPatchSchema } from './validation.js';

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.enum(['vertrag', 'zeugnis', 'zertifikat', 'bescheinigung', 'sonstiges']).optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  /** true = auch von neueren Versionen abgelöste Dokumente ausliefern. */
  include_superseded: z.coerce.boolean().optional(),
});

/**
 * Nutzereingabe → FTS5-MATCH-Ausdruck: Tokens werden als Prefix-Phrasen
 * ("token"*) UND-verknüpft; Sonderzeichen sind so unschädlich.
 */
function ftsQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok.replace(/"/g, '""')}"*`)
    .join(' ');
}

const DOC_SELECT = `
  SELECT d.*,
         f.original_name, f.mime_type, f.size_bytes,
         e.first_name || ' ' || e.last_name AS employee_name,
         EXISTS(SELECT 1 FROM documents s WHERE s.supersedes_id = d.id) AS is_superseded,
         CASE WHEN d.expiry_date IS NOT NULL
              THEN CAST(julianday(d.expiry_date) - julianday(date('now')) AS INTEGER)
         END AS days_until_expiry
  FROM documents d
  JOIN files f ON f.id = d.file_id
  LEFT JOIN employees e ON e.id = d.employee_id
`;

function getDocumentOr404(id: number): Record<string, unknown> {
  const row = getDb()
    .prepare(`${DOC_SELECT} WHERE d.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw notFound('Dokument nicht gefunden');
  return row;
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // Liste mit FTS5-Volltextsuche über Titel/Notiz/Kategorie/Dateiname/Mitarbeitername.
  app.get('/api/documents', async (req) => {
    const query = parse(listQuerySchema, req.query ?? {});
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      where.push('d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)');
      params.push(ftsQuery(query.search));
    }
    if (query.category) {
      where.push('d.category = ?');
      params.push(query.category);
    }
    if (query.employee_id !== undefined) {
      where.push('d.employee_id = ?');
      params.push(query.employee_id);
    }
    if (!query.include_superseded) {
      where.push('NOT EXISTS(SELECT 1 FROM documents s WHERE s.supersedes_id = d.id)');
    }
    const sql = `${DOC_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC, d.id DESC`;
    return { documents: getDb().prepare(sql).all(...params) };
  });

  // Ablaufende Dokumente: expiry_date innerhalb der dokumenteigenen reminder_days
  // (inklusive bereits abgelaufener), nur aktuelle Versionen.
  app.get('/api/documents/expiring', async () => {
    const documents = getDb()
      .prepare(
        `${DOC_SELECT}
         WHERE d.expiry_date IS NOT NULL
           AND date(d.expiry_date) <= date('now', '+' || d.reminder_days || ' days')
           AND NOT EXISTS(SELECT 1 FROM documents s WHERE s.supersedes_id = d.id)
         ORDER BY d.expiry_date ASC`,
      )
      .all();
    return { documents };
  });

  // Metadaten-Anlage nach Upload über POST /api/files (Core).
  app.post('/api/documents', async (req, reply) => {
    const body = parse(documentBodySchema, req.body);
    const db = getDb();
    if (!db.prepare('SELECT id FROM files WHERE id = ?').get(body.file_id)) {
      throw notFound('Datei nicht gefunden — bitte zuerst über POST /api/files hochladen');
    }
    if (body.employee_id && !db.prepare('SELECT id FROM employees WHERE id = ?').get(body.employee_id)) {
      throw notFound('Mitarbeiter:in nicht gefunden');
    }
    let version = 1;
    if (body.supersedes_id) {
      const old = db
        .prepare('SELECT version, employee_id FROM documents WHERE id = ?')
        .get(body.supersedes_id) as { version: number; employee_id: number | null } | undefined;
      if (!old) throw notFound('Vorgängerversion nicht gefunden');
      version = old.version + 1;
    }
    const info = db
      .prepare(
        `INSERT INTO documents (employee_id, file_id, category, title, note, expiry_date, reminder_days, version, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.employee_id ?? null,
        body.file_id,
        body.category,
        body.title,
        body.note ?? null,
        body.expiry_date ?? null,
        body.reminder_days,
        version,
        body.supersedes_id ?? null,
      );
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'document', id, {
      title: body.title,
      category: body.category,
      employee_id: body.employee_id ?? null,
      version,
    });
    reply.status(201);
    return { document: getDocumentOr404(id) };
  });

  app.patch('/api/documents/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | { file_id: number }
      | undefined;
    if (!existing) throw notFound('Dokument nicht gefunden');
    const patch = parse(documentPatchSchema, req.body);
    const cols = (
      ['employee_id', 'file_id', 'category', 'title', 'note', 'expiry_date', 'reminder_days'] as const
    ).filter((c) => patch[c] !== undefined);
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    getDb()
      .prepare(`UPDATE documents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => patch[c] ?? null), id);
    // Wird die hinterlegte Datei ausgetauscht, verliert die alte ihren letzten
    // Verweis. Ohne diesen Aufruf bliebe sie als Waise im Storage liegen und
    // wäre über eine signierte URL weiter abrufbar — derselbe Befund wie beim
    // Löschen (siehe DELETE unten).
    const oldFileId = existing.file_id;
    let fileDeleted = false;
    if (patch.file_id !== undefined && patch.file_id !== oldFileId) {
      fileDeleted = deleteFileIfUnreferenced(oldFileId);
    }
    audit(req, 'update', 'document', id, {
      changed: patch,
      ...(fileDeleted ? { replaced_file_id: oldFileId, file_deleted: true } : {}),
    });
    return { document: getDocumentOr404(id) };
  });

  /**
   * Löscht Metadaten UND — sofern niemand sonst mehr darauf zeigt — die Datei.
   *
   * SICHERHEIT/DSGVO: Ohne den zweiten Schritt blieben `files`-Zeile und Blob
   * im Storage liegen. Die Datei wäre über `POST /api/files/:id/sign` weiter
   * signierbar und damit abrufbar — ein Löschersuchen nach Art. 17 DSGVO wäre
   * nur vorgetäuscht, und in der Auskunft nach Art. 15 fehlte der Bestand.
   * Bitte nicht wieder auf ein reines `DELETE FROM documents` zurückdrehen.
   *
   * `deleteFileIfUnreferenced` prüft ALLE Spalten, die auf `files(id)` zeigen
   * (Liste in core/files.ts) und lässt die Datei stehen, wenn ein anderer
   * Datensatz denselben Blob verknüpft — etwa wenn HR dieselbe hochgeladene
   * Datei zusätzlich als Vertrag hinterlegt hat.
   */
  app.delete('/api/documents/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT title, file_id FROM documents WHERE id = ?').get(id) as
      | { title: string; file_id: number }
      | undefined;
    if (!existing) throw notFound('Dokument nicht gefunden');
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
    // Reihenfolge zwingend: erst die eigene Zeile löschen, sonst hält die
    // Referenzprüfung die Datei für weiterhin gebraucht.
    const fileDeleted = deleteFileIfUnreferenced(existing.file_id);
    audit(req, 'delete', 'document', id, {
      title: existing.title,
      file_id: existing.file_id,
      // Nachvollziehbar machen, ob der Inhalt wirklich weg ist: `false` heißt,
      // ein anderer Datensatz verweist noch auf dieselbe Datei.
      file_deleted: fileDeleted,
    });
    reply.status(204);
  });
}
