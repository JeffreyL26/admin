import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, notFound, parse } from '../../core/errors.js';
import { detachUnreferencedFile, removeDetachedBlob } from '../../core/files.js';
import { pageOffsetOf, pageRequest } from '../../core/paging.js';
import { documentBodySchema, documentCategorySchema, documentPatchSchema } from './validation.js';

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: documentCategorySchema.optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  /** Herkunft: von der Personalabteilung abgelegt oder aus dem Portal hochgeladen. */
  source: z.enum(['hr', 'portal']).optional(),
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

/**
 * Joins der Dokumentliste. Eigene Konstante, weil die geblätterte Liste mit
 * denselben Joins zählt: `files` ist ein INNER JOIN und bestimmt mit, was
 * gelistet wird.
 */
const DOC_FROM = `
  FROM documents d
  JOIN files f ON f.id = d.file_id
  LEFT JOIN employees e ON e.id = d.employee_id`;

const DOC_SELECT = `
  SELECT d.*,
         f.original_name, f.mime_type, f.size_bytes,
         e.first_name || ' ' || e.last_name AS employee_name,
         EXISTS(SELECT 1 FROM documents s WHERE s.supersedes_id = d.id) AS is_superseded,
         -- 'localtime': date('now') wäre das UTC-Datum und zwischen 0 und 2 Uhr
         -- deutscher Zeit noch der Vortag — days_until_expiry wiche dann um
         -- einen Tag von der übrigen (lokalen) Datumslogik ab (todayIso()).
         CASE WHEN d.expiry_date IS NOT NULL
              THEN CAST(julianday(d.expiry_date) - julianday(date('now', 'localtime')) AS INTEGER)
         END AS days_until_expiry
  ${DOC_FROM}
`;

