import type { FastifyInstance } from 'fastify';
import type { CountryCode, OrgChartPerson, OrgChartResponse, OrgTreeNode } from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { signDownloadUrl } from '../../core/files.js';
import {
  assertLocationRegion,
  departmentBodySchema,
  locationBodySchema,
  locationPatchSchema,
  teamBodySchema,
} from './validation.js';

interface DepartmentRow {
  id: number;
  name: string;
  parent_id: number | null;
  head_employee_id: number | null;
  head_name: string | null;
  employee_count: number;
}

interface TeamRow {
  id: number;
  name: string;
  department_id: number | null;
  lead_employee_id: number | null;
  lead_name: string | null;
  employee_count: number;
}

// Die Baumform teilen sich Backend, Renderer und Portal — sie lebt daher in
// @ohrganize/shared. Re-Export, damit bestehende Importpfade gültig bleiben.
export type { OrgTreeNode };

function loadDepartments(): DepartmentRow[] {
  return getDb()
    .prepare(
      `SELECT d.*,
              h.first_name || ' ' || h.last_name AS head_name,
              (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status = 'aktiv') AS employee_count
       FROM departments d
       LEFT JOIN employees h ON h.id = d.head_employee_id
       ORDER BY d.name COLLATE NOCASE`,
    )
    .all() as DepartmentRow[];
}

function loadTeams(): TeamRow[] {
  return getDb()
    .prepare(
      `SELECT t.*,
              l.first_name || ' ' || l.last_name AS lead_name,
              (SELECT COUNT(*) FROM employees e WHERE e.team_id = t.id AND e.status = 'aktiv') AS employee_count
       FROM teams t
       LEFT JOIN employees l ON l.id = t.lead_employee_id
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as TeamRow[];
}

/** Baum aus Abteilungen (parent_id) + zugeordneten Teams mit Mitarbeiterzahlen. */
export function buildOrgTree(): { tree: OrgTreeNode[]; unassigned_count: number } {
  const departments = loadDepartments();
  const teams = loadTeams();
  const nodes = new Map<number, OrgTreeNode>();
  for (const d of departments) {
    nodes.set(d.id, { ...d, total_employee_count: 0, teams: [], children: [] });
  }
  for (const t of teams) {
    if (t.department_id && nodes.has(t.department_id)) nodes.get(t.department_id)!.teams.push(t);
  }
  const roots: OrgTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent_id && nodes.has(node.parent_id)) nodes.get(node.parent_id)!.children.push(node);
    else roots.push(node);
  }
  const sumUp = (node: OrgTreeNode): number => {
    node.total_employee_count =
      node.employee_count + node.children.reduce((acc, c) => acc + sumUp(c), 0);
    return node.total_employee_count;
  };
  roots.forEach(sumUp);
  const unassigned = getDb()
    .prepare("SELECT COUNT(*) AS n FROM employees WHERE department_id IS NULL AND status = 'aktiv'")
    .get() as { n: number };
  return { tree: roots, unassigned_count: unassigned.n };
}

interface ChartRow {
  id: number;
  first_name: string;
  last_name: string;
  job_title: string | null;
  employee_type: OrgChartPerson['employee_type'];
  personnel_number: string | null;
  email: string | null;
  phone: string | null;
  hire_date: string | null;
  manager_id: number | null;
  department_id: number | null;
  department_name: string | null;
  team_id: number | null;
  team_name: string | null;
  team_lead_id: number | null;
  location_id: number | null;
  location_name: string | null;
  photo_file_id: number | null;
}

/**
 * Personen-Organigramm: alle aktiven Mitarbeitenden mit der Person, unter der
 * ihre Karte hängt.
 *
 * Quelle der Linie in dieser Reihenfolge: das gepflegte Feld `manager_id`,
 * sonst die Teamleitung, sonst die nächste Abteilungsleitung aufwärts (wer
 * selbst die Leitung ist, hängt an der Leitung der übergeordneten
 * Abteilung). Ohne den Ersatz stünde jede Person ohne Vorgesetzten als
 * eigener Baum neben der Geschäftsführung, und Bestandsdaten pflegen das Feld
 * selten lückenlos. Zeiger auf Ausgeschiedene oder auf sich selbst zählen
 * nicht.
 *
 * Fotos kommen signiert mit (wie im Mitarbeiterverzeichnis): `/api/org` hängt
 * am Bereich `personal`, demselben Bereich, dem Mitarbeiterfotos zugeordnet
 * sind (core/files.ts). Wer diese Route erreicht, dürfte also auch selbst
 * signieren; hier wird nur ein Roundtrip je Karte gespart.
 */
export function buildOrgChart(): OrgChartResponse {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.id, e.first_name, e.last_name, e.job_title, e.employee_type, e.personnel_number,
              e.email, e.phone, e.hire_date, e.manager_id,
              e.department_id, d.name AS department_name,
              e.team_id, t.name AS team_name, t.lead_employee_id AS team_lead_id,
              e.location_id, l.name AS location_name, e.photo_file_id
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN teams t ON t.id = e.team_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE e.status = 'aktiv'
       ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`,
    )
    .all() as ChartRow[];
  const departments = db
    .prepare('SELECT id, name, parent_id, head_employee_id FROM departments ORDER BY name COLLATE NOCASE')
    .all() as OrgChartResponse['departments'];
  const departmentById = new Map(departments.map((d) => [d.id, d]));
  const active = new Set(rows.map((r) => r.id));

  const resolveParent = (r: ChartRow): Pick<OrgChartPerson, 'parent_id' | 'parent_source'> => {
    const usable = (id: number | null): id is number => id !== null && id !== r.id && active.has(id);
    if (usable(r.manager_id)) return { parent_id: r.manager_id, parent_source: 'manager' };
    if (usable(r.team_lead_id)) return { parent_id: r.team_lead_id, parent_source: 'team_lead' };
    let department = r.department_id !== null ? departmentById.get(r.department_id) : undefined;
    let guard = 0;
    while (department && guard++ < 100) {
      if (usable(department.head_employee_id)) {
        return { parent_id: department.head_employee_id, parent_source: 'department_head' };
      }
      department = department.parent_id !== null ? departmentById.get(department.parent_id) : undefined;
    }
    return { parent_id: null, parent_source: null };
  };

  const people: OrgChartPerson[] = rows.map((row) => {
    const { team_lead_id: _lead, ...person } = row;
    return {
      ...person,
      ...resolveParent(row),
      photo_url: row.photo_file_id ? signDownloadUrl(row.photo_file_id) : null,
    };
  });

  // Gegenseitige oder ringförmige `manager_id`-Einträge sind in den Daten
  // möglich (kein Zyklen-Check beim Speichern). Der erste Zeiger, der die
  // Kette wieder auf sich selbst zurückführt, wird gekappt; die Person steht
  // dann als eigene Wurzel. Reihenfolge nach Name, also reproduzierbar.
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const person of people) {
    const path = new Set<number>([person.id]);
    let current = person;
    while (current.parent_id !== null) {
      const next = byId.get(current.parent_id)!;
      if (path.has(next.id)) {
        current.parent_id = null;
        current.parent_source = null;
        break;
      }
      path.add(next.id);
      current = next;
    }
  }

  return { people, departments };
}

