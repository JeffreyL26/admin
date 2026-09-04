/**
 * API-Smoke-Test ohne laufenden Server (fastify.inject) gegen eine
 * Wegwerf-Datenbank. Aufruf: npm run test -w apps/backend
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-smoke-'));
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

const { buildServer } = await import('../server.js');
const { closeDb } = await import('../db/db.js');
const { firstAdminLogin } = await import('./adminSession.js');
const { CLIENT_VERSION_HEADER, SERVER_VERSION_HEADER, MIN_CLIENT_VERSION, isAtLeast } =
  await import('@ohrganize/shared');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();

const health = await app.inject({ method: 'GET', url: '/api/health' });
check('Health-Check', health.statusCode === 200);

// Versionsabgleich (core/version.ts). Der Gate kann im Serverbetrieb jeden
// Arbeitsplatz aussperren — die Grenzfälle gehören deshalb abgesichert:
// Die Ausnahme für /api/health muss bleiben (sonst kann eine abgewiesene App
// die Ursache nicht lesen), und ein fehlender Header darf NICHT sperren
// (Portal, Monitoring, curl schicken keinen).
const clientHeader = (v: string) => ({ [CLIENT_VERSION_HEADER]: v });
// Nicht auf Gleichheit mit MIN_CLIENT_VERSION prüfen: Beide Werte waren nur so
// lange identisch, wie das Projekt auf seiner ersten Version stand — der erste
// Versionssprung ließ diesen Check fallen, ohne dass etwas kaputt war. Die
// eigentliche Invariante ist: Der Server meldet eine lesbare Version, und sie
// ist nie älter als das Minimum, das er selbst von Clients verlangt.
check(
  'Health nennt seine Version',
  isAtLeast(health.json().version, MIN_CLIENT_VERSION),
  health.json(),
);
check('Serverversion als Header', health.headers[SERVER_VERSION_HEADER] !== undefined);

const oldClient = await app.inject({
  method: 'GET',
  url: '/api/settings',
  headers: clientHeader('0.9.9'),
});
check('Zu alter Client → 426', oldClient.statusCode === 426, oldClient.json());
check('… mit Code CLIENT_TOO_OLD', oldClient.json().error?.code === 'CLIENT_TOO_OLD');

const oldLogin = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  headers: clientHeader('0.9.9'),
  payload: { email: 'admin@ohrganize.de', password: 'egal' },
});
check('Zu alter Client auch am Login → 426', oldLogin.statusCode === 426, oldLogin.statusCode);

const oldHealth = await app.inject({
  method: 'GET',
  url: '/api/health',
  headers: clientHeader('0.9.9'),
});
check('Health bleibt für alte Clients offen', oldHealth.statusCode === 200, oldHealth.statusCode);

const junkClient = await app.inject({
  method: 'GET',
  url: '/api/settings',
  headers: clientHeader('kaputt'),
});
check('Unlesbare Version fällt zu (426)', junkClient.statusCode === 426, junkClient.statusCode);

const currentClient = await app.inject({
  method: 'GET',
  url: '/api/settings',
  headers: clientHeader(MIN_CLIENT_VERSION),
});
check('Aktueller Client passiert (401, nicht 426)', currentClient.statusCode === 401, currentClient.statusCode);

const noAuth = await app.inject({ method: 'GET', url: '/api/settings' });
check('Auth-Pflicht greift', noAuth.statusCode === 401, noAuth.json());

const badLogin = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'admin@ohrganize.de', password: 'falsch' },
});
check('Login mit falschem Passwort → 401', badLogin.statusCode === 401);
check('Fehlerschema einheitlich', badLogin.json()?.error?.code === 'UNAUTHORIZED');

const { auth } = await firstAdminLogin(app, check);

const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('GET /api/auth/me', me.statusCode === 200 && me.json().user.email === 'admin@ohrganize.de');

const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: auth });
check('Einstellungen lesbar', settings.statusCode === 200 && !!settings.json().settings);

const holidays = await app.inject({ method: 'GET', url: '/api/holidays/2026/BY', headers: auth });
const list = holidays.json()?.holidays as { date: string; name: string }[];
check(
  'Feiertage BY 2026 (u. a. Fronleichnam 04.06.)',
  holidays.statusCode === 200 && list.some((h) => h.date === '2026-06-04' && h.name === 'Fronleichnam'),
  list,
);

await app.close();
closeDb();
try {
  fs.rmSync(process.env.OHRGANIZE_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows hält WAL-Dateien gelegentlich noch kurz — Tempdir-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Smoke-Checks bestanden.');
