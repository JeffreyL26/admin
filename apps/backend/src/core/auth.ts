import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { parse, unauthorized, badRequest } from './errors.js';
import { permissionsFor } from './permissions.js';

/** Rollen: 'admin' = HR-Administration (Desktop), 'mitarbeiter' = Web-Portal. */
export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  /** Verknüpftes Personalprofil (nur Mitarbeitenden-Accounts, sonst null). */
  employee_id: number | null;
  /**
   * Abgestufte Rechte innerhalb der HR-Administration. `null` bedeutet
   * Vollzugriff (siehe Migration 002_admin_roles) — nicht "keine Rechte".
   * Wie role und employee_id wird das Feld pro Request frisch geladen, damit
   * ein Rechteentzug sofort greift und nicht erst nach Tokenablauf.
   */
  admin_role_id?: number | null;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthUser;
    payload: AuthUser;
  }
}

/** Legt den Standard-Admin an, falls noch keine Benutzer existieren. */
export function ensureDefaultAdmin(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count === 0) {
    db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(
      'admin@hrmonic.de',
      'HR Administrator',
      bcrypt.hashSync('hrmonic2026', 10),
    );
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', { config: { public: true } }, async (req) => {
    const body = parse(
      z.object({ email: z.string().email(), password: z.string().min(1) }),
      req.body,
    );
    const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(body.email) as
      | (AuthUser & { password_hash: string })
      | undefined;
    if (!row || !bcrypt.compareSync(body.password, row.password_hash)) {
      throw unauthorized('E-Mail oder Passwort ist falsch');
    }
    const user: AuthUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      employee_id: row.employee_id ?? null,
      admin_role_id: row.admin_role_id ?? null,
    };
    const token = await (app as FastifyInstance & { jwt: { sign: (p: AuthUser) => string } }).jwt.sign(user);
    // Die Rechte reisen mit der Antwort, damit die Oberfläche gesperrte
    // Bereiche gar nicht erst anbietet. Sie sind reine Anzeigehilfe — die
    // Durchsetzung passiert ausschließlich im Hook (core/permissions.ts).
    return { token, user, permissions: permissionsFor(user.admin_role_id) };
  });

  app.get('/api/auth/me', async (req) => ({
    user: req.user,
    permissions: permissionsFor(req.user.admin_role_id),
  }));

  app.put('/api/auth/password', async (req) => {
    const body = parse(
      z.object({ currentPassword: z.string(), newPassword: z.string().min(8) }),
      req.body,
    );
    const db = getDb();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as
      | { password_hash: string }
      | undefined;
    if (!row || !bcrypt.compareSync(body.currentPassword, row.password_hash)) {
      throw badRequest('Das aktuelle Passwort ist falsch');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      bcrypt.hashSync(body.newPassword, 10),
      req.user.id,
    );
    return { ok: true };
  });
}
