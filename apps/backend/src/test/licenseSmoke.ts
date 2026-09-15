/**
 * Smoke-Test des Lizenzmodells (core/license.ts) gegen eine Wegwerf-Datenbank,
 * signiert mit einem Wegwerf-Schlüsselpaar (OHRGANIZE_LICENSE_PUBLIC_KEY).
 * Aufruf: npm run test -w apps/backend (läuft nach smoke.ts).
 *
 * Geprüft wird der ganze Zustandsautomat: Testphase → gültig → Platzgrenze →
 * monotone Installation → Kulanz → Nur-Lese-Betrieb (was offen bleibt, was
 * nicht) → Weg zurück per Upload → keine zweite Testphase → unbrauchbare
 * Datei → Uhren-Stolperdraht → Portal-Sicht.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-lizenz-'));
process.env.OHRGANIZE_DATA_DIR = dataDir;
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

// Wegwerf-Schlüsselpaar; der öffentliche Teil geht als Override in config.ts.
const testKeys = crypto.generateKeyPairSync('ed25519');
{
  const der = testKeys.publicKey.export({ format: 'der', type: 'spki' });
  process.env.OHRGANIZE_LICENSE_PUBLIC_KEY = der.subarray(der.length - 32).toString('base64');
}

const { buildServer } = await import('../server.js');
const { closeDb, getDb } = await import('../db/db.js');
const { firstAdminLogin, SMOKE_ADMIN_PASSWORD } = await import('./adminSession.js');
const { signLicensePayload } = await import('../core/licenseCodec.js');
const { invalidateLicenseCaches } = await import('../core/license.js');
const { addDaysIso, todayIso } = await import('../core/dates.js');
const { LICENSE_STATE_HEADER, LICENSE_FILE_NAME } = await import('@ohrganize/shared');
type LicensePayload = import('@ohrganize/shared').LicensePayload;

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const today = todayIso();
const licensePath = path.join(dataDir, LICENSE_FILE_NAME);

function makeLicense(over: Partial<LicensePayload>): string {
  const payload: LicensePayload = {
    v: 1,
    license_id: crypto.randomUUID(),
    kid: 'test',
    customer: 'Smoke GmbH',
    customer_id: 'smoke',
    installation_id: null,
    kind: 'standard',
    issued_at: today,
    // valid_from immer vor valid_until, auch bei absichtlich abgelaufenen Dateien.
    valid_from: addDaysIso(over.valid_until ?? addDaysIso(today, 100), -365),
    valid_until: addDaysIso(today, 100),
    grace_days: 14,
    warn_days: 30,
    max_users: null,
    notice: null,
    ...over,
  };
  return signLicensePayload(payload, testKeys.privateKey);
}

/** Signiert beliebiges JSON OHNE Schemaprüfung — für Payloads, die der Server ablehnen muss. */
function signRaw(payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, bytes, testKeys.privateKey);
  return `OHRG1.${bytes.toString('base64url')}.${sig.toString('base64url')}`;
}

/** Datei direkt schreiben — der Weg, den der Upload absichtlich verwehrt. */
function writeLicenseFile(text: string | null): void {
  if (text === null) fs.rmSync(licensePath, { force: true });
  else fs.writeFileSync(licensePath, `${text}\n`);
  invalidateLicenseCaches();
}

const app = await buildServer();

// --------------------------------------------------------------- Testphase --
const health0 = await app.inject({ method: 'GET', url: '/api/health' });
check('Health meldet read_only=false', health0.json().license?.read_only === false, health0.json());
check('Öffentliche Antwort ohne Lizenz-Header', health0.headers[LICENSE_STATE_HEADER] === undefined, health0.headers[LICENSE_STATE_HEADER]);

let { auth } = await firstAdminLogin(app, check);

const me0 = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('me.license.state = trial', me0.json().license?.state === 'trial', me0.json().license);
check('Zustands-Header (angemeldet): trial', me0.headers[LICENSE_STATE_HEADER] === 'trial', me0.headers[LICENSE_STATE_HEADER]);
check('Testphase: 29 Resttage, keine Warnung', me0.json().license?.days_left === 29 && me0.json().license?.warning === false, me0.json().license);

const status0 = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
const installationId = status0.json().license?.installation_id as string;
check('GET /api/license liefert Installations-ID (32 hex)', /^[0-9a-f]{32}$/.test(installationId ?? ''), status0.json());
check('Testphase: seats_used = 0, max_users = null', status0.json().license.seats_used === 0 && status0.json().license.max_users === null);

