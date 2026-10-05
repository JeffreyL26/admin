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
const { closeDb, getDb } = await import('../db/db.js');
const { firstAdminLogin, SMOKE_ADMIN_PASSWORD } = await import('./adminSession.js');
const { config } = await import('../config.js');
const { invalidateLicenseCaches } = await import('../core/license.js');
const { hashPassword, passwordWorkerActive } = await import('../core/passwordHashing.js');
const { audit, setAuditThrowsOutsideTransaction } = await import('../core/audit.js');
const {
  CLIENT_VERSION_HEADER,
  SERVER_VERSION_HEADER,
  MIN_CLIENT_VERSION,
  channelOf,
  compareVersions,
  isAtLeast,
} = await import('@ohrganize/shared');

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

// Kanal ist eine Funktion der Version (packages/shared/src/version.ts). Die
// Ordnung kennt seit Phase 6 Vorabkennungen; genau daran haengt, welches
// Release ein Update-Skript als neuer ansieht.
check('Health nennt den Kanal', health.json().channel === channelOf(health.json().version), health.json().channel);
check('Vorabversion ist Kanal beta', channelOf('1.1.0-beta.1') === 'beta' && channelOf('1.1.0') === 'stable');
check('Vorabversion ist aelter als die fertige', compareVersions('1.1.0-beta.1', '1.1.0') < 0);
check('beta.2 ist neuer als beta.1', compareVersions('1.1.0-beta.2', '1.1.0-beta.1') > 0);
check('Nummern schlagen die Kennung', compareVersions('1.1.0-beta.1', '1.0.9') > 0);
check('isAtLeast faellt bei Vorabversion derselben Nummer zu', isAtLeast('1.1.0-beta.1', '1.1.0') === false);
check('isAtLeast faellt bei unlesbarer Version zu', isAtLeast('kaputt', '1.0.0') === false);

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

// Audit in derselben Transaktion: Ein Trigger, der jeden Audit-Eintrag
// abweist, muss eine Änderung scheitern lassen, ohne dass etwas davon stehen
// bleibt. TEMP: gilt nur auf dieser Verbindung, über die auch die Routen
// schreiben. Solange er aktiv ist, meldet sich niemand an (die Anmeldung
// auditiert bewusst allein).
async function withBrokenAudit<T>(fn: () => Promise<T>): Promise<T> {
  getDb().exec(
    "CREATE TEMP TRIGGER audit_kaputt BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit kaputt'); END;",
  );
  try {
    return await fn();
  } finally {
    getDb().exec('DROP TRIGGER IF EXISTS audit_kaputt');
  }
}
const settingsProbe = { companyName: 'Audit-Probe GmbH', surveyMinParticipants: 9 };
const brokenSettings = await withBrokenAudit(() =>
  app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: settingsProbe }),
);
const settingsAfter = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json().settings;
check(
  'Audit kaputt: Einstellungen scheitern (5xx) und bleiben unverändert',
  brokenSettings.statusCode >= 500 &&
    settingsAfter.companyName === settings.json().settings.companyName &&
    settingsAfter.surveyMinParticipants === settings.json().settings.surveyMinParticipants,
  { status: brokenSettings.statusCode, settingsAfter },
);
const healedSettings = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: settingsProbe });
check(
  'Audit heil: Einstellungen gespeichert, mit Eintrag',
  healedSettings.statusCode === 200 &&
    healedSettings.json().settings.companyName === 'Audit-Probe GmbH' &&
    !!getDb().prepare("SELECT id FROM audit_log WHERE entity = 'settings' AND details = ?").get(JSON.stringify(settingsProbe)),
  healedSettings.json(),
);

const holidays = await app.inject({ method: 'GET', url: '/api/holidays/2026/BY', headers: auth });
const list = holidays.json()?.holidays as { date: string; name: string }[];
check(
  'Feiertage BY 2026 (u. a. Fronleichnam 04.06.)',
  holidays.statusCode === 200 && list.some((h) => h.date === '2026-06-04' && h.name === 'Fronleichnam'),
  list,
);

// ---------------------------------------------------------------------------
// Sitzungen (core/auth.ts): Sitzungsart, Laufzeit, Verlängerung. Am Ende der
// Suite, weil der Passwortwechsel alle älteren Tokens entwertet und der
// Nur-Lese-Betrieb danach jede Änderung sperrt.
// ---------------------------------------------------------------------------
const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    session?: string;
    iat: number;
    exp: number;
    auth_time?: number;
    session_end?: number;
  };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const loginAs = (email: string, password: string, client?: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, ...(client ? { client } : {}) } });
