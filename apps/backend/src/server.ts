import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import {
  LICENSE_FORMAT_VERSION,
  LICENSE_STATE_HEADER,
  MIN_CLIENT_VERSION,
  SERVER_VERSION_HEADER,
  channelOf,
} from '@ohrganize/shared';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { VARIANT, VARIANT_MARKER } from '@variant-manifest';
import { config, hardenDataPermissions } from './config.js';
import { migrate } from './db/migrate.js';
import { AppError, errorHandler, forbidden, unauthorized } from './core/errors.js';
import { authRoutes, ensureDefaultAdmin, type AuthUser } from './core/auth.js';
import { encryptDatabaseAtRest, enlargePageCache, getDb, restartStaleWalIndex } from './db/db.js';
import { CipherUnavailableError, ConversionVerificationError } from './db/encryption.js';
import { encryptStoredFiles, fileRoutes } from './core/files.js';
import { settingsRoutes } from './core/settingsRoutes.js';
import { lookupRoutes } from './core/lookupRoutes.js';
import { dashboardRoutes } from './core/dashboardRoutes.js';
import { setupRoutes } from './core/setupRoutes.js';
import { assertRouteAllowed, permissionsFor } from './core/permissions.js';
import { APP_VERSION, assertClientSupported } from './core/version.js';
import {
  assertLicenseAllows,
  licenseHeaderValueFor,
  effectiveFeatures,
  licenseStatusPublic,
  logLicenseAtStartup,
  setLicenseLogger,
} from './core/license.js';
import { licenseRoutes } from './core/licenseRoutes.js';
import { assertFeatureAllowed } from './core/featureGate.js';
import { registerModules } from './modules/index.js';
import { errorText } from './core/errorText.js';

/**
 * Routen, die ein Konto mit erzwungenem Passwortwechsel noch erreichen darf.
 * Bewusst exakt zwei: die eigene Identität lesen und das Passwort setzen.
 */
const PASSWORD_CHANGE_ROUTES = new Set(['/api/auth/me', '/api/auth/password']);