// ---------------------------------------------------------- Upload-Abwehr --
const put = (license: string) =>
  app.inject({ method: 'PUT', url: '/api/license', headers: auth, payload: { license } });

const junk = await put('das ist keine lizenz');
check('Upload: Unsinn → 400 LICENSE_INVALID', junk.statusCode === 400 && junk.json().error?.code === 'LICENSE_INVALID', junk.json());

const foreign = await put(makeLicense({ installation_id: 'f'.repeat(32) }));
check('Upload: andere Installation → 400', foreign.statusCode === 400 && /andere Installation/.test(foreign.json().error?.message), foreign.json());

const good = makeLicense({ installation_id: installationId, max_users: 2 });
// Ein Zeichen im Payload-Teil kippen: Signatur muss scheitern.
const [pfx, body, sig] = good.split('.');
const flipped = body[10] === 'A' ? 'B' : 'A';
const tampered = `${pfx}.${body.slice(0, 10)}${flipped}${body.slice(11)}.${sig}`;
const tamperedRes = await put(tampered);
check('Upload: manipulierter Inhalt → 400 (Signatur)', tamperedRes.statusCode === 400, tamperedRes.json());

const unknownKid = await put(makeLicense({ kid: 'nicht-vorhanden' }));
check('Upload: unbekannte kid → 400', unknownKid.statusCode === 400 && /Schlüssel/.test(unknownKid.json().error?.message), unknownKid.json());

const longDead = await put(makeLicense({ valid_until: addDaysIso(today, -20), grace_days: 14 }));
check('Upload: bereits über die Kulanz hinaus → 400', longDead.statusCode === 400 && /abgelaufen/.test(longDead.json().error?.message), longDead.json());

// Unsigniert, aber formatgerecht mit unmöglichem Datum: muss 400 sein, nicht 500.
const badDatePayload = Buffer.from(JSON.stringify({ v: 1, license_id: 'x', kid: 'test', customer: 'X', customer_id: 'x', installation_id: null, kind: 'standard', issued_at: today, valid_from: today, valid_until: '2026-13-01', grace_days: 14, warn_days: 30, max_users: null, notice: null })).toString('base64url');
const badDate = await put(`OHRG1.${badDatePayload}.${Buffer.alloc(64).toString('base64url')}`);
check('Upload: unmögliches Datum → 400 (kein 500)', badDate.statusCode === 400 && /Kalendertag/.test(badDate.json().error?.message), badDate.json());

const tooFar = await put(signRaw({ v: 1, license_id: 'far', kid: 'test', customer: 'X', customer_id: 'x', installation_id: null, kind: 'standard', issued_at: today, valid_from: today, valid_until: '3000-01-01', grace_days: 14, warn_days: 30, max_users: null, notice: null }));
check('Upload: Datum nach 2999 → 400', tooFar.statusCode === 400, tooFar.json());
const perpetual = await put(makeLicense({ valid_until: '2999-12-31', installation_id: installationId }));
check('Upload: „unbefristet“ (2999-12-31) wird angenommen', perpetual.statusCode === 200 && perpetual.json().license?.state === 'valid', perpetual.json());
{
  const l = perpetual.json().license ?? {};
  check('Unbefristet: perpetual, kein Countdown, keine Kulanz, keine Warnung', l.perpetual === true && l.days_left === null && l.grace_until === null && l.warning === false && l.issued_at === today, l);
}
// Zurück in die Testphase für die folgenden Fälle: Datei entfernen und die
// Markierung „je lizenziert“ löschen (nur im Test zulässig).
writeLicenseFile(null);
getDb().prepare('UPDATE installation SET licensed_at = NULL WHERE id = 1').run();
invalidateLicenseCaches();

// Abgelaufene Fremddatei im Datenverzeichnis während der Testphase: darf die
// Testphase nicht beenden (dieselbe Regel wie beim Upload).
writeLicenseFile(makeLicense({ valid_until: addDaysIso(today, -30) }));
const staleDuringTrial = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Abgelaufene Datei in der Testphase → weiter trial, mit Grund', staleDuringTrial.json().license?.state === 'trial' && /abgelaufen/.test(staleDuringTrial.json().license?.invalid_reason ?? ''), staleDuringTrial.json().license);
writeLicenseFile(null);

