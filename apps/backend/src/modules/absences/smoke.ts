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
  const cover = await post('/api/absences/closures', { name: 'Inventur', date_from: '2026-11-09', date_to: '2026-11-10' });
  const row = db.prepare('SELECT status, days_counted FROM absence_requests WHERE id = ?').get(insideId) as
    | { status: string; days_counted: number }
    | undefined;
  check('Antrag vollstaendig in Betriebsruhe wird storniert', inside.statusCode === 201 && cover.statusCode === 201 && row?.status === 'storniert' && row.days_counted === 0, { inside: inside.json(), row });
  await app.inject({ method: 'DELETE', url: `/api/absences/closures/${cover.json().closure.id}`, headers: auth });
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
check('Saldo: Eintritt 01.07. → 6/12 von 24 = 12', balClara.json().balance.entitlement === 12, balClara.json());
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