function getDocumentOr404(id: number): Record<string, unknown> {
  const row = getDb()
    .prepare(`${DOC_SELECT} WHERE d.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw notFound('Dokument nicht gefunden');
  return row;
}

/**
 * Alle Versionen derselben Kette (Vorgänger über supersedes_id und Nachfolger).
 * Die Sichtbarkeit gilt je Dokument, nicht je Version: Das Portal listet auch
 * abgelöste Versionen, eine allein umgestellte aktuelle Version ließe die
 * älteren weiter sichtbar.
 */
function versionChainIds(id: number): number[] {
  const db = getDb();
  const up = db.prepare('SELECT supersedes_id FROM documents WHERE id = ?');
  const down = db.prepare('SELECT id FROM documents WHERE supersedes_id = ?');
  const ids = new Set<number>([id]);
  let cursor = (up.get(id) as { supersedes_id: number | null } | undefined)?.supersedes_id ?? null;
  while (cursor !== null && !ids.has(cursor)) {
    ids.add(cursor);
    cursor = (up.get(cursor) as { supersedes_id: number | null } | undefined)?.supersedes_id ?? null;
  }
  const queue = [...ids];
  while (queue.length > 0) {
    for (const row of down.all(queue.pop()) as { id: number }[]) {
      if (!ids.has(row.id)) {
        ids.add(row.id);
        queue.push(row.id);
      }
    }
  }
  return [...ids];
}

function setChainVisibility(anyId: number, visibility: 'portal' | 'hr'): number[] {
  const ids = versionChainIds(anyId);
  getDb()
    .prepare(`UPDATE documents SET visibility = ? WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .run(visibility, ...ids);
  return ids;
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
    if (query.source) {
      where.push('d.source = ?');
      params.push(query.source);
    }
    if (!query.include_superseded) {
      where.push('NOT EXISTS(SELECT 1 FROM documents s WHERE s.supersedes_id = d.id)');
    }
    const sql = `${DOC_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC, d.id DESC`;
    // Ohne limit ungeblättert wie bisher: Die Personalakte listet alle
    // Dokumente EINER Person samt aller Versionen. Die Ablage blättert; Suche
    // und Filter wirken dabei serverseitig über alle Seiten.
    const page = pageRequest(req.query);
    if (!page) return { documents: getDb().prepare(sql).all(...params) };

    const count = (extra: string[], extraParams: unknown[]) =>
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n ${DOC_FROM} WHERE ${[...where, ...extra].join(' AND ') || '1'}`)
          .get([...params, ...extraParams]) as { n: number }
      ).n;
    const total = count([], []);
    let offset = page.offset;
    if (page.focusId !== null) {
      const focus = getDb()
        .prepare(`SELECT d.created_at ${DOC_FROM} WHERE ${[...where, 'd.id = ?'].join(' AND ')}`)
        .get([...params, page.focusId]) as { created_at: string } | undefined;
      // Vorgänger in derselben Sortierung (created_at DESC, id DESC) zählen.
      if (focus) {
        const before = count(
          ['(d.created_at > ? OR (d.created_at = ? AND d.id > ?))'],
          [focus.created_at, focus.created_at, page.focusId],
        );
        offset = pageOffsetOf(before, page.limit);
      }
    }
    const documents = getDb()
      .prepare(`${sql} LIMIT ? OFFSET ?`)
      .all([...params, page.limit, offset]);
    return { documents, total, offset };
  });

  // Ablaufende Dokumente: expiry_date innerhalb der dokumenteigenen reminder_days
  // (inklusive bereits abgelaufener), nur aktuelle Versionen.
  app.get('/api/documents/expiring', async () => {
    const documents = getDb()
      .prepare(
        `${DOC_SELECT}
         WHERE d.expiry_date IS NOT NULL
           -- 'localtime' wie bei days_until_expiry (DOC_SELECT): sonst wichen
           -- Zähler und Erinnerungsliste zwischen 0 und 2 Uhr voneinander ab.
           AND date(d.expiry_date) <= date('now', 'localtime', '+' || d.reminder_days || ' days')
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
    // Dokument, Sichtbarkeit der Kette und Audit-Eintrag in EINER Transaktion:
    // kein Stand ohne Protokoll.
    const id = inTransaction(() => {
      const info = db
        .prepare(
          `INSERT INTO documents (employee_id, file_id, category, title, note, expiry_date, reminder_days, version, supersedes_id, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          body.visibility,
        );
      const newId = Number(info.lastInsertRowid);
      // Eine neue Version trägt ihre Sichtbarkeit in die ganze Kette, sonst
      // bliebe die abgelöste Fassung im Portal sichtbar, während die neue HR-intern ist.
      const chain = body.supersedes_id ? setChainVisibility(newId, body.visibility) : [newId];
      audit(req, 'create', 'document', newId, {
        title: body.title,
        category: body.category,
        employee_id: body.employee_id ?? null,
        version,
        visibility: body.visibility,
        ...(chain.length > 1 ? { visibility_chain: chain } : {}),
      });
      return newId;
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
      ['employee_id', 'file_id', 'category', 'title', 'note', 'expiry_date', 'reminder_days', 'visibility'] as const
    ).filter((c) => patch[c] !== undefined);
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    // Wird die hinterlegte Datei ausgetauscht, verliert die alte ihren letzten
    // Verweis. Ohne diesen Aufruf bliebe sie als Waise im Storage liegen und
    // wäre über eine signierte URL weiter abrufbar — derselbe Befund wie beim
    // Löschen (siehe DELETE unten).
    const oldFileId = existing.file_id;
    const replacesFile = patch.file_id !== undefined && patch.file_id !== oldFileId;
    // Änderung, Entfernen des Dateieintrags und Audit in EINER Transaktion;
    // den Blob auf der Platte erst nach dem Commit, ihn nimmt kein Rollback
    // zurück (detachUnreferencedFile/removeDetachedBlob in core/files.ts).
    const detached = inTransaction(() => {
      getDb()
        .prepare(`UPDATE documents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => patch[c] ?? null), id);
      const removed = replacesFile ? detachUnreferencedFile(oldFileId) : null;
      const chain = patch.visibility !== undefined ? setChainVisibility(id, patch.visibility) : [id];
      audit(req, 'update', 'document', id, {
        changed: patch,
        ...(removed ? { replaced_file_id: oldFileId, file_deleted: true } : {}),
        ...(chain.length > 1 ? { visibility_chain: chain } : {}),
      });
      return removed;
    });
    removeDetachedBlob(detached);
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
   * `detachUnreferencedFile` (wie `deleteFileIfUnreferenced`, nur mit dem Blob
   * erst nach dem Commit) prüft ALLE Spalten, die auf `files(id)` zeigen
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
    // Löschen und Audit in EINER Transaktion. Reihenfolge zwingend: erst die
    // eigene Zeile löschen, sonst hält die Referenzprüfung die Datei für
    // weiterhin gebraucht.
    const detached = inTransaction(() => {
      getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
      const removed = detachUnreferencedFile(existing.file_id);
      audit(req, 'delete', 'document', id, {
        title: existing.title,
        file_id: existing.file_id,
        // Nachvollziehbar machen, ob der Inhalt wirklich weg ist: `false` heißt,
        // ein anderer Datensatz verweist noch auf dieselbe Datei.
        file_deleted: removed !== null,
      });
      return removed;
    });
    // Erst nach dem Commit: Den Blob auf der Platte nimmt kein Rollback zurück.
    removeDetachedBlob(detached);
    reply.status(204);
  });
}
