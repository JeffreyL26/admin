/**
 * Liest die Blattseiten von survey_responses und ihres Index roh aus einer
 * Klartextdatei und zählt, auf wie vielen Seiten die zuletzt eingefügte Zelle
 * (kleinster Versatz) zur jüngsten Teilnahme gehört. Bei einem Leck sind das
 * fast alle Seiten, bei zufälliger Lage etwa eine von so vielen, wie Zellen
 * auf einer Seite liegen. Für src/test/encryptionSmoke.ts.
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';

function varint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    const byte = buf[offset + i];
    if (i === 8) return [value * 256 + byte, 9];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  return [value, 9];
}

const SERIAL_BYTES: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8, 8: 0, 9: 0 };

function readInt(buf: Buffer, offset: number, type: number): number {
  if (type === 8) return 0;
  if (type === 9) return 1;
  let value = 0;
  for (let i = 0; i < SERIAL_BYTES[type]; i++) value = value * 256 + buf[offset + i];
  return value;
}

function leafPages(raw: Buffer, pageSize: number, root: number): number[] {
  const leaves: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const pageNo = stack.pop()!;
    const page = raw.subarray((pageNo - 1) * pageSize, pageNo * pageSize);
    if (page[0] === 0x0d || page[0] === 0x0a) {
      leaves.push(pageNo);
      continue;
    }
    stack.push(page.readUInt32BE(8));
    for (let i = 0; i < page.readUInt16BE(3); i++) stack.push(page.readUInt32BE(page.readUInt16BE(12 + 2 * i)));
  }
  return leaves;
}

/** Teilnahmenummer aus dem Antworttext (`teilnahme-<n>`). */
export function pageOrderLeaks(
  db: Database.Database,
  file: string,
): { table: [number, number]; index: [number, number] | null } {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const rootOf = (name: string) =>
    (db.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(name) as { rootpage: number } | undefined)?.rootpage;
  const tableRoot = rootOf('survey_responses')!;
  // Seit Migration 503 gibt es keinen Index mehr; ältere Stände prüft das Mass mit.
  const indexRoot = rootOf('idx_survey_responses_survey');
  const byId = new Map(
    (db.prepare('SELECT id, answers FROM survey_responses').all() as { id: number; answers: string }[]).map((r) => [
      r.id,
      Number(/teilnahme-(\d+)/.exec(r.answers)?.[1]),
    ]),
  );
  const raw = fs.readFileSync(file);
  const count = (root: number, cellId: (page: Buffer, offset: number) => number): [number, number] => {
    let newestLast = 0;
    const leaves = leafPages(raw, pageSize, root);
    for (const pageNo of leaves) {
      const page = raw.subarray((pageNo - 1) * pageSize, pageNo * pageSize);
      const cells = Array.from({ length: page.readUInt16BE(3) }, (_, k) => page.readUInt16BE(8 + 2 * k));
      if (cells.length < 2) continue;
      const numbers = cells.map((offset) => ({ offset, n: byId.get(cellId(page, offset)) ?? -1 }));
      const newest = Math.max(...numbers.map((c) => c.n));
      const lowest = numbers.reduce((a, b) => (b.offset < a.offset ? b : a));
      if (lowest.n === newest) newestLast++;
    }
    return [newestLast, leaves.length];
  };
  const tableId = (page: Buffer, offset: number) => {
    const [, lenBytes] = varint(page, offset);
    return varint(page, offset + lenBytes)[0];
  };
  const indexId = (page: Buffer, offset: number) => {
    const [, lenBytes] = varint(page, offset);
    let p = offset + lenBytes;
    const [headerLen, h] = varint(page, p);
    const [surveyType, s] = varint(page, p + h);
    const [idType] = varint(page, p + h + s);
    p += headerLen;
    p += SERIAL_BYTES[surveyType];
    return readInt(page, p, idType);
  };
  return { table: count(tableRoot, tableId), index: indexRoot === undefined ? null : count(indexRoot, indexId) };
}