const refresh = (token: string) => app.inject({ method: 'POST', url: '/api/auth/refresh', headers: bearer(token) });
const db = getDb();

check('Passwortvergleich läuft im Worker-Thread', passwordWorkerActive());
check('Laufzeiten: Vorgaben 1h (Portal) und 3d (Desktop)', config.tokenTtl === 3600 && config.desktopTokenTtl === 3 * 86400);

const desktopLogin = await loginAs('admin@ohrganize.de', SMOKE_ADMIN_PASSWORD, 'desktop');
const desktopToken = desktopLogin.json().token as string;
const dc = claims(desktopToken);
check(
  'Admin mit client desktop: Desktop-Token mit Desktop-Laufzeit',
  desktopLogin.statusCode === 200 && dc.session === 'desktop' && dc.exp - dc.iat === config.desktopTokenTtl,
  dc,
);
const pc = claims((await loginAs('admin@ohrganize.de', SMOKE_ADMIN_PASSWORD)).json().token as string);
check('Ohne client: Portal-Token mit Portal-Laufzeit', pc.session === 'portal' && pc.exp - pc.iat === config.tokenTtl, pc);

const refreshed = await refresh(desktopToken);
const refreshedToken = refreshed.json().token as string;
const rc = refreshed.statusCode === 200 ? claims(refreshedToken) : null;
check(
  'Verlängerung: neues Desktop-Token mit Desktop-Laufzeit',
  rc?.session === 'desktop' && rc.exp - rc.iat === config.desktopTokenTtl,
  refreshed.json(),
);
const meRefreshed = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(refreshedToken) });
check('Verlängertes Token ist gültig', meRefreshed.statusCode === 200, meRefreshed.json());

// Höchstdauer der Sitzung (config.ts, core/auth.ts): Die Anmeldung beginnt
// die Sitzung (auth_time), jede Verlängerung übernimmt ihn, und nach der
// Höchstdauer gibt es kein neues Token mehr.
check(
  'Höchstdauer: Vorgaben 6h (Portal) und 5d (Desktop)',
  config.sessionMax === 6 * 3600 && config.desktopSessionMax === 5 * 86400,
);
check(
  'Anmeldung beginnt die Sitzung: auth_time = iat, session_end = Beginn plus Höchstdauer',
  dc.auth_time === dc.iat &&
    dc.session_end === dc.iat + config.desktopSessionMax &&
    pc.auth_time === pc.iat &&
    pc.session_end === pc.iat + config.sessionMax,
  { dc, pc },
);
check(
  'Verlängerung übernimmt den Beginn der Sitzung',
  rc?.auth_time === dc.auth_time && rc?.session_end === dc.session_end,
  rc,
);
// iat wie beim echten Token: nie vor der Sitzungssperre des Kontos.
const signRaw = (payload: object) =>
  (app as unknown as { jwt: { sign: (p: object) => string } }).jwt.sign({ iat: dc.iat, ...payload });
const adminIdentity = desktopLogin.json().user as { id: number; email: string; name: string; role: string };
const nowSeconds = dc.iat;
const sessionOver = (r: { statusCode: number; json: () => { error?: { message?: string } } }) =>
  r.statusCode === 401 && /Anmeldung ist abgelaufen/.test(r.json().error?.message ?? '');
const nearEnd = await refresh(
  signRaw({
    ...adminIdentity,
    employee_id: null,
    session: 'desktop',
    auth_time: nowSeconds - config.desktopSessionMax + 100,
  }),
);
const nec = nearEnd.statusCode === 200 ? claims(nearEnd.json().token as string) : null;
check(
  'Kurz vor dem Ende: Verlängerung gelingt, das Token läuft nur bis zum Ende der Sitzung',
  nec !== null &&
    nec.exp === nowSeconds - config.desktopSessionMax + 100 + config.desktopSessionMax &&
    nec.session_end === nec.exp,
  nearEnd.json(),
);
const pastEnd = await refresh(
  signRaw({ ...adminIdentity, employee_id: null, session: 'desktop', auth_time: nowSeconds - config.desktopSessionMax - 5 }),
);
check('Nach der Höchstdauer: keine Verlängerung (401)', sessionOver(pastEnd), pastEnd.json());
const pastPortalEnd = await refresh(
  signRaw({ ...adminIdentity, employee_id: null, session: 'portal', auth_time: nowSeconds - config.sessionMax - 5 }),
);
check('Portal nach 6 Stunden: keine Verlängerung (401)', sessionOver(pastPortalEnd), pastPortalEnd.json());

