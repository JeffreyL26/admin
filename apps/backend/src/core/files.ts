import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/db.js';
import { badRequest, notFound, unauthorized } from './errors.js';

export interface FileRecord {
  id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

/** Persistiert einen Buffer im Storage und legt den files-Eintrag an. */
export function storeFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  uploadedBy?: number,
): FileRecord {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(config.storageDir, storedName), buffer);
  const info = getDb()
    .prepare(
      `INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(originalName, storedName, mimeType, buffer.length, sha256, uploadedBy ?? null);
  return getFileRecord(Number(info.lastInsertRowid));
}

export function getFileRecord(id: number): FileRecord {
  const row = getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
  if (!row) throw notFound('Datei nicht gefunden');
  return row;
}

/**
 * Kurzlebige signierte Download-URL — funktioniert für Desktop- und
 * (späteren) Web-Client identisch, ohne dass der Download-Request selbst
 * einen Auth-Header braucht (z. B. für <img src> oder Betriebssystem-Viewer).
 */
export function signDownloadUrl(fileId: number): string {
  const expires = Date.now() + config.downloadUrlTtlMs;
  const sig = crypto
    .createHmac('sha256', config.secret)
    .update(`${fileId}.${expires}`)
    .digest('hex');
  return `/api/files/${fileId}/download?expires=${expires}&sig=${sig}`;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/files', async (req) => {
    const data = await req.file();
    if (!data) throw badRequest('Keine Datei übertragen');
    const buffer = await data.toBuffer();
    const record = storeFile(buffer, data.filename, data.mimetype, req.user.id);
    return { file: record };
  });

  app.post('/api/files/:id/sign', async (req) => {
    const id = Number((req.params as { id: string }).id);
    getFileRecord(id);
    return { url: signDownloadUrl(id) };
  });

  app.get('/api/files/:id/download', { config: { public: true } }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { expires, sig } = req.query as { expires?: string; sig?: string };
    if (!expires || !sig) throw unauthorized('Download-Link ist ungültig');
    if (Number(expires) < Date.now()) throw unauthorized('Download-Link ist abgelaufen');
    const expected = crypto
      .createHmac('sha256', config.secret)
      .update(`${id}.${expires}`)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw unauthorized('Download-Link ist ungültig');
    }
    const record = getFileRecord(id);
    const filePath = path.join(config.storageDir, record.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('Dateiinhalt fehlt im Storage');
    reply
      .header('Content-Type', record.mime_type)
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(record.original_name)}`,
      );
    return reply.send(fs.createReadStream(filePath));
  });
}
