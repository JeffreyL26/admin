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

const balClara = await get('/api/absences/balance/3/2026');
check('Saldo: Eintritt 01.07. → 6/12 von 24 = 12', balClara.json().balance.entitlement === 12, balClara.json());

const balances = await get('/api/absences/balances/2026');
check('Saldenübersicht: 3 aktive MA', balances.json().balances.length === 3, balances.json());

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
// Ben ebenfalls 21./22.12. im Urlaub → Team "Backend" (2 Mitglieder) zu 100 % abwesend.
const rBen = await post('/api/absences/requests', {
  employee_id: 2,
  type_id: urlaubType.id,
  date_from: '2026-12-21',
  date_to: '2026-12-22',
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
