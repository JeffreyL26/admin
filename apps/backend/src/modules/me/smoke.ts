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

// ============================================================================
// Ab hier: Selbstauskunft (Gehalt, Organigramm, Kalender, Dokumente) und
// Berechtigungssteuerung. Alle Zeitfenster liegen bewusst in 2027 bzw. im
// April 2026, damit sie sich nicht mit den Anträgen oben überschneiden.
// ============================================================================

/** Sucht einen Feldnamen rekursiv im gesamten Antwortbaum. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value && typeof value === 'object') {
    return (
      Object.keys(value as object).includes(key) ||
      Object.values(value as object).some((v) => hasKeyDeep(v, key))
    );
  }
  return false;
}

// --------------------------------------------------------------- Vergütung ---
// Beide Komponenten tragen eine `note` — genau die darf die Selbstauskunft
// niemals ausliefern (sie enthält HR-interne Begründungen).
db.prepare('UPDATE employees SET weekly_hours = 40, employee_type = ? WHERE id = 1').run('vollzeit');
const insertComponent = db.prepare(
  'INSERT INTO salary_components (employee_id, kind, amount_cents, valid_from, valid_to, note) VALUES (?, ?, ?, ?, ?, ?)',
);
insertComponent.run(1, 'grundgehalt', 450000, '2018-01-01', '2019-12-31', 'Alte Stufe — HR-intern');
insertComponent.run(1, 'grundgehalt', 500000, '2020-01-01', null, 'Verhandlungsstand: Ziel 5.200 EUR');

const salary = await empGet('/api/me/salary');
const sal = salary.json().salary;
check(
  'Gehalt: nur aktuelle Komponente, Monatsbrutto = Summe der Monatswerte',
  salary.statusCode === 200 &&
    sal.weekly_hours === 40 &&
    sal.components.length === 1 &&
    sal.components[0].amount_cents === 500000 &&
    sal.components[0].monthly_cents === 500000 &&
    sal.monthly_gross_cents === 500000,
  sal,
);
check('Gehalt: kein Feld "note" in der Antwort', !hasKeyDeep(salary.json(), 'note'), sal);

const history = await empGet('/api/me/salary/history');
const hist = history.json().components as { valid_from: string; amount_cents: number }[];
check(
  'Gehaltshistorie: vollständig und absteigend nach valid_from',
  history.statusCode === 200 &&
    hist.length === 2 &&
    hist[0]!.valid_from === '2020-01-01' &&
    hist[1]!.valid_from === '2018-01-01',
  hist,
);
check('Gehaltshistorie: kein Feld "note"', !hasKeyDeep(history.json(), 'note'), hist);

// Fixbonus und zielgekoppelter Bonus — Letzterer ist nur "voraussichtlich".
db.prepare(
  `INSERT INTO bonuses (employee_id, kind, title, amount_cents, target_amount_cents, goal_id, payout_month, status, note)
   VALUES (1, 'einmalzahlung', 'Projektprämie', 100000, NULL, NULL, '2027-03', 'ausgezahlt', 'HR-intern')`,
).run();
db.prepare(
  `INSERT INTO bonuses (employee_id, kind, title, amount_cents, target_amount_cents, goal_id, payout_month, status, note)
   VALUES (1, 'zielbonus', 'Jahresziel 2027', NULL, 200000, 1, '2027-12', 'geplant', 'HR-intern')`,
).run();
const bonuses = await empGet('/api/me/bonuses');
const bon = bonuses.json().bonuses as { title: string; payout_cents: number; is_projected: boolean }[];
const fix = bon.find((b) => b.title === 'Projektprämie')!;
const ziel = bon.find((b) => b.title === 'Jahresziel 2027')!;
check(
  'Boni: Fixbetrag fest, Zielbonus als voraussichtlich markiert',
  bonuses.statusCode === 200 &&
    bon.length === 2 &&
    fix.is_projected === false &&
    fix.payout_cents === 100000 &&
    ziel.is_projected === true,
  bon,
);
check(
  'Boni: weder "note" noch "goal_id" in der Antwort',
  !hasKeyDeep(bonuses.json(), 'note') && !hasKeyDeep(bonuses.json(), 'goal_id'),
  bon,
);

const freelancer = await empGet('/api/me/freelancer');
check(
  'Honorare: für Nicht-Freiberufler:innen leere Listen statt 403',
  freelancer.statusCode === 200 &&
    freelancer.json().rates.length === 0 &&
    freelancer.json().invoices.length === 0,
  freelancer.json(),
);

// Und derselbe Aufruf als Freiberuflerin — die Rechnung trägt einen
// Prüfvermerk und einen Dateiverweis, beides bleibt HR-intern.
db.prepare("UPDATE employees SET employee_type = 'freiberufler' WHERE id = 1").run();
db.prepare(
  `INSERT INTO freelancer_rates (employee_id, description, rate_cents, unit, valid_from)
   VALUES (1, 'Entwicklung', 9500, 'stunde', '2027-01-01')`,
).run();
db.prepare(
  `INSERT INTO freelancer_invoices (employee_id, invoice_number, invoice_date, period, amount_cents, hours, status, note)
   VALUES (1, 'RE-2027-001', '2027-01-31', '2027-01', 950000, 100, 'offen', 'Prüfvermerk der Buchhaltung')`,
).run();
const asFreelancer = await empGet('/api/me/freelancer');
const fl = asFreelancer.json();
check(
  'Honorare: Sätze und eigene Rechnungen für Freiberufler:innen',
  asFreelancer.statusCode === 200 &&
    fl.rates.length === 1 &&
    fl.rates[0].rate_cents === 9500 &&
    fl.rates[0].unit === 'stunde' &&
    fl.invoices.length === 1 &&
    fl.invoices[0].invoice_number === 'RE-2027-001' &&
    fl.invoices[0].amount_cents === 950000,
  fl,
);
check(
  'Honorare: weder "note" noch "file_id" in der Antwort',
  !hasKeyDeep(fl, 'note') && !hasKeyDeep(fl, 'file_id'),
  fl,
);
db.prepare("UPDATE employees SET employee_type = 'vollzeit' WHERE id = 1").run();

// Stundenlohn ohne hinterlegte Wochenstunden: die Route rechnet NICHT mit dem
// stillen 40-h-Rückfall aus monthlyCents hoch, sondern liefert 0 — eine
// geschätzte Zahl läse sich im Portal wie eine Zusage. Der Client erkennt den
// Fall an weekly_hours: null.
db.prepare('UPDATE employees SET weekly_hours = NULL WHERE id = 1').run();
db.prepare(
  "INSERT INTO salary_components (employee_id, kind, amount_cents, valid_from) VALUES (1, 'stundenlohn', 2500, '2021-01-01')",
).run();
const hourly = await empGet('/api/me/salary');
const hourlyComponent = (hourly.json().salary.components as { kind: string; monthly_cents: number }[]).find(
  (c) => c.kind === 'stundenlohn',
);
check(
  'Gehalt: Stundenlohn ohne Wochenstunden → 0 statt erfundener Hochrechnung',
  hourly.json().salary.weekly_hours === null &&
    hourlyComponent?.monthly_cents === 0 &&
    hourly.json().salary.monthly_gross_cents === 0,
  hourly.json().salary,
);
db.prepare("DELETE FROM salary_components WHERE employee_id = 1 AND kind = 'stundenlohn'").run();
db.prepare('UPDATE employees SET weekly_hours = 40 WHERE id = 1').run();

// ------------------------------------------------------------- Organigramm ---
const orgTree = await empGet('/api/me/org-tree');
const tree = orgTree.json().tree as { name: string; teams: { name: string }[] }[];
check(
  'Organigramm: Abteilung mit Team, unassigned_count als Zahl',
  orgTree.statusCode === 200 &&
    tree.length === 1 &&
    tree[0]!.name === 'Technik' &&
    tree[0]!.teams.length === 1 &&
    tree[0]!.teams[0]!.name === 'Backend' &&
    typeof orgTree.json().unassigned_count === 'number',
  orgTree.json(),
);
check(
  'Organigramm: auf den Vertrag projiziert (kein created_at aus SELECT *)',
  !hasKeyDeep(tree, 'created_at'),
  tree,
);

// ---------------------------------------------------------- Firmenkalender ---
// Zwei zusätzliche Anträge Bens im April 2026, die NICHT sichtbar sein dürfen.
const insertRequest = db.prepare(
  `INSERT INTO absence_requests (employee_id, type_id, date_from, date_to, days_counted, status)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const pendingId = Number(
  insertRequest.run(2, urlaub.id, '2026-04-06', '2026-04-08', 3, 'beantragt').lastInsertRowid,
);
const rejectedId = Number(
  insertRequest.run(2, urlaub.id, '2026-04-13', '2026-04-15', 3, 'abgelehnt').lastInsertRowid,
);

const noMonth = await empGet('/api/me/calendar?year=2026');
check('Kalender ohne Monat → 400 (harte Lastbegrenzung)', noMonth.statusCode === 400, noMonth.json());
const badMonth = await empGet('/api/me/calendar?year=2026&month=13');
check('Kalender mit Monat 13 → 400', badMonth.statusCode === 400, badMonth.json());

const calendar = await empGet('/api/me/calendar?year=2026&month=4');
const calBody = calendar.json();
const calEntries = (calBody.employees as { absences: { request_id: number; type_name: string; type_id: number | null; color: string }[] }[]).flatMap(
  (e) => e.absences,
);
check(
  'Kalender: Zeitraum, alle aktiven Mitarbeitenden, keine conflicts',
  calendar.statusCode === 200 &&
    calBody.range.from === '2026-04-01' &&
    calBody.range.to === '2026-04-30' &&
    calBody.employees.length === 2 &&
    !('conflicts' in calBody),
  calBody.range,
);
check(
  'Kalender: nur genehmigte Abwesenheiten (beantragt/abgelehnt fehlen)',
  calEntries.length === 1 &&
    calEntries[0]!.request_id === r1Id &&
    !calEntries.some((e) => e.request_id === pendingId || e.request_id === rejectedId),
  calEntries,
);

// Maskierung: Art auf 'neutral' stellen — Klarname darf die DB nicht verlassen.
db.prepare("UPDATE absence_types SET portal_visibility = 'neutral' WHERE id = ?").run(urlaub.id);
const masked = await empGet('/api/me/calendar?year=2026&month=4');
const maskedEntries = (masked.json().employees as { absences: { type_id: number | null; type_name: string }[] }[]).flatMap(
  (e) => e.absences,
);
check(
  "Kalender: portal_visibility 'neutral' maskiert Art zu „Abwesend“ (type_id null)",
  maskedEntries.length === 1 &&
    maskedEntries[0]!.type_id === null &&
    maskedEntries[0]!.type_name === 'Abwesend',
  maskedEntries,
);
db.prepare("UPDATE absence_types SET portal_visibility = 'name' WHERE id = ?").run(urlaub.id);
const unmasked = await empGet('/api/me/calendar?year=2026&month=4');
check(
  'Kalender: zurückgestellt auf Klarnamen',
  (unmasked.json().employees as { absences: { type_name: string }[] }[])
    .flatMap((e) => e.absences)
    .every((a) => a.type_name === 'Urlaub'),
);

// ---------------------------------------------------------------- Dokumente ---
// Je ein von der HR abgelegtes Dokument für Anna und für Ben.
const insertFile = db.prepare(
  "INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256) VALUES (?, ?, 'application/pdf', 1024, 'deadbeef')",
);
const insertDoc = db.prepare(
  "INSERT INTO documents (employee_id, file_id, category, title, source) VALUES (?, ?, ?, ?, 'hr')",
);
const annaFileId = Number(insertFile.run('Arbeitsvertrag_Adler.pdf', 'smoke-anna.pdf').lastInsertRowid);
const annaDocId = Number(insertDoc.run(1, annaFileId, 'vertrag', 'Arbeitsvertrag Anna Adler').lastInsertRowid);
const benFileId = Number(insertFile.run('Zeugnis_Berg.pdf', 'smoke-ben.pdf').lastInsertRowid);
const benDocId = Number(insertDoc.run(2, benFileId, 'zeugnis', 'Arbeitszeugnis Ben Berg').lastInsertRowid);

const docList = await empGet('/api/me/documents');
const docs = docList.json().documents as { id: number; title: string; source: string }[];
check(
  'Dokumente: eigene inkl. HR-Ablage, keine fremden, ohne download_url',
  docList.statusCode === 200 &&
    docs.length === 1 &&
    docs[0]!.id === annaDocId &&
    docs[0]!.source === 'hr' &&
    !hasKeyDeep(docList.json(), 'download_url'),
  docs,
);

const ownDownload = await empPost(`/api/me/documents/${annaDocId}/download`);
check(
  'Download des eigenen Dokuments → signierte URL, nicht cachebar',
  ownDownload.statusCode === 200 &&
    typeof ownDownload.json().url === 'string' &&
    ownDownload.headers['cache-control'] === 'no-store',
  ownDownload.json(),
);
const foreignDownload = await empPost(`/api/me/documents/${benDocId}/download`);
check(
  'Download eines FREMDEN Dokuments → 404 (kein 403, das würde die Existenz verraten)',
  foreignDownload.statusCode === 404,
  foreignDownload.json(),
);
const ghostDownload = await empPost('/api/me/documents/999999/download');
check('Download eines unbekannten Dokuments → 404', ghostDownload.statusCode === 404);

// Upload über multipart/form-data.
const DOC_BOUNDARY = '----hrmonicMeDocBoundary';
function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; content: string } | null,
  fieldsFirst = true,
): Buffer {
  const fieldParts = Object.entries(fields).map(([k, v]) =>
    Buffer.from(`--${DOC_BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
  );
  const fileParts = file
    ? [
        Buffer.from(
          `--${DOC_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
            `Content-Type: ${file.type}\r\n\r\n${file.content}\r\n`,
        ),
      ]
    : [];
  const body = fieldsFirst ? [...fieldParts, ...fileParts] : [...fileParts, ...fieldParts];
  return Buffer.concat([...body, Buffer.from(`--${DOC_BOUNDARY}--\r\n`)]);
}
const empUpload = (payload: Buffer) =>
  app.inject({
    method: 'POST',
    url: '/api/me/documents',
    headers: { ...empAuth, 'content-type': `multipart/form-data; boundary=${DOC_BOUNDARY}` },
    payload,
  });

const uploaded = await empUpload(
  multipart({ category: 'bescheinigung', title: 'Erste-Hilfe-Kurs', note: 'Auffrischung' }, {
    name: 'kurs.txt',
    type: 'text/plain',
    content: 'Teilnahmebestätigung',
  }),
);
const uploadedDoc = uploaded.json().document as { id: number; source: string; original_name: string };
check(
  'Dokument-Upload → 201, source=portal, Dateimetadaten angereichert',
  uploaded.statusCode === 201 &&
    uploadedDoc.source === 'portal' &&
    uploadedDoc.original_name === 'kurs.txt',
  uploaded.json(),
);
const uploadedRow = db
  .prepare('SELECT employee_id, uploaded_by_user_id, supersedes_id, version FROM documents WHERE id = ?')
  .get(uploadedDoc.id) as { employee_id: number; uploaded_by_user_id: number | null; supersedes_id: number | null };
check(
  'Upload: employee_id aus dem eigenen Profil, Hochladende:r vermerkt, keine Verkettung',
  uploadedRow.employee_id === 1 &&
    uploadedRow.uploaded_by_user_id !== null &&
    uploadedRow.supersedes_id === null,
  uploadedRow,
);
const uploadAudit = db
  .prepare("SELECT action, details FROM audit_log WHERE entity = 'document' ORDER BY id DESC LIMIT 1")
  .get() as { action: string; details: string } | undefined;
check(
  'Upload schreibt Audit-Eintrag mit self_service:true',
  uploadAudit?.action === 'create' && String(uploadAudit.details).includes('"self_service":true'),
  uploadAudit,
);
// Die signierte URL muss die Datei auch ohne Anmeldung ausliefern (sie IST die Berechtigung).
const uploadedUrl = (await empPost(`/api/me/documents/${uploadedDoc.id}/download`)).json().url as string;
const signedPath = new URL(uploadedUrl, 'http://127.0.0.1').pathname + new URL(uploadedUrl, 'http://127.0.0.1').search;
const signedFetch = await app.inject({ method: 'GET', url: signedPath });
check('Signierte Download-URL liefert die Datei aus', signedFetch.statusCode === 200, signedFetch.statusCode);

// Metadaten NACH der Datei — die Reihenfolge im FormData gehört dem Client.
const uploadReordered = await empUpload(
  multipart({ category: 'zertifikat', title: 'Zertifikat' }, { name: 'z.txt', type: 'text/plain', content: 'x' }, false),
);
check('Upload: Metadatenfelder dürfen nach der Datei stehen', uploadReordered.statusCode === 201, uploadReordered.json());

const uploadNoTitle = await empUpload(
  multipart({ category: 'sonstiges' }, { name: 'ohne-titel.txt', type: 'text/plain', content: 'x' }),
);
check(
  'Upload ohne Titel → Dateiname als Titel',
  uploadNoTitle.statusCode === 201 && uploadNoTitle.json().document.title === 'ohne-titel.txt',
  uploadNoTitle.json(),
);
const uploadHrCategory = await empUpload(
  multipart({ category: 'vertrag', title: 'Eigener Vertrag' }, { name: 'v.txt', type: 'text/plain', content: 'x' }),
);
check(
  'Upload mit HR-Kategorie "vertrag" → 400 (niemand legt sich selbst einen Vertrag ab)',
  uploadHrCategory.statusCode === 400,
  uploadHrCategory.json(),
);
const uploadBadMime = await empUpload(
  multipart({ category: 'sonstiges', title: 'HTML' }, { name: 'x.html', type: 'text/html', content: '<h1>x</h1>' }),
);
check('Upload mit nicht erlaubtem Dateityp → 400', uploadBadMime.statusCode === 400, uploadBadMime.json());
const uploadSupersedes = await empUpload(
  multipart({ category: 'sonstiges', title: 'V2', supersedes_id: String(annaDocId) }, {
    name: 'v2.txt',
    type: 'text/plain',
    content: 'x',
  }),
);
check('Upload mit supersedes_id → 400 (Versionierung bleibt HR-Sache)', uploadSupersedes.statusCode === 400, uploadSupersedes.json());
const uploadTooBig = await empUpload(
  multipart({ category: 'sonstiges', title: 'Zu groß' }, {
    name: 'gross.txt',
    type: 'text/plain',
    content: 'A'.repeat(11 * 1024 * 1024),
  }),
);
check('Upload über 10 MB → 400', uploadTooBig.statusCode === 400, uploadTooBig.json());
const uploadNoFile = await empUpload(multipart({ category: 'sonstiges', title: 'Ohne Datei' }, null));
check('Upload ohne Datei → 400', uploadNoFile.statusCode === 400, uploadNoFile.json());
const uploadNotMultipart = await empPost('/api/me/documents', { category: 'sonstiges' });
check('Upload ohne multipart → 400', uploadNotMultipart.statusCode === 400, uploadNotMultipart.json());

// ------------------------------------------- Berechtigung je Abwesenheitsart ---
// Anna bekommt die Rolle "Vollzeit" (die Migration hat sie nur bestehenden
// Mitarbeitenden zugewiesen — die Testpersonen entstehen erst danach).
const roleVollzeit = db.prepare("SELECT id FROM roles WHERE name = 'Vollzeit'").get() as { id: number };
const roleMinijob = db.prepare("SELECT id FROM roles WHERE name = 'Minijob'").get() as { id: number };
db.prepare('INSERT INTO employee_roles (employee_id, role_id) VALUES (1, ?)').run(roleVollzeit.id);

const baseTypes = (await empGet('/api/me/leave-types')).json().types as { id: number; name: string }[];
// Eine Art, die nicht "Urlaub" ist — Urlaub wird oben noch gebraucht.
const blockable = baseTypes.find((t) => t.id !== urlaub.id)!;

db.prepare(
  "INSERT INTO absence_type_employee_rules (type_id, employee_id, effect) VALUES (?, 1, 'deny')",
).run(blockable.id);
const afterDeny = (await empGet('/api/me/leave-types')).json().types as { id: number }[];
check(
  `Personenregel deny entfernt „${blockable.name}“ aus der Auswahl`,
  afterDeny.length === baseTypes.length - 1 && !afterDeny.some((t) => t.id === blockable.id),
  afterDeny.length,
);
const denyPost = await empPost('/api/me/leave-requests', {
  type_id: blockable.id,
  date_from: '2027-03-02',
  date_to: '2027-03-03',
});
check(
  'Gesperrte Art beantragen → 403 (Lese- und Schreibseite decken sich)',
  denyPost.statusCode === 403,
  denyPost.json(),
);
db.prepare('DELETE FROM absence_type_employee_rules WHERE type_id = ?').run(blockable.id);

// Rollen-Allowlist: nur eine Rolle, die Anna nicht hat.
db.prepare('INSERT INTO absence_type_roles (type_id, role_id) VALUES (?, ?)').run(blockable.id, roleMinijob.id);
const afterAllowlist = (await empGet('/api/me/leave-types')).json().types as { id: number }[];
check(
  'Rollen-Allowlist ohne die eigene Rolle sperrt die Art',
  !afterAllowlist.some((t) => t.id === blockable.id),
  afterAllowlist.length,
);
// Personenregel 'allow' schlägt die Rollen-Allowlist.
db.prepare(
  "INSERT INTO absence_type_employee_rules (type_id, employee_id, effect) VALUES (?, 1, 'allow')",
).run(blockable.id);
const allowWins = (await empGet('/api/me/leave-types')).json().types as { id: number }[];
check(
  "Personenregel 'allow' schlägt die Rollen-Allowlist",
  allowWins.some((t) => t.id === blockable.id),
  allowWins.length,
);
db.prepare('DELETE FROM absence_type_employee_rules WHERE type_id = ?').run(blockable.id);
db.prepare('INSERT INTO absence_type_roles (type_id, role_id) VALUES (?, ?)').run(blockable.id, roleVollzeit.id);
const withOwnRole = (await empGet('/api/me/leave-types')).json().types as { id: number }[];
check(
  'Allowlist mit der eigenen Rolle gibt die Art wieder frei',
  withOwnRole.some((t) => t.id === blockable.id),
  withOwnRole.length,
);
db.prepare('DELETE FROM absence_type_roles WHERE type_id = ?').run(blockable.id);
const restoredTypes = (await empGet('/api/me/leave-types')).json().types as { id: number }[];
check('Ohne Regeln ist die Liste wieder vollständig', restoredTypes.length === baseTypes.length, restoredTypes.length);

// D4: Krankmeldungen dürfen nie blockiert werden.
const krankheitType = db
  .prepare("SELECT id FROM absence_types WHERE category = 'krankheit' ORDER BY id LIMIT 1")
  .get() as { id: number };
db.prepare(
  "INSERT INTO absence_type_employee_rules (type_id, employee_id, effect) VALUES (?, 1, 'deny')",
).run(krankheitType.id);
const sickDespiteDeny = await empPost('/api/me/sick-notes', {
  date_from: '2027-04-05',
  date_to: '2027-04-06',
});
check(
  'Krankmeldung trotz deny-Regel → 201 (Kategorie krankheit ist ausgenommen)',
  sickDespiteDeny.statusCode === 201,
  sickDespiteDeny.json(),
);
db.prepare('DELETE FROM absence_type_employee_rules WHERE type_id = ?').run(krankheitType.id);

// ------------------------------------------------------------- Vier-Augen ---
// Ben bekommt vorübergehend HR-Rechte — er ist damit ein HR-Konto MIT eigenem
// Personalprofil und darf den eigenen Antrag nicht entscheiden. Ein zweites
// Konto für dieselbe Person ginge nicht: users.employee_id ist UNIQUE.
// Die Rolle wird pro Request frisch geladen, das bestehende Token genügt.
db.prepare("UPDATE users SET role = 'admin' WHERE email = 'ben.berg@test.de'").run();
const selfApprove = await app.inject({
  method: 'POST',
  url: `/api/absences/requests/${benReqId}/approve`,
  headers: benAuth,
});
check('Vier-Augen: eigenen Antrag genehmigen → 403', selfApprove.statusCode === 403, selfApprove.json());
const selfReject = await app.inject({
  method: 'POST',
  url: `/api/absences/requests/${benReqId}/reject`,
  headers: benAuth,
  // Feldname `reason`; das Schema greift VOR dem Vier-Augen-Guard, ein
  // falscher Name liefert 400 statt des erwarteten 403.
  payload: { reason: 'Selbstablehnung' },
});
check('Vier-Augen: eigenen Antrag ablehnen → 403', selfReject.statusCode === 403, selfReject.json());
// Derselbe Account darf den Antrag einer ANDEREN Person weiterhin entscheiden
// (eigenes Fenster in 2027, damit es sich mit nichts oben überschneidet).
const annaPendingId = Number(
  insertRequest.run(1, urlaub.id, '2027-05-03', '2027-05-05', 3, 'beantragt').lastInsertRowid,
);
const foreignApprove = await app.inject({
  method: 'POST',
  url: `/api/absences/requests/${annaPendingId}/approve`,
  headers: benAuth,
});
check(
  'Vier-Augen: fremden Antrag genehmigen bleibt möglich',
  foreignApprove.statusCode === 200,
  foreignApprove.json(),
);
db.prepare("UPDATE users SET role = 'mitarbeiter' WHERE email = 'ben.berg@test.de'").run();

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