export async function buildServer(): Promise<FastifyInstance> {
  // Verschlüsselung im Ruhezustand (db/encryption.ts): Ein Klartextbestand
  // wird hier einmalig umgestellt, vor dem ersten Datenbankzugriff. Scheitert
  // das (ein anderer Prozess hat die Datei offen, die Platte ist voll), läuft
  // der Dienst mit dem unveränderten Bestand weiter und versucht es beim
  // nächsten Start erneut: Die Umstellung läuft in einer Transaktion mit
  // Rollback-Journal; scheitert sie, bleibt der Klartextbestand unverändert.
  let encryptionNote: string | null = null;
  try {
    if (encryptDatabaseAtRest()) {
      encryptionNote =
        'Die Datenbank wurde auf Verschlüsselung im Ruhezustand umgestellt. Der Schlüssel liegt in data.key im ' +
        'Datenverzeichnis und gehört ab jetzt zu jeder Sicherung: Ohne ihn sind Datenbank und Dateiablage nicht lesbar.';
    }
  } catch (err) {
    // Verschlüsselt, aber die Prüfung danach gescheitert: Es gibt keinen
    // Klartextstand mehr, auf dem der Dienst weiterlaufen könnte. Ebenso ein
    // Modul, das gar nicht verschlüsseln kann: Weiterlaufen hiesse, Datenbank
    // und neue Dateien dauerhaft im Klartext zu halten, ohne dass es jemand sieht.
    if (err instanceof ConversionVerificationError || err instanceof CipherUnavailableError) throw err;
    encryptionNote =
      'Die Datenbank konnte nicht auf Verschlüsselung im Ruhezustand umgestellt werden und läuft unverändert weiter ' +
      `(${errorText(err)}). Der nächste Start versucht es erneut.`;
  }
  migrate();
  enlargePageCache();
  // Eine Füllung der -shm, die der vorige Prozess offen liess, nachholen,
  // falls die -shm noch steht (db.ts#restartStaleWalIndex; ob sie steht, hat
  // getDb schon beim Öffnen gemessen, vor den Migrationen).
  restartStaleWalIndex();
  // Zweiter Durchlauf nach migrate(): Jetzt existieren ohrganize.db samt -wal/-shm
  // auch bei einer frischen Installation und können auf 0600 gesetzt werden.
  hardenDataPermissions();
  ensureDefaultAdmin();

  const app = Fastify({
    logger: {
      level: process.env.OHRGANIZE_LOG_LEVEL ?? 'warn',
      serializers: {
        // Eigener Request-Serializer: Fastifys Vorgabe protokolliert die URL
        // samt Query-String. Auf Loglevel 'info' landet damit jeder signierte
        // Download-Link (?expires=…&sig=…) im Log — und der ist 60 Sekunden
        // lang ein anmeldefreier Zugang zu genau dieser Datei
        // (Personalakte, AU-Bescheinigung, Gehaltsnachweis). Der
        // Reverse-Proxy schneidet den Query-String bereits ab
        // (deploy/windows/Caddyfile); ein Backend-Log, das ihn führt,
        // unterliefe diese Absicht.
        //
        // Für die Fehlersuche bleibt alles Übrige erhalten: Methode, Pfad,
        // Zielhost und Herkunft (IP/Port). Nur der Query-String fällt weg.
        req(request: FastifyRequest) {
          return {
            method: request.method,
            url: (request.url ?? '').split('?')[0],
            host: request.headers?.host,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
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
  if (encryptionNote) app.log.warn(encryptionNote);
  // Variante und Marker ins Journal; der Marker haelt die Zeichenkette fuer
  // scripts/check-variant.mjs im Bundle.
  app.log.info(`Variante ${VARIANT.id} (${VARIANT.label}) [${VARIANT_MARKER}]`);
  // Dateiwechsel im Datenverzeichnis (ohne Request) landen ueber diesen Logger
  // im Journal, zusaetzlich zur Audit-Zeile.
  setLicenseLogger(app.log);
  // Lizenzzustand nach den Migrationen (braucht die Tabelle installation) —
  // eine Testphase, Kulanz oder der Nur-Lese-Betrieb soll im Journal stehen,
  // bevor der erste Nutzer davon in der Oberfläche liest.
  logLicenseAtStartup(app.log);

  // CORS-Herkünfte kommen aus config.ts: Im Serverbetrieb eine feste Liste
  // (OHRGANIZE_CORS_ORIGIN, Pflicht sobald OHRGANIZE_HOST nicht loopback ist),
  // lokal offen für den Desktop-Renderer.
  // exposedHeaders: Im Serverbetrieb laufen Desktop-App (ohrganize://app) und
  // ein getrennt gehostetes Portal cross-origin; ohne diese Liste dürfte der
  // Browserkern den Versions- und Lizenz-Header nicht an den Client geben.
  await app.register(cors, {
    origin: config.corsOrigin,
    exposedHeaders: [SERVER_VERSION_HEADER, LICENSE_STATE_HEADER],
  });
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

  // Versionsabgleich VOR allem anderen — vor der Authentifizierung und auch
  // auf öffentlichen Routen. Eine zu alte App soll schon beim Login eine
  // verständliche Meldung bekommen und nicht erst danach an einer Maske
  // scheitern, die halb funktioniert.
  //
  // Die Serverversion geht auf jeder Antwort mit hinaus: So merkt ein Client
  // einen Serverwechsel im laufenden Betrieb, ohne /api/health abzufragen.
  app.addHook('onRequest', async (req, reply) => {
    reply.header(SERVER_VERSION_HEADER, APP_VERSION);
    // Keine API-Antwort gehört in einen Zwischenspeicher: Ohne diesen Kopf
    // darf der Browserkern (Portal, Desktop-App im Serverbetrieb) Antworten
    // mit Stammdaten, Gehältern oder Exporten in seinen Cache auf der Platte
    // legen, wo sie die Abmeldung überdauern. Routen mit eigener Angabe
    // (Downloads, signierte Links) überschreiben den Wert.
    reply.header('Cache-Control', 'no-store');
    if ((req.routeOptions.url ?? req.url) === '/api/health') return;
    assertClientSupported(req);
  });

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
  app.addHook('onRequest', async (req, reply) => {
    if ((req.routeOptions.config as { public?: boolean } | undefined)?.public) return;
    await req.jwtVerify();
    // iat vor dem Überschreiben von req.user sichern (Unix-Sekunden).
    const issuedAt = typeof req.user.iat === 'number' ? req.user.iat : null;
    // Ebenso die Sitzungsart (Desktop/Portal, core/auth.ts): Sie steht nur im
    // Token; Verlängerung und Passwortwechsel stellen dieselbe Art wieder aus.
    const session = req.user.session === 'desktop' ? 'desktop' : 'portal';
    // Und der Beginn der Sitzung (auth_time): Die Verlängerung misst daran die
    // Höchstdauer (core/auth.ts, sessionMaxOf).
    const authTime = typeof req.user.auth_time === 'number' ? req.user.auth_time : undefined;
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

    req.user = { ...account, iat: issuedAt ?? undefined, session, auth_time: authTime };
    // Lizenzzustand auf jeder angemeldeten Antwort — nur der Zustand, keine
    // Vertragsdaten, und für Portal-Konten nur „valid“/„expired“. Beide Clients
    // zeigen daraus Banner ohne eigene Abfrage. Öffentliche Antworten tragen
    // den Header bewusst nicht (core/license.ts, licenseHeaderValueFor).
    reply.header(LICENSE_STATE_HEADER, licenseHeaderValueFor(account.role));
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

    // Nur-Lese-Betrieb nach Ablauf von Lizenz oder Testphase (core/license.ts).
    // Nach der Anmeldung, damit ein abgelaufenes System 401 und 403 sauber
    // unterscheidet; vor der Rollenprüfung, weil die Antwort für Portal und
    // Administration dieselbe ist. GET/HEAD und die offenen Routen (Passwort,
    // Lizenz-Upload, Signieren von Downloads) kommen durch.
    assertLicenseAllows(req.method, route, account.role);

    // Feature-Schluessel der Lizenz (core/featureGate.ts): Eine Funktion, die
    // der Build enthaelt, die Lizenz aber nicht freischaltet, antwortet 403
    // LICENSE_FEATURE_MISSING. Vor dem Self-Service-Zweig, damit auch
    // /api/me/* erfasst ist; Routen ohne Feature-Eintrag bleiben offen.
    assertFeatureAllowed(req.method, route, effectiveFeatures());

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

  // Öffentlich und bewusst ohne Versionsprüfung: Genau hier erfährt eine
  // abgewiesene App, welche Version der Server hat und welche er verlangt.
  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    name: 'oHRganize Backend',
    version: APP_VERSION,
    min_client_version: MIN_CLIENT_VERSION,
    // Kanal ist eine Funktion der Version (1.2.0 = stable, 1.2.0-beta.1 =
    // beta), kein eigenes Feld: So kann ein Release nicht im falschen Kanal
    // landen, weil jemand eine Angabe vergessen hat.
    channel: channelOf(APP_VERSION),
    // Variante dieses Servers: Die Desktop-App bricht bei Abweichung ab, das
    // Update-Skript prueft sie vor dem Entpacken.
    variant: { id: VARIANT.id, country: VARIANT.country, edition: VARIANT.edition, label: VARIANT.label },
    // Nur die Frage „sind Änderungen möglich?“ — Monitoring kann darauf
    // alarmieren, ohne dass hier etwas über den Vertrag preisgegeben wird
    // (die Route ist ohne Anmeldung erreichbar). Die Feature-Liste bleibt
    // angemeldeten Antworten vorbehalten.
    license: { read_only: licenseStatusPublic().read_only },
    // Hoechste Lizenzfassung, die dieser Server liest: Der Anbieter prueft sie,
    // bevor er eine v2-Datei ausstellt.
    license_format: LICENSE_FORMAT_VERSION,
  }));

  await app.register(authRoutes);
  await app.register(fileRoutes);
  await app.register(licenseRoutes);
  await app.register(settingsRoutes);
  await app.register(lookupRoutes);
  await app.register(dashboardRoutes);
  await app.register(setupRoutes);
  await registerModules(app);

  return app;
}

/** Startet den Server; port 0 = zufälliger freier Port (Desktop-Embedding). */
export async function startServer(port?: number): Promise<{ app: FastifyInstance; port: number }> {
  const app = await buildServer();
  await app.listen({ port: port ?? config.port, host: config.host });
  // Dateiablage aus der Zeit vor der Verschlüsselung umstellen, im
  // Hintergrund und erst jetzt (Begründung an encryptStoredFiles).
  void encryptStoredFiles()
    .then(({ encrypted, failed, failures }) => {
      if (encrypted > 0) app.log.warn(`Dateiablage: ${encrypted} Datei(en) auf Verschlüsselung im Ruhezustand umgestellt.`);
      if (failed > 0) {
        // Mit Namen und Grund, aber begrenzt: Bei einem Schaden an vielen
        // Dateien soll das Journal nicht überlaufen.
        const shown = failures.slice(0, 20).join('; ');
        const rest = failures.length > 20 ? `; und ${failures.length - 20} weitere` : '';
        app.log.warn(
          `Dateiablage: ${failed} Datei(en) konnten nicht umgestellt werden und liegen weiter im Klartext auf der Platte ` +
            `(${shown}${rest}). Der nächste Start versucht es erneut.`,
        );
      }
    })
    .catch((err: unknown) => {
      app.log.warn(`Dateiablage: Umstellung auf Verschlüsselung abgebrochen (${errorText(err)}).`);
    });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : (port ?? config.port);
  return { app, port: actualPort };
}