// Portal-Konto (ohne Profil genügt für /api/auth/*) und zweites Admin-Konto.
const smokeHash = await hashPassword('Portal-Kennwort-0815!');
const addUser = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)');
addUser.run(['portal.smoke@example.org', 'Portal Smoke', smokeHash, 'mitarbeiter']);
addUser.run(['zweit.smoke@example.org', 'Zweit Smoke', smokeHash, 'admin']);

const portalLogin = await loginAs('portal.smoke@example.org', 'Portal-Kennwort-0815!', 'desktop');
const portalToken = portalLogin.json().token as string;
const mc = claims(portalToken);
check(
  'Portal-Konto mit client desktop bekommt ein Portal-Token',
  portalLogin.statusCode === 200 && mc.session === 'portal' && mc.exp - mc.iat === config.tokenTtl,
  mc,
);
const portalRefreshed = await refresh(portalToken);
check(
  'Verlängerung eines Portal-Tokens bleibt Portal',
  portalRefreshed.statusCode === 200 && claims(portalRefreshed.json().token as string).session === 'portal',
  portalRefreshed.json(),
);

// Token einer älteren Fassung (ohne Claim session) gilt als Portal.
const legacyToken = (app as unknown as { jwt: { sign: (p: object) => string } }).jwt.sign({
  id: portalLogin.json().user.id,
  email: 'portal.smoke@example.org',
  name: 'Portal Smoke',
  role: 'mitarbeiter',
  employee_id: null,
});
const legacyRefreshed = await refresh(legacyToken);
const legacyClaims = legacyRefreshed.statusCode === 200 ? claims(legacyRefreshed.json().token as string) : null;
check(
  'Token ohne Sitzungsart wird als Portal verlängert, die Sitzung beginnt bei seinem iat',
  legacyClaims?.session === 'portal' && legacyClaims.auth_time === claims(legacyToken).iat,
  legacyRefreshed.json(),
);

const secondToken = (await loginAs('zweit.smoke@example.org', 'Portal-Kennwort-0815!', 'desktop')).json().token as string;
db.prepare("UPDATE users SET role = 'mitarbeiter' WHERE email = ?").run('zweit.smoke@example.org');
const demoted = await refresh(secondToken);
check(
  'Desktop nur für Admins: nach Rollenwechsel wird die Verlängerung ein Portal-Token',
  demoted.statusCode === 200 && claims(demoted.json().token as string).session === 'portal',
  demoted.json(),
);
db.prepare('UPDATE users SET must_change_password = 1 WHERE email = ?').run('zweit.smoke@example.org');
const forced = await refresh(secondToken);
check(
  'Keine Verlängerung bei erzwungenem Passwortwechsel (403)',
  forced.statusCode === 403 && forced.json().error?.code === 'PASSWORD_CHANGE_REQUIRED',
  forced.json(),
);

db.prepare('UPDATE users SET sessions_valid_from = ? WHERE email = ?').run([
  Math.floor(Date.now() / 1000) + 5,
  'portal.smoke@example.org',
]);
const stale = await refresh(portalToken);
check('Verlängerung mit Token vor sessions_valid_from → 401', stale.statusCode === 401, stale.json());

// Passwortwechsel bei kaputtem Audit: kein Wechsel, keine entwerteten
// Sitzungen (sonst scheiterte der Wechsel gleich darunter mit 401).
const credentialsRow = () =>
  db.prepare('SELECT password_hash, must_change_password, sessions_valid_from FROM users WHERE email = ?').get('admin@ohrganize.de');
const credentialsBefore = credentialsRow();
const brokenPwChange = await withBrokenAudit(() =>
  app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: bearer(refreshedToken),
    payload: { currentPassword: SMOKE_ADMIN_PASSWORD, newPassword: 'Zweites-Kennwort-0815!' },
  }),
);
check(
  'Audit kaputt: Passwortwechsel scheitert (5xx), Konto unverändert',
  brokenPwChange.statusCode >= 500 && JSON.stringify(credentialsRow()) === JSON.stringify(credentialsBefore),
  { status: brokenPwChange.statusCode, before: credentialsBefore, after: credentialsRow() },
);

