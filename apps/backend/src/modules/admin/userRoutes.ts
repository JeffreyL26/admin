/**
 * Benutzer- und Rechteverwaltung der HR-Administration.
 *
 * Zwei getrennte Dinge, die hier zusammenlaufen:
 * - `admin_roles` bündeln Rechte je Bereich (kein/lesen/bearbeiten).
 * - `users.admin_role_id` weist einem Konto eine solche Rolle zu.
 *
 * Der Zugang zu diesen Routen hängt am Bereich `benutzer` und wird bereits im
 * globalen Hook geprüft (core/permissions.ts). Hier geht es nur noch darum,
 * dass niemand die Rechteverwaltung gegen sich selbst oder gegen die
 * Erreichbarkeit der Installation wenden kann.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ADMIN_AREAS,
  PERMISSION_LEVELS,
  type AdminArea,
  type AdminPermissions,
  type PermissionLevel,
} from '@hrmonic/shared';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { permissionsFor } from '../../core/permissions.js';

const permissionsSchema = z.record(z.enum(PERMISSION_LEVELS)).refine(
  (p) => Object.keys(p).every((k) => (ADMIN_AREAS as readonly string[]).includes(k)),
  { message: 'Unbekannter Rechtebereich' },
);

const roleBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich').max(80),
  description: z.string().trim().max(400).nullish(),
  permissions: permissionsSchema,
});

const assignSchema = z.object({ admin_role_id: z.number().int().positive().nullable() });

interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  member_count: number;
}

function loadPermissions(roleId: number): AdminPermissions {
  return permissionsFor(roleId);
}

/**
 * Zählt Konten, die die Benutzerverwaltung tatsächlich ausüben können.
 * Konten ohne Rolle haben Vollzugriff und zählen deshalb mit — sonst würde die
 * Sperre bei einer frischen Installation sofort greifen.
 */