// --------------------------------------------------------------- Gültig --
const ok = await put(good);
check('Upload: gültige, gebundene Lizenz → 200', ok.statusCode === 200, ok.json());
check('Zustand valid, 100 Tage, keine Warnung', ok.json().license?.state === 'valid' && ok.json().license?.days_left === 100 && ok.json().license?.warning === false, ok.json().license);
check('Kunde und Plätze sichtbar', ok.json().license?.customer === 'Smoke GmbH' && ok.json().license?.max_users === 2);
check('Datei liegt im Datenverzeichnis', fs.existsSync(licensePath));

const hdr = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('Zustands-Header: valid', hdr.headers[LICENSE_STATE_HEADER] === 'valid', hdr.headers[LICENSE_STATE_HEADER]);

const warnSoon = await put(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, 100), warn_days: 120, max_users: 2 }));
check('Gleiches Ablaufdatum wird angenommen (warn_days 120 → warning)', warnSoon.statusCode === 200 && warnSoon.json().license?.warning === true, warnSoon.json());

// Zweites Admin-Konto — wird später im Nur-Lese-Betrieb widerrufen.
const second = await app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { email: 'zweit@smoke.de', name: 'Zweites Konto', role: 'admin' } });
check('Zweites Admin-Konto angelegt', second.statusCode === 201 || second.statusCode === 200, second.json());
const secondId = second.json().user?.id as number;

// ------------------------------------------------------------ Platzgrenze --
const minijob = (n: number) => ({ first_name: `Test${n}`, last_name: 'Person', employee_type: 'minijob', weekly_hours: 8 });
const createEmp = (n: number) => app.inject({ method: 'POST', url: '/api/employees', headers: auth, payload: minijob(n) });

const e1 = await createEmp(1);
const e2 = await createEmp(2);
check('Zwei Profile passen in zwei Plätze', e1.statusCode === 201 && e2.statusCode === 201, [e1.json(), e2.json()]);
const e3 = await createEmp(3);
check('Drittes Profil → 409 LICENSE_SEATS_EXCEEDED', e3.statusCode === 409 && e3.json().error?.code === 'LICENSE_SEATS_EXCEEDED', e3.json());

const id1 = e1.json().employee.id as number;
const leave = await app.inject({ method: 'PATCH', url: `/api/employees/${id1}`, headers: auth, payload: { status: 'ausgeschieden' } });
check('Austritt setzen bleibt möglich', leave.statusCode === 200, leave.json());
const e3b = await createEmp(3);
check('Freigewordener Platz kann neu belegt werden', e3b.statusCode === 201, e3b.json());
const reactivate = await app.inject({ method: 'PATCH', url: `/api/employees/${id1}`, headers: auth, payload: { status: 'aktiv' } });
check('Reaktivierung ohne freien Platz → 409', reactivate.statusCode === 409, reactivate.json());
const bulk = await app.inject({ method: 'POST', url: '/api/employees/bulk', headers: auth, payload: { ids: [id1], set: { status: 'aktiv' } } });
check('Massen-Reaktivierung ohne freien Platz → 409', bulk.statusCode === 409, bulk.json());
const statusSeats = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('seats_used = 2', statusSeats.json().license.seats_used === 2, statusSeats.json().license);

// -------------------------------------------------------- Monotonie --
const shorter = await put(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, 50) }));
check('Kürzere Lizenz wird abgelehnt (monoton)', shorter.statusCode === 400 && /länger/.test(shorter.json().error?.message), shorter.json());
const moreSeats = await put(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, 100), max_users: 10 }));
check('Gleiche Laufzeit, mehr Plätze → 200', moreSeats.statusCode === 200 && moreSeats.json().license?.max_users === 10, moreSeats.json());
const e4 = await createEmp(4);
check('Mit 10 Plätzen geht das vierte Profil', e4.statusCode === 201, e4.json());

// ------------------------------------------------------------- Kulanz --
writeLicenseFile(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, -5), grace_days: 14 }));
const grace = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Kulanz: state grace, read_only false, 9 Resttage', grace.json().license?.state === 'grace' && grace.json().license?.read_only === false && grace.json().license?.days_left === 9, grace.json().license);
const e5 = await createEmp(5);
check('In der Kulanz bleibt alles möglich', e5.statusCode === 201, e5.json());

// ------------------------------------------------------- Nur-Lese --
writeLicenseFile(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, -30), grace_days: 14 }));
const expired = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Abgelaufen: state expired, read_only true', expired.json().license?.state === 'expired' && expired.json().license?.read_only === true, expired.json().license);
const healthRo = await app.inject({ method: 'GET', url: '/api/health' });
check('Health meldet read_only=true', healthRo.json().license?.read_only === true, healthRo.json());