const pwChange = await app.inject({
  method: 'PUT',
  url: '/api/auth/password',
  headers: bearer(refreshedToken),
  payload: { currentPassword: SMOKE_ADMIN_PASSWORD, newPassword: 'Zweites-Kennwort-0815!' },
});
const pwToken = pwChange.json().token as string;
const pwc = pwChange.statusCode === 200 ? claims(pwToken) : null;
check(
  'Passwortwechsel behält Sitzungsart und Laufzeit (Desktop)',
  pwc?.session === 'desktop' && pwc.exp - pwc.iat === config.desktopTokenTtl,
  pwChange.json(),
);
check(
  'Passwortwechsel mit Audit-Eintrag',
  !!db.prepare("SELECT id FROM audit_log WHERE action = 'passwort_geaendert'").get(),
);

// Nur-Lese-Betrieb: Testphase abgelaufen (wie licenseSmoke.ts).
db.prepare("UPDATE installation SET licensed_at = NULL, created_at = datetime('now', '-40 days') WHERE id = 1").run();
invalidateLicenseCaches();
const roWrite = await app.inject({ method: 'POST', url: '/api/admin/users', headers: bearer(pwToken), payload: {} });
check(
  'Nur-Lese-Betrieb hergestellt (Schreiben → 403 LICENSE_EXPIRED)',
  roWrite.statusCode === 403 && roWrite.json().error?.code === 'LICENSE_EXPIRED',
  roWrite.json(),
);
const roRefresh = await refresh(pwToken);
check(
  'Verlängerung bleibt im Nur-Lese-Betrieb erlaubt',
  roRefresh.statusCode === 200 && claims(roRefresh.json().token as string).session === 'desktop',
  roRefresh.json(),
);