function userAdminCount(excludeUserId?: number): number {
  const rows = getDb()
    .prepare(`SELECT id, admin_role_id FROM users WHERE role = 'admin'`)
    .all() as { id: number; admin_role_id: number | null }[];
  return rows.filter(
    (r) => r.id !== excludeUserId && permissionsFor(r.admin_role_id).benutzer === 'bearbeiten',
  ).length;
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getDb();

  // ---------------------------------------------------------------- Rollen --
  app.get('/api/admin/admin-roles', async () => {
    const rows = db()
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.admin_role_id = r.id) AS member_count
         FROM admin_roles r ORDER BY r.name COLLATE NOCASE`,
      )
      .all() as RoleRow[];
    return {
      admin_roles: rows.map((r) => ({ ...r, permissions: loadPermissions(r.id) })),
    };
  });

  app.post('/api/admin/admin-roles', async (req, reply) => {
    const body = parse(roleBodySchema, req.body);
    const id = inTransaction(() => {
      const exists = db().prepare('SELECT id FROM admin_roles WHERE name = ?').get(body.name);
      if (exists) throw conflict(`Es gibt bereits eine Rolle mit dem Namen „${body.name}“.`);
      const res = db()
        .prepare('INSERT INTO admin_roles (name, description) VALUES (?, ?)')
        .run(body.name, body.description ?? null);
      const roleId = Number(res.lastInsertRowid);
      writePermissions(roleId, body.permissions);
      return roleId;
    });
    audit(req, 'create', 'admin_role', id, { name: body.name });
    reply.status(201);
    return { admin_role: { ...loadRole(id), permissions: loadPermissions(id) } };
  });

  app.patch('/api/admin/admin-roles/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const role = loadRole(id);
    const body = parse(roleBodySchema, req.body);

    // Selbstschutz: Die eigene Rolle darf man pflegen, aber nicht zum Hebel
    // machen. Rechte anheben wäre Selbstbeförderung; die Benutzerverwaltung
    // abzugeben würde die letzte Tür hinter sich zuziehen.
    if ((req.user.admin_role_id ?? null) === id) {
      const before = loadPermissions(id);
      const raised = ADMIN_AREAS.filter(
        (a) => rank(body.permissions[a] ?? 'kein') > rank(before[a]),
      );
      if (raised.length > 0) {
        throw forbidden(
          'Sie können Ihre eigenen Rechte nicht erweitern. Bitten Sie eine andere Person mit Benutzerverwaltung darum.',
        );
      }
      if ((body.permissions.benutzer ?? 'kein') !== 'bearbeiten') {
        throw forbidden(
          'Sie können sich die Benutzerverwaltung nicht selbst entziehen — sonst kann niemand die Änderung rückgängig machen.',
        );
      }
    }

    inTransaction(() => {
      const clash = db()
        .prepare('SELECT id FROM admin_roles WHERE name = ? AND id != ?')
        .get([body.name, id]);
      if (clash) throw conflict(`Es gibt bereits eine Rolle mit dem Namen „${body.name}“.`);
      db()
        .prepare('UPDATE admin_roles SET name = ?, description = ? WHERE id = ?')
        .run(body.name, body.description ?? null, id);
      writePermissions(id, body.permissions);
    });

    // Nach der Änderung muss weiterhin jemand die Rechte vergeben können.
    if (userAdminCount() === 0) {
      throw conflict('Nach dieser Änderung könnte niemand mehr Rechte vergeben.');
    }

    audit(req, 'update', 'admin_role', id, { name: body.name, before: role.name });
    return { admin_role: { ...loadRole(id), permissions: loadPermissions(id) } };
  });

  app.delete('/api/admin/admin-roles/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const role = loadRole(id);
    if ((req.user.admin_role_id ?? null) === id) {
      throw forbidden('Die eigene Rolle kann nicht gelöscht werden.');
    }
    const members = (
      db().prepare('SELECT COUNT(*) AS n FROM users WHERE admin_role_id = ?').get(id) as {
        n: number;
      }
    ).n;
    // Bewusst kein stilles Aufräumen: Ohne Rolle hätten die Konten VOLLZUGRIFF
    // (siehe Migration 002). Eine Löschung würde Rechte also ausweiten statt
    // entziehen — deshalb erst umhängen, dann löschen.
    if (members > 0) {
      throw conflict(
        `„${role.name}“ ist noch ${members === 1 ? 'einem Konto' : `${members} Konten`} zugewiesen. ` +
          'Weisen Sie diesen Konten zuerst eine andere Rolle zu — ohne Rolle hätten sie Vollzugriff.',
      );
    }
    db().prepare('DELETE FROM admin_roles WHERE id = ?').run(id);
    audit(req, 'delete', 'admin_role', id, { name: role.name });
    reply.status(204);
  });

  // --------------------------------------------------------------- Konten --
  app.get('/api/admin/users', async () => {
    const rows = db()
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.employee_id, u.admin_role_id, u.created_at,
                r.name AS admin_role_name
         FROM users u
         LEFT JOIN admin_roles r ON r.id = u.admin_role_id
         ORDER BY u.role, u.name COLLATE NOCASE`,
      )
      .all();
    return { users: rows };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(assignSchema, req.body);
    const target = db()
      .prepare('SELECT id, name, role, admin_role_id FROM users WHERE id = ?')
      .get(id) as { id: number; name: string; role: string; admin_role_id: number | null } | undefined;
    if (!target) throw notFound('Konto nicht gefunden');

    // Selbstschutz: die eigene Zuweisung ist tabu — sonst wäre jede
    // Einschränkung mit einem Klick wieder aufgehoben.
    if (id === req.user.id) {
      throw forbidden(
        'Die eigene Rolle können Sie nicht ändern. Das muss eine andere Person mit Benutzerverwaltung tun.',
      );
    }
    if (target.role !== 'admin') {
      throw badRequest('Admin-Rollen gelten nur für Konten der HR-Administration.');
    }
    if (body.admin_role_id !== null) loadRole(body.admin_role_id);

    db().prepare('UPDATE users SET admin_role_id = ? WHERE id = ?').run(body.admin_role_id, id);

    // Erreichbarkeit sichern: Es muss jemand übrig bleiben, der Rechte vergibt.
    if (userAdminCount() === 0) {
      db().prepare('UPDATE users SET admin_role_id = ? WHERE id = ?').run(target.admin_role_id, id);
      throw conflict(
        'Das wäre das letzte Konto mit Benutzerverwaltung. Vergeben Sie das Recht zuerst an jemand anderen.',
      );
    }

    audit(req, 'update', 'user_admin_role', id, {
      user: target.name,
      before: target.admin_role_id,
      after: body.admin_role_id,
    });
    return { user: db().prepare('SELECT id, email, name, role, employee_id, admin_role_id FROM users WHERE id = ?').get(id) };
  });

  // ------------------------------------------------------------- Interna ---
  function loadRole(id: number): RoleRow {
    const row = db().prepare('SELECT * FROM admin_roles WHERE id = ?').get(id) as RoleRow | undefined;
    if (!row) throw notFound('Rolle nicht gefunden');
    return row;
  }

  function writePermissions(roleId: number, permissions: Record<string, PermissionLevel>): void {
    db().prepare('DELETE FROM admin_role_permissions WHERE role_id = ?').run(roleId);
    const insert = db().prepare(
      'INSERT INTO admin_role_permissions (role_id, area, level) VALUES (?, ?, ?)',
    );
    for (const area of ADMIN_AREAS) {
      insert.run(roleId, area, permissions[area] ?? 'kein');
    }
  }
}

/** Stufen als Zahl, um „angehoben?“ vergleichen zu können. */
function rank(level: PermissionLevel): number {
  return level === 'bearbeiten' ? 2 : level === 'lesen' ? 1 : 0;
}

export type { AdminArea };
