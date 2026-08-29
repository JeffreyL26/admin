import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { config, hardenDataPermissions } from './config.js';
import { migrate } from './db/migrate.js';
import { AppError, errorHandler, forbidden, unauthorized } from './core/errors.js';
import { authRoutes, ensureDefaultAdmin, type AuthUser } from './core/auth.js';
import { getDb } from './db/db.js';
import { fileRoutes } from './core/files.js';
import { settingsRoutes } from './core/settingsRoutes.js';
import { dashboardRoutes } from './core/dashboardRoutes.js';
import { assertRouteAllowed, permissionsFor } from './core/permissions.js';
import { registerModules } from './modules/index.js';

/**
 * Routen, die ein Konto mit erzwungenem Passwortwechsel noch erreichen darf.
 * Bewusst exakt zwei: die eigene Identität lesen und das Passwort setzen.
 */
const PASSWORD_CHANGE_ROUTES = new Set(['/api/auth/me', '/api/auth/password']);

export async function buildServer(): Promise<FastifyInstance> {
  migrate();
  // Zweiter Durchlauf nach migrate(): Jetzt existieren hrmonic.db samt -wal/-shm
  // auch bei einer frischen Installation und können auf 0600 gesetzt werden.
  hardenDataPermissions();
  ensureDefaultAdmin();

  const app = Fastify({
    logger: { level: process.env.HRMONIC_LOG_LEVEL ?? 'warn' },
    // trustProxy: Im Serverbetrieb terminiert ein Reverse-Proxy TLS und das
    // Backend sieht sonst als req.ip konstant 127.0.0.1. Die Login-Drosselung
    // (core/auth.ts) würde dann bei jedem Angriff die gesamte Firma über eine
    // einzige "IP" aussperren, und Logs wären wertlos. Voraussetzung im Deploy:
    // Der Proxy MUSS X-Forwarded-For selbst setzen (nicht durchreichen), sonst
    // kann ein Client seine Herkunft frei behaupten.
    trustProxy: true,
    // Fastify überschreibt Nodes 300-Sekunden-Default aktiv mit 0 — ohne diese
    // beiden Werte kann eine unauthentifizierte Verbindung beliebig lange offen
    // gehalten werden (langsamer Body auf /api/auth/login, beliebig viele
    // Sockets). Die Grenzen müssen über dem größten regulären Upload liegen:
    // 50 MB brauchen auf einer schwachen Leitung mehrere Sekunden — bei
    // Zeitüberschreitungen im Kundenbetrieb hier nachjustieren, nicht abschalten.
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
  });

  for (const warning of config.startupWarnings) app.log.warn(warning);

  // CORS-Herkünfte kommen aus config.ts: Im Serverbetrieb eine feste Liste
  // (HRMONIC_CORS_ORIGIN, Pflicht sobald HRMONIC_HOST nicht loopback ist),
  // lokal offen für den Desktop-Renderer.
  await app.register(cors, { origin: config.corsOrigin });
  await app.register(jwt, { secret: config.secret, sign: { expiresIn: config.tokenTtl } });
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      // Ein Upload je Request; mehr braucht keine Route. Ohne Deckel puffert
      // ein einziger Request beliebig viele Dateien und Felder in den RAM.
      files: 1,
      fields: 20,
      fieldSize: 16 * 1024,
    },
  });

  app.setErrorHandler(errorHandler);

  // Zugriffsprüfung passiert immer hier im Backend — der Client ist keine
  // Sicherheitsgrenze. Routen sind nur öffentlich, wenn sie explizit
  // config.public setzen (Login, signierte Downloads, Health).
  //
  // Rollenmodell: Mitarbeitenden-Accounts (role 'mitarbeiter', Web-Portal)
  // erreichen nur den Self-Service (/api/me/*) und die Auth-Routen; alle
  // übrigen Routen sind der HR-Administration (role 'admin') vorbehalten.
  //
  // Das Token belegt nur die Identität (id); Rolle, Profil-Verknüpfung,
  // Wechselzwang und Sitzungsgültigkeit werden pro Request frisch geladen,
  // damit Rollenentzug, Umverknüpfung oder Kontolöschung sofort wirken —
  // nicht erst nach Ablauf der Token-Laufzeit. (Ein indizierter
  // Primärschlüssel-Lookup pro Request; bei better-sqlite3 im
  // Mikrosekundenbereich.)
  app.addHook('onRequest', async (req) => {
    if ((req.routeOptions.config as { public?: boolean } | undefined)?.public) return;
    await req.jwtVerify();
    // iat vor dem Überschreiben von req.user sichern (Unix-Sekunden).
    const issuedAt = typeof req.user.iat === 'number' ? req.user.iat : null;
    const row = getDb()
      .prepare(
        `SELECT id, email, name, role, employee_id, admin_role_id, must_change_password,
                sessions_valid_from
           FROM users WHERE id = ?`,
      )
      .get(req.user.id) as (AuthUser & { sessions_valid_from: number | null }) | undefined;
    if (!row) throw unauthorized('Nicht angemeldet oder Sitzung abgelaufen');

    // Sitzungssperre: Ein Passwortwechsel (und später ein "Alle Sitzungen
    // beenden") setzt sessions_valid_from. Ältere Tokens gelten damit nicht
    // mehr — ohne diese Prüfung liefe ein abgegriffenes Token nach dem
    // Passwortwechsel bis zum regulären Ablauf weiter.
    // NULL bedeutet ausdrücklich "keine Sperre", deshalb explizit auf null
    // prüfen und nicht auf Truthiness (0 wäre ein gültiger Zeitpunkt).
    const { sessions_valid_from: validFrom, ...account } = row;
    if (validFrom !== null && (issuedAt === null || issuedAt < validFrom)) {
      throw unauthorized('Die Sitzung wurde beendet. Bitte melden Sie sich erneut an.');
    }

    req.user = { ...account, iat: issuedAt ?? undefined };
    const route = req.routeOptions.url ?? req.url;

    // Erzwungener Passwortwechsel (Standard-Admin nach der Erstinbetriebnahme
    // oder nach einem administrativen Zurücksetzen): Das Konto ist angemeldet,
    // darf aber ausschließlich sein Passwort setzen. Ohne diese Sperre wäre
    // das generierte Initialpasswort ein vollwertiger Dauerzugang.
    if (req.user.must_change_password === 1 && !PASSWORD_CHANGE_ROUTES.has(route)) {
      throw new AppError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'Bitte vergeben Sie zuerst ein eigenes Passwort.',
      );
    }

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
