/**
 * Prueft den Einrichtungs-Assistenten: GET /api/setup/status (Zaehlungen,
 * Rechte je Block, nichts wird geschrieben), die Bestaetigung der
 * Abwesenheitsarten fuer die Installation und die reine Fortschrittslogik
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
const {
  deriveSetupProgress, isFreshInstallation, SETUP_STEPS, MODULE_KEYS, setupCardStep, setupLauncherVisible, setupWelcomeDue,
  setupClaimOwed, setupStatusWatched, visibleSetupStepKeys,
} = await import('@ohrganize/shared');

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
check('Status frisch: Abwesenheitsarten noch nicht bestaetigt', f.absence_confirmed === false, f);
check('Status frisch: noch kein Konto hat die Einrichtung uebernommen', f.assistant_owner === 'none', f);
check('Status frisch: das Startkonto kann (vorlaeufig) uebernehmen', f.assistant_claimable === true, f);
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
check('eingeschraenkte Rolle: absence_confirmed fehlt', !('absence_confirmed' in l), l);

// ------------------------------------------- Bestaetigung der Abwesenheitsarten ---
const limConfirm = await app.inject({ method: 'POST', url: '/api/setup/absence-confirmed', headers: limAuth });
check('Bestaetigen ohne abwesenheit: bearbeiten → 403', limConfirm.statusCode === 403, limConfirm.body);
// Grenze der Pruefung: abwesenheit lesen genuegt nicht, verlangt ist bearbeiten.
const roleRead = await send('POST', '/api/admin/admin-roles', { name: 'Abwesenheit lesen', permissions: { abwesenheit: 'lesen' } });
const readUser = await send('POST', '/api/admin/users', {
  email: 'abwesenheit.lesen@example.org', name: 'Abwesenheit Lesen', role: 'admin', admin_role_id: roleRead.json().admin_role.id,
});
const readLogin = await app.inject({
  method: 'POST', url: '/api/auth/login',
  payload: { email: 'abwesenheit.lesen@example.org', password: readUser.json().initial_password },
});
const readChange = await app.inject({
  method: 'PUT', url: '/api/auth/password',
  headers: { authorization: `Bearer ${readLogin.json().token}` },
  payload: { currentPassword: readUser.json().initial_password, newPassword: pw },
});
const readAuth = { authorization: `Bearer ${readChange.json().token}` };
check('Rolle mit abwesenheit lesen sieht absence_confirmed',
  (await get('/api/setup/status', readAuth)).json().absence_confirmed === false);
const readConfirm = await app.inject({ method: 'POST', url: '/api/setup/absence-confirmed', headers: readAuth });
check('Bestaetigen mit abwesenheit lesen → 403', readConfirm.statusCode === 403, readConfirm.body);
check('nach 403 bleibt sie unbestaetigt', (await get('/api/setup/status')).json().absence_confirmed === false);
const confirm1 = await app.inject({ method: 'POST', url: '/api/setup/absence-confirmed', headers: auth });
const confirm2 = await app.inject({ method: 'POST', url: '/api/setup/absence-confirmed', headers: auth });
check('Bestaetigen: 200, zweimal ohne Fehler', confirm1.statusCode === 200 && confirm2.statusCode === 200,
  [confirm1.body, confirm2.body]);
const confirmed = (await get('/api/setup/status')).json();
check('Status meldet die Bestaetigung fuer die Installation', confirmed.absence_confirmed === true, confirmed);
const fromServer = deriveSetupProgress(confirmed, { absenceConfirmed: false, skipped: [] }, ['abwesenheit']);
check('Logik: Bestaetigung des Servers reicht, ohne lokalen Stand (weiterer Arbeitsplatz)',
  fromServer.complete, fromServer);

// ------------------------------------------------- Uebernahme der Einrichtung ---
// Wer den Assistenten kennenlernt, uebernimmt die Einrichtung, solange sie frei
// ist. Karte und Willkommen erscheinen danach nur noch diesem Konto. Das Feld
// haengt an keinem Bereich, jede Rolle sieht es (aus der eigenen Sicht).
async function loginAs(email: string, initial: string) {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: initial } });
  const change = await app.inject({
    method: 'PUT', url: '/api/auth/password',
    headers: { authorization: `Bearer ${login.json().token}` },
    payload: { currentPassword: initial, newPassword: pw },
  });
  return { authorization: `Bearer ${change.json().token}` };
}
const zweitAuth = await loginAs('zweit.konto@example.org', acc.json().initial_password);
const markusAuth = await loginAs('markus.admin@example.org', adminWithProfile.json().initial_password);
const started = (headers: { authorization: string }) => app.inject({ method: 'POST', url: '/api/setup/started', headers });
const ownerOf = async (headers: { authorization: string }) => (await get('/api/setup/status', headers)).json();

const limOwner = await ownerOf(limAuth);
check('eingeschraenkte Rolle sieht assistant_owner, darf aber nicht uebernehmen',
  limOwner.assistant_owner === 'none' && limOwner.assistant_claimable === false, limOwner);
const limStarted = await started(limAuth);
check('Uebernehmen ohne bearbeitbaren Schritt (nur personal lesen) → 403', limStarted.statusCode === 403, limStarted.body);
const readStarted = await started(readAuth);
check('Uebernehmen mit abwesenheit lesen → 403', readStarted.statusCode === 403, readStarted.body);
check('nach den 403 hat niemand uebernommen', (await ownerOf(zweitAuth)).assistant_owner === 'none');

// Startkonto des Betreibers: haelt die Einrichtung nur vorlaeufig. Fuer jedes
// andere Konto bleibt sie frei, das erste persoenliche Konto uebernimmt.
const bootClaim = await started(auth);
check('Startkonto uebernimmt vorlaeufig: 200, Antwort self',
  bootClaim.statusCode === 200 && bootClaim.json().assistant_owner === 'self', bootClaim.body);
const zweitView = await ownerOf(zweitAuth);
check('fuer ein persoenliches Konto gilt die Einrichtung des Startkontos als frei',
  zweitView.assistant_owner === 'none' && zweitView.assistant_claimable === true, zweitView);

const claim1 = await started(zweitAuth);
const claim2 = await started(zweitAuth);
check('persoenliches Konto uebernimmt vom Startkonto: 200, zweimal, Antwort self',
  claim1.statusCode === 200 && claim2.statusCode === 200 && claim2.json().assistant_owner === 'self',
  [claim1.body, claim2.body]);
check('Uebernahme ist an das Konto gebunden: self fuer es, other fuer alle anderen (auch das Startkonto)',
  (await ownerOf(zweitAuth)).assistant_owner === 'self' &&
    (await ownerOf(markusAuth)).assistant_owner === 'other' &&
    (await ownerOf(limAuth)).assistant_owner === 'other' &&
    (await ownerOf(auth)).assistant_owner === 'other');
check('solange jemand uebernommen hat, meldet der Status kein Uebernehmen-Duerfen',
  (await ownerOf(markusAuth)).assistant_claimable === false);
const markusClaim = await started(markusAuth);
check('ein zweites Konto uebernimmt nicht: 200, Antwort other',
  markusClaim.statusCode === 200 && markusClaim.json().assistant_owner === 'other', markusClaim.body);
const bootClaim2 = await started(auth);
check('das Startkonto holt sie nicht zurueck: Antwort other', bootClaim2.json().assistant_owner === 'other', bootClaim2.body);

// Eigentuemer verliert seine Assistentenschritte (Rolle nur personal lesen): wieder frei.
const zweitId = acc.json().user.id as number;
const demote = await send('PATCH', `/api/admin/users/${zweitId}`, { admin_role_id: role.json().admin_role.id });
check('Eigentuemer bekommt eine Rolle ohne Assistentenschritt', demote.statusCode === 200, demote.body);
const afterDemote = await ownerOf(zweitAuth);
check('Eigentuemer ohne Recht: fuer ihn frei, aber nicht uebernehmbar',
  afterDemote.assistant_owner === 'none' && afterDemote.assistant_claimable === false, afterDemote);
check('Eigentuemer ohne Recht: fuer andere wieder frei', (await ownerOf(markusAuth)).assistant_owner === 'none');
const markusClaim2 = await started(markusAuth);
check('danach uebernimmt das naechste Konto', markusClaim2.json().assistant_owner === 'self', markusClaim2.body);

// Konto geloescht: Die Kontoloeschung setzt user_id auf NULL, die Einrichtung ist wieder frei.
const markusId = adminWithProfile.json().user.id as number;
const del = await app.inject({ method: 'DELETE', url: `/api/admin/users/${markusId}`, headers: auth });
check('Eigentuemer-Konto loeschen', del.statusCode === 200 || del.statusCode === 204, del.body);
check('Kontoloeschung leert user_id',
  (db.prepare(`SELECT user_id FROM setup_confirmations WHERE step = 'assistent'`).get() as { user_id: number | null })
    .user_id === null);
check('nach dem Loeschen ist die Einrichtung wieder frei', (await ownerOf(auth)).assistant_owner === 'none');

// Portal-Konto: der globale Hook laesst `mitarbeiter` nur an /api/auth und /api/me.
const portalLogin = await app.inject({
  method: 'POST', url: '/api/auth/login',
  payload: { email: 'anna.portal@example.org', password: portal.json().initial_password, client: 'portal' },
});
const portalChange = await app.inject({
  method: 'PUT', url: '/api/auth/password',
  headers: { authorization: `Bearer ${portalLogin.json().token}` },
  payload: { currentPassword: portal.json().initial_password, newPassword: pw },
});
check('Portal-Konto angemeldet', portalChange.statusCode === 200, portalChange.body);
const portalConfirm = await app.inject({
  method: 'POST', url: '/api/setup/absence-confirmed',
  headers: { authorization: `Bearer ${portalChange.json().token}` },
});
check('Bestaetigen als Portal-Konto → 403', portalConfirm.statusCode === 403, portalConfirm.body);
const portalStarted = await app.inject({
  method: 'POST', url: '/api/setup/started',
  headers: { authorization: `Bearer ${portalChange.json().token}` },
});
check('Uebernehmen als Portal-Konto → 403', portalStarted.statusCode === 403, portalStarted.body);

// Nur-Lese-Betrieb: Testphase abgelaufen. Die Route steht bewusst NICHT in
// LICENSE_OPEN_ROUTES, der Client versucht es dort gar nicht erst.
const { invalidateLicenseCaches } = await import('../core/license.js');
const createdAt = (db.prepare('SELECT created_at FROM installation WHERE id = 1').get() as { created_at: string }).created_at;
db.prepare(`UPDATE installation SET created_at = datetime('now', '-90 days') WHERE id = 1`).run();
invalidateLicenseCaches();
const readOnly = await app.inject({ method: 'POST', url: '/api/setup/absence-confirmed', headers: auth });
check('Bestaetigen im Nur-Lese-Betrieb → 403 LICENSE_EXPIRED',
  readOnly.statusCode === 403 && readOnly.json().error?.code === 'LICENSE_EXPIRED', readOnly.body);
const readOnlyStarted = await app.inject({ method: 'POST', url: '/api/setup/started', headers: auth });
check('Uebernehmen im Nur-Lese-Betrieb → 403 LICENSE_EXPIRED',
  readOnlyStarted.statusCode === 403 && readOnlyStarted.json().error?.code === 'LICENSE_EXPIRED', readOnlyStarted.body);
db.prepare('UPDATE installation SET created_at = ? WHERE id = 1').run(createdAt);
invalidateLicenseCaches();

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

// ------------------------------------------------- Sichtbarkeit (shared) ---
const viewNew = { welcomed: false, open: false, cardDismissed: false };
const asOwner = (o: 'none' | 'self' | 'other') => ({ ...mid, assistant_owner: o, assistant_claimable: true });
const progMid = deriveSetupProgress(mid, { absenceConfirmed: false, skipped: [] }, keys);
check('Sichtbarkeit: Karte fuer ein neues Konto, solange niemand uebernommen hat, mit dem naechsten Schritt',
  setupCardStep(asOwner('none'), progMid, viewNew) === progMid.next && progMid.next !== null);
check('Sichtbarkeit: Karte fuer den Eigentuemer auf einem weiteren Geraet',
  setupCardStep(asOwner('self'), progMid, viewNew) !== null);
check('Sichtbarkeit: keine Karte, wenn ein anderes Konto uebernommen hat',
  setupCardStep(asOwner('other'), progMid, viewNew) === null);
check('Sichtbarkeit: keine Karte nach Ausblenden oder mit Launcher',
  setupCardStep(asOwner('none'), progMid, { ...viewNew, cardDismissed: true }) === null &&
    setupCardStep(asOwner('none'), progMid, { ...viewNew, welcomed: true }) === null);
check('Sichtbarkeit: keine Karte, wenn alles erledigt ist',
  setupCardStep(asOwner('none'), all, viewNew) === null);
const viewLaunch = { ...viewNew, welcomed: true, doneSeen: false };
check('Launcher: fuer das Konto, das den Assistenten kennt, nicht fuer einen Nicht-Eigentuemer',
  setupLauncherVisible(asOwner('self'), progMid, viewLaunch) && setupLauncherVisible(asOwner('none'), progMid, viewLaunch) &&
    !setupLauncherVisible(asOwner('other'), progMid, viewLaunch));
check('Launcher: nicht ohne Kennenlernen, nicht nach gesehenem Abschluss',
  !setupLauncherVisible(asOwner('self'), progMid, { ...viewLaunch, welcomed: false }) &&
    !setupLauncherVisible(asOwner('self'), all, { ...viewLaunch, doneSeen: true }) &&
    setupLauncherVisible(asOwner('self'), all, viewLaunch));
const freshFor = (o: 'none' | 'self' | 'other') => ({ ...f, assistant_owner: o, assistant_claimable: true });
check('Willkommen: bei leerer Firma fuer jedes Konto, solange niemand uebernommen hat (auch nach dem Startkonto)',
  setupWelcomeDue(freshFor('none'), viewNew) && setupWelcomeDue(freshFor('self'), viewNew));
check('Willkommen: nicht, wenn ein anderes Konto uebernommen hat, nicht zweimal, nicht bei Daten',
  !setupWelcomeDue(freshFor('other'), viewNew) && !setupWelcomeDue(freshFor('none'), { ...viewNew, welcomed: true }) &&
    !setupWelcomeDue(asOwner('none'), viewNew));
check('Uebernahme: faellig, wer den Assistenten kennt, solange sie frei ist und das Konto darf',
  setupClaimOwed(asOwner('none'), { ...viewNew, welcomed: true }) &&
    !setupClaimOwed(asOwner('none'), viewNew) &&
    !setupClaimOwed(asOwner('none'), { ...viewNew, cardDismissed: true }) &&
    !setupClaimOwed(asOwner('self'), { ...viewNew, welcomed: true }) &&
    !setupClaimOwed({ ...asOwner('none'), assistant_claimable: false }, { ...viewNew, welcomed: true }));
check('Nachladen: nicht, wenn ein anderes Konto uebernommen hat; ohne Status ja',
  !setupStatusWatched(asOwner('other'), progMid, viewNew) &&
    !setupStatusWatched(asOwner('other'), progMid, { ...viewNew, welcomed: true }) &&
    setupStatusWatched(asOwner('self'), progMid, { ...viewNew, welcomed: true }) &&
    setupStatusWatched(undefined, progMid, viewNew) && !setupStatusWatched(asOwner('none'), all, viewNew));
const allAreas = () => true;
check('Schritte: Vollzugriff in der Vollversion sieht alle sieben',
  visibleSetupStepKeys(allAreas, { modules: [...MODULE_KEYS] }, null).length === 7);
check('Schritte: ohne Modul me entfaellt der Portal-Schritt',
  !visibleSetupStepKeys(allAreas, { modules: MODULE_KEYS.filter((m) => m !== 'me') }, null).includes('portal'));
check('Schritte: nur Bereich personal bearbeitbar ergibt die drei Personal-Schritte',
  JSON.stringify(visibleSetupStepKeys((a) => a === 'personal', { modules: [...MODULE_KEYS] }, null)) ===
    JSON.stringify(['abteilungen', 'mitarbeitende', 'vorgesetzte']));

closeDb();
if (failures) {
  console.log(`\n${failures} Pruefung(en) fehlgeschlagen.`);
  process.exit(1);
}
console.log('\nAlle Pruefungen bestanden.');
