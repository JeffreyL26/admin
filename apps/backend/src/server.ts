import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { errorHandler, forbidden, unauthorized } from './core/errors.js';
import { authRoutes, ensureDefaultAdmin, type AuthUser } from './core/auth.js';
import { getDb } from './db/db.js';
import { fileRoutes } from './core/files.js';
import { settingsRoutes } from './core/settingsRoutes.js';
import { dashboardRoutes } from './core/dashboardRoutes.js';
import { assertRouteAllowed, permissionsFor } from './core/permissions.js';
import { registerModules } from './modules/index.js';

export async function buildServer(): Promise<FastifyInstance> {
  migrate();
  ensureDefaultAdmin();

  const app = Fastify({ logger: { level: process.env.HRMONIC_LOG_LEVEL ?? 'warn' } });

  // Standardmäßig bindet das Backend nur an 127.0.0.1 und CORS ist offen
  // (Desktop-Client lädt von file://, Origin "null"). Im Server-Deploy wird
  // die Origin-Liste über HRMONIC_CORS_ORIGIN eingeschränkt (siehe config.ts).
  await app.register(cors, { origin: config.corsOrigin });
  await app.register(jwt, { secret: config.secret, sign: { expiresIn: config.tokenTtl } });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.setErrorHandler(errorHandler);

  // Zugriffsprüfung passiert immer hier im Backend — der Client ist keine
  // Sicherheitsgrenze. Routen sind nur öffentlich, wenn sie explizit
  // config.public setzen (Login, signierte Downloads, Health).
  //
  // Rollenmodell: Mitarbeitenden-Accounts (role 'mitarbeiter', Web-Portal)
  // erreichen nur den Self-Service (/api/me/*) und die Auth-Routen; alle
  // übrigen Routen sind der HR-Administration (role 'admin') vorbehalten.
  //
  // Das Token belegt nur die Identität (id); Rolle und Profil-Verknüpfung
  // werden pro Request frisch geladen, damit Rollenentzug, Umverknüpfung
  // oder Kontolöschung sofort wirken — nicht erst nach Ablauf der
  // 12-Stunden-Token-Laufzeit. (Ein indizierter Primärschlüssel-Lookup
  // pro Request; bei better-sqlite3 im Mikrosekundenbereich.)
  app.addHook('onRequest', async (req) => {
    if ((req.routeOptions.config as { public?: boolean } | undefined)?.public) return;
    await req.jwtVerify();
    const account = getDb()
      .prepare('SELECT id, email, name, role, employee_id, admin_role_id FROM users WHERE id = ?')
      .get(req.user.id) as AuthUser | undefined;
    if (!account) throw unauthorized('Nicht angemeldet oder Sitzung abgelaufen');
    req.user = account;
    const route = req.routeOptions.url ?? req.url;
    const selfService = route.startsWith('/api/me/') || route.startsWith('/api/auth/');
    if (!selfService && req.user.role !== 'admin') {
      throw forbidden('Dieser Bereich ist der HR-Administration vorbehalten');
    }
    // Zweite Stufe: Innerhalb der HR-Administration entscheidet die Admin-Rolle,
    // welche Bereiche gelesen bzw. bearbeitet werden dürfen. Der Self-Service
    // bleibt ausgenommen — dort gelten ausschließlich die eigenen Daten.
    if (!selfService) {
      assertRouteAllowed(req, permissionsFor(account.admin_role_id));
    }
  });

  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    name: 'HRMONIC Backend',
  }));

  await app.register(authRoutes);
  await app.register(fileRoutes);
  await app.register(settingsRoutes);
  await app.register(dashboardRoutes);
  await registerModules(app);

  return app;
}

/** Startet den Server; port 0 = zufälliger freier Port (Desktop-Embedding). */
export async function startServer(port?: number): Promise<{ app: FastifyInstance; port: number }> {
  const app = await buildServer();
  await app.listen({ port: port ?? config.port, host: config.host });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : (port ?? config.port);
  return { app, port: actualPort };
}
