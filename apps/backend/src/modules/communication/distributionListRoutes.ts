import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import {
  countAudience,
  DISTRIBUTION_MEMBER_TYPES,
  type DistributionMemberType,
} from './audience.js';

/**
 * Verteiler: von der HR gepflegte Zielgruppen aus Abteilungen (samt
 * Unterabteilungen), Teams, Standorten und einzelnen Personen. Ankuendigungen
 * und Umfragen zeigen mit audience_type 'verteiler' darauf; wer dazugehoert,
 * entscheidet audience.ts.
 *
 * Eine Person, die bereits ueber eine Einheit desselben Verteilers erreicht
 * wird, darf nicht zusaetzlich einzeln aufgenommen werden (400): Die
 * Oberflaeche bietet sie nicht an, und ein Doppel im Datenbestand liesse die
 * Mitgliederliste etwas anderes behaupten als die Empfaengerzahl.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const memberSchema = z.object({
  member_type: z.enum(DISTRIBUTION_MEMBER_TYPES),
  member_id: z.number().int().positive(),
});

const listBodySchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(120),
  description: z.string().trim().max(500).nullable().optional(),
  members: z.array(memberSchema).max(500).default([]),
});

type Member = z.infer<typeof memberSchema>;

interface ListRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

const MEMBER_TABLE: Record<DistributionMemberType, string> = {
  abteilung: 'departments',
  team: 'teams',
  standort: 'locations',
  mitarbeiter: 'employees',
};

function getList(id: number): ListRow {
  const row = getDb().prepare('SELECT * FROM distribution_lists WHERE id = ?').get(id) as ListRow | undefined;
  if (!row) throw notFound('Verteiler nicht gefunden');
  return row;
}

function usageCount(listId: number): number {
  const row = getDb()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM announcements WHERE audience_type = 'verteiler' AND audience_id = ?)
            + (SELECT COUNT(*) FROM surveys WHERE audience_type = 'verteiler' AND audience_id = ?) AS c`,
    )
    .get(listId, listId) as { c: number };
  return row.c;
}

function memberCount(listId: number): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM distribution_list_members WHERE list_id = ?').get(listId) as {
      c: number;
    }
  ).c;
}

function listToJson(l: ListRow) {
  return {
    ...l,
    member_count: memberCount(l.id),
    recipients: countAudience('verteiler', l.id),
    usage_count: usageCount(l.id),
  };
}

/** Mitglieder mit aufgeloestem Namen: eine Abfrage je Mitgliedsart, nicht je Mitglied. */
function membersOf(listId: number): { member_type: DistributionMemberType; member_id: number; name: string | null }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT member_type, member_id FROM distribution_list_members
       WHERE list_id = ?
       ORDER BY CASE member_type WHEN 'abteilung' THEN 0 WHEN 'team' THEN 1 WHEN 'standort' THEN 2 ELSE 3 END, id`,
    )
    .all(listId) as Member[];
  const names = new Map<string, string>();
  for (const type of DISTRIBUTION_MEMBER_TYPES) {
    const ids = rows.filter((m) => m.member_type === type).map((m) => m.member_id);
    if (ids.length === 0) continue;
    const marks = ids.map(() => '?').join(', ');
    const nameSql =
      type === 'mitarbeiter'
        ? `SELECT id, (first_name || ' ' || last_name) AS name FROM employees WHERE id IN (${marks})`
        : `SELECT id, name FROM ${MEMBER_TABLE[type]} WHERE id IN (${marks})`;
    for (const r of db.prepare(nameSql).all(...ids) as { id: number; name: string }[]) {
      names.set(`${type}:${r.id}`, r.name);
    }
  }
  return rows.map((m) => ({ ...m, name: names.get(`${m.member_type}:${m.member_id}`) ?? null }));
}

/**
 * Prueft die Mitglieder: Einheit existiert, keine Doppel, und keine Person,
 * die ueber Abteilung (samt Unterabteilungen), Team oder Standort desselben
 * Verteilers schon erreicht wird.
 */
function validateMembers(members: Member[]): void {
  const db = getDb();
  const seen = new Set<string>();
  for (const m of members) {
    const key = `${m.member_type}:${m.member_id}`;
    if (seen.has(key)) throw badRequest('Ein Mitglied ist doppelt aufgeführt');
    seen.add(key);
    const exists = db.prepare(`SELECT 1 AS x FROM ${MEMBER_TABLE[m.member_type]} WHERE id = ?`).get(m.member_id);
    if (!exists) throw badRequest('Ein gewähltes Mitglied existiert nicht (mehr)');
  }

  const persons = members.filter((m) => m.member_type === 'mitarbeiter').map((m) => m.member_id);
  if (persons.length === 0) return;
  const departments = members.filter((m) => m.member_type === 'abteilung').map((m) => m.member_id);
  const teams = members.filter((m) => m.member_type === 'team').map((m) => m.member_id);
  const locations = members.filter((m) => m.member_type === 'standort').map((m) => m.member_id);
  const inList = (ids: number[]) => (ids.length === 0 ? '(NULL)' : `(${ids.map(() => '?').join(', ')})`);
  const covered = db
    .prepare(
      `SELECT (e.first_name || ' ' || e.last_name) AS name FROM employees e
       WHERE e.id IN ${inList(persons)} AND (
         e.team_id IN ${inList(teams)}
         OR e.location_id IN ${inList(locations)}
         OR e.department_id IN (
           WITH RECURSIVE sub(id) AS (
             SELECT id FROM departments WHERE id IN ${inList(departments)}
             UNION
             SELECT d.id FROM departments d JOIN sub ON d.parent_id = sub.id
           )
           SELECT id FROM sub
         )
       )
       LIMIT 1`,
    )
    .get(...persons, ...teams, ...locations, ...departments) as { name: string } | undefined;
  if (covered) {
    throw badRequest(
      `${covered.name} wird bereits über eine Abteilung, ein Team oder einen Standort dieses Verteilers erreicht und darf nicht zusätzlich einzeln aufgenommen werden`,
    );
  }
}

function replaceMembers(listId: number, members: Member[]): void {
  const db = getDb();
  db.prepare('DELETE FROM distribution_list_members WHERE list_id = ?').run(listId);
  const insert = db.prepare(
    'INSERT INTO distribution_list_members (list_id, member_type, member_id) VALUES (?, ?, ?)',
  );
  for (const m of members) insert.run(listId, m.member_type, m.member_id);
}

export const distributionListRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/communication/distribution-lists', async () => {
    const rows = getDb().prepare('SELECT * FROM distribution_lists ORDER BY name').all() as ListRow[];
    return { distribution_lists: rows.map(listToJson) };
  });

  app.get('/api/communication/distribution-lists/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const list = getList(id);
    return { distribution_list: { ...listToJson(list), members: membersOf(id) } };
  });

  app.post('/api/communication/distribution-lists', async (req, reply) => {
    const body = parse(listBodySchema, req.body);
    validateMembers(body.members);
    const duplicate = getDb()
      .prepare('SELECT id FROM distribution_lists WHERE name = ? COLLATE NOCASE')
      .get(body.name);
    if (duplicate) throw conflict('Ein Verteiler mit diesem Namen existiert bereits');
    const id = inTransaction(() => {
      const info = getDb()
        .prepare('INSERT INTO distribution_lists (name, description) VALUES (?, ?)')
        .run(body.name, body.description ?? null);
      const listId = Number(info.lastInsertRowid);
      replaceMembers(listId, body.members);
      return listId;
    });
    audit(req, 'create', 'distribution_list', id, { name: body.name, members: body.members.length });
    reply.code(201);
    return { distribution_list: { ...listToJson(getList(id)), members: membersOf(id) } };
  });

  app.put('/api/communication/distribution-lists/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    getList(id);
    const body = parse(listBodySchema, req.body);
    validateMembers(body.members);
    const duplicate = getDb()
      .prepare('SELECT id FROM distribution_lists WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(body.name, id);
    if (duplicate) throw conflict('Ein Verteiler mit diesem Namen existiert bereits');
    inTransaction(() => {
      getDb()
        .prepare('UPDATE distribution_lists SET name = ?, description = ? WHERE id = ?')
        .run(body.name, body.description ?? null, id);
      replaceMembers(id, body.members);
    });
    audit(req, 'update', 'distribution_list', id, { name: body.name, members: body.members.length });
    return { distribution_list: { ...listToJson(getList(id)), members: membersOf(id) } };
  });

  app.delete('/api/communication/distribution-lists/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const list = getList(id);
    const usage = usageCount(id);
    if (usage > 0) {
      throw conflict(
        `Der Verteiler wird noch von ${usage} ${usage === 1 ? 'Ankündigung oder Umfrage' : 'Ankündigungen oder Umfragen'} verwendet. Bitte dort zuerst die Zielgruppe ändern.`,
      );
    }
    getDb().prepare('DELETE FROM distribution_lists WHERE id = ?').run(id);
    audit(req, 'delete', 'distribution_list', id, { name: list.name });
    reply.code(204);
  });
};
