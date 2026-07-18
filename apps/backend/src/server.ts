import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { errorHandler } from './core/errors.js';
import { authRoutes, ensureDefaultAdmin } from './core/auth.js';
import { fileRoutes } from './core/files.js';
import { settingsRoutes } from './core/settingsRoutes.js';
import { registerModules } from './modules/index.js';

export async function buildServer(): Promise<FastifyInstance> {
  migrate();
  ensureDefaultAdmin();

  const app = Fastify({ logger: { level: process.env.HRMONIC_LOG_LEVEL ?? 'warn' } });

  // Das Backend bindet ausschließlich an 127.0.0.1. CORS ist offen, weil der
  // Desktop-Client im Prod-Betrieb von file:// aus zugreift (Origin "null").
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.secret, sign: { expiresIn: config.tokenTtl } });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.setErrorHandler(errorHandler);

  // Zugriffsprüfung passiert immer hier im Backend — der Client ist keine
  // Sicherheitsgrenze. Routen sind nur öffentlich, wenn sie explizit
  // config.public setzen (Login, signierte Downloads, Health).
  app.addHook('onRequest', async (req) => {
    if ((req.routeOptions.config as { public?: boolean } | undefined)?.public) return;
    await req.jwtVerify();
  });

  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    name: 'HRMONIC Backend',
  }));

  await app.register(authRoutes);
  await app.register(fileRoutes);
  await app.register(settingsRoutes);
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
