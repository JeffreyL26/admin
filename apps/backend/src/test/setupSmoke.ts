/**
 * Prueft den Einrichtungs-Assistenten: GET /api/setup/status (Zaehlungen,
 * Rechte je Block, nichts wird geschrieben) und die reine Fortschrittslogik
 * aus packages/shared/src/setup.ts.
 *
 * Aufruf: tsx src/test/setupSmoke.ts (Teil von npm test)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-setup-'));
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

const { buildServer } = await import('../server.js');
const { getDb, closeDb } = await import('../db/db.js');
const { firstAdminLogin } = await import('./adminSession.js');
const { deriveSetupProgress, isFreshInstallation, SETUP_STEPS } = await import('@ohrganize/shared');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();
const db = getDb();
const { auth } = await firstAdminLogin(app, check);
const get = (url: string, headers = auth) => app.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: Record<string, unknown>, headers = auth) =>
  app.inject({ method, url, headers, payload });

// ----------------------------------------------------------- frische Datenbank ---
const fresh = await get('/api/setup/status');
const f = fresh.json();
check('Status: 200 fuer den Standard-Admin', fresh.statusCode === 200, f);
check('Status frisch: nichts gespeichert, nichts angelegt',
  f.company_saved === false && f.departments === 0 && f.locations === 0 && f.employees_active === 0 &&
    f.employees_with_manager === 0, f);
check('Status frisch: Seed-Abwesenheitsarten sind aktiv', f.absence_types_active > 0, f);
check('Status frisch: genau ein Admin, kein Portal-Konto', f.admin_users === 1 && f.portal_users === 0, f);
check('Status frisch: alle Bereiche lesbar', Array.isArray(f.allowed_areas) && f.allowed_areas.length >= 9, f);
check('frische Installation wird erkannt', isFreshInstallation(f));
check('Status nennt eine Installationskennung (Hash, nicht die Lizenz-ID)',
  typeof f.instance === 'string' && /^[0-9a-f]{16}$/.test(f.instance), f.instance);
const again = (await get('/api/setup/status')).json();
check('Installationskennung bleibt stabil', again.instance === f.instance);

const anon = await app.inject({ method: 'GET', url: '/api/setup/status' });
check('Status ohne Anmeldung → 401', anon.statusCode === 401, anon.body);

// ------------------------------------------------------------ Daten entstehen ---
check('Firma speichern', (await send('PUT', '/api/settings', { companyName: 'Muster GmbH', defaultBundesland: 'BY' })).statusCode === 200);
const dep = await send('POST', '/api/departments', { name: 'Personal' });
check('Abteilung anlegen', dep.statusCode === 201, dep.json());
const mk = async (first: string, last: string) =>
  send('POST', '/api/employees', {
    first_name: first, last_name: last, employee_type: 'werkstudent', weekly_hours: 20,
    department_id: dep.json().department?.id ?? null,
  });
const a = await mk('Anna', 'Schneider');
const b = await mk('Markus', 'Brandt');
check('zwei Personen angelegt', a.statusCode === 201 && b.statusCode === 201, [a.json(), b.json()]);

const mid = (await get('/api/setup/status')).json();
check('Status danach: Firma, Abteilung, Personen gezaehlt',
  mid.company_saved === true && mid.departments === 1 && mid.employees_active === 2 && mid.employees_with_manager === 0, mid);
check('nach den Daten ist die Installation nicht mehr frisch', !isFreshInstallation(mid));

const aId = a.json().employee.id as number;
const bId = b.json().employee.id as number;
await send('PATCH', `/api/employees/${aId}`, { manager_id: bId });
check('Vorgesetzte werden gezaehlt', (await get('/api/setup/status')).json().employees_with_manager === 1);

// ------------------------------------------------------------ Konten und Rechte ---
const acc = await send('POST', '/api/admin/users', { email: 'zweit.konto@example.org', name: 'Zweit Konto', role: 'admin' });
check('zweites Admin-Konto angelegt', acc.statusCode === 201, acc.json());
const portal = await send('POST', '/api/admin/users', {
  email: 'anna.portal@example.org', name: 'Anna Schneider', role: 'mitarbeiter', employee_id: aId,
});
check('Portal-Konto angelegt', portal.statusCode === 201, portal.json());
const acct = (await get('/api/setup/status')).json();
check('Konten werden gezaehlt', acct.admin_users === 2 && acct.portal_users === 1, acct);
// Das eigene Konto zaehlt nicht als Portal-Zugang: Profil an das abfragende Admin-Konto haengen aendert nichts.
const self = db.prepare("SELECT id FROM users WHERE email = 'admin@ohrganize.de'").get() as { id: number };
db.prepare('UPDATE users SET employee_id = ? WHERE id = ?').run(bId, self.id);
check('eigenes Konto mit Profil zaehlt nicht als Portal-Zugang', (await get('/api/setup/status')).json().portal_users === 1);
db.prepare('UPDATE users SET employee_id = NULL WHERE id = ?').run(self.id);
check('Personen ohne Konto: nur Markus', acct.employees_without_account === 1, acct);

// Ein Admin-Konto MIT Personalprofil ist ebenfalls Portal-Zugang (gleiche Zugangsdaten).
const adminWithProfile = await send('POST', '/api/admin/users', {
  email: 'markus.admin@example.org', name: 'Markus Brandt', role: 'admin', employee_id: bId,
});
check('Admin-Konto mit Profil angelegt', adminWithProfile.statusCode === 201, adminWithProfile.json());
const both = (await get('/api/setup/status')).json();
check('Admin mit Profil zaehlt als Portal-Zugang und als Admin',
  both.portal_users === 2 && both.admin_users === 3 && both.employees_without_account === 0, both);

// Rolle nur mit Lesen auf "personal": alle anderen Bereiche fehlen in der Antwort.
const role = await send('POST', '/api/admin/admin-roles', { name: 'Nur Personal lesen', permissions: { personal: 'lesen' } });
check('Rolle angelegt', role.statusCode === 201, role.json());
const lim = await send('POST', '/api/admin/users', {
  email: 'eingeschraenkt@example.org', name: 'Eingeschraenkt', role: 'admin', admin_role_id: role.json().admin_role.id,
});
const limLogin = await app.inject({
  method: 'POST', url: '/api/auth/login',
  payload: { email: 'eingeschraenkt@example.org', password: lim.json().initial_password },
});
const pw = 'Gutes-Kennwort-4711!';
const limChange = await app.inject({
  method: 'PUT', url: '/api/auth/password',
  headers: { authorization: `Bearer ${limLogin.json().token}` },
  payload: { currentPassword: lim.json().initial_password, newPassword: pw },
});
const limAuth = { authorization: `Bearer ${limChange.json().token}` };
const limited = await get('/api/setup/status', limAuth);
const l = limited.json();
check('eingeschraenkte Rolle: 200 (Route fuer jede Rolle offen)', limited.statusCode === 200, l);
check('eingeschraenkte Rolle: Personal sichtbar', l.departments === 1 && l.employees_active === 2, l);
check('eingeschraenkte Rolle: gesperrte Bloecke fehlen, statt 0 zu sein',
  !('company_saved' in l) && !('absence_types_active' in l) && !('admin_users' in l) &&
    !('portal_users' in l) && !('employees_without_account' in l), l);
check('eingeschraenkte Rolle: allowed_areas nennt nur personal',
  JSON.stringify(l.allowed_areas) === JSON.stringify(['personal']), l.allowed_areas);

// Rolle nur mit "benutzer": Konten sichtbar, Belegschaftszahlen (personal) nicht.
const role2 = await send('POST', '/api/admin/admin-roles', { name: 'Nur Benutzer lesen', permissions: { benutzer: 'lesen' } });
const lim2 = await send('POST', '/api/admin/users', {
  email: 'nurbenutzer@example.org', name: 'Nur Benutzer', role: 'admin', admin_role_id: role2.json().admin_role.id,
});
const lim2Login = await app.inject({
  method: 'POST', url: '/api/auth/login',
  payload: { email: 'nurbenutzer@example.org', password: lim2.json().initial_password },
});
const lim2Change = await app.inject({
  method: 'PUT', url: '/api/auth/password',
  headers: { authorization: `Bearer ${lim2Login.json().token}` },
  payload: { currentPassword: lim2.json().initial_password, newPassword: pw },
});
const l2 = (await get('/api/setup/status', { authorization: `Bearer ${lim2Change.json().token}` })).json();
check('Rolle nur mit benutzer: Konten sichtbar, Personalzahlen und employees_without_account fehlen',
  typeof l2.admin_users === 'number' && !('employees_active' in l2) && !('employees_without_account' in l2), l2);

// ----------------------------------------------------------- Fortschrittslogik ---
const keys = SETUP_STEPS.map((s) => s.key);
const none = deriveSetupProgress(f, { absenceConfirmed: false, skipped: [] }, keys);
check('Logik: sieben Schritte, keiner erledigt, erster ist der naechste',
  none.total === 7 && none.doneCount === 0 && none.next === 'firma' && !none.complete, none);
check('Logik: Restzeit ist die Summe der offenen Minuten',
  none.remainingMinutes === SETUP_STEPS.reduce((n, s) => n + s.minutes, 0), none.remainingMinutes);
check('Logik: Gesamtdauer bleibt knapp (hoechstens zehn Minuten)', none.remainingMinutes <= 10, none.remainingMinutes);

const oneUser = deriveSetupProgress({ ...f, employees_active: 1 }, { absenceConfirmed: false, skipped: [] }, keys);
check('Logik: Vorgesetzte bleiben mit nur einer Person gesperrt',
  oneUser.steps.find((s) => s.def.key === 'vorgesetzte')?.blocked === true);

const all = deriveSetupProgress(acct, { absenceConfirmed: true, skipped: [] }, keys);
check('Logik: alles erledigt → complete, kein naechster Schritt', all.complete && all.next === null, all);

const skip = deriveSetupProgress(f, { absenceConfirmed: false, skipped: ['firma'] }, keys);
check('Logik: uebersprungener Schritt wird beim naechsten Vorschlag ausgelassen', skip.next === 'abteilungen', skip.next);

const some = deriveSetupProgress(l, { absenceConfirmed: false, skipped: [] }, ['abteilungen', 'mitarbeitende', 'vorgesetzte']);
check('Logik: nur sichtbare Schritte zaehlen, Nummern beginnen bei 1',
  some.total === 3 && some.steps[0].n === 1 && some.steps[2].n === 3 && some.doneCount === 3, some);

closeDb();
if (failures) {
  console.log(`\n${failures} Pruefung(en) fehlgeschlagen.`);
  process.exit(1);
}
console.log('\nAlle Pruefungen bestanden.');