const readList = await app.inject({ method: 'GET', url: '/api/employees', headers: auth });
check('Nur-Lese: GET /api/employees → 200', readList.statusCode === 200, readList.statusCode);
const readCsv = await app.inject({ method: 'GET', url: '/api/employees/export.csv', headers: auth });
check('Nur-Lese: Export bleibt offen', readCsv.statusCode === 200, readCsv.statusCode);
const meRo = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('Nur-Lese: /api/auth/me → 200 mit state expired', meRo.statusCode === 200 && meRo.json().license?.state === 'expired');
check('Zustands-Header (angemeldet): expired', meRo.headers[LICENSE_STATE_HEADER] === 'expired', meRo.headers[LICENSE_STATE_HEADER]);
const report = await app.inject({ method: 'GET', url: '/api/license/report', headers: auth });
check('Nur-Lese: Lizenzbericht abrufbar', report.statusCode === 200 && JSON.parse(report.body).installation_id === installationId, report.body);

const writeEmp = await createEmp(6);
check('Nur-Lese: POST /api/employees → 403 LICENSE_EXPIRED', writeEmp.statusCode === 403 && writeEmp.json().error?.code === 'LICENSE_EXPIRED', writeEmp.json());
const writeSettings = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { companyName: 'X' } });
check('Nur-Lese: PUT /api/settings → 403', writeSettings.statusCode === 403 && writeSettings.json().error?.code === 'LICENSE_EXPIRED', writeSettings.json());
const patchRo = await app.inject({ method: 'PATCH', url: `/api/employees/${id1}`, headers: auth, payload: { phone: '1' } });
check('Nur-Lese: PATCH → 403', patchRo.statusCode === 403, patchRo.json());

// Konto-Widerruf bleibt im Nur-Lese-Betrieb möglich (Lesezugriff bleibt ja für alle offen).
const revokeUser = await app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { email: 'weg@smoke.de', name: 'Geht weg', role: 'admin' } });
check('Nur-Lese: Konto ANLEGEN bleibt gesperrt (403)', revokeUser.statusCode === 403, revokeUser.json());
const resetOther = await app.inject({ method: 'POST', url: `/api/admin/users/${secondId}/reset-password`, headers: auth });
check('Nur-Lese: fremdes Passwort zurücksetzen bleibt möglich', resetOther.statusCode === 200 && typeof resetOther.json().initial_password === 'string', resetOther.json());
const deleteOther = await app.inject({ method: 'DELETE', url: `/api/admin/users/${secondId}`, headers: auth });
check('Nur-Lese: Konto löschen bleibt möglich', deleteOther.statusCode === 204, deleteOther.statusCode);
check('Nur-Lese-Meldung nennt Einstellungen → Lizenz', /Einstellungen → Lizenz/.test(writeEmp.json().error?.message ?? ''));

// Der Weg zurück bleibt offen: Passwortwechsel, Login, Lizenz-Upload.
const newPassword = 'Neues-Kennwort-0815!';
const pw = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: auth, payload: { currentPassword: SMOKE_ADMIN_PASSWORD, newPassword } });
check('Nur-Lese: Passwortwechsel bleibt möglich', pw.statusCode === 200, pw.json());
const relogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@ohrganize.de', password: newPassword } });
check('Nur-Lese: Login bleibt möglich, Lizenz reist mit', relogin.statusCode === 200 && relogin.json().license?.state === 'expired', relogin.json());
auth = { authorization: `Bearer ${relogin.json().token}` };

const renew = await put(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, 200) }));
check('Nur-Lese: Upload einer gültigen Lizenz → 200, valid', renew.statusCode === 200 && renew.json().license?.state === 'valid', renew.json());
const writeAgain = await createEmp(6);
check('Nach Verlängerung wieder schreibbar', writeAgain.statusCode === 201, writeAgain.json());

// -------------------------------------------- Keine zweite Testphase --
writeLicenseFile(null);
const noFile = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Datei gelöscht nach Lizenz → expired, NICHT trial', noFile.json().license?.state === 'expired' && noFile.json().license?.invalid_reason === null, noFile.json().license);

// ------------------------------------------------- Unbrauchbare Datei --
writeLicenseFile('OHRG1.kaputt.kaputt');
const broken = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Unbrauchbare Datei → expired mit invalid_reason', broken.json().license?.state === 'expired' && typeof broken.json().license?.invalid_reason === 'string', broken.json().license);

