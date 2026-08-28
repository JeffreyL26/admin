import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Role, RoleMember } from '@hrmonic/shared';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';

const roleBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich').max(80),
  description: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

const rolePatchSchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich').max(80).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

const employeeRolesSchema = z.object({
  role_ids: z.array(z.number().int().positive()),
});

const MEMBER_SELECT = `
  SELECT e.id, e.first_name, e.last_name, e.employee_type, e.status, e.job_title,
         d.name AS department_name
  FROM employee_roles er
  JOIN employees e ON e.id = er.employee_id
  LEFT JOIN departments d ON d.id = e.department_id`;

function getRoleOr404(id: number): Role {
  const row = getDb().prepare('SELECT * FROM roles WHERE id = ?').get(id) as Role | undefined;
  if (!row) throw notFound('Rolle nicht gefunden');
  return row;
}

/**
 * Wirft 409, wenn der Name schon vergeben ist. Die eigentliche Garantie ist der
 * UNIQUE-Index auf roles.name — der Vorabcheck existiert nur, damit der Client
 * eine deutsche Fachmeldung statt der generischen Constraint-Meldung bekommt.
 */
function assertNameFree(name: string, exceptId?: number): void {
  const row = getDb().prepare('SELECT id FROM roles WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (row && row.id !== exceptId) {
    throw conflict(`Die Rolle „${name}“ existiert bereits`);
  }
}

export async function roleRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getDb();

  // Mitgliederzahl kommt aus demselben Query (LEFT JOIN + GROUP BY) — eine
  // Zählabfrage je Rolle wäre bei frei wachsenden Rollenlisten N+1.
  app.get('/api/admin/roles', async () => {
    const roles = db()
      .prepare(
        `SELECT r.*, COUNT(er.employee_id) AS member_count
         FROM roles r
         LEFT JOIN employee_roles er ON er.role_id = r.id
         GROUP BY r.id
         ORDER BY r.active DESC, r.name COLLATE NOCASE`,
      )
      .all() as Role[];
    return { roles };
  });

  app.post('/api/admin/roles', async (req, reply) => {
    const body = parse(roleBodySchema, req.body);
    assertNameFree(body.name);
    const result = db()
      .prepare('INSERT INTO roles (name, description, active) VALUES (?, ?, ?)')
      .run(body.name, body.description ?? null, body.active === false ? 0 : 1);
    const id = Number(result.lastInsertRowid);
    audit(req, 'create', 'role', id, { name: body.name });
    reply.status(201);
    return { role: getRoleOr404(id) };
  });

  app.patch('/api/admin/roles/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getRoleOr404(id);
    const patch = parse(rolePatchSchema, req.body);
    if (patch.name === undefined && patch.description === undefined && patch.active === undefined) {
      throw badRequest('Keine Änderungen übergeben');
    }
    if (patch.name !== undefined) assertNameFree(patch.name, id);
    db()
      .prepare('UPDATE roles SET name = ?, description = ?, active = ? WHERE id = ?')
      .run(
        patch.name ?? existing.name,
        patch.description !== undefined ? patch.description : existing.description,
        patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active,
        id,
      );
    audit(req, 'update', 'role', id, { changed: patch });
    return { role: getRoleOr404(id) };
  });

  // Löschen räumt per ON DELETE CASCADE nicht nur die Zuweisungen in
  // employee_roles, sondern auch die Allowlist-Einträge in absence_type_roles —
  // eine gelöschte Rolle nimmt also die mit ihr formulierten Berechtigungsregeln
  // mit. Steht sie in der Allowlist einer Art allein, darf danach wieder jede:r
  // diese Art beantragen (leere Allowlist = alle Rollen).
  app.delete('/api/admin/roles/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getRoleOr404(id);
    const members = db()
      .prepare('SELECT COUNT(*) AS n FROM employee_roles WHERE role_id = ?')
      .get(id) as { n: number };
    db().prepare('DELETE FROM roles WHERE id = ?').run(id);
    audit(req, 'delete', 'role', id, { name: existing.name, member_count: members.n });
    reply.status(204);
  });

  app.get('/api/admin/roles/:id/members', async (req) => {
    const id = Number((req.params as { id: string }).id);
    getRoleOr404(id);
    const employees = db()
      .prepare(
        `${MEMBER_SELECT}
         WHERE er.role_id = ?
         ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`,
      )
      .all(id) as RoleMember[];
    return { employees };
  });

  /** Ersetzt die Rollenzuweisung einer Person vollständig (kein Teil-Update). */
  app.put('/api/admin/employees/:id/roles', async (req) => {
    const employeeId = Number((req.params as { id: string }).id);
    if (!db().prepare('SELECT id FROM employees WHERE id = ?').get(employeeId)) {
      throw notFound('Mitarbeiter:in nicht gefunden');
    }
    const body = parse(employeeRolesSchema, req.body);
    // Doppelte IDs würden am zusammengesetzten Primärschlüssel scheitern.
    const roleIds = [...new Set(body.role_ids)];
    if (roleIds.length > 0) {
      const found = db()
        .prepare(`SELECT id FROM roles WHERE id IN (${roleIds.map(() => '?').join(', ')})`)
        .all(roleIds) as { id: number }[];
      if (found.length !== roleIds.length) {
        throw badRequest('Mindestens eine der übergebenen Rollen existiert nicht');
      }
    }

    // Löschen und Neuanlage müssen zusammen gelten — sonst stünde die Person bei
    // einem Fehler in der Mitte ganz ohne Rollen da.
    inTransaction(() => {
      db().prepare('DELETE FROM employee_roles WHERE employee_id = ?').run(employeeId);
      const insert = db().prepare('INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)');
      for (const roleId of roleIds) insert.run(employeeId, roleId);
    });
    audit(req, 'update', 'employee_roles', employeeId, { role_ids: roleIds });

    const roles = db()
      .prepare(
        `SELECT r.* FROM employee_roles er
         JOIN roles r ON r.id = er.role_id
         WHERE er.employee_id = ?
         ORDER BY r.name COLLATE NOCASE`,
      )
      .all(employeeId) as Role[];
    return { roles };
  });
}
