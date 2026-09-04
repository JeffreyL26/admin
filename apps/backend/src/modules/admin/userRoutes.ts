/**
 * Benutzer- und Rechteverwaltung der HR-Administration.
 *
 * Drei Dinge, die hier zusammenlaufen:
 * - `admin_roles` bündeln Rechte je Bereich (kein/lesen/bearbeiten).
 * - `users.admin_role_id` weist einem Konto eine solche Rolle zu.
 * - Konten werden hier angelegt, zurückgesetzt und gelöscht.
 *
 * Der Zugang zu diesen Routen hängt am Bereich `benutzer` und wird bereits im
 * globalen Hook geprüft (core/permissions.ts). Hier geht es nur noch darum,
 * dass niemand die Rechteverwaltung gegen sich selbst, gegen ranghöhere Konten
 * oder gegen die Erreichbarkeit der Installation wenden kann.
 *
 * Passwörter: Diese Routen nehmen NIE ein Passwort entgegen. Erst- und
 * Ersatzpasswörter erzeugt der Server zufällig, gibt sie genau einmal in der
 * Antwort zurück und erzwingt über `must_change_password` den Wechsel beim
 * ersten Login. Damit gibt es keinen Weg mehr, ein schwaches oder aus der
 * Dokumentation bekanntes Passwort zu setzen — genau das war der Grund, warum
 * `npm run seed` mit seinen Demo-Passwörtern bisher der De-facto-Weg war,
 * Konten anzulegen. Passwörter dürfen weder ins Audit-Log noch in req.log.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  ADMIN_AREAS,
  ADMIN_AREA_LABELS,
  PERMISSION_LEVELS,
  type AdminArea,
  type AdminPermissions,
  type PermissionLevel,
} from '@ohrganize/shared';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { permissionsFor } from '../../core/permissions.js';
import { nextSessionsValidFrom } from '../../core/auth.js';

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

/**
 * Anlage eines Kontos. Bewusst OHNE Passwortfeld — siehe Kopfkommentar.
 * Die E-Mail wird normalisiert (getrimmt, klein), weil sie der Login-Schlüssel
 * ist: `WHERE email = ?` vergleicht in SQLite binär, „Anna@…“ und „anna@…“
 * wären sonst zwei Konten, von denen sich nur eines wie erwartet anmeldet.
 */
const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-Mail-Adresse ist ungültig').max(200),
  name: z.string().trim().min(1, 'Name ist erforderlich').max(120),
  role: z.enum(['admin', 'mitarbeiter']),
  employee_id: z.number().int().positive().nullish(),
  admin_role_id: z.number().int().positive().nullish(),
});

interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  member_count: number;
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  employee_id: number | null;
  admin_role_id: number | null;
}

/** Rechte eines Kontos ohne jede Admin-Berechtigung (Portal-Konten). */
const NO_ACCESS: AdminPermissions = Object.fromEntries(
  ADMIN_AREAS.map((a) => [a, 'kein' as PermissionLevel]),
) as AdminPermissions;

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

/**
 * Rechte, die ein Konto tatsächlich ausübt.
 *
 * `admin_role_id = NULL` bedeutet nur bei role 'admin' Vollzugriff (Migration
 * 002). Ein Portal-Konto hat ebenfalls keine Rolle, aber keinerlei
 * Admin-Rechte — `permissionsFor` allein würde es fälschlich als das mächtigste
 * Konto der Installation einstufen und wäre damit gegen jede Änderung geschützt.
 */
function effectivePermissions(account: { role: string; admin_role_id: number | null }): AdminPermissions {
  return account.role === 'admin' ? permissionsFor(account.admin_role_id) : NO_ACCESS;
}

/** Rechte der handelnden Person. Der globale Hook garantiert hier role 'admin'. */
function ownPermissions(req: FastifyRequest): AdminPermissions {
  return permissionsFor(req.user.admin_role_id ?? null);
}

/**
 * Eskalationsdeckel: Niemand darf Rechte vergeben oder anfassen, die über die
 * eigenen hinausgehen.
 *
 * Ohne diese Prüfung genügt der Bereich `benutzer` = bearbeiten für den
 * Vollzugriff: eine neue Rolle mit allen Rechten anlegen (oder eine bestehende
 * hochziehen), sie einem frisch angelegten Zweitkonto geben — dessen
 * Erstpasswort man in der Antwort selbst bekommt — und sich damit anmelden.
 * Dieselbe Prüfung sperrt die Gegenrichtung: Ein eingeschränktes Konto darf
 * ranghöhere Rollen und Konten auch nicht beschneiden oder löschen, sonst wird
 * aus der Rechteverwaltung ein Hebel gegen die Geschäftsführung.
 */
