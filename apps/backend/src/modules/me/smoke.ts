/**
 * Smoke-Test Self-Service (/api/me/*) gegen eine Wegwerf-Datenbank.
 * Aufruf: npx tsx apps/backend/src/modules/me/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

process.env.HRMONIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrmonic-me-'));
process.env.HRMONIC_LOG_LEVEL = 'silent';

const { buildServer } = await import('../../server.js');
const { getDb, closeDb } = await import('../../db/db.js');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();

// Testdaten direkt in die Wegwerf-DB.
const db = getDb();
db.prepare("INSERT INTO locations (name, bundesland) VALUES ('München', 'BY')").run();
db.prepare("INSERT INTO departments (name) VALUES ('Technik')").run();
db.prepare('INSERT INTO teams (name, department_id) VALUES (?, ?)').run('Backend', 1);
const insertEmp = db.prepare(
  `INSERT INTO employees (first_name, last_name, email, status, hire_date, annual_leave_days, job_title, location_id, department_id, team_id)
   VALUES (?, ?, ?, 'aktiv', ?, ?, ?, ?, ?, ?)`,
);
insertEmp.run('Anna', 'Adler', 'anna.adler@test.de', '2020-01-01', 30, 'Entwicklerin', 1, 1, 1); // id 1
insertEmp.run('Ben', 'Berg', 'ben.berg@test.de', '2021-03-01', 28, 'Entwickler', 1, 1, 1); // id 2
db.prepare('UPDATE employees SET manager_id = 2 WHERE id = 1').run();

const hash = bcrypt.hashSync('geheim123', 10);
db.prepare(
  "INSERT INTO users (email, name, password_hash, role, employee_id) VALUES ('anna.adler@test.de', 'Anna Adler', ?, 'mitarbeiter', 1)",
).run(hash);
db.prepare(
  "INSERT INTO users (email, name, password_hash, role, employee_id) VALUES ('ben.berg@test.de', 'Ben Berg', ?, 'mitarbeiter', 2)",
).run(hash);

// ---------------------------------------------------------------- Anmeldung ---
const loginEmp = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'anna.adler@test.de', password: 'geheim123' },
});
check(
  'Mitarbeiter-Login liefert role + employee_id',
  loginEmp.statusCode === 200 &&
    loginEmp.json().user.role === 'mitarbeiter' &&
    loginEmp.json().user.employee_id === 1,
  loginEmp.json(),
);
const empToken = loginEmp.json().token as string;
const empAuth = { authorization: `Bearer ${empToken}` };
const empGet = (url: string) => app.inject({ method: 'GET', url, headers: empAuth });
const empPost = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: empAuth, payload });

const loginAdmin = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'admin@hrmonic.de', password: 'hrmonic2026' },
});
const adminAuth = { authorization: `Bearer ${loginAdmin.json().token as string}` };

// -------------------------------------------------------------- Rollen-Guard ---
const adminRouteAsEmp = await empGet('/api/absences/requests');
check('Admin-Route mit Mitarbeiter-Token → 403', adminRouteAsEmp.statusCode === 403, adminRouteAsEmp.json());
const employeesAsEmp = await empGet('/api/employees');
check('Personalliste mit Mitarbeiter-Token → 403', employeesAsEmp.statusCode === 403);
const approveAsEmp = await empPost('/api/absences/requests/1/approve');
check('Genehmigen mit Mitarbeiter-Token → 403', approveAsEmp.statusCode === 403);
const meAsPlainAdmin = await app.inject({ method: 'GET', url: '/api/me/profile', headers: adminAuth });
check('Self-Service ohne verknüpftes Profil → 403', meAsPlainAdmin.statusCode === 403, meAsPlainAdmin.json());
const noToken = await app.inject({ method: 'GET', url: '/api/me/profile' });
check('Self-Service ohne Token → 401', noToken.statusCode === 401);

// ----------------------------------------------------------------- Stammdaten ---
const profile = await empGet('/api/me/profile');
const p = profile.json().profile;
check(
  'Profil: eigene Daten mit Organisationskontext',
  profile.statusCode === 200 &&
    p.first_name === 'Anna' &&
    p.department_name === 'Technik' &&
    p.team_name === 'Backend' &&
    p.manager_name === 'Ben Berg',
  p,
);
check('Profil: keine Bank-/Steuerdaten enthalten', !('iban' in p) && !('tax_id' in p) && !('social_security_number' in p), Object.keys(p));

// ---------------------------------------------------------------------- Arten ---
const types = await empGet('/api/me/leave-types');
const typeList = types.json().types as { id: number; name: string; category: string }[];
check(
  'Arten: aktiv und ohne Krankheit',
  types.statusCode === 200 && typeList.length > 0 && typeList.every((t) => t.category !== 'krankheit'),
  typeList.map((t) => t.name),
);
const urlaub = typeList.find((t) => t.name === 'Urlaub')!;

// -------------------------------------------------------------------- Vorschau ---
// KW 18/2026: Mo 27.04.–Fr 01.05.; 01.05. ist bundesweiter Feiertag → 4 Tage.
const preview = await empGet('/api/me/leave-preview?date_from=2026-04-27&date_to=2026-05-01');
check('Vorschau: 4 Tage', preview.json().days_counted === 4, preview.json());

// --------------------------------------------------------------------- Anträge ---
const r1 = await empPost('/api/me/leave-requests', {
  type_id: urlaub.id,
  date_from: '2026-04-27',
  date_to: '2026-05-01',
  comment: 'Wanderwoche',
});
check(
  'Urlaubsantrag → 201, beantragt, eigenes Profil',
  r1.statusCode === 201 &&
    r1.json().request.status === 'beantragt' &&
    r1.json().request.employee_id === 1 &&
    r1.json().request.days_counted === 4,
  r1.json(),
);
const r1Id = r1.json().request.id as number;

const overlap = await empPost('/api/me/leave-requests', {
  type_id: urlaub.id,
  date_from: '2026-04-29',
  date_to: '2026-05-04',
});
check('Überlappender Antrag → 409', overlap.statusCode === 409, overlap.json());

const badRange = await empPost('/api/me/leave-requests', {
  type_id: urlaub.id,
  date_from: '2026-06-10',
  date_to: '2026-06-01',
});
check('Ende vor Beginn → 400', badRange.statusCode === 400);

const absurdSpan = await empPost('/api/me/leave-requests', {
  type_id: urlaub.id,
  date_from: '2026-01-01',
  date_to: '9999-12-31',
});
check('Absurde Zeitspanne → 400 (DoS-Schutz)', absurdSpan.statusCode === 400, absurdSpan.json());
const absurdPreview = await empGet('/api/me/leave-preview?date_from=2026-01-01&date_to=9999-12-31');
check('Absurde Vorschau-Spanne → 400', absurdPreview.statusCode === 400);

const list = await empGet('/api/me/leave-requests');
check(
  'Antragsliste: nur eigene Anträge',
  list.statusCode === 200 &&
    list.json().requests.length === 1 &&
    list.json().requests[0].id === r1Id,
  list.json(),
);

// Fremden Antrag (Ben) kann Anna weder sehen noch zurückziehen.
const loginBen = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'ben.berg@test.de', password: 'geheim123' },
});
const benAuth = { authorization: `Bearer ${loginBen.json().token as string}` };
const rBen = await app.inject({
  method: 'POST',
  url: '/api/me/leave-requests',
  headers: benAuth,
  payload: { type_id: urlaub.id, date_from: '2026-06-15', date_to: '2026-06-19' },
});
const benReqId = rBen.json().request.id as number;
const cancelForeign = await empPost(`/api/me/leave-requests/${benReqId}/cancel`);
check('Fremden Antrag zurückziehen → 404', cancelForeign.statusCode === 404, cancelForeign.json());
const listAnna = await empGet('/api/me/leave-requests');
check('Fremde Anträge tauchen nicht in der Liste auf', !listAnna.json().requests.some((r: { id: number }) => r.id === benReqId));

// Genehmigung durch die HR-Administration → im Portal sichtbar.
const approve = await app.inject({
  method: 'POST',
  url: `/api/absences/requests/${r1Id}/approve`,
  headers: adminAuth,
});
check('Admin genehmigt', approve.statusCode === 200);
const afterApprove = await empGet('/api/me/leave-requests');
const approved = afterApprove.json().requests.find((r: { id: number }) => r.id === r1Id);
check(
  'Portal sieht Genehmigung inkl. entscheidender Person',
  approved.status === 'genehmigt' && approved.decided_by_name === 'HR Administrator',
  approved,
);
const cancelApproved = await empPost(`/api/me/leave-requests/${r1Id}/cancel`);
check('Genehmigten Antrag zurückziehen → 409', cancelApproved.statusCode === 409, cancelApproved.json());

// Eigenen offenen Antrag zurückziehen.
const r2 = await empPost('/api/me/leave-requests', {
  type_id: urlaub.id,
  date_from: '2026-09-14',
  date_to: '2026-09-15',
});
const cancelOwn = await empPost(`/api/me/leave-requests/${r2.json().request.id}/cancel`);
check('Eigenen offenen Antrag zurückziehen', cancelOwn.statusCode === 200 && cancelOwn.json().request.status === 'storniert');

// ----------------------------------------------------------------------- Saldo ---
const balance = await empGet('/api/me/leave-balance?year=2026');
const b = balance.json().balance;
check(
  'Saldo: Anspruch 30, Rest konsistent',
  balance.statusCode === 200 &&
    b.entitlement === 30 &&
    b.remaining === b.entitlement + b.carryover - b.taken - b.planned,
  b,
);

// -------------------------------------------------------------- Krankmeldungen ---
const sick = await empPost('/api/me/sick-notes', {
  date_from: '2026-06-01',
  date_to: '2026-06-03',
});
const s = sick.json().sick_note;
check(
  'Krankmeldung → 201, auto-genehmigt, AU-Frist 3. Kalendertag',
  sick.statusCode === 201 && s.request_status === 'genehmigt' && s.certificate_due_date === '2026-06-03',
  sick.json(),
);
const mySick = await empGet('/api/me/sick-notes');
check('Eigene Krankmeldungen gelistet', mySick.json().sick_notes.some((n: { id: number }) => n.id === s.id));
const adminSick = await app.inject({ method: 'GET', url: '/api/absences/sick-notes/missing', headers: adminAuth });
check(
  'HR sieht fehlende AU-Bescheinigung aus dem Portal',
  adminSick.json().sick_notes.some((n: { id: number }) => n.id === s.id),
  adminSick.json(),
);

// ------------------------------------------------------ Sofortiger Widerruf ---
// Rolle/Verknüpfung werden pro Request frisch geladen — Änderungen wirken
// sofort, nicht erst nach Ablauf der Token-Laufzeit.
db.prepare("UPDATE users SET employee_id = NULL WHERE email = 'ben.berg@test.de'").run();
const unlinked = await app.inject({ method: 'GET', url: '/api/me/profile', headers: benAuth });
check('Entfernte Profil-Verknüpfung wirkt sofort (altes Token → 403)', unlinked.statusCode === 403, unlinked.json());
db.prepare("UPDATE users SET role = 'mitarbeiter' WHERE email = 'admin@hrmonic.de'").run();
const demoted = await app.inject({ method: 'GET', url: '/api/employees', headers: adminAuth });
check('Rollenentzug wirkt sofort (Admin-Token → 403)', demoted.statusCode === 403, demoted.json());
db.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin@hrmonic.de'").run();
// Löschung: eigenes Wegwerf-Konto ohne Aktivität (Konten mit Anträgen sind
// per FK absichtlich nicht hart löschbar).
db.prepare(
  "INSERT INTO users (email, name, password_hash, role, employee_id) VALUES ('temp@test.de', 'Temp', ?, 'mitarbeiter', 2)",
).run(hash);
const loginTemp = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'temp@test.de', password: 'geheim123' },
});
const tempAuth = { authorization: `Bearer ${loginTemp.json().token as string}` };
db.prepare("DELETE FROM users WHERE email = 'temp@test.de'").run();
const deleted = await app.inject({ method: 'GET', url: '/api/me/profile', headers: tempAuth });
check('Gelöschtes Konto wirkt sofort (altes Token → 401)', deleted.statusCode === 401, deleted.json());

await app.close();
closeDb();
try {
  fs.rmSync(process.env.HRMONIC_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows/WAL-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Smoke-Checks des Self-Service-Moduls bestanden.');
