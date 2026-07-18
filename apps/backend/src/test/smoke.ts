/**
 * API-Smoke-Test ohne laufenden Server (fastify.inject) gegen eine
 * Wegwerf-Datenbank. Aufruf: npm run test -w apps/backend
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HRMONIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrmonic-smoke-'));
process.env.HRMONIC_LOG_LEVEL = 'silent';

const { buildServer } = await import('../server.js');
const { closeDb } = await import('../db/db.js');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();

const health = await app.inject({ method: 'GET', url: '/api/health' });
check('Health-Check', health.statusCode === 200);

const noAuth = await app.inject({ method: 'GET', url: '/api/settings' });
check('Auth-Pflicht greift', noAuth.statusCode === 401, noAuth.json());

const badLogin = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'admin@hrmonic.de', password: 'falsch' },
});
check('Login mit falschem Passwort → 401', badLogin.statusCode === 401);
check('Fehlerschema einheitlich', badLogin.json()?.error?.code === 'UNAUTHORIZED');

const login = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'admin@hrmonic.de', password: 'hrmonic2026' },
});
check('Login Standard-Admin', login.statusCode === 200, login.json());
const token = login.json().token as string;
const auth = { authorization: `Bearer ${token}` };

const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('GET /api/auth/me', me.statusCode === 200 && me.json().user.email === 'admin@hrmonic.de');

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
  fs.rmSync(process.env.HRMONIC_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows hält WAL-Dateien gelegentlich noch kurz — Tempdir-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Smoke-Checks bestanden.');