/** Zyklen-Check: läuft vom neuen Parent aufwärts — trifft er self, wäre es ein Zyklus. */
function assertNoCycle(departmentId: number, newParentId: number): void {
  if (departmentId === newParentId) {
    throw conflict('Eine Abteilung kann nicht sich selbst untergeordnet werden');
  }
  const db = getDb();
  let cursor: number | null = newParentId;
  let guard = 0;
  while (cursor !== null && guard++ < 100) {
    if (cursor === departmentId) {
      throw conflict('Umhängen nicht möglich: Das Ziel liegt unterhalb dieser Abteilung (Zyklus)');
    }
    const row = db.prepare('SELECT parent_id FROM departments WHERE id = ?').get(cursor) as
      | { parent_id: number | null }
      | undefined;
    cursor = row ? row.parent_id : null;
  }
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/org/tree', async () => buildOrgTree());
  app.get('/api/org/chart', async () => buildOrgChart());

  // ---------------- Abteilungen ----------------
  app.get('/api/departments', async () => ({ departments: loadDepartments() }));

  app.post('/api/departments', async (req, reply) => {
    const body = parse(departmentBodySchema, req.body);
    const info = getDb()
      .prepare('INSERT INTO departments (name, parent_id, head_employee_id) VALUES (?, ?, ?)')
      .run(body.name, body.parent_id ?? null, body.head_employee_id ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'department', id, { name: body.name });
    reply.status(201);
    return { department: getDb().prepare('SELECT * FROM departments WHERE id = ?').get(id) };
  });

  app.patch('/api/departments/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM departments WHERE id = ?').get(id) as
      | { id: number; name: string }
      | undefined;
    if (!existing) throw notFound('Abteilung nicht gefunden');
    const patch = parse(departmentBodySchema.partial(), req.body);
    if (patch.parent_id !== undefined && patch.parent_id !== null) {
      const parent = getDb().prepare('SELECT id FROM departments WHERE id = ?').get(patch.parent_id);
      if (!parent) throw notFound('Übergeordnete Abteilung nicht gefunden');
      assertNoCycle(id, patch.parent_id);
    }
    const cols = (['name', 'parent_id', 'head_employee_id'] as const).filter(
      (c) => patch[c] !== undefined,
    );
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    getDb()
      .prepare(`UPDATE departments SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => patch[c] ?? null), id);
    audit(req, 'update', 'department', id, { changed: patch });
    return { department: getDb().prepare('SELECT * FROM departments WHERE id = ?').get(id) };
  });

  app.delete('/api/departments/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT name FROM departments WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    if (!existing) throw notFound('Abteilung nicht gefunden');
    getDb().prepare('DELETE FROM departments WHERE id = ?').run(id);
    audit(req, 'delete', 'department', id, { name: existing.name });
    reply.status(204);
  });

  // ---------------- Teams ----------------
  app.get('/api/teams', async () => ({ teams: loadTeams() }));

  app.post('/api/teams', async (req, reply) => {
    const body = parse(teamBodySchema, req.body);
    const info = getDb()
      .prepare('INSERT INTO teams (name, department_id, lead_employee_id) VALUES (?, ?, ?)')
      .run(body.name, body.department_id ?? null, body.lead_employee_id ?? null);
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'team', id, { name: body.name });
    reply.status(201);
    return { team: getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id) };
  });

  app.patch('/api/teams/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!existing) throw notFound('Team nicht gefunden');
    const patch = parse(teamBodySchema.partial(), req.body);
    if (patch.department_id !== undefined && patch.department_id !== null) {
      const dep = getDb().prepare('SELECT id FROM departments WHERE id = ?').get(patch.department_id);
      if (!dep) throw notFound('Abteilung nicht gefunden');
    }
    const cols = (['name', 'department_id', 'lead_employee_id'] as const).filter(
      (c) => patch[c] !== undefined,
    );
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    getDb()
      .prepare(`UPDATE teams SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => patch[c] ?? null), id);
    audit(req, 'update', 'team', id, { changed: patch });
    return { team: getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id) };
  });

  app.delete('/api/teams/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT name FROM teams WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    if (!existing) throw notFound('Team nicht gefunden');
    getDb().prepare('DELETE FROM teams WHERE id = ?').run(id);
    audit(req, 'delete', 'team', id, { name: existing.name });
    reply.status(204);
  });

  // ---------------- Standorte ----------------
  app.get('/api/locations', async () => ({
    locations: getDb()
      .prepare(
        `SELECT l.*,
                (SELECT COUNT(*) FROM employees e WHERE e.location_id = l.id AND e.status = 'aktiv') AS employee_count
         FROM locations l ORDER BY l.name COLLATE NOCASE`,
      )
      .all(),
  }));

  app.post('/api/locations', async (req, reply) => {
    const body = parse(locationBodySchema, req.body);
    assertLocationRegion(body.country, body.bundesland);
    const info = getDb()
      .prepare(
        'INSERT INTO locations (name, street, zip, city, country, bundesland) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        body.name,
        body.street ?? null,
        body.zip ?? null,
        body.city ?? null,
        body.country,
        body.bundesland,
      );
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'location', id, {
      name: body.name,
      country: body.country,
      bundesland: body.bundesland,
    });
    reply.status(201);
    return { location: getDb().prepare('SELECT * FROM locations WHERE id = ?').get(id) };
  });

  app.patch('/api/locations/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM locations WHERE id = ?').get(id) as
      | { country: string; bundesland: string }
      | undefined;
    if (!existing) throw notFound('Standort nicht gefunden');
    const patch = parse(locationPatchSchema, req.body);
    // Land und Region haengen zusammen: Aendert der Rumpf nur eines von
    // beiden, wird gegen den Bestand geprueft, sonst liesse sich ein
    // deutscher Code an einem Schweizer Standort halten.
    if (patch.country !== undefined || patch.bundesland !== undefined) {
      assertLocationRegion(
        patch.country ?? (existing.country as CountryCode),
        patch.bundesland ?? existing.bundesland,
      );
    }
    const cols = (['name', 'street', 'zip', 'city', 'country', 'bundesland'] as const).filter(
      (c) => patch[c] !== undefined,
    );
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    getDb()
      .prepare(`UPDATE locations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => patch[c] ?? null), id);
    audit(req, 'update', 'location', id, { changed: patch });
    return { location: getDb().prepare('SELECT * FROM locations WHERE id = ?').get(id) };
  });

  app.delete('/api/locations/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT name FROM locations WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    if (!existing) throw notFound('Standort nicht gefunden');
    getDb().prepare('DELETE FROM locations WHERE id = ?').run(id);
    audit(req, 'delete', 'location', id, { name: existing.name });
    reply.status(204);
  });
}
