/**
 * Smoke-Test Abwesenheitsmanagement gegen eine Wegwerf-Datenbank.
 * Aufruf: npx tsx apps/backend/src/modules/absences/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-absences-'));
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

const { buildServer } = await import('../../server.js');
const { getDb, closeDb } = await import('../../db/db.js');
const { firstAdminLogin } = await import('../../test/adminSession.js');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();

// Testdaten direkt in die Wegwerf-DB (Kerntabellen gehören dem Personal-Modul,
// dessen API hier nicht vorausgesetzt wird).
const db = getDb();
db.prepare("INSERT INTO locations (name, bundesland) VALUES ('München', 'BY')").run();
db.prepare("INSERT INTO departments (name) VALUES ('Technik')").run();
db.prepare('INSERT INTO teams (name, department_id) VALUES (?, ?)').run('Backend', 1);
const insertEmp = db.prepare(
  `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id, team_id)
   VALUES (?, ?, 'aktiv', ?, ?, ?, ?, ?)`,
);
insertEmp.run('Anna', 'Adler', '2020-01-01', 30, 1, 1, 1); // id 1
insertEmp.run('Ben', 'Berg', '2021-03-01', 28, null, 1, 1); // id 2, kein Standort → Fallback BY
insertEmp.run('Clara', 'Curie', '2026-07-01', 24, 1, 1, null); // id 3, Eintritt Mitte 2026

const { token, auth } = await firstAdminLogin(app, check);
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: auth, payload });

// ------------------------------------------------------------------- Arten ---
const types = await get('/api/absences/types');
const typeList = types.json().types as { id: number; name: string; category: string }[];
// 11 aus dem Ursprungs-Seed + 'Home Office' aus 201_absence_type_eligibility.
check('12 Standardarten geseedet', types.statusCode === 200 && typeList.length === 12, typeList);
const urlaubType = typeList.find((t) => t.name === 'Urlaub')!;
const bildungType = typeList.find((t) => t.name === 'Bildungsurlaub')!;
check('Urlaub & Bildungsurlaub vorhanden', !!urlaubType && !!bildungType);
const krankheitType = typeList.find((t) => t.category === 'krankheit')!;

// Freigegebene Arten je Person (HR-Erfassung filtert damit die Auswahl).
const allowedAll = await get('/api/absences/types/allowed?employee_id=1');
check(
  'Freigegebene Arten ohne Regeln = alle Arten',
  allowedAll.statusCode === 200 && allowedAll.json().type_ids.length === typeList.length,
  allowedAll.json(),
);
const allowedNoEmp = await get('/api/absences/types/allowed');
check('Freigegebene Arten ohne employee_id → 400', allowedNoEmp.statusCode === 400);
const allowedUnknown = await get('/api/absences/types/allowed?employee_id=999');
check('Freigegebene Arten fuer unbekannte Person → 404', allowedUnknown.statusCode === 404);
db.prepare("INSERT INTO absence_type_employee_rules (type_id, employee_id, effect) VALUES (?, 1, 'deny')").run(
  bildungType.id,
);
const allowedDeny = await get('/api/absences/types/allowed?employee_id=1');
check(
  'deny-Regel nimmt die Art aus der Liste',
  !allowedDeny.json().type_ids.includes(bildungType.id) && allowedDeny.json().type_ids.includes(urlaubType.id),
  allowedDeny.json(),
);
const deniedRequest = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: bildungType.id,
  date_from: '2026-03-02',
  date_to: '2026-03-03',
});
check(
  'HR-Erfassung einer gesperrten Art → 403 mit Namen der Person',
  deniedRequest.statusCode === 403 && /Anna Adler/.test(deniedRequest.json().error.message),
  deniedRequest.json(),
);
db.prepare('DELETE FROM absence_type_employee_rules WHERE type_id = ?').run(bildungType.id);

const sickAsRequest = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: krankheitType.id,
  date_from: '2026-03-02',
  date_to: '2026-03-03',
});
check('Kategorie krankheit als Antrag → 400 (Krankmeldung nutzen)', sickAsRequest.statusCode === 400, sickAsRequest.json());

const badType = await post('/api/absences/types', {
  name: 'X',
  category: 'urlaub',
  paid: true,
  affects_balance: true,
  requires_proof: false,
  requires_approval: true,
  color: 'rot',
});
check('Art mit ungültiger Farbe → 400', badType.statusCode === 400, badType.json());

const newType = await post('/api/absences/types', {
  name: 'Gleittag',
  category: 'sonder',
  paid: true,
  affects_balance: false,
  requires_proof: false,
  requires_approval: true,
  color: '#22AA88',
  max_days_per_year: 12,
});
check('Art anlegen → 201', newType.statusCode === 201, newType.json());
const newTypeId = newType.json().type.id as number;

const updType = await app.inject({
  method: 'PUT',
  url: `/api/absences/types/${newTypeId}`,
  headers: auth,
  payload: {
    name: 'Gleittag',
    category: 'sonder',
    paid: false,
    affects_balance: false,
    requires_proof: false,
    requires_approval: true,
    color: '#118866',
    max_days_per_year: 10,
  },
});
check('Art bearbeiten', updType.statusCode === 200 && updType.json().type.color === '#118866');

const delUnused = await app.inject({ method: 'DELETE', url: `/api/absences/types/${newTypeId}`, headers: auth });
check('Unbenutzte Art löschen → 204', delUnused.statusCode === 204);

// ---------------------------------------------------------------- Vorschau ---
// KW 18/2026: Mo 27.04.–Fr 01.05.; 01.05. ist bundesweiter Feiertag → 4 Tage.
const preview = await get(
  '/api/absences/preview?employee_id=1&date_from=2026-04-27&date_to=2026-05-01',
);
check('Vorschau: 5 Werktage minus 1 Feiertag = 4', preview.json().days_counted === 4, preview.json());
const previewHalf = await get(
  '/api/absences/preview?employee_id=1&date_from=2026-04-27&date_to=2026-05-01&half_day_start=1',
);
check('Vorschau mit halbem Starttag = 3.5', previewHalf.json().days_counted === 3.5, previewHalf.json());

// ------------------------------------ Betriebsruhe deckt Antrag ganz ab ---
{
  const inside = await post('/api/absences/requests', { employee_id: 2, type_id: 1, date_from: '2026-11-09', date_to: '2026-11-10' });
  const insideId = inside.json().request?.id as number;
  // Sa 07.11. bis Di 10.11.: schliesst ein Wochenende ein (Krankmeldung unten).
  const cover = await post('/api/absences/closures', { name: 'Inventur', date_from: '2026-11-07', date_to: '2026-11-10' });
  const row = db.prepare('SELECT status, days_counted FROM absence_requests WHERE id = ?').get(insideId) as
    | { status: string; days_counted: number }
    | undefined;
  check('Antrag vollstaendig in Betriebsruhe: 0 Tage, Status bleibt', inside.statusCode === 201 && cover.statusCode === 201 && row?.status === 'beantragt' && row.days_counted === 0, { inside: inside.json(), row });
  const listed = (await get('/api/absences/requests?employee_id=2')).json().requests as { id: number; closure_covered: number }[];
  check('Liste kennzeichnet den Antrag als Betriebsruhe', listed.find((r) => r.id === insideId)?.closure_covered === 1, listed);
  // Krankmeldungen bleiben auch vollstaendig in einer Betriebsruhe erfassbar
  // (AU-Frist und Entgeltfortzahlung haengen am Kalender).
  const sickInside = await post('/api/absences/sick-notes', { employee_id: 3, date_from: '2026-11-09', date_to: '2026-11-10' });
  const sickNote = sickInside.json().sick_note as { id: number; absence_request_id: number; days_counted: number; closure_covered: number } | undefined;
  check('Krankmeldung in Betriebsruhe → 201 mit 0 Tagen', sickInside.statusCode === 201 && sickNote?.days_counted === 0 && sickNote.closure_covered === 1, sickInside.json());
  // Wochenende innerhalb der Betriebsruhe: die 0 kommt vom Wochenende, nicht
  // von der Betriebsruhe, also keine Kennzeichnung.
  const sickWeekend = await post('/api/absences/sick-notes', { employee_id: 3, date_from: '2026-11-07', date_to: '2026-11-08' });
  const weekendNote = sickWeekend.json().sick_note as { id: number; absence_request_id: number; days_counted: number; closure_covered: number } | undefined;
  check('Krankmeldung nur am Wochenende in Betriebsruhe: 0 Tage ohne Kennzeichnung', sickWeekend.statusCode === 201 && weekendNote?.days_counted === 0 && weekendNote.closure_covered === 0, sickWeekend.json());
  for (const note of [sickNote, weekendNote]) {
    if (!note) continue;
    db.prepare('DELETE FROM sick_notes WHERE id = ?').run(note.id);
    db.prepare('DELETE FROM absence_requests WHERE id = ?').run(note.absence_request_id);
  }
  const vacationInside = await post('/api/absences/requests', { employee_id: 3, type_id: 1, date_from: '2026-11-09', date_to: '2026-11-10' });
  check(
    'Urlaub nur in Betriebsruhe bleibt abgewiesen → 400 (keine zu zaehlenden Tage)',
    vacationInside.statusCode === 400 && /keine zu zählenden Arbeitstage/.test(vacationInside.json().error?.message ?? ''),
    vacationInside.json(),
  );
  // Zurueckgezogen, solange er 0 Tage hatte: Die Historie bekommt ihre Tage
  // beim Loeschen der Betriebsruhe trotzdem zurueck.
  await post(`/api/absences/requests/${insideId}/cancel`, {});
  await app.inject({ method: 'DELETE', url: `/api/absences/closures/${cover.json().closure.id}`, headers: auth });
  const back = db.prepare('SELECT status, days_counted FROM absence_requests WHERE id = ?').get(insideId) as
    | { status: string; days_counted: number }
    | undefined;
  check('Betriebsruhe geloescht: Tage auch fuer stornierten Antrag zurueckgerechnet', back?.status === 'storniert' && back.days_counted === 2, back);
}

// Abgeschlossene Entscheidungen: Eine nachtraeglich angelegte Betriebsruhe
// schreibt die Tageszahl eines stornierten Antrags nicht um.
{
  const closed = await post('/api/absences/requests', { employee_id: 2, type_id: 1, date_from: '2026-11-16', date_to: '2026-11-18' });
  const closedId = closed.json().request?.id as number;
  await post(`/api/absences/requests/${closedId}/cancel`, {});
  const late = await post('/api/absences/closures', { name: 'Nachtrag', date_from: '2026-11-17', date_to: '2026-11-17' });
  const after = db.prepare('SELECT status, days_counted FROM absence_requests WHERE id = ?').get(closedId) as
    | { status: string; days_counted: number }
    | undefined;
  check(
    'Stornierter Antrag behaelt seine Tage bei nachtraeglicher Betriebsruhe',
    closed.statusCode === 201 && late.statusCode === 201 && late.json().recounted_requests === 0 && after?.status === 'storniert' && after.days_counted === 3,
    { after, late: late.json() },
  );
  await app.inject({ method: 'DELETE', url: `/api/absences/closures/${late.json().closure.id}`, headers: auth });
}

// ----------------------------------------------------------- Betriebsruhe ---
const closure = await post('/api/absences/closures', {
  name: 'Zwischen den Jahren',
  date_from: '2026-12-24',
  date_to: '2026-12-31',
});
check('Betriebsruhe anlegen → 201', closure.statusCode === 201, closure.json());
const badClosure = await post('/api/absences/closures', {
  name: 'Falsch',
  date_from: '2026-12-31',
  date_to: '2026-12-24',
});
check('Betriebsruhe mit Ende vor Beginn → 400', badClosure.statusCode === 400);

// ----------------------------------------------------------------- Anträge ---
const r1 = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-04-27',
  date_to: '2026-05-01',
});
check(
  'Urlaubsantrag → 201, beantragt, 4 Tage',
  r1.statusCode === 201 && r1.json().request.status === 'beantragt' && r1.json().request.days_counted === 4,
  r1.json(),
);
const r1Id = r1.json().request.id as number;
check(
  'HR-Erfassung traegt die anlegende Person (created_by_proxy 1)',
  r1.json().request.created_by_proxy === 1 && typeof r1.json().request.created_by_name === 'string',
  r1.json().request,
);

// Nachtraegliche Erfassung: approve genehmigt sofort, aber nie die eigene Abwesenheit.
const direct = await post('/api/absences/requests', {
  employee_id: 2,
  type_id: urlaubType.id,
  date_from: '2026-03-02',
  date_to: '2026-03-03',
  approve: true,
});
check(
  'Erfassung mit approve → 201, sofort genehmigt, decided_by gesetzt',
  direct.statusCode === 201 &&
    direct.json().request.status === 'genehmigt' &&
    direct.json().request.decided_by_user_id !== null &&
    direct.json().request.decided_at !== null,
  direct.json(),
);
const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@ohrganize.de'").get() as { id: number };
db.prepare('UPDATE users SET employee_id = 3 WHERE id = ?').run(adminUser.id);
const ownDirect = await post('/api/absences/requests', {
  employee_id: 3,
  type_id: urlaubType.id,
  date_from: '2026-08-03',
  date_to: '2026-08-04',
  approve: true,
});
check('approve fuer die eigene Abwesenheit → 403', ownDirect.statusCode === 403, ownDirect.json());
const ownPending = await post('/api/absences/requests', {
  employee_id: 3,
  type_id: urlaubType.id,
  date_from: '2026-08-03',
  date_to: '2026-08-04',
});
check('eigene Abwesenheit ohne approve → 201 beantragt', ownPending.statusCode === 201 && ownPending.json().request.status === 'beantragt', ownPending.json());
check('eigene Erfassung gilt nicht als stellvertretend (created_by_proxy 0)', ownPending.json().request.created_by_proxy === 0, ownPending.json().request);
db.prepare('UPDATE users SET employee_id = NULL WHERE id = ?').run(adminUser.id);
// Aufraeumen, damit die Salden- und Ueberschneidungspruefungen weiter unten
// von einer leeren Ausgangslage ausgehen koennen.
for (const id of [direct.json().request.id, ownPending.json().request.id] as number[]) {
  const cancelled = await post(`/api/absences/requests/${id}/cancel`);
  check(`Testantrag ${id} storniert`, cancelled.statusCode === 200 && cancelled.json().request.status === 'storniert', cancelled.json());
}

const badRange = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-06-10',
  date_to: '2026-06-01',
});
check('Antrag mit Ende vor Beginn → 400', badRange.statusCode === 400, badRange.json());

const overlap = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-04-29',
  date_to: '2026-05-04',
});
check('Überlappender Antrag → 409', overlap.statusCode === 409, overlap.json());

const weekendOnly = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-08-01',
  date_to: '2026-08-02',
});
check('Antrag nur am Wochenende → 400', weekendOnly.statusCode === 400, weekendOnly.json());

const approve1 = await post(`/api/absences/requests/${r1Id}/approve`);
check('Genehmigen', approve1.statusCode === 200 && approve1.json().request.status === 'genehmigt');
const approveAgain = await post(`/api/absences/requests/${r1Id}/approve`);
check('Bereits genehmigten Antrag erneut genehmigen → 409', approveAgain.statusCode === 409);

// Dez-Antrag: Mo 21.–Do 31.12.; Betriebsruhe ab 24.12., Feiertage 25./26.12. → 3 Tage.
const r2 = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-12-21',
  date_to: '2026-12-31',
});
check('Dez-Antrag zählt Betriebsruhe/Feiertage nicht mit (3 Tage)', r2.json().request.days_counted === 3, r2.json());
const r2Id = r2.json().request.id as number;
await post(`/api/absences/requests/${r2Id}/approve`);

// Betriebsruhe loeschen und neu anlegen: days_counted der ueberlappenden
// Antraege folgt dem Kalender (ohne Betriebsruhe 8 Tage, mit ihr wieder 3).
const closureId = closure.json().closure.id as number;
const delClosure = await app.inject({ method: 'DELETE', url: `/api/absences/closures/${closureId}`, headers: auth });
const r2AfterDelete = (await get(`/api/absences/requests?employee_id=1`)).json().requests.find(
  (r: { id: number }) => r.id === r2Id,
);
check(
  'Betriebsruhe geloescht → Dez-Antrag neu gezaehlt (8 Tage)',
  delClosure.statusCode === 204 && r2AfterDelete.days_counted === 8,
  r2AfterDelete,
);
const closureAgain = await post('/api/absences/closures', {
  name: 'Zwischen den Jahren',
  date_from: '2026-12-24',
  date_to: '2026-12-31',
});
const r2AfterCreate = (await get(`/api/absences/requests?employee_id=1`)).json().requests.find(
  (r: { id: number }) => r.id === r2Id,
);
check(
  'Betriebsruhe angelegt → Dez-Antrag neu gezaehlt (3 Tage), recounted_requests 1',
  closureAgain.statusCode === 201 && closureAgain.json().recounted_requests === 1 && r2AfterCreate.days_counted === 3,
  { closure: closureAgain.json(), request: r2AfterCreate },
);

const r3 = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-08-10',
  date_to: '2026-08-11',
});
const r3Id = r3.json().request.id as number;
const rejectNoReason = await post(`/api/absences/requests/${r3Id}/reject`, {});
check('Ablehnen ohne Begründung → 400', rejectNoReason.statusCode === 400);
const reject3 = await post(`/api/absences/requests/${r3Id}/reject`, { reason: 'Projektabschluss, bitte verschieben' });
check('Ablehnen mit Begründung', reject3.statusCode === 200 && reject3.json().request.status === 'abgelehnt');

const r4 = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: urlaubType.id,
  date_from: '2026-09-14',
  date_to: '2026-09-15',
});
const cancel4 = await post(`/api/absences/requests/${r4.json().request.id}/cancel`);
check('Stornieren', cancel4.statusCode === 200 && cancel4.json().request.status === 'storniert');

// Jahresobergrenze: Bildungsurlaub max. 5 Tage.
const bu1 = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: bildungType.id,
  date_from: '2026-08-03',
  date_to: '2026-08-07',
});
check('Bildungsurlaub 5 Tage ok', bu1.statusCode === 201 && bu1.json().request.days_counted === 5, bu1.json());
const bu2 = await post('/api/absences/requests', {
  employee_id: 1,
  type_id: bildungType.id,
  date_from: '2026-09-07',
  date_to: '2026-09-08',
});
check('Bildungsurlaub über Jahresobergrenze → 409', bu2.statusCode === 409, bu2.json());

const delUsed = await app.inject({ method: 'DELETE', url: `/api/absences/types/${urlaubType.id}`, headers: auth });
check('Benutzte Art löschen → 409 mit Hinweis', delUsed.statusCode === 409 && /deaktivieren/i.test(delUsed.json().error.message), delUsed.json());

// ------------------------------------------------------------------- Saldo ---
const bal = await get('/api/absences/balance/1/2026');
const b = bal.json().balance;
check('Saldo: Anspruch 30 (volles Jahr)', b.entitlement === 30, b);
check('Saldo: genommen+verplant = 7 (nur saldowirksam, ohne abgelehnt/storniert)', b.taken + b.planned === 7, b);
check('Saldo: Rest konsistent', b.remaining === b.entitlement + b.carryover - b.taken - b.planned, b);

// Aufschlüsselung (Personalakte): Zeitabschnitte "genommen" (bis heute) und
// "verplant" (ab morgen bzw. beantragt), deren Tagessummen exakt die Kacheln ergeben.
type Segment = { status: string; kind: 'taken' | 'planned'; date_from: string; date_to: string; days: number };
const bd = b.breakdown as { taken_until: string | null; segments: Segment[] } | undefined;
check(
  'Saldo: Aufschlüsselung nennt nur genehmigte/beantragte Abschnitte',
  !!bd && bd.segments.length > 0 && bd.segments.every((s) => s.status === 'genehmigt' || s.status === 'beantragt'),
  bd,
);
check(
  'Saldo: Tagessummen der Abschnitte = Kacheln',
  !!bd &&
    bd.segments.filter((s) => s.kind === 'taken').reduce((sum, s) => sum + s.days, 0) === b.taken &&
    bd.segments.filter((s) => s.kind === 'planned').reduce((sum, s) => sum + s.days, 0) === b.planned,
  bd,
);
check(
  'Saldo: genommene Abschnitte enden spätestens am Stichtag, verplante beginnen danach',
  !!bd &&
    bd.segments.every((s) =>
      s.kind === 'taken'
        ? bd.taken_until !== null && s.date_to <= bd.taken_until
        : s.status === 'beantragt' || bd.taken_until === null || s.date_from > bd.taken_until,
    ),
  bd,
);
check('Saldo: Abschnitte liegen im Jahr und sind sortiert', !!bd && bd.segments.every((s, i) => s.date_from >= '2026-01-01' && s.date_to <= '2026-12-31' && (i === 0 || bd.segments[i - 1].date_from <= s.date_from)), bd);

const balClara = await get('/api/absences/balance/3/2026');
// § 5 BUrlG: Eintritt am 01.07. erfuellt die Wartezeit am 31.12., der gesetzliche
// Teil (20 bei fuenf Tagen) steht voll zu; nur der vertragliche Mehrurlaub
// (4) wird gezwoelftelt: 20 + 2 = 22.
check(
  'Saldo: Eintritt 01.07. → gesetzlich 20 voll, vertraglich 6/12 von 4 = 2',
  balClara.json().balance.entitlement === 22 &&
    balClara.json().balance.entitlement_detail?.statutory === 20 &&
    balClara.json().balance.entitlement_detail?.contractual === 2,
  balClara.json(),
);
check('Saldo: Aufschlüsselung ohne Anträge ist leer', balClara.json().balance.breakdown?.segments.length === 0, balClara.json());

const balances = await get('/api/absences/balances/2026');
check('Saldenübersicht: 3 aktive MA', balances.json().balances.length === 3, balances.json());
check(
  'Saldenübersicht ohne Aufschlüsselung',
  balances.json().balances.every((x: { breakdown?: unknown }) => x.breakdown === undefined),
);

// ---------------------------------------------------------- Krankmeldungen ---
const sick1 = await post('/api/absences/sick-notes', {
  employee_id: 2,
  date_from: '2026-06-01',
  date_to: '2026-06-03',
});
const s1 = sick1.json().sick_note;
check(
  'Krankmeldung → 201, auto-genehmigt, AU-Frist 3. Kalendertag',
  sick1.statusCode === 201 && s1.request_status === 'genehmigt' && s1.certificate_due_date === '2026-06-03',
  sick1.json(),
);
const missing = await get('/api/absences/sick-notes/missing');
check(
  'Fehlende Bescheinigung wird gelistet',
  missing.json().sick_notes.some((n: { id: number }) => n.id === s1.id),
  missing.json(),
);

const followUp = await post('/api/absences/sick-notes', {
  employee_id: 2,
  date_from: '2026-06-04',
  date_to: '2026-06-05',
  follow_up_of_id: s1.id,
});
check('Folgebescheinigung verknüpft', followUp.statusCode === 201 && followUp.json().sick_note.follow_up_of_id === s1.id);
const badFollowUp = await post('/api/absences/sick-notes', {
  employee_id: 2,
  date_from: '2026-06-08',
  date_to: '2026-06-09',
  follow_up_of_id: 9999,
});
check('Folgebescheinigung auf unbekannte AU → 400', badFollowUp.statusCode === 400);

const childSick = await post('/api/absences/sick-notes', {
  employee_id: 1,
  date_from: '2026-06-15',
  date_to: '2026-06-16',
  child_sick: true,
});
check('Kind krank → eigene Art', childSick.statusCode === 201 && childSick.json().sick_note.child_sick === 1);
const childList = await get('/api/absences/sick-notes?child_sick=1');
check('Kind-krank-Filter', childList.json().sick_notes.every((n: { child_sick: number }) => n.child_sick === 1) && childList.json().sick_notes.length === 1);

const sickOverlap = await post('/api/absences/sick-notes', {
  employee_id: 2,
  date_from: '2026-06-02',
  date_to: '2026-06-04',
});
check('Überlappende Krankmeldung → 409', sickOverlap.statusCode === 409);

// Dashboard: nur, wer an einem Tag krank ist, und heute Abwesende mit Rückkehrtag.
const activeOn = (await get('/api/absences/sick-notes?active_on=2026-06-02')).json().sick_notes as { id: number }[];
check(
  'active_on: nur Krankmeldungen, die den Tag einschliessen',
  activeOn.some((n) => n.id === s1.id) && !activeOn.some((n) => n.id === childSick.json().sick_note.id),
  activeOn,
);

// Bereits fehlende Tage + Entgeltfortzahlung (Anreicherung der Liste).
const enrichedList = await get('/api/absences/sick-notes');
const enriched = enrichedList.json().sick_notes as {
  id: number;
  days_absent_so_far: number;
  sick_pay_days_used: number;
  sick_pay_exceeded: boolean;
}[];
const e1 = enriched.find((n) => n.id === s1.id)!;
check(
  'Krankmeldung 01.–03.06. (Mo–Mi): 3 bereits fehlende Arbeitstage',
  e1.days_absent_so_far === 3,
  e1,
);
check(
  'AU-Kette (Erst- + Folgebescheinigung 01.–05.06.): 5 Kalendertage Entgeltfortzahlung, nicht überzogen',
  e1.sick_pay_days_used === 5 && e1.sick_pay_exceeded === false,
  e1,
);
// Langzeiterkrankung > 42 Kalendertage → Überzogen-Warnung.
const longSick = await post('/api/absences/sick-notes', {
  employee_id: 3,
  date_from: '2026-01-05',
  date_to: '2026-02-27',
});
check('Langzeit-Krankmeldung → 201', longSick.statusCode === 201, longSick.json());
const enriched2 = await get('/api/absences/sick-notes');
const eLong = (enriched2.json().sick_notes as typeof enriched).find(
  (n) => n.id === longSick.json().sick_note.id,
)!;
check(
  'Langzeiterkrankung (54 Kalendertage) → Entgeltfortzahlung überzogen',
  eLong.sick_pay_days_used === 54 && eLong.sick_pay_exceeded === true,
  eLong,
);
// HR-Erfassung ohne Angabe verkettet die nahtlose Fortsetzung wie das Portal
// (seamlessPredecessorSickNoteId); ausdrücklich null bleibt Erstbescheinigung,
// eine andere Art (Kind krank) setzt keine Kette fort.
{
  const first = await post('/api/absences/sick-notes', { employee_id: 2, date_from: '2026-09-07', date_to: '2026-09-08' });
  const seamless = await post('/api/absences/sick-notes', { employee_id: 2, date_from: '2026-09-09', date_to: '2026-09-10' });
  const explicitNone = await post('/api/absences/sick-notes', {
    employee_id: 2,
    date_from: '2026-09-11',
    date_to: '2026-09-11',
    follow_up_of_id: null,
  });
  const otherKind = await post('/api/absences/sick-notes', {
    employee_id: 2,
    date_from: '2026-09-12',
    date_to: '2026-09-12',
    child_sick: true,
  });
  check(
    'HR-Krankmeldung ohne Angabe: nahtlose Fortsetzung wird Folgebescheinigung',
    first.statusCode === 201 && seamless.statusCode === 201 && seamless.json().sick_note.follow_up_of_id === first.json().sick_note.id,
    seamless.json(),
  );
  check(
    'HR-Krankmeldung mit follow_up_of_id null bleibt Erstbescheinigung, andere Art verkettet nicht',
    explicitNone.statusCode === 201 &&
      explicitNone.json().sick_note.follow_up_of_id === null &&
      otherKind.statusCode === 201 &&
      otherKind.json().sick_note.follow_up_of_id === null,
    { explicitNone: explicitNone.json(), otherKind: otherKind.json() },
  );
}

// ---------------------------------------------------------------- Kalender ---
// Ben ebenfalls 21. bis 25.12. im Urlaub → Team "Backend" (2 Mitglieder) zu 100 % abwesend;
// 24.12. ist Betriebsruhe, 25.12. Feiertag: an beiden Tagen fehlt niemand dem Team.
const rBen = await post('/api/absences/requests', {
  employee_id: 2,
  type_id: urlaubType.id,
  date_from: '2026-12-21',
  date_to: '2026-12-25',
});
await post(`/api/absences/requests/${rBen.json().request.id}/approve`);

const cal = await get('/api/absences/calendar?year=2026&month=12');
const calJson = cal.json();
check('Kalender: 3 aktive MA', cal.statusCode === 200 && calJson.employees.length === 3, calJson.employees?.length);
const annaCal = calJson.employees.find((e: { id: number }) => e.id === 1);
check('Kalender: Annas Dez-Urlaub enthalten', annaCal.absences.some((a: { date_from: string }) => a.date_from === '2026-12-21'));
check('Kalender: Feiertage BY enthalten Weihnachten', calJson.holidays.BY?.some((h: { date: string }) => h.date === '2026-12-25'), calJson.holidays);
check('Kalender: Betriebsruhe enthalten', calJson.closures.length === 1);
check(
  'Kalender: Konflikt am 21.12. (Team komplett abwesend)',
  calJson.conflicts.some((c: { date: string; ratio: number }) => c.date === '2026-12-21' && c.ratio > 0.5),
  calJson.conflicts,
);
check(
  'Kalender: kein Konflikt an Betriebsruhe (24.12.) und Feiertag (25.12.)',
  !calJson.conflicts.some((c: { date: string }) => c.date === '2026-12-24' || c.date === '2026-12-25'),
  calJson.conflicts,
);

const calYear = await get('/api/absences/calendar?year=2026');
check('Jahreskalender liefert Gesamtzeitraum', calYear.json().range.from === '2026-01-01' && calYear.json().range.to === '2026-12-31');

const calFiltered = await get('/api/absences/calendar?year=2026&month=12&team_id=1');
check('Kalender-Teamfilter', calFiltered.json().employees.length === 2);

// ------------------------------------------- Krankmeldungen: Filter, Zählung ---
{
  const all = (await get('/api/absences/sick-notes')).json().sick_notes as { id: number; employee_id: number }[];
  const ofBen = (await get('/api/absences/sick-notes?employee_id=2')).json().sick_notes as typeof all;
  check(
    'Krankmeldungen: employee_id liefert genau die Meldungen der Person',
    ofBen.length > 0 && ofBen.length === all.filter((n) => n.employee_id === 2).length && ofBen.every((n) => n.employee_id === 2),
    ofBen,
  );
  const of2025 = (await get('/api/absences/sick-notes?year=2025')).json().sick_notes as typeof all;
  const of2026 = (await get('/api/absences/sick-notes?year=2026')).json().sick_notes as typeof all;
  check('Krankmeldungen: Jahresfilter (alle Testdaten liegen 2026)', of2025.length === 0 && of2026.length === all.length, { of2025, of2026: of2026.length });

  // Betriebsruhe einmal für alle Zeilen geladen: days_absent_so_far muss der
  // Zählung je Zeile mit eigener Abfrage (countAbsenceDays ohne closures)
  // gleichen. Zwei vergangene Betriebsruhen in zwei Krankmeldungen.
  const { countAbsenceDays, regionForEmployee } = await import('./service.js');
  const { todayIso } = await import('../../core/dates.js');
  const c1 = await post('/api/absences/closures', { name: 'Brückentag', date_from: '2026-06-02', date_to: '2026-06-02' });
  const c2 = await post('/api/absences/closures', { name: 'Umzug', date_from: '2026-02-02', date_to: '2026-02-03' });
  const notes = (await get('/api/absences/sick-notes')).json().sick_notes as {
    id: number;
    employee_id: number;
    date_from: string;
    date_to: string;
    days_absent_so_far: number;
  }[];
  const mismatches = notes.filter(
    (n) =>
      n.days_absent_so_far !==
      countAbsenceDays({ place: regionForEmployee(n.employee_id), dateFrom: n.date_from, dateTo: n.date_to, clipTo: todayIso() }),
  );
  check(
    'Krankmeldungen: Betriebsruhe einmal geladen zählt wie je Zeile',
    c1.statusCode === 201 && c2.statusCode === 201 && notes.length > 0 && mismatches.length === 0,
    mismatches,
  );
  check(
    'Krankmeldungen: Betriebsruhe wirkt (01. bis 03.06. mit Brückentag 02.06.: 2 Tage)',
    notes.find((n) => n.id === s1.id)?.days_absent_so_far === 2,
    notes.find((n) => n.id === s1.id),
  );
  for (const c of [c1, c2]) {
    await app.inject({ method: 'DELETE', url: `/api/absences/closures/${c.json().closure.id}`, headers: auth });
  }
}

// --------------------------------------------- Blättern (Alle Anträge) ---
// 520 Altanträge direkt in die DB, damit die Obergrenze von 500 je Seite
// greift. Ohne limit kommt weiterhin alles, ohne total.
{
  const insertOld = db.prepare(
    `INSERT INTO absence_requests (employee_id, type_id, date_from, date_to, days_counted, status)
     VALUES (?, ?, ?, ?, 1, 'genehmigt')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 520; i++) {
      const d = new Date(Date.UTC(2019, 0, 1 + i)).toISOString().slice(0, 10);
      insertOld.run(1 + (i % 3), urlaubType.id, d, d);
    }
  })();
  const ids = (rows: { id: number }[]) => rows.map((r) => r.id).join(',');
  const stored = (db.prepare('SELECT COUNT(*) AS n FROM absence_requests').get() as { n: number }).n;
  const full = (await get('/api/absences/requests')).json();
  const fullRows = full.requests as { id: number }[];
  check('Ohne limit: alle Anträge, ohne total', fullRows.length === stored && full.total === undefined, { rows: fullRows.length, stored });

  const p1 = (await get('/api/absences/requests?limit=2')).json();
  const p2 = (await get('/api/absences/requests?limit=2&offset=2')).json();
  check(
    'limit/offset: Seiten folgen der Sortierung lückenlos, total über alle Seiten',
    ids(p1.requests) === ids(fullRows.slice(0, 2)) &&
      ids(p2.requests) === ids(fullRows.slice(2, 4)) &&
      p1.total === stored &&
      p1.offset === 0 &&
      p2.offset === 2,
    { p1, p2 },
  );
  const capped = (await get('/api/absences/requests?limit=100000')).json();
  const rest = (await get('/api/absences/requests?limit=500&offset=500')).json();
  check(
    'limit höchstens 500, die nächste Seite liefert den Rest',
    capped.requests.length === 500 &&
      ids(capped.requests) === ids(fullRows.slice(0, 500)) &&
      ids(rest.requests) === ids(fullRows.slice(500)),
    { capped: capped.requests.length, rest: rest.requests.length },
  );

  const yearAll = (await get('/api/absences/requests?from=2019-01-01&to=2019-12-31')).json().requests as { id: number }[];
  const yearPage = (await get('/api/absences/requests?from=2019-01-01&to=2019-12-31&limit=100&offset=100')).json();
  check(
    'Jahresfilter geblättert: total wie ungeblättert, Seite 2 passt',
    yearAll.length === 365 && yearPage.total === yearAll.length && ids(yearPage.requests) === ids(yearAll.slice(100, 200)),
    { all: yearAll.length, total: yearPage.total },
  );

  // Absprung: Jeder Antrag liegt auf der Seite, die focus_id liefert, auch bei
  // gleichem Beginn (Dez-Anträge von Anna und Ben, Sortierung über die id).
  const misplaced: number[] = [];
  for (let i = 0; i < 40; i++) {
    const page = (await get(`/api/absences/requests?limit=3&focus_id=${fullRows[i].id}`)).json();
    if (page.offset !== Math.floor(i / 3) * 3 || !page.requests.some((r: { id: number }) => r.id === fullRows[i].id)) misplaced.push(i);
  }
  check('focus_id liefert die Seite des Antrags', misplaced.length === 0, misplaced);
  const unknownFocus = (await get('/api/absences/requests?limit=5&offset=10&focus_id=999999')).json();
  check('focus_id ausserhalb der Filter: offset bleibt', unknownFocus.offset === 10 && unknownFocus.requests.length === 5, unknownFocus.offset);

  const badLimit = await get('/api/absences/requests?limit=0');
  const textLimit = await get('/api/absences/requests?limit=viele');
  const badOffset = await get('/api/absences/requests?limit=5&offset=-1');
  check(
    'Ungültiges limit/offset → 400',
    badLimit.statusCode === 400 && textLimit.statusCode === 400 && badOffset.statusCode === 400,
    [badLimit.statusCode, textLimit.statusCode, badOffset.statusCode],
  );
}

// ------------------------------------ Audit in derselben Transaktion ---
// Ein TEMP-Trigger auf derselben Verbindung, über die auch die Routen
// schreiben, weist jeden Audit-Eintrag ab. Die Anfrage muss scheitern (5xx),
// und von der fachlichen Änderung darf nichts stehen bleiben.
{
  const { storeFile } = await import('../../core/files.js');
  const { config } = await import('../../config.js');
  async function withBrokenAudit<T>(fn: () => Promise<T>): Promise<T> {
    db.exec("CREATE TEMP TRIGGER audit_kaputt BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit kaputt'); END;");
    try {
      return await fn();
    } finally {
      db.exec('DROP TRIGGER IF EXISTS audit_kaputt');
    }
  }
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const requestRow = (id: number) =>
    db.prepare('SELECT status, decided_by_user_id, days_counted FROM absence_requests WHERE id = ?').get(id) as {
      status: string;
      decided_by_user_id: number | null;
      days_counted: number;
    };

  // Antrag genehmigen: Status und Entscheider bleiben, wie sie waren.
  const open = await post('/api/absences/requests', { employee_id: 2, type_id: urlaubType.id, date_from: '2026-10-19', date_to: '2026-10-20' });
  const openId = open.json().request?.id as number;
  const brokenApprove = await withBrokenAudit(() => post(`/api/absences/requests/${openId}/approve`, { override_balance: true }));
  check(
    'Audit kaputt: Genehmigung scheitert (5xx), Antrag bleibt beantragt',
    open.statusCode === 201 &&
      brokenApprove.statusCode >= 500 &&
      requestRow(openId).status === 'beantragt' &&
      requestRow(openId).decided_by_user_id === null,
    { open: open.json(), status: brokenApprove.statusCode, row: requestRow(openId) },
  );

  // Betriebsruhe: weder die Zeile noch die Neuberechnung des überlappten
  // Antrags (2 Tage, mit der Ruhe am 20.10. wären es 1) bleiben stehen.
  const closuresBefore = count('company_closures');
  const brokenClosure = await withBrokenAudit(() =>
    post('/api/absences/closures', { name: 'Audit-Probe', date_from: '2026-10-20', date_to: '2026-10-20' }),
  );
  check(
    'Audit kaputt: Betriebsruhe scheitert (5xx), keine Zeile, Zählung unverändert',
    brokenClosure.statusCode >= 500 && count('company_closures') === closuresBefore && requestRow(openId).days_counted === 2,
    { status: brokenClosure.statusCode, row: requestRow(openId) },
  );

  // Krankmeldung: createRequest auditiert selbst (Savepoint in der Route).
  // Auch der Antrag darunter darf nicht stehen bleiben.
  const requestsBefore = count('absence_requests');
  const sickBefore = count('sick_notes');
  const brokenSick = await withBrokenAudit(() =>
    post('/api/absences/sick-notes', { employee_id: 1, date_from: '2026-10-26', date_to: '2026-10-27' }),
  );
  check(
    'Audit kaputt: Krankmeldung scheitert (5xx), weder Antrag noch Krankmeldung gespeichert',
    brokenSick.statusCode >= 500 && count('absence_requests') === requestsBefore && count('sick_notes') === sickBefore,
    { status: brokenSick.statusCode },
  );

  // AU-Bescheinigung ersetzen: Die alte Datei räumt erst der Schritt nach
  // dem Commit weg. Scheitert das Audit, bleiben Verknüpfung, files-Zeile
  // UND Blob auf der Platte stehen.
  // Hochgeladen vom handelnden Konto wie ueber POST /api/files: Verknuepfen
  // verlangt Leserecht (assertMayLinkFiles), eine fremde, unverknuepfte Datei
  // gilt als fremder Upload.
  const uploaderId = (db.prepare("SELECT id FROM users WHERE email = 'admin@ohrganize.de'").get() as { id: number }).id;
  const oldCert = storeFile(Buffer.from('AU alt'), 'au-alt.pdf', 'application/pdf', uploaderId);
  const newCert = storeFile(Buffer.from('AU neu'), 'au-neu.pdf', 'application/pdf', uploaderId);
  const patchCert = (fileId: number) =>
    app.inject({ method: 'PATCH', url: `/api/absences/sick-notes/${s1.id}`, headers: auth, payload: { certificate_file_id: fileId } });
  const certOf = () =>
    (db.prepare('SELECT certificate_file_id FROM sick_notes WHERE id = ?').get(s1.id) as { certificate_file_id: number | null })
      .certificate_file_id;
  const blobOf = (storedName: string) => fs.existsSync(path.join(config.storageDir, storedName));
  const linked = await patchCert(oldCert.id);
  const brokenCert = await withBrokenAudit(() => patchCert(newCert.id));
  check(
    'Audit kaputt: Bescheinigung ersetzen scheitert (5xx), alte Datei samt Blob bleibt verknüpft',
    linked.statusCode === 200 &&
      brokenCert.statusCode >= 500 &&
      certOf() === oldCert.id &&
      !!db.prepare('SELECT id FROM files WHERE id = ?').get(oldCert.id) &&
      blobOf(oldCert.stored_name),
    { linked: linked.statusCode, status: brokenCert.statusCode, cert: certOf() },
  );

  // Gegenprobe ohne Trigger: alles gelingt, mit Eintrag und Aufräumen.
  const healedApprove = await post(`/api/absences/requests/${openId}/approve`, { override_balance: true });
  const healedCert = await patchCert(newCert.id);
  const certAudit = db
    .prepare("SELECT details FROM audit_log WHERE entity = 'sick_note' AND entity_id = ? ORDER BY id DESC LIMIT 1")
    .get(s1.id) as { details: string } | undefined;
  check(
    'Audit heil: Genehmigung und Ersetzen gelingen, alte Datei weg, Eintrag nennt sie',
    healedApprove.statusCode === 200 &&
      requestRow(openId).status === 'genehmigt' &&
      healedCert.statusCode === 200 &&
      certOf() === newCert.id &&
      !db.prepare('SELECT id FROM files WHERE id = ?').get(oldCert.id) &&
      !blobOf(oldCert.stored_name) &&
      JSON.parse(certAudit?.details ?? '{}').removed_file?.id === oldCert.id,
    { approve: healedApprove.statusCode, cert: healedCert.statusCode, audit: certAudit },
  );
}

// ------------------------------------------------- Heute abwesend (Dashboard) ---
// Eigene Person, damit der Test am realen Tag etwas findet: genehmigt heute,
// danach ein Arbeitstag Betriebsruhe und direkt anschliessend genehmigter
// Urlaub. Wieder da ist sie am ersten freien Arbeitstag danach.
{
  const { todayIso, addDaysIso, isWeekend } = await import('../../core/dates.js');
  const { isHoliday } = await import('../../core/holidays.js');
  const { closureDates } = await import('./service.js');
  const today = todayIso();
  const dora = Number(insertEmp.run('Dora', 'Dietrich', '2020-01-01', 30, 1, 1, null).lastInsertRowid);
  const nextFree = (after: string, skip: (d: string) => boolean = () => false) => {
    let d = addDaysIso(after, 1);
    const closures = closureDates(d, addDaysIso(d, 60));
    while (isWeekend(d) || isHoliday(d, 'DE', 'BY') || closures.has(d) || skip(d)) d = addDaysIso(d, 1);
    return d;
  };
  const insertReq = db.prepare(
    `INSERT INTO absence_requests (employee_id, type_id, date_from, date_to, days_counted, status)
     VALUES (?, ?, ?, ?, 1, ?)`,
  );
  const todayId = Number(insertReq.run(dora, urlaubType.id, today, today, 'genehmigt').lastInsertRowid);
  const shut = nextFree(today);
  const shutClosure = await post('/api/absences/closures', { name: 'Test heute', date_from: shut, date_to: shut });
  const vacation = nextFree(today);
  insertReq.run(dora, urlaubType.id, vacation, vacation, 'genehmigt');
  const expected = nextFree(vacation);
  const row = ((await get('/api/absences/today')).json().absences as { id: number; back_on: string }[]).find(
    (r) => r.id === todayId,
  );
  check(
    'Heute abwesend: back_on überspringt Betriebsruhe und anschließenden Urlaub',
    shutClosure.statusCode === 201 && vacation !== shut && row?.back_on === expected,
    { shut, vacation, expected, row },
  );

  // Halber Folgetag: Beginnt der anschliessende Urlaub mit einem halben Tag,
  // ist die Person an diesem Tag wieder da.
  const emil = Number(insertEmp.run('Emil', 'Ernst', '2020-01-01', 30, 1, 1, null).lastInsertRowid);
  const emilToday = Number(insertReq.run(emil, urlaubType.id, today, today, 'genehmigt').lastInsertRowid);
  const halfDay = nextFree(today);
  db.prepare(
    `INSERT INTO absence_requests (employee_id, type_id, date_from, date_to, days_counted, status, half_day_start)
     VALUES (?, ?, ?, ?, 0.5, 'genehmigt', 1)`,
  ).run(emil, urlaubType.id, halfDay, halfDay);
  const emilRow = ((await get('/api/absences/today')).json().absences as { id: number; back_on: string }[]).find(
    (r) => r.id === emilToday,
  );
  check('Heute abwesend: halber Folgetag zählt als wieder da', emilRow?.back_on === halfDay, { halfDay, emilRow });

  // Halber letzter Tag heute: heute wieder da, als halber Tag markiert.
  const frida = Number(insertEmp.run('Frida', 'Fuchs', '2020-01-01', 30, 1, 1, null).lastInsertRowid);
  const fridaId = Number(
    db.prepare(
      `INSERT INTO absence_requests (employee_id, type_id, date_from, date_to, days_counted, status, half_day_end)
       VALUES (?, ?, ?, ?, 1.5, 'genehmigt', 1)`,
    ).run(frida, urlaubType.id, addDaysIso(today, -1), today).lastInsertRowid,
  );
  const fridaRow = ((await get('/api/absences/today')).json().absences as {
    id: number; back_on: string; back_today: boolean; half_today: boolean;
  }[]).find((r) => r.id === fridaId);
  check(
    'Heute abwesend: halber letzter Tag heißt heute wieder da',
    fridaRow?.back_on === today && fridaRow.back_today === true && fridaRow.half_today === true,
    fridaRow,
  );
}

// ---------------------------------------------------------- Arbeitswoche ---
// Eigene Person, damit die Arbeitswoche keine der Pruefungen oben veraendert.
{
  const dora = Number(
    db
      .prepare(
        `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                employee_type, weekly_hours, iban, tax_class, social_security_number)
         VALUES ('Dora', 'Diehl', 'aktiv', '2020-01-01', 18, 1, 1,
                 'teilzeit', 24, 'DE02120300000000202051', 'I', '12 010190 D 123')`,
      )
      .run().lastInsertRowid,
  );
  const patchEmp = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/employees/${dora}`, headers: auth, payload });

  const fixed = await patchEmp({ work_weekdays: '4,2,3' });
  check(
    'Arbeitswoche: feste Tage sortiert, Zahl daraus',
    fixed.statusCode === 200 && fixed.json().employee.work_weekdays === '2,3,4' && fixed.json().employee.work_days_per_week === 3,
    fixed.json(),
  );
  // 07. bis 11.12.2026: Mo bis Fr ohne Feiertag; Di bis Do sind drei Tage.
  const fixedPreview = await get(`/api/absences/preview?employee_id=${dora}&date_from=2026-12-07&date_to=2026-12-11`);
  check(
    'Arbeitswoche: feste Tage zaehlen nur Di bis Do',
    fixedPreview.json().days_counted === 3 && fixedPreview.json().flexible === false,
    fixedPreview.json(),
  );
  const fixedBalance = await get(`/api/absences/balance/${dora}/2026`);
  check(
    'Arbeitswoche: drei Tage → 12 gesetzlich + 6 vertraglich',
    fixedBalance.json().balance.entitlement_detail?.statutory === 12 &&
      fixedBalance.json().balance.entitlement_detail?.contractual === 6,
    fixedBalance.json(),
  );
  const fixedOverride = await post('/api/absences/requests', {
    employee_id: dora, type_id: urlaubType.id, date_from: '2026-12-07', date_to: '2026-12-11', days_override: 2,
  });
  check('Arbeitswoche: Tage von Hand bei fester Woche → 400', fixedOverride.statusCode === 400, fixedOverride.json());

  const flexible = await patchEmp({ work_weekdays: null, work_days_per_week: 3 });
  check(
    'Arbeitswoche: flexibel ohne feste Tage',
    flexible.statusCode === 200 && flexible.json().employee.work_weekdays === null && flexible.json().employee.work_days_per_week === 3,
    flexible.json(),
  );
  const flexPreview = await get(`/api/absences/preview?employee_id=${dora}&date_from=2026-12-07&date_to=2026-12-11`);
  check(
    'Arbeitswoche: flexibel schlaegt 3 von 5 Werktagen vor',
    flexPreview.json().days_counted === 3 && flexPreview.json().flexible === true && flexPreview.json().weekdays === 5,
    flexPreview.json(),
  );
  const tooMany = await post('/api/absences/requests', {
    employee_id: dora, type_id: urlaubType.id, date_from: '2026-12-07', date_to: '2026-12-11', days_override: 6,
  });
  check('Arbeitswoche: mehr Tage als Werktage → 400', tooMany.statusCode === 400, tooMany.json());
  const manual = await post('/api/absences/requests', {
    employee_id: dora, type_id: urlaubType.id, date_from: '2026-12-07', date_to: '2026-12-11', days_override: 2,
  });
  check(
    'Arbeitswoche: Tage von Hand gespeichert',
    manual.statusCode === 201 && manual.json().request.days_counted === 2 && manual.json().request.days_manual === 1,
    manual.json(),
  );
  const flexBalance = await get(`/api/absences/balance/${dora}/2026`);
  check(
    'Arbeitswoche: Saldo nimmt die Tage von Hand',
    flexBalance.json().balance.planned === 2 || flexBalance.json().balance.taken === 2,
    flexBalance.json(),
  );
  // Eine Betriebsruhe im Zeitraum rechnet gezaehlte Antraege neu, die Zahl
  // von Hand bleibt stehen.
  const closure = await post('/api/absences/closures', { date_from: '2026-12-08', date_to: '2026-12-08', name: 'Brueckentag' });
  if (closure.statusCode === 201 || closure.statusCode === 200) {
    const after = db.prepare('SELECT days_counted, days_manual FROM absence_requests WHERE id = ?').get(manual.json().request.id) as {
      days_counted: number;
      days_manual: number;
    };
    check('Arbeitswoche: Betriebsruhe laesst Tage von Hand stehen', after.days_counted === 2 && after.days_manual === 1, after);
  }

  // Ausschnitte eines Antrags (bis heute, ab morgen) ergeben zusammen die
  // gespeicherten Tage, statt einzeln zu runden. 07. bis 11.12.2026: Mo bis
  // Fr ohne Feiertag, bei zwei Tagen je Woche ein Vorschlag von 2.
  {
    const { computeBalance, countAbsenceDays } = await import('./service.js');
    type Place = Parameters<typeof countAbsenceDays>[0]['place'];
    const flexPlace = { country: 'DE', region: 'BY', schedule: { daysPerWeek: 2, weekdays: null } } as Place;
    const week = { place: flexPlace, dateFrom: '2026-12-07', dateTo: '2026-12-11', closures: new Set<string>() };
    const parts = [countAbsenceDays({ ...week, clipTo: '2026-12-07' }), countAbsenceDays({ ...week, clipFrom: '2026-12-08' })];
    check(
      'Flexible Woche: Ausschnitte ergeben zusammen den Vorschlag',
      countAbsenceDays(week) === 2 && Math.round((parts[0] + parts[1]) * 100) === 200,
      parts,
    );
    const doraRow = db.prepare('SELECT * FROM employees WHERE id = ?').get(dora) as Parameters<typeof computeBalance>[0];
    // 2 wie der Vorschlag, 3 wie von Hand genannt.
    for (const stored of [2, 3]) {
      const b = computeBalance(doraRow, 2026, '2026-12-07', {
        place: flexPlace,
        carryoverDeadline: '03-31',
        closures: new Set(),
        requests: [
          { date_from: '2026-12-07', date_to: '2026-12-11', half_day_start: 0, half_day_end: 0, status: 'genehmigt', days_counted: stored },
        ],
      });
      check(
        `Flexible Woche: genommen und geplant ergeben die gespeicherten ${stored} Tage`,
        b.taken > 0 && Math.round((b.taken + b.planned) * 100) === stored * 100,
        { taken: b.taken, planned: b.planned },
      );
    }
  }

  // Eine neue Arbeitswoche zaehlt kommende Antraege neu; vergangene bleiben,
  // wie sie gezaehlt wurden (sonst aenderte sie genommene Tage rueckwirkend).
  {
    const { closureDates, countAbsenceDays, regionForEmployee } = await import('./service.js');
    const { todayIso, addDaysIso } = await import('../../core/dates.js');
    const { isHoliday } = await import('../../core/holidays.js');
    const { isoWeekday, regionCodesFor } = await import('@ohrganize/shared');
    const today = todayIso();
    const mondayIn = (weeks: number) => addDaysIso(today, 1 - isoWeekday(today) + 7 * weeks);
    // Kommende Testwochen ohne Feiertag (in keinem Bundesland, der Ort
    // wechselt unten) und ohne Betriebsruhe dieser Datenbank: Sonst haengen
    // die Erwartungen am Kalender und scheitern in einzelnen Wochen, etwa
    // um die Betriebsruhe zum Jahreswechsel.
    const closed = closureDates(today, addDaysIso(today, 400));
    const cleanMondayFrom = (start: string) => {
      for (let monday = start, i = 0; i < 40; monday = addDaysIso(monday, 7), i++) {
        const week = [0, 1, 2, 3, 4].map((n) => addDaysIso(monday, n));
        if (week.every((d) => !closed.has(d) && regionCodesFor('DE').every((r) => !isHoliday(d, 'DE', r)))) return monday;
      }
      throw new Error('Keine Testwoche ohne Feiertag und Betriebsruhe gefunden');
    };
    const upMonday = cleanMondayFrom(mondayIn(3));
    const manualMonday = cleanMondayFrom(addDaysIso(upMonday, 14));
    const emil = Number(
      db
        .prepare(
          `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                  employee_type, weekly_hours, iban, tax_class, social_security_number,
                                  work_weekdays, work_days_per_week)
           VALUES ('Emil', 'Eck', 'aktiv', '2020-01-01', 30, 1, 1,
                   'vollzeit', 40, 'DE02120300000000202051', 'I', '12 010190 E 123', '1,2,3,4,5', 5)`,
        )
        .run().lastInsertRowid,
    );
    const capture = (monday: string) =>
      post('/api/absences/requests', {
        employee_id: emil,
        type_id: urlaubType.id,
        date_from: monday,
        date_to: addDaysIso(monday, 4),
        approve: true,
      });
    const past = await capture(mondayIn(-3));
    const upcoming = await capture(upMonday);
    const daysOf = (id: number) =>
      (db.prepare('SELECT days_counted FROM absence_requests WHERE id = ?').get(id) as { days_counted: number }).days_counted;
    const pastId = past.json().request?.id as number;
    const upcomingId = upcoming.json().request?.id as number;
    const pastBefore = pastId ? daysOf(pastId) : -1;
    const upcomingBefore = upcomingId ? daysOf(upcomingId) : -1;
    const patched = await app.inject({ method: 'PATCH', url: `/api/employees/${emil}`, headers: auth, payload: { work_weekdays: '1,2' } });
    const expected = countAbsenceDays({ place: regionForEmployee(emil), dateFrom: upMonday, dateTo: addDaysIso(upMonday, 4) });
    check(
      'Arbeitswoche: neue Woche zaehlt kommende Antraege neu, vergangene bleiben',
      past.statusCode === 201 &&
        upcoming.statusCode === 201 &&
        patched.statusCode === 200 &&
        daysOf(pastId) === pastBefore &&
        daysOf(upcomingId) === expected &&
        expected < upcomingBefore,
      { past: past.json(), upcoming: upcoming.json(), patched: patched.statusCode, pastBefore, upcomingBefore, expected },
    );

    // Jeder Weg, der Ort oder Woche aendert, zaehlt neu (statisch:
    // src/test/placeChangeCheck.ts): Die gespeicherte Zahl wird verfaelscht,
    // der Weg muss sie richtigstellen.
    const correct = () =>
      countAbsenceDays({ place: regionForEmployee(emil), dateFrom: upMonday, dateTo: addDaysIso(upMonday, 4) });
    const spoil = () => db.prepare('UPDATE absence_requests SET days_counted = 99 WHERE id = ?').run(upcomingId);
    const viaWay = async (label: string, act: () => Promise<{ statusCode: number }>) => {
      spoil();
      const res = await act();
      check(`Neuzaehlung ueber ${label}`, res.statusCode < 300 && daysOf(upcomingId) === correct(), {
        status: res.statusCode,
        days: daysOf(upcomingId),
        expected: correct(),
      });
    };
    const berlin = Number(db.prepare("INSERT INTO locations (name, bundesland) VALUES ('Berlin', 'BE')").run().lastInsertRowid);
    await viaWay('Sammelaenderung des Standorts', () => post('/api/employees/bulk', { ids: [emil], set: { location_id: berlin } }));
    await viaWay('neue Region des Standorts', () =>
      app.inject({ method: 'PATCH', url: `/api/locations/${berlin}`, headers: auth, payload: { bundesland: 'HH' } }),
    );
    await viaWay('geloeschten Standort', () => app.inject({ method: 'DELETE', url: `/api/locations/${berlin}`, headers: auth }));
    // Ohne Standort gilt die Firmenvorgabe.
    const defaultRegion = (await get('/api/settings')).json().settings.defaultBundesland as string;
    await viaWay('Firmenvorgabe der Region', () =>
      app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: auth,
        payload: { defaultBundesland: defaultRegion === 'NW' ? 'BY' : 'NW' },
      }),
    );
    await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { defaultBundesland: defaultRegion } });

    // Tage von Hand gibt es nur bei flexibler Woche: Der Wechsel auf feste
    // Tage zaehlt solche kommenden Antraege und nimmt die Kennzeichnung weg.
    await app.inject({ method: 'PATCH', url: `/api/employees/${emil}`, headers: auth, payload: { work_weekdays: null, work_days_per_week: 3 } });
    const manualReq = await post('/api/absences/requests', {
      employee_id: emil,
      type_id: urlaubType.id,
      date_from: manualMonday,
      date_to: addDaysIso(manualMonday, 4),
      days_override: 1,
      approve: true,
    });
    const toFixed = await app.inject({ method: 'PATCH', url: `/api/employees/${emil}`, headers: auth, payload: { work_weekdays: '1,2,3,4,5' } });
    const manualRow = db
      .prepare('SELECT days_counted, days_manual FROM absence_requests WHERE id = ?')
      .get(manualReq.json().request?.id ?? -1) as { days_counted: number; days_manual: number } | undefined;
    const fixedCount = countAbsenceDays({ place: regionForEmployee(emil), dateFrom: manualMonday, dateTo: addDaysIso(manualMonday, 4) });
    check(
      'Wechsel auf feste Woche zaehlt Tage von Hand neu',
      manualReq.statusCode === 201 && toFixed.statusCode === 200 && manualRow?.days_manual === 0 && manualRow.days_counted === fixedCount,
      { manual: manualReq.json(), row: manualRow, fixedCount },
    );

    // Geaenderte Feiertagsregeln (ein Update) zaehlt der Start des Moduls neu;
    // erkannt am Fingerabdruck in _holiday_rules_state.
    const { recountAfterHolidayRuleChange } = await import('./service.js');
    spoil();
    const unchanged = recountAfterHolidayRuleChange();
    db.prepare("UPDATE _holiday_rules_state SET fingerprint = 'vor dem Update'").run();
    const recounted = recountAfterHolidayRuleChange();
    const systemRows = (
      db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'absence_request.recount_holidays' AND user_id IS NULL")
        .get() as { n: number }
    ).n;
    check(
      'Feiertagsregeln: unveraendert keine Neuzaehlung, geaendert kommende Antraege neu samt Protokoll',
      unchanged.length === 0 && recounted.includes(upcomingId) && daysOf(upcomingId) === correct() && systemRows > 0,
      { unchanged, recounted, days: daysOf(upcomingId), systemRows },
    );
  }

  // Anspruch je Vertragsversion: Wechsel von Vollzeit (5 Tage, 30) auf Teilzeit
  // (3 Tage, 18) zum 01.10.2026. 2026 rechnet 9/12 und 3/12 (27), 2025 bleibt
  // bei 30, auch wenn die Akte heute 3 Tage und 18 traegt.
  {
    const frieda = Number(
      db
        .prepare(
          `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                  employee_type, weekly_hours, iban, tax_class, social_security_number,
                                  work_weekdays, work_days_per_week)
           VALUES ('Frieda', 'Fink', 'aktiv', '2020-01-01', 18, 1, 1,
                   'teilzeit', 24, 'DE02120300000000202051', 'I', '12 010190 F 123', '1,2,3', 3)`,
        )
        .run().lastInsertRowid,
    );
    const version = db.prepare(
      `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to, annual_leave_days, work_weekdays, work_days_per_week)
       VALUES (?, 'unbefristet', ?, ?, ?, ?, ?)`,
    );
    version.run(frieda, '2025-01-01', '2026-09-30', 30, '1,2,3,4,5', 5);
    version.run(frieda, '2026-10-01', null, 18, '1,2,3', 3);
    const balanceOf = async (year: number) =>
      (await get(`/api/absences/balance/${frieda}/${year}`)).json().balance as {
        entitlement: number;
        carryover: number;
        entitlement_detail: { periods?: { total: number }[] };
      };
    const b2026 = await balanceOf(2026);
    const b2025 = await balanceOf(2025);
    check(
      'Anspruch je Vertragsversion: 2026 anteilig 27 mit zwei Abschnitten, 2025 bleibt 30',
      b2026.entitlement === 27 && b2026.entitlement_detail.periods?.length === 2 && b2025.entitlement === 30,
      { b2026, b2025 },
    );
    // Uebertrag vor dem Stichtag (Anfang Februar), nichts genommen: der
    // volle Anspruch 2025, gerechnet mit der damaligen Version.
    const { computeBalance } = await import('./service.js');
    const friedaRow = db.prepare('SELECT * FROM employees WHERE id = ?').get(frieda) as Parameters<typeof computeBalance>[0];
    const february = computeBalance(friedaRow, 2026, '2026-02-01');
    check('Anspruch je Vertragsversion: Uebertrag aus 2025 mit 30 Tagen', february.carryover === 30, february);
  }

  // Festhalten vor einer Aenderung der Akte: Eine alte Version ohne
  // Arbeitswoche (vor Migration 118) und die Zeit vor der ersten Version
  // rechneten mit den HEUTIGEN Werten der Akte. Ein Wechsel in Teilzeit
  // (neue Version, gespiegelt) aenderte sonst 2024 rueckwirkend.
  {
    const greta = Number(
      db
        .prepare(
          `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                  employee_type, weekly_hours, iban, tax_class, social_security_number)
           VALUES ('Greta', 'Gans', 'aktiv', '2024-03-15', 30, 1, 1,
                   'vollzeit', 40, 'DE02120300000000202051', 'I', '12 150390 G 123')`,
        )
        .run().lastInsertRowid,
    );
    const legacyId = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, annual_leave_days)
           VALUES (?, 'unbefristet', '2024-06-01', NULL)`,
        )
        .run(greta).lastInsertRowid,
    );
    const entitlementIn = async (year: number) =>
      (await get(`/api/absences/balance/${greta}/${year}`)).json().balance.entitlement as number;
    const before = await entitlementIn(2024);
    const todayLocal = (db.prepare("SELECT date('now', 'localtime') AS d").get() as { d: string }).d;
    const partTime = await post(`/api/employees/${greta}/contracts`, {
      contract_type: 'unbefristet',
      valid_from: todayLocal,
      employee_type: 'teilzeit',
      weekly_hours: 24,
      annual_leave_days: 18,
      work_weekdays: '1,2,3',
    });
    const after = await entitlementIn(2024);
    const legacy = db
      .prepare(
        'SELECT employee_type, annual_leave_days, work_weekdays, work_days_per_week, entitlement_frozen FROM contracts WHERE id = ?',
      )
      .get(legacyId);
    const gapRows = () =>
      db
        .prepare(
          `SELECT valid_from, valid_to, employee_type, annual_leave_days, work_weekdays
           FROM contract_gap_values WHERE employee_id = ? ORDER BY valid_from`,
        )
        .all(greta);
    const createAudit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'create' AND entity = 'contract' AND entity_id = ?")
      .get(partTime.json().contract?.id ?? -1) as { details: string } | undefined;
    check(
      'Festhalten: Teilzeit ab heute aendert 2024 nicht (alte Version und Zeit davor behalten die Werte der Akte)',
      partTime.statusCode === 201 &&
        before === 27.5 &&
        after === before &&
        JSON.stringify(legacy) ===
          JSON.stringify({
            employee_type: 'vollzeit',
            annual_leave_days: 30,
            work_weekdays: '1,2,3,4,5',
            work_days_per_week: 5,
            entitlement_frozen: 'employee_type,weekly_hours,annual_leave_days,work_week_default',
          }) &&
        JSON.stringify(gapRows()) ===
          JSON.stringify([
            { valid_from: '0000-01-01', valid_to: '2024-05-31', employee_type: 'vollzeit', annual_leave_days: 30, work_weekdays: '1,2,3,4,5' },
          ]) &&
        JSON.parse(createAudit?.details ?? '{}').frozen?.contracts?.includes(legacyId) === true,
      { status: partTime.statusCode, body: partTime.json(), before, after, legacy, gaps: gapRows(), createAudit },
    );
    // Eine zweite Aenderung haelt nichts doppelt fest.
    await app.inject({
      method: 'PATCH',
      url: `/api/employees/${greta}`,
      headers: auth,
      payload: { annual_leave_days: 20 },
    });
    check(
      'Festhalten: weitere Aenderung legt nichts doppelt an, 2024 unveraendert',
      gapRows().length === 1 && (await entitlementIn(2024)) === before,
      { gaps: gapRows(), entitlement2024: await entitlementIn(2024) },
    );
  }

  // Festhalten nach der letzten Version: Ein befristeter Vertrag ist am
  // 30.06.2025 ausgelaufen, die Person arbeitet weiter. Aendert die HR die Akte
  // (Teilzeit, 3 Tage, 18), rechnet die Zeit seit dem 01.07.2025 bis gestern
  // weiter mit den bisherigen Werten; 2025 bleibt 30.
  {
    const hanna = Number(
      db
        .prepare(
          `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                  employee_type, weekly_hours, iban, tax_class, social_security_number)
           VALUES ('Hanna', 'Hahn', 'aktiv', '2024-01-01', 30, 1, 1,
                   'vollzeit', 40, 'DE02120300000000202051', 'I', '12 010190 H 123')`,
        )
        .run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to, annual_leave_days, work_weekdays, work_days_per_week)
       VALUES (?, 'befristet', '2024-01-01', '2025-06-30', 30, '1,2,3,4,5', 5)`,
    ).run(hanna);
    const entitlement2025 = async () =>
      (await get(`/api/absences/balance/${hanna}/2025`)).json().balance.entitlement as number;
    const before = await entitlement2025();
    const toPartTime = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${hanna}`,
      headers: auth,
      payload: { employee_type: 'teilzeit', weekly_hours: 24, annual_leave_days: 18, work_weekdays: '1,2,3' },
    });
    const after = await entitlement2025();
    const tail = db
      .prepare('SELECT valid_from, annual_leave_days, work_weekdays FROM contract_gap_values WHERE employee_id = ?')
      .all(hanna) as { valid_from: string; annual_leave_days: number; work_weekdays: string | null }[];
    check(
      'Festhalten: Zeit nach der letzten Version behaelt die bisherigen Werte, 2025 bleibt 30',
      toPartTime.statusCode === 200 &&
        before === 30 &&
        after === 30 &&
        tail.length === 1 &&
        tail[0].valid_from === '2025-07-01' &&
        tail[0].annual_leave_days === 30 &&
        tail[0].work_weekdays === '1,2,3,4,5',
      { status: toPartTime.statusCode, body: toPartTime.json(), before, after, tail },
    );
    // Weitere Laeufe ohne Aenderung der Werte: Die Zeile waechst, statt sich zu verdoppeln.
    const { freezeEntitlementInputs } = await import('./service.js');
    const dayIn = (days: number) =>
      (db.prepare(`SELECT date('now', 'localtime', ?) AS d`).get(`${days >= 0 ? '+' : ''}${days} days`) as { d: string }).d;
    freezeEntitlementInputs(hanna, dayIn(10));
    freezeEntitlementInputs(hanna, dayIn(20));
    const rows = db
      .prepare('SELECT valid_from, valid_to FROM contract_gap_values WHERE employee_id = ? ORDER BY valid_from')
      .all(hanna) as { valid_from: string; valid_to: string }[];
    check(
      'Festhalten: gleiche Werte im Anschluss verlaengern die Zeile',
      rows.length === 2 && rows[1].valid_to === dayIn(19),
      rows,
    );
  }

  // Die heute geltende Version haelt nichts fest: Eine Korrektur der Art in den
  // Stammdaten trifft sie fuer ihren ganzen Zeitraum, ohne eine aus Vollzeit
  // abgeleitete Woche Mo bis Fr stehen zu lassen.
  {
    const ida = Number(
      db
        .prepare(
          `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                  employee_type, weekly_hours, iban, tax_class, social_security_number)
           VALUES ('Ida', 'Igel', 'aktiv', '2023-01-01', 30, 1, 1,
                   'vollzeit', 40, 'DE02120300000000202051', 'I', '12 010190 I 123')`,
        )
        .run().lastInsertRowid,
    );
    const versionId = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, annual_leave_days, weekly_hours)
           VALUES (?, 'unbefristet', '2023-01-01', 30, 40)`,
        )
        .run(ida).lastInsertRowid,
    );
    const corrected = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${ida}`,
      headers: auth,
      payload: { employee_type: 'teilzeit', weekly_hours: 20 },
    });
    const version = db
      .prepare('SELECT employee_type, work_weekdays, work_days_per_week, entitlement_frozen FROM contracts WHERE id = ?')
      .get(versionId);
    check(
      'Festhalten: geltende Version bleibt frei, die Korrektur gilt fuer ihren ganzen Zeitraum',
      corrected.statusCode === 200 &&
        JSON.stringify(version) ===
          JSON.stringify({ employee_type: 'teilzeit', work_weekdays: null, work_days_per_week: null, entitlement_frozen: null }),
      { status: corrected.statusCode, body: corrected.json(), version },
    );
  }

  // Wieder geltende Vorversion: Verschiebt eine Korrektur den Beginn der
  // Folgeversion nach hinten, gilt die angrenzende Vorversion wieder. Die Akte
  // spiegelt sie dann bis zum neuen Beginn (Art und Stunden bekam sie beim
  // Abloesen, fillClosedVersion), festgehaltene Urlaubstage und Woche gleich
  // der Akte werden wieder leer, Art und Stunden behalten Wert und Vermerk.
  // Passt sie nicht zu den heutigen Stammdaten, wird das Verschieben abgelehnt.
  {
    const dayIn = (days: number) =>
      (db.prepare(`SELECT date('now', 'localtime', ?) AS d`).get(`${days >= 0 ? '+' : ''}${days} days`) as { d: string }).d;
    const newPerson = (first: string, week: string | null = '1,2,3,4,5') =>
      Number(
        db
          .prepare(
            `INSERT INTO employees (first_name, last_name, status, hire_date, annual_leave_days, location_id, department_id,
                                    employee_type, weekly_hours, iban, tax_class, social_security_number,
                                    work_weekdays, work_days_per_week)
             VALUES (?, 'Probe', 'aktiv', '2023-01-01', 30, 1, 1,
                     'vollzeit', 40, 'DE02120300000000202051', 'I', '12 010190 P 123', ?, ?)`,
          )
          .run(first, week, week === null ? null : week.split(',').length).lastInsertRowid,
      );
    const versionOf = (v1: number) =>
      db
        .prepare(
          `SELECT valid_to, employee_type, weekly_hours, annual_leave_days, work_weekdays, work_days_per_week,
                  entitlement_frozen, mirror_pending, mirror_error
           FROM contracts WHERE id = ?`,
        )
        .get(v1) as {
        valid_to: string | null;
        employee_type: string | null;
        weekly_hours: number | null;
        annual_leave_days: number | null;
        work_weekdays: string | null;
        work_days_per_week: number | null;
        entitlement_frozen: string | null;
        mirror_pending: number;
        mirror_error: string | null;
      };
    const akteOf = (person: number) =>
      db
        .prepare(
          'SELECT employee_type, weekly_hours, annual_leave_days, work_weekdays, work_days_per_week FROM employees WHERE id = ?',
        )
        .get(person) as {
        employee_type: string;
        weekly_hours: number;
        annual_leave_days: number;
        work_weekdays: string | null;
        work_days_per_week: number | null;
      };
    const lastContractAudit = (contractId: number) =>
      JSON.parse(
        (
          db
            .prepare("SELECT details FROM audit_log WHERE action = 'update' AND entity = 'contract' AND entity_id = ? ORDER BY id DESC LIMIT 1")
            .get(contractId) as { details: string } | undefined
        )?.details ?? '{}',
      );
    const reopen = async (
      first: string,
      v1: { type: string | null; hours: number; annual: number | null },
      change: Record<string, unknown>,
      week: string | null = '1,2,3,4,5',
    ) => {
      const person = newPerson(first, week);
      const v1Id = Number(
        db
          .prepare(
            `INSERT INTO contracts (employee_id, contract_type, valid_from, employee_type, annual_leave_days, weekly_hours)
             VALUES (?, 'unbefristet', '2023-01-01', ?, ?, ?)`,
          )
          .run(person, v1.type, v1.annual, v1.hours).lastInsertRowid,
      );
      const v2 = await post(`/api/employees/${person}/contracts`, {
        contract_type: 'unbefristet',
        valid_from: dayIn(0),
        ...change,
      });
      const v2Id = v2.json().contract?.id ?? -1;
      const atClose = versionOf(v1Id);
      const moved = await app.inject({
        method: 'PATCH',
        url: `/api/contracts/${v2Id}`,
        headers: auth,
        payload: { valid_from: dayIn(30) },
      });
      return {
        person,
        v1: v1Id,
        v2Id,
        v2: v2.statusCode,
        atClose,
        moved: moved.statusCode,
        movedBody: moved.json(),
        after: versionOf(v1Id),
        akte: akteOf(person),
        reopened: lastContractAudit(v2Id).reopened,
      };
    };
    // Vorversion ohne Art und ohne Urlaubstage: Beim Abloesen bekommt sie die
    // Art, beim Wechsel Urlaub und Woche; nach dem Verschieben spiegelt die
    // Akte sie, Urlaub und Woche werden wieder leer, die Art bleibt vermerkt.
    const same = await reopen('Jan', { type: null, hours: 40, annual: null }, { weekly_hours: 40, annual_leave_days: 28 });
    check(
      'Wieder geltende Vorversion: Akte spiegelt sie, Urlaub und Woche wieder leer, Art bleibt vermerkt',
      same.v2 === 201 &&
        same.atClose.employee_type === 'vollzeit' &&
        same.atClose.entitlement_frozen === 'employee_type,annual_leave_days,work_week' &&
        same.moved === 200 &&
        same.after.valid_to === dayIn(29) &&
        same.after.annual_leave_days === null &&
        same.after.work_weekdays === null &&
        same.after.employee_type === 'vollzeit' &&
        same.after.entitlement_frozen === 'employee_type' &&
        same.after.mirror_pending === 0 &&
        same.akte.annual_leave_days === 30 &&
        same.akte.work_weekdays === '1,2,3,4,5' &&
        JSON.stringify(same.reopened?.unfrozen) === JSON.stringify(['annual_leave_days', 'work_week']),
      same,
    );
    // Teilzeit mit drei Tagen: Die Akte bekommt Art, Stunden und Woche der Vorversion zurueck.
    const partTime = await reopen(
      'Kai',
      { type: null, hours: 40, annual: 30 },
      { employee_type: 'teilzeit', weekly_hours: 24, work_weekdays: '1,2,3' },
    );
    check(
      'Wieder geltende Vorversion: Akte wieder mit Art, Stunden und Woche der Vorversion',
      partTime.v2 === 201 &&
        partTime.moved === 200 &&
        partTime.akte.employee_type === 'vollzeit' &&
        partTime.akte.weekly_hours === 40 &&
        partTime.akte.work_weekdays === '1,2,3,4,5' &&
        partTime.after.work_weekdays === null &&
        partTime.after.entitlement_frozen === 'employee_type',
      partTime,
    );
    // Abgeleitete Woche: Die Akte nannte keine (Vollzeit zaehlt Mo bis Fr).
    // Zurueck geht sie als "nicht hinterlegt", nicht als feste Woche.
    const derived = await reopen(
      'Ada',
      { type: 'vollzeit', hours: 40, annual: 30 },
      { employee_type: 'teilzeit', weekly_hours: 24, work_weekdays: '1,2,3' },
      null,
    );
    check(
      'Wieder geltende Vorversion: abgeleitete Woche geht als nicht hinterlegt zurueck',
      derived.v2 === 201 &&
        derived.atClose.entitlement_frozen === 'work_week_default' &&
        derived.atClose.work_weekdays === '1,2,3,4,5' &&
        derived.moved === 200 &&
        derived.akte.work_weekdays === null &&
        derived.akte.work_days_per_week === null &&
        derived.after.work_weekdays === null &&
        derived.after.entitlement_frozen === null,
      derived,
    );
    // Werkstudentin mit 30 Stunden (hoechstens 20): Die Vorversion passt nicht
    // zu den heutigen Stammdaten, das Verschieben wird abgelehnt, nichts geaendert.
    const student = await reopen(
      'Lea',
      { type: 'werkstudent', hours: 30, annual: 30 },
      { employee_type: 'teilzeit', weekly_hours: 24, work_weekdays: '1,2,3' },
    );
    check(
      'Wieder geltende Vorversion passt nicht: Verschieben abgelehnt, Vorversion und Akte unveraendert',
      student.v2 === 201 &&
        student.moved === 409 &&
        /nicht nach hinten verschieben/.test(student.movedBody.error?.message ?? '') &&
        /20/.test(student.movedBody.error?.message ?? '') &&
        student.after.valid_to === dayIn(-1) &&
        student.after.mirror_pending === 0 &&
        student.akte.employee_type === 'teilzeit' &&
        student.akte.work_weekdays === '1,2,3',
      student,
    );
    // Eine Korrektur in den Stammdaten setzt die Art der geltenden Version
    // selbst: Ihr Vermerk faellt weg, und das Protokoll nennt das.
    const corrected = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${same.person}`,
      headers: auth,
      payload: { employee_type: 'teilzeit' },
    });
    const correctedVersion = versionOf(same.v1);
    const correctedAudit = lastContractAudit(same.v1);
    check(
      'Korrektur in den Stammdaten entfernt den Vermerk des Feldes, Protokoll nennt es',
      corrected.statusCode === 200 &&
        correctedVersion.employee_type === 'teilzeit' &&
        correctedVersion.entitlement_frozen === null &&
        JSON.stringify(correctedAudit.changed?.entitlement_frozen) === JSON.stringify({ from: 'employee_type', to: null }),
      { status: corrected.statusCode, correctedVersion, correctedAudit },
    );
    // Die Woche geht nur als Paar: Weicht die Version von der Akte ab und
    // schickt das Formular nur die Zahl, kommen beide Haelften aus der Akte.
    db.prepare("UPDATE contracts SET work_weekdays = '1,2,3,4,5', work_days_per_week = 5 WHERE id = ?").run(partTime.v1);
    db.prepare('UPDATE employees SET work_weekdays = NULL, work_days_per_week = 3 WHERE id = ?').run(partTime.person);
    const pair = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${partTime.person}`,
      headers: auth,
      payload: { work_days_per_week: 4 },
    });
    const pairVersion = versionOf(partTime.v1);
    check(
      'Korrektur der Woche schreibt das Paar aus der Akte in die Version',
      pair.statusCode === 200 && pairVersion.work_weekdays === null && pairVersion.work_days_per_week === 4,
      { status: pair.statusCode, pairVersion },
    );
    // Altbestand: Die Vorversion wurde vor fillClosedVersion abgeloest und
    // nennt keine Art; verschieben hiesse, die Akte behielte die der
    // Folgeversion. Abgelehnt, nichts geaendert.
    const legacyPerson = newPerson('Ole');
    const yesterday = dayIn(-1);
    const legacyV1 = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to, annual_leave_days, weekly_hours)
           VALUES (?, 'unbefristet', '2023-01-01', ?, 30, 40)`,
        )
        .run(legacyPerson, yesterday).lastInsertRowid,
    );
    const legacyV2 = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, employee_type, annual_leave_days, weekly_hours)
           VALUES (?, 'unbefristet', ?, 'teilzeit', 30, 24)`,
        )
        .run(legacyPerson, dayIn(0)).lastInsertRowid,
    );
    db.prepare("UPDATE employees SET employee_type = 'teilzeit', weekly_hours = 24 WHERE id = ?").run(legacyPerson);
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/contracts/${legacyV2}`,
      headers: auth,
      payload: { valid_from: dayIn(30) },
    });
    check(
      'Wieder geltende Vorversion ohne Art: Verschieben abgelehnt, nichts geaendert',
      refused.statusCode === 409 &&
        /keine Beschäftigungsart/.test(refused.json().error?.message ?? '') &&
        /eine neue Version anlegen/.test(refused.json().error?.message ?? '') &&
        versionOf(legacyV1).valid_to === yesterday &&
        akteOf(legacyPerson).employee_type === 'teilzeit',
      { status: refused.statusCode, body: refused.json(), v1: versionOf(legacyV1) },
    );

    // Luecke vor der Folgeversion: Ein befristeter Vertrag endete, die
    // Folgeversion beginnt erst spaeter. Ihr Beginn verschiebt sich, die
    // Luecke bleibt; gekuerzt wird nur bei Ueberschneidung.
    const gapPerson = newPerson('Ina');
    const gapV1 = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to, employee_type, annual_leave_days, weekly_hours)
           VALUES (?, 'befristet', '2024-01-01', '2024-12-31', 'vollzeit', 20, 40)`,
        )
        .run(gapPerson).lastInsertRowid,
    );
    const gapV2 = await post(`/api/employees/${gapPerson}/contracts`, {
      contract_type: 'unbefristet',
      valid_from: '2025-03-01',
      weekly_hours: 40,
      annual_leave_days: 30,
    });
    const gapV2Id = gapV2.json().contract?.id ?? -1;
    const later = await app.inject({ method: 'PATCH', url: `/api/contracts/${gapV2Id}`, headers: auth, payload: { valid_from: '2025-03-03' } });
    const keptGap = versionOf(gapV1).valid_to;
    const earlier = await app.inject({ method: 'PATCH', url: `/api/contracts/${gapV2Id}`, headers: auth, payload: { valid_from: '2024-12-15' } });
    check(
      'Luecke vor der Folgeversion bleibt beim Verschieben, Ueberschneidung kuerzt die Vorversion',
      gapV2.statusCode === 201 &&
        later.statusCode === 200 &&
        keptGap === '2024-12-31' &&
        earlier.statusCode === 200 &&
        versionOf(gapV1).valid_to === '2024-12-14',
      { gapV2: gapV2.statusCode, later: later.json(), keptGap, earlier: earlier.json(), v1: versionOf(gapV1) },
    );

    // Heute begonnene, noch nicht uebernommene Version: Der Personal-PATCH
    // uebernimmt sie zuerst; ein Stand von vorher faellt am expected_updated_at auf.
    const duePerson = newPerson('Uwe');
    const dueV1 = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, employee_type, annual_leave_days, weekly_hours)
           VALUES (?, 'unbefristet', '2023-01-01', 'vollzeit', 30, 40)`,
        )
        .run(duePerson).lastInsertRowid,
    );
    const dueV2 = await post(`/api/employees/${duePerson}/contracts`, {
      contract_type: 'unbefristet',
      valid_from: dayIn(5),
      employee_type: 'teilzeit',
      weekly_hours: 20,
      annual_leave_days: 25,
    });
    const dueV2Id = dueV2.json().contract?.id ?? -1;
    // Der Beginn ist erreicht (so laege es nach Mitternacht), der stuendliche Lauf noch nicht.
    db.prepare('UPDATE contracts SET valid_from = ? WHERE id = ?').run(dayIn(0), dueV2Id);
    db.prepare('UPDATE contracts SET valid_to = ? WHERE id = ?').run(dayIn(-1), dueV1);
    db.prepare("UPDATE employees SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(duePerson);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${duePerson}`,
      headers: auth,
      payload: { annual_leave_days: 28, expected_updated_at: '2000-01-01 00:00:00' },
    });
    const afterStale = versionOf(dueV2Id);
    const fresh = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${duePerson}`,
      headers: auth,
      payload: { annual_leave_days: 28 },
    });
    check(
      'Heute begonnene Version: zuerst uebernommen, veralteter Stand abgelehnt, danach trifft die Korrektur sie',
      dueV2.statusCode === 201 &&
        stale.statusCode === 409 &&
        /neue Vertragsversion/.test(stale.json().error?.message ?? '') &&
        !/jemand anderem/.test(stale.json().error?.message ?? '') &&
        afterStale.mirror_pending === 0 &&
        afterStale.annual_leave_days === 25 &&
        akteOf(duePerson).employee_type === 'teilzeit' &&
        fresh.statusCode === 200 &&
        versionOf(dueV2Id).annual_leave_days === 28 &&
        versionOf(dueV1).annual_leave_days === 30,
      { stale: stale.json(), afterStale, fresh: fresh.statusCode, v2: versionOf(dueV2Id), v1: versionOf(dueV1) },
    );
    // Dasselbe Formular ohne Vertragsfeld (Telefon): Die Uebernahme ist kein
    // fremder Stand, das Speichern geht durch. Ein Formular von vor einer
    // schon uebernommenen Version nennt die Version statt jemand anderen;
    // ohne Uebernahme bleibt die bisherige Meldung.
    const phonePerson = newPerson('Vera');
    db.prepare(
      `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to, employee_type, annual_leave_days, weekly_hours)
       VALUES (?, 'unbefristet', '2023-01-01', ?, 'vollzeit', 30, 40)`,
    ).run(phonePerson, dayIn(-1));
    db.prepare(
      `INSERT INTO contracts (employee_id, contract_type, valid_from, employee_type, annual_leave_days, weekly_hours, mirror_pending)
       VALUES (?, 'unbefristet', ?, 'teilzeit', 25, 20, 1)`,
    ).run(phonePerson, dayIn(0));
    db.prepare("UPDATE employees SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(phonePerson);
    const phoneOnly = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${phonePerson}`,
      headers: auth,
      payload: { phone: '+49 30 1', expected_updated_at: '2000-01-01 00:00:00' },
    });
    const laterForm = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${phonePerson}`,
      headers: auth,
      payload: { phone: '+49 30 2', expected_updated_at: '2000-01-01 00:00:00' },
    });
    const otherPerson = newPerson('Wim');
    db.prepare("UPDATE employees SET updated_at = '2001-01-01 00:00:00' WHERE id = ?").run(otherPerson);
    const otherStale = await app.inject({
      method: 'PATCH',
      url: `/api/employees/${otherPerson}`,
      headers: auth,
      payload: { phone: '+49 30 3', expected_updated_at: '2000-01-01 00:00:00' },
    });
    check(
      'Uebernahme beim Speichern: Telefon geht durch, spaeteres Formular nennt die Version, sonst jemand anderes',
      phoneOnly.statusCode === 200 &&
        phoneOnly.json().employee?.phone === '+49 30 1' &&
        akteOf(phonePerson).employee_type === 'teilzeit' &&
        laterForm.statusCode === 409 &&
        laterForm.json().error?.message?.startsWith(
          `Die Personalakte wurde zwischenzeitlich geändert. Seit dem ${dayIn(0).split('-').reverse().join('.')} gilt eine neue Vertragsversion, die Personalakte zeigt jetzt deren Beschäftigungsart, Wochenstunden und Urlaubstage; weitere Änderungen anderer sind möglich.`,
        ) &&
        otherStale.statusCode === 409 &&
        /jemand anderem/.test(otherStale.json().error?.message ?? ''),
      { phoneOnly: phoneOnly.json(), laterForm: laterForm.json(), otherStale: otherStale.json() },
    );
    // Ein Formular, das alle Felder mitschickt: Die Werte, die die Version
    // nicht nennt oder die ihr gleichen, gehen durch; abgelehnt wird nur der
    // alte Urlaub gegen den neuen, und die Meldung nennt nur ihn.
    const dueOnlyLeave = (first: string) => {
      const person = newPerson(first);
      db.prepare(
        `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to, employee_type, annual_leave_days, weekly_hours)
         VALUES (?, 'unbefristet', '2023-01-01', ?, 'vollzeit', 30, 40)`,
      ).run(person, dayIn(-1));
      db.prepare(
        `INSERT INTO contracts (employee_id, contract_type, valid_from, annual_leave_days, mirror_pending)
         VALUES (?, 'unbefristet', ?, 25, 1)`,
      ).run(person, dayIn(0));
      db.prepare("UPDATE employees SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(person);
      return person;
    };
    const fullForm = (person: number, annual: number) =>
      app.inject({
        method: 'PATCH',
        url: `/api/employees/${person}`,
        headers: auth,
        payload: {
          employee_type: 'vollzeit',
          weekly_hours: 40,
          annual_leave_days: annual,
          phone: '+49 30 4',
          expected_updated_at: '2000-01-01 00:00:00',
        },
      });
    const sameValues = await fullForm(dueOnlyLeave('Xaver'), 25);
    const oldLeavePerson = dueOnlyLeave('Yara');
    const oldLeave = await fullForm(oldLeavePerson, 30);
    check(
      'Uebernahme beim Speichern: gleiche Werte gehen durch, nur der ueberschriebene Urlaub wird abgelehnt und genannt',
      sameValues.statusCode === 200 &&
        sameValues.json().employee?.annual_leave_days === 25 &&
        oldLeave.statusCode === 409 &&
        oldLeave.json().error?.message ===
          `Seit dem ${dayIn(0).split('-').reverse().join('.')} gilt eine neue Vertragsversion, die Personalakte zeigt jetzt deren Urlaubstage. Bitte laden Sie die Personalakte neu und übernehmen Sie Ihre Änderungen erneut.` &&
        akteOf(oldLeavePerson).annual_leave_days === 25,
      { sameValues: sameValues.json(), oldLeave: oldLeave.json() },
    );

    // Offene Uebernahme einer abgeloesten Version ist mit ihrem Ende erledigt.
    const openPerson = newPerson('Pia');
    const openV1 = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, employee_type, annual_leave_days, weekly_hours,
                                  mirror_pending, mirror_error)
           VALUES (?, 'unbefristet', '2023-01-01', 'vollzeit', 30, 40, 1, 'Typregeln')`,
        )
        .run(openPerson).lastInsertRowid,
    );
    const replaced = await post(`/api/employees/${openPerson}/contracts`, {
      contract_type: 'unbefristet',
      valid_from: dayIn(0),
      weekly_hours: 40,
    });
    check(
      'Abgeloeste Version mit offener Uebernahme: Markierung mit dem Ende weg',
      replaced.statusCode === 201 && versionOf(openV1).mirror_pending === 0 && versionOf(openV1).mirror_error === null,
      { status: replaced.statusCode, v1: versionOf(openV1) },
    );

    // Korrektur einer Version: Den Vermerk verliert nur ein Feld, das sich
    // wirklich aendert (der Dialog schickt alle Felder mit).
    const markPerson = newPerson('Max');
    const markV = Number(
      db
        .prepare(
          `INSERT INTO contracts (employee_id, contract_type, valid_from, employee_type, annual_leave_days, weekly_hours,
                                  entitlement_frozen)
           VALUES (?, 'unbefristet', '2023-01-01', 'vollzeit', 30, 40, 'annual_leave_days')`,
        )
        .run(markPerson).lastInsertRowid,
    );
    const noteOnly = await app.inject({
      method: 'PATCH',
      url: `/api/contracts/${markV}`,
      headers: auth,
      payload: { note: 'nur Notiz', annual_leave_days: 30, weekly_hours: 40 },
    });
    const afterNote = versionOf(markV).entitlement_frozen;
    const realChange = await app.inject({
      method: 'PATCH',
      url: `/api/contracts/${markV}`,
      headers: auth,
      payload: { annual_leave_days: 29 },
    });
    check(
      'Korrektur einer Version entfernt den Vermerk nur fuer geaenderte Felder, Protokoll nennt es',
      noteOnly.statusCode === 200 &&
        afterNote === 'annual_leave_days' &&
        realChange.statusCode === 200 &&
        versionOf(markV).entitlement_frozen === null &&
        JSON.stringify(lastContractAudit(markV).entitlement_frozen) === JSON.stringify({ from: 'annual_leave_days', to: null }),
      { noteOnly: noteOnly.statusCode, afterNote, realChange: realChange.json(), audit: lastContractAudit(markV) },
    );
  }

  // ------------------------------------------------------- Home Office ---
  // Muster Di (2) und Do (4); 01.12.2026 ist ein Dienstag, 02.12. ein Mittwoch.
  const pattern = await patchEmp({ home_office_weekdays: '4,2' });
  check(
    'Home Office: Muster gespeichert und sortiert',
    pattern.statusCode === 200 && pattern.json().employee.home_office_weekdays === '2,4',
    pattern.json(),
  );
  const office = await post('/api/absences/home-office', { employee_id: dora, date: '2026-12-01', home_office: false });
  check('Home Office: Buerotag an einem Muster-Tag', office.statusCode === 200 && office.json().exception === 'buero', office.json());
  const extra = await post('/api/absences/home-office', { employee_id: dora, date: '2026-12-02', home_office: true });
  check('Home Office: zusaetzlicher Tag', extra.json().exception === 'homeoffice', extra.json());
  const calendar = await get('/api/absences/calendar?year=2026&month=12');
  const doraRow = (calendar.json().employees as { id: number; home_office_weekdays: string | null; home_office: { date: string; kind: string }[] }[]).find(
    (e) => e.id === dora,
  );
  check(
    'Home Office: Kalender liefert Muster und Ausnahmen',
    doraRow?.home_office_weekdays === '2,4' &&
      doraRow.home_office.some((x) => x.date === '2026-12-01' && x.kind === 'buero') &&
      doraRow.home_office.some((x) => x.date === '2026-12-02' && x.kind === 'homeoffice'),
    doraRow,
  );
  const back = await post('/api/absences/home-office', { employee_id: dora, date: '2026-12-01', home_office: true });
  check('Home Office: zurueck zum Muster entfernt die Ausnahme', back.json().exception === null, back.json());
  const removed = await post('/api/absences/home-office', { employee_id: dora, date: '2026-12-02', home_office: false });
  const left = db.prepare('SELECT COUNT(*) AS n FROM home_office_exceptions WHERE employee_id = ?').get(dora) as { n: number };
  check('Home Office: zurueck zum Buerotag entfernt die Ausnahme, keine mehr', removed.json().exception === null && left.n === 0, left);
}

await app.close();
closeDb();
try {
  fs.rmSync(process.env.OHRGANIZE_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows/WAL-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Smoke-Checks des Abwesenheitsmoduls bestanden.');