// Drosselung bei gleichzeitigen Versuchen (core/auth.ts, pendingAttemptAt):
// Seit der Vergleich im Worker läuft, liegt ein await zwischen Prüfung und
// Ergebnis. Ein Bündel paralleler Fehlversuche darf trotzdem nur bis zur
// Schwelle je Konto (10) rechnen; der Rest ist 429. Eigene IPs, damit die
// übrigen Prüfungen nicht an der IP-Schwelle hängen.
const parallel = await Promise.all(
  Array.from({ length: 15 }, () =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.9.8.7',
      payload: { email: 'parallel@ohrganize.de', password: 'falsch-geraten' },
    }),
  ),
);
const parallelCounts = {
  unauthorized: parallel.filter((r) => r.statusCode === 401).length,
  throttled: parallel.filter((r) => r.statusCode === 429).length,
};
check(
  'Gleichzeitige Fehlversuche: höchstens 10 Vergleiche, Rest 429',
  parallelCounts.unauthorized === 10 && parallelCounts.throttled === 5,
  parallelCounts,
);
// Der Vermerk eines erfolgreichen Versuchs fällt bei der IP wieder weg:
// Mehr erfolgreiche Anmeldungen als die IP-Schwelle (50) hinter einer
// Adresse (Firmen-NAT) bleiben möglich.
let natLogins = 0;
for (let i = 0; i < 55; i += 1) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '10.9.8.8',
    payload: { email: 'admin@ohrganize.de', password: 'Zweites-Kennwort-0815!' },
  });
  if (r.statusCode === 200) natLogins += 1;
}
check('55 erfolgreiche Anmeldungen hinter einer IP werden nicht gedrosselt', natLogins === 55, natLogins);
// Dasselbe GLEICHZEITIG, wie zum Schichtbeginn: Laufende Anmeldungen sind bei
// der IP kein Fehlversuch, sie belegen ihre Schwelle (50) nur, solange sie
// laufen. Bis zu 50 gleichzeitige gelingen alle, und danach bleibt nichts
// stehen (die nächste Anmeldung derselben IP gelingt).
const natHash = await hashPassword('Nat-Kennwort-4711!');
for (let i = 0; i < 50; i += 1) addUser.run([`nat${i}.smoke@example.org`, `NAT ${i}`, natHash, 'admin']);
const natBurst = await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.9.8.9',
      payload: { email: `nat${i}.smoke@example.org`, password: 'Nat-Kennwort-4711!' },
    }),
  ),
);
const natStatuses = natBurst.map((r) => r.statusCode);
check(
  '50 gleichzeitige richtige Anmeldungen hinter einer IP: alle 200',
  natStatuses.every((s) => s === 200),
  natStatuses.filter((s) => s !== 200),
);
const afterNat = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  remoteAddress: '10.9.8.9',
  payload: { email: 'nat0.smoke@example.org', password: 'Nat-Kennwort-4711!' },
});
check('Nach dem gleichzeitigen Bündel gelingt die nächste Anmeldung derselben IP', afterNat.statusCode === 200, afterNat.statusCode);
// Laufende Versuche zählen gegen die IP-Schwelle (50): Von 110 parallelen
// Versuchen einer Quelle, je mit eigener Adresse (die Kontoschwelle greift
// also nicht), rechnen genau 50, der Rest ist 429. Auch nachgeschobene
// Versuche kommen nicht mehr durch.
const flood = await Promise.all(
  Array.from({ length: 110 }, (_, i) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.9.8.10',
      payload: { email: `flut${i}@example.org`, password: 'falsch-geraten' },
    }),
  ),
);
const floodCounts = {
  unauthorized: flood.filter((r) => r.statusCode === 401).length,
  throttled: flood.filter((r) => r.statusCode === 429).length,
};
check(
  'Paralleles Bündel einer Quelle: höchstens 50 Vergleiche (IP-Schwelle), Rest 429',
  floodCounts.unauthorized === 50 && floodCounts.throttled === 60,
  floodCounts,
);
// Danach zählen die 50 echten Fehlversuche bei der IP (Schwelle 50).
const afterFlood = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  remoteAddress: '10.9.8.10',
  payload: { email: 'noch.einer@example.org', password: 'falsch-geraten' },
});
check('Nach dem Bündel ist die Quelle gesperrt (429)', afterFlood.statusCode === 429, afterFlood.statusCode);
const floodMessages = new Set(flood.filter((r) => r.statusCode === 429).map((r) => r.json().error?.message as string));
check(
  'Bündel ohne Fehlversuche: 429 bittet um einen Versuch gleich danach',
  floodMessages.size === 1 && [...floodMessages][0].includes('gleich noch einmal'),
  [...floodMessages],
);
// Überwiegen die Fehlversuche (45 von 50), hilft kein sofortiger neuer
// Versuch: Die Meldung nennt einige Minuten.
for (let i = 0; i < 45; i += 1) {
  await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '10.9.8.11',
    payload: { email: `vorab${i}@example.org`, password: 'falsch-geraten' },
  });
}
const nearLimit = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.9.8.11',
      payload: { email: `knapp${i}@example.org`, password: 'falsch-geraten' },
    }),
  ),
);
const nearLimitThrottled = nearLimit.filter((r) => r.statusCode === 429);
check(
  'Kurz vor der IP-Schwelle: Rest 429 mit „in einigen Minuten“',
  nearLimit.filter((r) => r.statusCode === 401).length === 5 &&
    nearLimitThrottled.length === 5 &&
    nearLimitThrottled.every((r) => (r.json().error?.message as string).includes('einigen Minuten')),
  nearLimit.map((r) => r.statusCode),
);

// audit() ausserhalb einer Transaktion wirft unter tsx (core/audit.ts); im
// gebündelten Betrieb schreibt es stattdessen und meldet den Fehler im Log.
let auditOutsideThrew = false;
try {
  audit({ user: undefined, log: app.log } as unknown as Parameters<typeof audit>[0], 'smoke.ausserhalb', 'smoke');
} catch {
  auditOutsideThrew = true;
}
check(
  'audit() ausserhalb einer Transaktion wirft in Entwicklung und Tests',
  auditOutsideThrew && !db.prepare("SELECT 1 FROM audit_log WHERE action = 'smoke.ausserhalb'").get(),
);
// Gebündelter Betrieb: schreiben und im Log melden, nicht werfen.
const loggedErrors: unknown[] = [];
setAuditThrowsOutsideTransaction(false);
let auditBundledThrew = false;
try {
  audit(
    { user: undefined, log: { error: (...args: unknown[]) => loggedErrors.push(args) } } as unknown as Parameters<typeof audit>[0],
    'smoke.betrieb',
    'smoke',
  );
} catch {
  auditBundledThrew = true;
} finally {
  setAuditThrowsOutsideTransaction(true);
}
check(
  'audit() ausserhalb einer Transaktion im Betrieb: Eintrag geschrieben, Fehler im Log, kein Wurf',
  !auditBundledThrew &&
    loggedErrors.length === 1 &&
    !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'smoke.betrieb'").get(),
  { auditBundledThrew, loggedErrors },
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