// ------------------------------------------------- Uhren-Stolperdraht --
writeLicenseFile(makeLicense({ installation_id: installationId, valid_until: addDaysIso(today, 200) }));
getDb().prepare('UPDATE installation SET last_seen_date = ? WHERE id = 1').run(addDaysIso(today, 5));
invalidateLicenseCaches();
const clock = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Uhr hinter gesehenem Datum → clock_warning, aber KEIN Riegel', clock.json().license?.clock_warning === true && clock.json().license?.read_only === false, clock.json().license);
getDb().prepare('UPDATE installation SET last_seen_date = ? WHERE id = 1').run(addDaysIso(today, 1));
invalidateLicenseCaches();
const clockTol = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Ein Tag Toleranz ohne Warnung', clockTol.json().license?.clock_warning === false, clockTol.json().license);

// --------------------------------------------------------- Portal-Sicht --
const portalUser = await app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { email: 'portal@smoke.de', name: 'Portal Person', role: 'mitarbeiter', employee_id: id1 } });
check('Portal-Konto angelegt', portalUser.statusCode === 201 || portalUser.statusCode === 200, portalUser.json());
const portalLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'portal@smoke.de', password: portalUser.json().initial_password } });
const portalLicense = portalLogin.json().license;
check('Portal sieht nur read_only, keine Vertragsdaten', portalLogin.statusCode === 200 && portalLicense && Object.keys(portalLicense).join() === 'read_only', portalLicense);
const portalStatus = await app.inject({ method: 'GET', url: '/api/license', headers: { authorization: `Bearer ${portalLogin.json().token}` } });
check('Portal-Konto erreicht /api/license nicht (403)', portalStatus.statusCode === 403, portalStatus.statusCode);
const portalAuth = { authorization: `Bearer ${portalLogin.json().token}` };
const portalHdr = await app.inject({ method: 'GET', url: '/api/me/profile', headers: portalAuth });
check('Portal-Header nennt nur valid/expired', ['valid', 'expired'].includes(String(portalHdr.headers[LICENSE_STATE_HEADER])), portalHdr.headers[LICENSE_STATE_HEADER]);
const publicHdr = await app.inject({ method: 'GET', url: '/api/health' });
check('Öffentliche Antwort trägt keinen Lizenz-Header', publicHdr.headers[LICENSE_STATE_HEADER] === undefined, publicHdr.headers[LICENSE_STATE_HEADER]);

// Testphase → abgelaufen: Datei weg, nie lizenziert, Anlage 40 Tage her.
writeLicenseFile(null);
getDb().prepare("UPDATE installation SET licensed_at = NULL, created_at = datetime('now', '-40 days') WHERE id = 1").run();
invalidateLicenseCaches();
const trialOver = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Testphase vorbei → expired, read_only', trialOver.json().license?.state === 'expired' && trialOver.json().license?.read_only === true && trialOver.json().license?.license_id === null, trialOver.json().license);
const trialMsg = await createEmp(9);
check('Meldung nennt die Testphase', trialMsg.statusCode === 403 && /Testphase/.test(trialMsg.json().error?.message ?? ''), trialMsg.json());
// Wechselzwang des neuen Portal-Kontos zuerst erfüllen (der greift vor dem Lizenz-Gate).
const portalPw = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: portalAuth, payload: { currentPassword: portalUser.json().initial_password, newPassword: 'Wiesenblume-Kranich-4471!' } });
check('Portal: Passwortwechsel im Nur-Lese-Betrieb möglich', portalPw.statusCode === 200, portalPw.json());
const portalLogin2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'portal@smoke.de', password: 'Wiesenblume-Kranich-4471!' } });
const portalAuth2 = { authorization: `Bearer ${portalLogin2.json().token}` };
const portalWrite = await app.inject({ method: 'POST', url: '/api/me/change-requests', headers: portalAuth2, payload: {} });
check('Portal-Konto bekommt neutrale Meldung ohne Datum', portalWrite.statusCode === 403 && /Personalabteilung/.test(portalWrite.json().error?.message ?? '') && !/\d{2}\.\d{2}\.\d{4}/.test(portalWrite.json().error?.message ?? ''), portalWrite.json());

await app.close();
closeDb();
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  // Windows hält WAL-Dateien gelegentlich noch kurz — Tempdir-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Lizenz-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Lizenz-Checks bestanden.');