function assertWithinOwnRights(
  req: FastifyRequest,
  levels: Partial<AdminPermissions>,
  message: string,
): void {
  const own = ownPermissions(req);
  const exceeded = ADMIN_AREAS.filter((a) => rank(levels[a] ?? 'kein') > rank(own[a]));
  if (exceeded.length > 0) {
    throw forbidden(
      `${message} Betroffene Bereiche: ${exceeded.map((a) => ADMIN_AREA_LABELS[a]).join(', ')}.`,
    );
  }
}

/**
 * Erstpasswort: 12 zufällige Bytes (96 Bit) als base64url — 16 Zeichen, in
 * jeder Umgebung ohne Kodierungsfragen weiterzugeben. Es wird nur gehasht
 * gespeichert und genau einmal in der Antwort ausgegeben; erraten lässt es sich
 * nicht, und die Zeit bis zum erzwungenen Wechsel ist kurz.
 */
function generateInitialPassword(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Löst alle Verweise auf ein Konto, damit es gelöscht werden kann.
 *
 * Die Fachtabellen verweisen mit „wer hat das gemacht"-Spalten auf `users(id)`
 * (`audit_log.user_id`, `absence_requests.decided_by_user_id`, …) — alle
 * NULL-bar, aber ohne ON DELETE SET NULL. Da `foreign_keys = ON` gesetzt ist
 * (db/db.ts), scheitert sonst jedes DELETE an der Fremdschlüsselprüfung, sobald
 * das Konto irgendetwas getan hat — also praktisch immer.
 *
 * Die Verweise werden über PRAGMA foreign_key_list ermittelt statt hier
 * aufgezählt: Ein neues Modul mit einer weiteren *_user_id-Spalte ist damit
 * automatisch berücksichtigt, statt die Kontolöschung mit einem rohen
 * SQLite-Fehler zu brechen.
 *
 * Bewusste Folge: Die Einträge im Audit-Log BLEIBEN erhalten, verlieren aber
 * ihre Zuordnung (`user_name` wird leer). Genau das ist die Bedeutung einer
 * Kontolöschung — die Spur der Änderung bleibt, die Person verschwindet.
 * Wer die Zuordnung behalten will, entzieht dem Konto die Rechte, statt es zu
 * löschen.
 */
function detachUserReferences(userId: number): void {
  const db = getDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  for (const { name } of tables) {
    // Tabellennamen stammen aus sqlite_master, nicht aus der Anfrage; die
    // Prüfung hält die Zeichenkettenverkettung unten trotzdem nachweisbar sicher.
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    const fks = db.pragma(`foreign_key_list("${name}")`) as {
      table: string;
      from: string;
      to: string | null;
    }[];
    const columns = db.pragma(`table_info("${name}")`) as { name: string; notnull: number }[];
    for (const fk of fks) {
      if (fk.table !== 'users' || (fk.to !== null && fk.to !== 'id')) continue;
      const column = columns.find((c) => c.name === fk.from);
      if (!column) continue;
      if (column.notnull === 1) {
        // Lieber ein klarer Fehler als ein halb gelöschtes Konto.
        throw conflict(
          `Das Konto ist in „${name}" fest verknüpft und kann deshalb nicht gelöscht werden.`,
        );
      }
      db.prepare(`UPDATE "${name}" SET "${fk.from}" = NULL WHERE "${fk.from}" = ?`).run(userId);
    }
  }
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
    // Eskalationsdeckel (Audit S4): Eine neue Rolle darf nicht mehr können als
    // die Person, die sie anlegt — sonst ist die Rechteverwaltung selbst der
    // kürzeste Weg zum Vollzugriff.
    assertWithinOwnRights(
      req,
      body.permissions,
      'Sie können keine Rolle mit Rechten anlegen, die Sie selbst nicht haben.',
    );
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

    // Eskalationsdeckel (Audit S4), beide Richtungen:
    // - Die neuen Stufen dürfen die eigenen Rechte nicht überschreiten (sonst
    //   legt man sich die Vollmacht über ein zweites Konto selbst zu).
    // - Auch die BESTEHENDEN Stufen müssen gedeckt sein: Eine ranghöhere Rolle
    //   darf ein eingeschränktes Konto weder kapern noch beschneiden.
    assertWithinOwnRights(
      req,
      body.permissions,
      'Sie können einer Rolle keine Rechte geben, die Sie selbst nicht haben.',
    );
    assertWithinOwnRights(
      req,
      loadPermissions(id),
      'Diese Rolle hat mehr Rechte als Sie selbst und kann deshalb nur von einer entsprechend berechtigten Person bearbeitet werden.',
    );

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
    // Eskalationsdeckel (Audit S4): Eine ranghöhere Rolle darf ein
    // eingeschränktes Konto nicht aus dem System entfernen.
    assertWithinOwnRights(
      req,
      loadPermissions(id),
      'Diese Rolle hat mehr Rechte als Sie selbst und kann deshalb nur von einer entsprechend berechtigten Person gelöscht werden.',
    );
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
                u.must_change_password, r.name AS admin_role_name
         FROM users u
         LEFT JOIN admin_roles r ON r.id = u.admin_role_id
         ORDER BY u.role, u.name COLLATE NOCASE`,
      )
      .all();
    return { users: rows };
  });

  /**
   * Konto anlegen. Das Erstpasswort erzeugt der Server und gibt es GENAU EINMAL
   * zurück — es wird nirgends gespeichert (nur der bcrypt-Hash) und darf nicht
   * ins Audit-Log oder in ein Log geraten. `must_change_password = 1` sperrt das
   * Konto bis zum Passwortwechsel auf /api/auth/me und /api/auth/password
   * (Durchsetzung im globalen Hook, server.ts).
   */
  app.post('/api/admin/users', async (req, reply) => {
    const body = parse(createUserSchema, req.body);
    const employeeId = body.employee_id ?? null;
    const adminRoleId = body.admin_role_id ?? null;

    if (body.role === 'mitarbeiter') {
      // Ein Portal-Konto ohne Personalprofil sieht nichts: Der gesamte
      // Self-Service (modules/me) hängt an users.employee_id.
      if (employeeId === null) {
        throw badRequest('Ein Portal-Konto braucht ein verknüpftes Personalprofil.');
      }
      if (adminRoleId !== null) {
        throw badRequest('Admin-Rollen gelten nur für Konten der HR-Administration.');
      }
    }

    // Eskalationsdeckel (Audit S4): Ein Konto OHNE Rolle hat Vollzugriff
    // (Migration 002). Wer selbst eingeschränkt ist, darf so ein Konto nicht
    // anlegen — er bekäme das Erstpasswort in dieser Antwort gleich mit.
    if (body.role === 'admin' && adminRoleId === null && (req.user.admin_role_id ?? null) !== null) {
      throw forbidden(
        'Konten ohne Admin-Rolle haben Vollzugriff. Diese Zuweisung kann nur eine Person mit Vollzugriff vornehmen.',
      );
    }
    if (adminRoleId !== null) {
      loadRole(adminRoleId);
      assertWithinOwnRights(
        req,
        loadPermissions(adminRoleId),
        'Sie können kein Konto mit mehr Rechten anlegen, als Sie selbst haben.',
      );
    }

    const initialPassword = generateInitialPassword();
    const passwordHash = bcrypt.hashSync(initialPassword, 10);

    const id = inTransaction(() => {
      // Doppelte Adressen bewusst ohne Rücksicht auf Groß-/Kleinschreibung
      // ablehnen: Die Anlage soll an einer verwechselbaren Adresse scheitern,
      // nicht der spätere Login.
      const exists = db()
        .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
        .get(body.email);
      if (exists) throw conflict(`Es gibt bereits ein Konto mit der E-Mail „${body.email}“.`);
      if (employeeId !== null) {
        const employee = db().prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
        if (!employee) throw notFound('Personalprofil nicht gefunden');
        const linked = db()
          .prepare('SELECT email FROM users WHERE employee_id = ?')
          .get(employeeId) as { email: string } | undefined;
        if (linked) {
          throw conflict(`Dieses Personalprofil ist bereits mit „${linked.email}“ verknüpft.`);
        }
      }
      const res = db()
        .prepare(
          `INSERT INTO users (email, name, password_hash, role, employee_id, admin_role_id, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(body.email, body.name, passwordHash, body.role, employeeId, adminRoleId);
      return Number(res.lastInsertRowid);
    });

    // Ohne Passwort und ohne Hash — das Audit-Log ist für viele Augen sichtbar.
    audit(req, 'create', 'user', id, {
      email: body.email,
      name: body.name,
      role: body.role,
      employee_id: employeeId,
      admin_role_id: adminRoleId,
    });
    reply.status(201);
    return { user: loadUser(id), initial_password: initialPassword };
  });

  /**
   * Passwort zurücksetzen (Konto ausgesperrt, Passwort kompromittiert).
   * Erzeugt ein neues Zufallspasswort, erzwingt den Wechsel und entwertet alle
   * bereits ausgestellten Tokens des Kontos über `sessions_valid_from` — sonst
   * bliebe eine gekaperte Sitzung bis zu ihrem Ablauf gültig, und genau dagegen
   * setzt man ein Passwort zurück.
   */
  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const target = loadUser(id);
    // Eskalationsdeckel (Audit S4): Wer ein Passwort zurücksetzt, bekommt es in
    // dieser Antwort — das ist eine vollständige Kontoübernahme. Ranghöhere
    // Konten sind deshalb tabu.
    assertWithinOwnRights(
      req,
      effectivePermissions(target),
      'Dieses Konto hat mehr Rechte als Sie selbst. Das Passwort kann nur eine entsprechend berechtigte Person zurücksetzen.',
    );

    const newPassword = generateInitialPassword();
    // Unix-SEKUNDEN, dieselbe Quelle wie der Passwortwechsel in core/auth.ts.
    // nextSessionsValidFrom() liefert bewusst die NÄCHSTE Sekunde: `iat` hat
    // nur Sekundenauflösung, mit der laufenden Sekunde überlebte ein in
    // derselben Sekunde ausgestelltes Token das Zurücksetzen. Der unmittelbar
    // folgende Login des Kontos wird dadurch nicht entwertet — die Login-Route
    // hebt das `iat` eines frischen Tokens auf sessions_valid_from an.
    const validFrom = nextSessionsValidFrom();
    db()
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 1, sessions_valid_from = ? WHERE id = ?',
      )
      .run(bcrypt.hashSync(newPassword, 10), validFrom, id);

    audit(req, 'reset_password', 'user', id, { email: target.email, name: target.name });
    return { user: loadUser(id), initial_password: newPassword };
  });

  /**
   * Konto löschen. Drei Sperren: nicht das eigene Konto, nicht ein ranghöheres,
   * und nicht das letzte, das noch Rechte vergeben kann — sonst wäre die
   * Installation nicht mehr verwaltbar.
   */
  app.delete('/api/admin/users/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const target = loadUser(id);

    if (id === req.user.id) {
      throw forbidden(
        'Das eigene Konto können Sie nicht löschen. Das muss eine andere Person mit Benutzerverwaltung tun.',
      );
    }
    assertWithinOwnRights(
      req,
      effectivePermissions(target),
      'Dieses Konto hat mehr Rechte als Sie selbst und kann deshalb nur von einer entsprechend berechtigten Person gelöscht werden.',
    );
    // Erreichbarkeit sichern: Es muss jemand übrig bleiben, der Rechte vergibt.
    // Rückversicherung, kein Alltagsfall — die handelnde Person hat selbst
    // `benutzer` = bearbeiten (sonst käme sie hier nicht an) und zählt mit.
    // Der Zweig bleibt trotzdem stehen: Sobald jemand die Selbstlöschung
    // erlaubt oder das Zählen ändert, ist die Sperre schon da.
    if (userAdminCount(id) === 0) {
      throw conflict(
        'Das ist das letzte Konto mit Benutzerverwaltung. Vergeben Sie das Recht zuerst an jemand anderen.',
      );
    }

    inTransaction(() => {
      detachUserReferences(id);
      db().prepare('DELETE FROM users WHERE id = ?').run(id);
    });

    audit(req, 'delete', 'user', id, {
      email: target.email,
      name: target.name,
      role: target.role,
    });
    reply.status(204);
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

    // Eskalationsdeckel (Audit S4), drei Fälle:
    // 1. `admin_role_id: null` bedeutet VOLLZUGRIFF (Migration 002). Wer selbst
    //    eingeschränkt ist, würde damit über ein fremdes Konto genau die Rechte
    //    verschenken, die ihm fehlen — und käme über ein Passwort-Reset auch
    //    gleich selbst hinein.
    // 2. Eine Rolle zuzuweisen, die mehr kann als die eigene, ist derselbe Weg
    //    mit einem Zwischenschritt.
    // 3. Ein ranghöheres Konto darf ein eingeschränktes auch nicht beschneiden.
    if (body.admin_role_id === null && (req.user.admin_role_id ?? null) !== null) {
      throw forbidden(
        'Konten ohne Admin-Rolle haben Vollzugriff. Diese Zuweisung kann nur eine Person mit Vollzugriff vornehmen.',
      );
    }
    if (body.admin_role_id !== null) {
      loadRole(body.admin_role_id);
      assertWithinOwnRights(
        req,
        loadPermissions(body.admin_role_id),
        'Sie können keine Rolle zuweisen, die mehr Rechte hat als Sie selbst.',
      );
    }
    assertWithinOwnRights(
      req,
      effectivePermissions(target),
      'Dieses Konto hat mehr Rechte als Sie selbst und kann deshalb nur von einer entsprechend berechtigten Person geändert werden.',
    );

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
  /** Konto laden — ohne password_hash, der hat in keiner Antwort etwas verloren. */
  function loadUser(id: number): UserRow {
    const row = db()
      .prepare('SELECT id, email, name, role, employee_id, admin_role_id FROM users WHERE id = ?')
      .get(id) as UserRow | undefined;
    if (!row) throw notFound('Konto nicht gefunden');
    return row;
  }

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
