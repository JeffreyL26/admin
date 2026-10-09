/**
 * Smoke-Test Modul Personalverwaltung & Stammdaten.
 * Aufruf: npx tsx apps/backend/src/modules/employees/smoke.ts
 * Wegwerf-DB via OHRGANIZE_DATA_DIR (Muster: src/test/smoke.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-employees-smoke-'));
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

/** ISO-Datum heute + n Tage (für datumsunabhängige Ablauf-Checks). */
function isoInDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Login ----------
const { auth } = await firstAdminLogin(app, check);

// ---------- Organisation anlegen ----------
const loc = await app.inject({
  method: 'POST',
  url: '/api/locations',
  headers: auth,
  payload: { name: 'Zentrale München', city: 'München', bundesland: 'BY' },
});
check('Standort anlegen', loc.statusCode === 201, loc.json());
const locationId = loc.json().location.id as number;

const badLoc = await app.inject({
  method: 'POST',
  url: '/api/locations',
  headers: auth,
  payload: { name: 'Kaputt', bundesland: 'XX' },
});
check('Standort mit ungültigem Bundesland → 400', badLoc.statusCode === 400);

const depA = await app.inject({
  method: 'POST',
  url: '/api/departments',
  headers: auth,
  payload: { name: 'Technik' },
});
const depAId = depA.json().department.id as number;
const depB = await app.inject({
  method: 'POST',
  url: '/api/departments',
  headers: auth,
  payload: { name: 'Entwicklung', parent_id: depAId },
});
const depBId = depB.json().department.id as number;
check('Abteilungen anlegen (Hierarchie)', depA.statusCode === 201 && depB.statusCode === 201);

// Zyklus: Technik unter Entwicklung hängen, obwohl Entwicklung unter Technik hängt.
const cycle = await app.inject({
  method: 'PATCH',
  url: `/api/departments/${depAId}`,
  headers: auth,
  payload: { parent_id: depBId },
});
check('Abteilungs-Zyklus → 409 (Konfliktfall)', cycle.statusCode === 409, cycle.json());

const team = await app.inject({
  method: 'POST',
  url: '/api/teams',
  headers: auth,
  payload: { name: 'Backend-Team', department_id: depBId },
});
check('Team anlegen', team.statusCode === 201);
const teamId = team.json().team.id as number;

// Abteilung mit Unterabteilung ist nicht loeschbar (409), sonst rueckte
// „Entwicklung“ still auf die oberste Ebene.
const delParent = await app.inject({ method: 'DELETE', url: `/api/departments/${depAId}`, headers: auth });
check('Abteilung mit Unterabteilung löschen → 409', delParent.statusCode === 409, delParent.json());

// Zweite Abteilung fuer den Team/Abteilungs-Abgleich.
const depC = await app.inject({
  method: 'POST',
  url: '/api/departments',
  headers: auth,
  payload: { name: 'Vertrieb' },
});
const depCId = depC.json().department.id as number;

// ---------- Mitarbeiter: typabhängige Pflichtfelder ----------
const invalidVollzeit = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Max', last_name: 'Muster', employee_type: 'vollzeit', weekly_hours: 40 },
});
check(
  'Vollzeit ohne IBAN/Steuerklasse/SV → 400 (Validierungsfehler)',
  invalidVollzeit.statusCode === 400,
  invalidVollzeit.json(),
);

const emp = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: {
    first_name: 'Erika',
    last_name: 'Musterfrau',
    email: 'erika@firma.de',
    employee_type: 'vollzeit',
    job_title: 'Senior Entwicklerin',
    department_id: depBId,
    team_id: teamId,
    location_id: locationId,
    hire_date: '2024-01-01',
    weekly_hours: 40,
    annual_leave_days: 30,
    iban: 'DE02120300000000202051',
    tax_class: 'I',
    social_security_number: '65 260885 M 007',
    private_city: 'Augsburg',
  },
});
check('Vollzeit vollständig anlegen → 201', emp.statusCode === 201, emp.json());
const empId = emp.json().employee.id as number;

// Team gehoert zu „Entwicklung“, Person soll nach „Vertrieb“: 400.
const teamMismatch = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { department_id: depCId },
});
check('PATCH Abteilung passt nicht zum Team → 400', teamMismatch.statusCode === 400, teamMismatch.json());
const teamMismatchPost = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Falsch', last_name: 'Zugeordnet', employee_type: 'freiberufler', department_id: depCId, team_id: teamId },
});
check('POST Team aus fremder Abteilung → 400', teamMismatchPost.statusCode === 400);
// Unbeteiligte Aenderung bleibt moeglich (keine Pruefung ohne Team/Abteilung im Patch).
const phoneOnly = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { phone: '0821 1234' },
});
check('PATCH ohne Team/Abteilung prüft den Abgleich nicht', phoneOnly.statusCode === 200);

// Teamleitung setzen (PATCH /api/teams/:id mit lead_employee_id).
const setLead = await app.inject({
  method: 'PATCH',
  url: `/api/teams/${teamId}`,
  headers: auth,
  payload: { lead_employee_id: empId },
});
check('Teamleitung setzen → 200', setLead.statusCode === 200 && setLead.json().team.lead_employee_id === empId);

const werkstudentTooMany = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: {
    first_name: 'Tim',
    last_name: 'Student',
    employee_type: 'werkstudent',
    weekly_hours: 25,
  },
});
check('Werkstudent mit 25h → 400', werkstudentTooMany.statusCode === 400);

const werkstudent = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Tim', last_name: 'Student', employee_type: 'werkstudent', weekly_hours: 18 },
});
check('Werkstudent mit 18h → 201', werkstudent.statusCode === 201);
const werkstudentId = werkstudent.json().employee.id as number;

const praktikantNoDates = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Pia', last_name: 'Praktikum', employee_type: 'praktikant' },
});
check('Praktikant ohne Zeitraum → 400', praktikantNoDates.statusCode === 400);

const freiberufler = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Frank', last_name: 'Frei', employee_type: 'freiberufler' },
});
check('Freiberufler ohne Steuer/SV → 201', freiberufler.statusCode === 201);

// ---------- Liste, lite-Kontrakt, Suche, Filter ----------
const lite = await app.inject({ method: 'GET', url: '/api/employees?fields=lite&status=aktiv', headers: auth });
const liteRows = lite.json().employees as Record<string, unknown>[];
const liteKeys = Object.keys(liteRows[0] ?? {}).sort();
check(
  'fields=lite liefert exakt den Kontrakt',
  lite.statusCode === 200 &&
    JSON.stringify(liteKeys) ===
      JSON.stringify(
        ['department_id', 'employee_type', 'first_name', 'id', 'job_title', 'last_name', 'location_id', 'status', 'team_id'].sort(),
      ),
  liteKeys,
);

const search = await app.inject({ method: 'GET', url: '/api/employees?search=augsburg', headers: auth });
check(
  'Suche über Privat-Ort findet Erika',
  search.json().employees.length === 1 && search.json().employees[0].first_name === 'Erika',
  search.json(),
);

const filter = await app.inject({
  method: 'GET',
  url: `/api/employees?employee_type=werkstudent&department_id=${depBId}`,
  headers: auth,
});
check('Filter employee_type+department kombiniert', filter.json().employees.length === 0);

const detail = await app.inject({ method: 'GET', url: `/api/employees/${empId}`, headers: auth });
check(
  'Detail mit Join-Namen + Reporting-Line',
  detail.statusCode === 200 &&
    detail.json().employee.department_name === 'Entwicklung' &&
    Array.isArray(detail.json().reporting_line),
);

// PATCH mit Typregel-Verletzung auf gemergtem Stand
const patchBad = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { iban: null },
});
check('PATCH entfernt Pflichtfeld → 400', patchBad.statusCode === 400);

// ---------- Verträge ----------
const c1 = await app.inject({
  method: 'POST',
  url: `/api/employees/${empId}/contracts`,
  headers: auth,
  payload: {
    contract_type: 'unbefristet',
    valid_from: '2024-01-01',
    probation_end: '2024-06-30',
    notice_period_weeks: 4,
    weekly_hours: 40,
    annual_leave_days: 30,
  },
});
check('Vertrag V1 anlegen', c1.statusCode === 201, c1.json());
const c1Id = c1.json().contract.id as number;

const c2 = await app.inject({
  method: 'POST',
  url: `/api/employees/${empId}/contracts`,
  headers: auth,
  payload: {
    contract_type: 'unbefristet',
    valid_from: '2025-07-01',
    notice_period_weeks: 8,
    weekly_hours: 35,
    annual_leave_days: 32,
  },
});
check('Vertrag V2 anlegen', c2.statusCode === 201);

const history = await app.inject({ method: 'GET', url: `/api/employees/${empId}/contracts`, headers: auth });
const contracts = history.json().contracts as { id: number; valid_to: string | null }[];
const closed = contracts.find((c) => c.id === c1Id);
check('V1 wurde auf Vortag geschlossen (2025-06-30)', closed?.valid_to === '2025-06-30', contracts);

const afterMirror = await app.inject({ method: 'GET', url: `/api/employees/${empId}`, headers: auth });
check(
  'weekly_hours/annual_leave_days auf employees gespiegelt',
  afterMirror.json().employee.weekly_hours === 35 && afterMirror.json().employee.annual_leave_days === 32,
  afterMirror.json().employee,
);

const patchClosed = await app.inject({
  method: 'PATCH',
  url: `/api/contracts/${c1Id}`,
  headers: auth,
  payload: { note: 'nachträglich' },
});
check('Korrektur geschlossener Version → 409 (Konfliktfall)', patchClosed.statusCode === 409);

const backdated = await app.inject({
  method: 'POST',
  url: `/api/employees/${empId}/contracts`,
  headers: auth,
  payload: { contract_type: 'befristet', valid_from: '2025-01-01', valid_to: null },
});
check('Neue Version vor Beginn der offenen → 409', backdated.statusCode === 409);

const patchOpen = await app.inject({
  method: 'PATCH',
  url: `/api/contracts/${c2.json().contract.id}`,
  headers: auth,
  payload: { weekly_hours: 36 },
});
check('Korrektur der offenen Version → 200', patchOpen.statusCode === 200);

// Befristete Version mit Ende in der Zukunft ist „aktuell“: sie spiegelt
// und laesst sich korrigieren; eine Befristung allein ist keine Historie.
const c3 = await app.inject({
  method: 'POST',
  url: `/api/employees/${empId}/contracts`,
  headers: auth,
  payload: {
    contract_type: 'befristet',
    valid_from: '2026-01-01',
    valid_to: isoInDays(200),
    weekly_hours: 38,
    annual_leave_days: 28,
    fixed_term_reason: 'Elternzeitvertretung',
  },
});
check('Befristete Version anlegen → 201', c3.statusCode === 201, c3.json());
const c3Id = c3.json().contract.id as number;
const afterFixed = await app.inject({ method: 'GET', url: `/api/employees/${empId}`, headers: auth });
check(
  'Befristete aktuelle Version spiegelt Stunden/Urlaub',
  afterFixed.json().employee.weekly_hours === 38 && afterFixed.json().employee.annual_leave_days === 28,
  afterFixed.json().employee,
);
const patchFixed = await app.inject({
  method: 'PATCH',
  url: `/api/contracts/${c3Id}`,
  headers: auth,
  payload: { note: 'korrigiert' },
});
check('Korrektur der befristeten aktuellen Version → 200', patchFixed.statusCode === 200, patchFixed.json());
const patchSuperseded = await app.inject({
  method: 'PATCH',
  url: `/api/contracts/${c2.json().contract.id}`,
  headers: auth,
  payload: { note: 'zu spät' },
});
check('Abgelöste (geschlossene) Vorversion → 409', patchSuperseded.statusCode === 409);

// Spiegelung laeuft durch die Typregeln: Werkstudent mit 30 Wochenstunden im Vertrag → 400.
const badMirror = await app.inject({
  method: 'POST',
  url: `/api/employees/${werkstudentId}/contracts`,
  headers: auth,
  payload: { contract_type: 'befristet', valid_from: '2026-01-01', weekly_hours: 30 },
});
check('Vertrag verletzt Typregel der Person → 400', badMirror.statusCode === 400, badMirror.json());
const werkstudentContracts = await app.inject({
  method: 'GET',
  url: `/api/employees/${werkstudentId}/contracts`,
  headers: auth,
});
check('Abgewiesener Vertrag wurde nicht gespeichert', werkstudentContracts.json().contracts.length === 0);

// Altbestand verletzt schon die Stundengrenze (Typwechsel ohne Stundenanpassung):
// Ein Vertrag, der nur Urlaubstage spiegelt, verursacht das nicht und bleibt erlaubt.
const { weekly_hours: werkstudentHours, annual_leave_days: werkstudentLeave } = getDb()
  .prepare('SELECT weekly_hours, annual_leave_days FROM employees WHERE id = ?')
  .get(werkstudentId) as { weekly_hours: number | null; annual_leave_days: number | null };
getDb().prepare('UPDATE employees SET weekly_hours = 30 WHERE id = ?').run(werkstudentId);
const leaveOnly = await app.inject({
  method: 'POST',
  url: `/api/employees/${werkstudentId}/contracts`,
  headers: auth,
  payload: { contract_type: 'befristet', valid_from: '2026-01-01', annual_leave_days: 20 },
});
check('Vertrag nur mit Urlaubstagen trotz Alt-Stundenverstoss → 201', leaveOnly.statusCode === 201, leaveOnly.json());
getDb().prepare('DELETE FROM contracts WHERE employee_id = ?').run(werkstudentId);
getDb()
  .prepare('UPDATE employees SET weekly_hours = ?, annual_leave_days = ? WHERE id = ?')
  .run(werkstudentHours, werkstudentLeave, werkstudentId);

// ---------- Org-Baum ----------
const tree = await app.inject({ method: 'GET', url: '/api/org/tree', headers: auth });
const roots = tree.json().tree as {
  name: string;
  total_employee_count: number;
  children: { name: string; employee_count: number; teams: { name: string }[] }[];
}[];
const technik = roots.find((r) => r.name === 'Technik');
check(
  'Org-Baum verschachtelt mit Mitarbeiterzahlen',
  tree.statusCode === 200 &&
    technik?.children[0]?.name === 'Entwicklung' &&
    technik.children[0].employee_count === 1 &&
    technik.total_employee_count === 1 &&
    technik.children[0].teams[0]?.name === 'Backend-Team',
  roots,
);

// ---------- Personen-Organigramm ----------
// Erika leitet die Abteilung „Entwicklung", Tim steht ohne Vorgesetzten in
// derselben Abteilung, Frank ist Erikas gepflegter Vorgesetzter. Erwartet:
// Tim hängt ersatzweise an Erika (Abteilungsleitung), Erika am gepflegten
// Feld unter Frank, Frank ist Wurzel.
const frankId = freiberufler.json().employee.id as number;
await app.inject({
  method: 'PATCH',
  url: `/api/departments/${depBId}`,
  headers: auth,
  payload: { head_employee_id: empId },
});
await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { department_id: depBId },
});
await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { manager_id: frankId },
});
const chart = await app.inject({ method: 'GET', url: '/api/org/chart', headers: auth });
type ChartPerson = { id: number; parent_id: number | null; parent_source: string | null; photo_url: string | null };
const people = chart.json().people as ChartPerson[];
const byId = new Map(people.map((p) => [p.id, p]));
check(
  'Personen-Organigramm: gepflegte und abgeleitete Berichtslinie',
  chart.statusCode === 200 &&
    byId.get(empId)?.parent_id === frankId &&
    byId.get(empId)?.parent_source === 'manager' &&
    byId.get(werkstudentId)?.parent_id === empId &&
    byId.get(werkstudentId)?.parent_source === 'department_head' &&
    byId.get(frankId)?.parent_id === null &&
    people.every((p) => p.photo_url === null),
  people,
);

// Ring: Frank soll unter Tim hängen, Tim hängt (abgeleitet) unter Erika,
// Erika unter Frank. Der Server muss die Kette an einer Stelle kappen.
await app.inject({
  method: 'PATCH',
  url: `/api/employees/${frankId}`,
  headers: auth,
  payload: { manager_id: werkstudentId },
});
const ring = await app.inject({ method: 'GET', url: '/api/org/chart', headers: auth });
const ringPeople = ring.json().people as ChartPerson[];
const ringById = new Map(ringPeople.map((p) => [p.id, p]));
const reachesRoot = (id: number): boolean => {
  const seen = new Set<number>();
  let cursor: number | null = id;
  while (cursor !== null) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = ringById.get(cursor)?.parent_id ?? null;
  }
  return true;
};
check(
  'Personen-Organigramm: Ring in manager_id wird aufgetrennt',
  ring.statusCode === 200 &&
    ringPeople.some((p) => p.parent_id === null) &&
    ringPeople.every((p) => reachesRoot(p.id)),
  ringPeople,
);

// ---------- Dokumente (Upload + FTS + Ablauf) ----------
const boundary = '----ohrganizeSmokeBoundary';
const filePart = (name: string, content: string, type = 'application/pdf') =>
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  );
const upload = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('Arbeitsvertrag_Musterfrau.pdf', '%PDF-1.4 dummy'),
});
check('Datei-Upload über Core', upload.statusCode === 200, upload.json());
const fileId = upload.json().file.id as number;

const doc = await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: {
    employee_id: empId,
    file_id: fileId,
    category: 'vertrag',
    title: 'Arbeitsvertrag 2024',
    note: 'Original unterschrieben',
    expiry_date: isoInDays(10),
    reminder_days: 30,
  },
});
check('Dokument-Metadaten anlegen', doc.statusCode === 201, doc.json());
const docId = doc.json().document.id as number;

const ftsByName = await app.inject({ method: 'GET', url: '/api/documents?search=Musterfrau', headers: auth });
check(
  'FTS findet Dokument über Mitarbeiternamen',
  ftsByName.json().documents.some((d: { id: number }) => d.id === docId),
  ftsByName.json(),
);
const ftsByTitle = await app.inject({ method: 'GET', url: '/api/documents?search=arbeitsvertr', headers: auth });
check(
  'FTS Prefix-Suche über Titel',
  ftsByTitle.json().documents.some((d: { id: number }) => d.id === docId),
);

const expiring = await app.inject({ method: 'GET', url: '/api/documents/expiring', headers: auth });
check(
  'Ablaufende Dokumente (Ablauf in 10 Tagen, reminder 30 Tage)',
  expiring.json().documents.some((d: { id: number }) => d.id === docId),
  expiring.json(),
);
{
  // Ausgeschiedene: Akte nur noch aufbewahrt, nichts mehr „ablaufend“.
  const owner = (getDb().prepare('SELECT employee_id FROM documents WHERE id = ?').get(docId) as { employee_id: number }).employee_id;
  getDb().prepare("UPDATE employees SET status = 'ausgeschieden' WHERE id = ?").run(owner);
  const gone = await app.inject({ method: 'GET', url: '/api/documents/expiring', headers: auth });
  getDb().prepare("UPDATE employees SET status = 'aktiv' WHERE id = ?").run(owner);
  check(
    'Ablaufende Dokumente ohne Ausgeschiedene',
    !gone.json().documents.some((d: { id: number }) => d.id === docId),
    gone.json(),
  );

  // Dashboard: Geburtstag heute (Kopfzeile), nur aktive Personen.
  const { todayIso } = await import('../../core/dates.js');
  const born = `1990-${todayIso().slice(5)}`;
  const before = (getDb().prepare('SELECT birth_date FROM employees WHERE id = ?').get(owner) as { birth_date: string | null }).birth_date;
  getDb().prepare('UPDATE employees SET birth_date = ? WHERE id = ?').run(born === '1990-02-29' ? '1992-02-29' : born, owner);
  const dash = await app.inject({ method: 'GET', url: '/api/dashboard', headers: auth });
  getDb().prepare("UPDATE employees SET status = 'ausgeschieden' WHERE id = ?").run(owner);
  const dashGone = await app.inject({ method: 'GET', url: '/api/dashboard', headers: auth });
  getDb().prepare("UPDATE employees SET status = 'aktiv', birth_date = ? WHERE id = ?").run(before, owner);
  const ids = (res: typeof dash) => ((res.json().birthdays_today ?? []) as { id: number }[]).map((b) => b.id);
  check(
    'Dashboard: birthdays_today nennt heutige Geburtstage, ohne Ausgeschiedene',
    ids(dash).includes(owner) && !ids(dashGone).includes(owner),
    { today: dash.json().birthdays_today, gone: dashGone.json().birthdays_today },
  );
}

// Versionierung
const upload2 = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('Arbeitsvertrag_Musterfrau_v2.pdf', '%PDF-1.4 dummy2'),
});
const doc2 = await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: {
    employee_id: empId,
    file_id: upload2.json().file.id,
    category: 'vertrag',
    title: 'Arbeitsvertrag 2024 (aktualisiert)',
    supersedes_id: docId,
  },
});
check('Neue Dokumentversion → version 2', doc2.json().document.version === 2, doc2.json());

const currentOnly = await app.inject({ method: 'GET', url: '/api/documents', headers: auth });
check(
  'Abgelöste Version standardmäßig ausgeblendet',
  !currentOnly.json().documents.some((d: { id: number }) => d.id === docId),
);

// Sichtbarkeit: Vorgabe 'portal'; ein Teil-Update ohne das Feld lässt sie in
// Ruhe; ein Wechsel gilt für die ganze Versionskette (das Portal listet auch
// abgelöste Versionen).
const doc2Id = doc2.json().document.id as number;
const visibilityOf = (id: number) =>
  (getDb().prepare('SELECT visibility FROM documents WHERE id = ?').get(id) as { visibility: string }).visibility;
check('Dokument ohne Angabe ist im Portal sichtbar', doc2.json().document.visibility === 'portal');
const titleOnly = await app.inject({
  method: 'PATCH',
  url: `/api/documents/${doc2Id}`,
  headers: auth,
  payload: { title: 'Arbeitsvertrag 2024 (v2)' },
});
check(
  'PATCH nur Titel lässt die Sichtbarkeit unangetastet',
  titleOnly.statusCode === 200 && titleOnly.json().document.visibility === 'portal',
  titleOnly.json(),
);
const toHr = await app.inject({
  method: 'PATCH',
  url: `/api/documents/${doc2Id}`,
  headers: auth,
  payload: { visibility: 'hr' },
});
check(
  'PATCH visibility=hr stellt aktuelle UND abgelöste Version um',
  toHr.statusCode === 200 && toHr.json().document.visibility === 'hr' && visibilityOf(docId) === 'hr',
  { v2: toHr.json().document.visibility, v1: visibilityOf(docId) },
);
const upload3 = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('Arbeitsvertrag_Musterfrau_v3.pdf', '%PDF-1.4 dummy3'),
});
const doc3 = await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: {
    employee_id: empId,
    file_id: upload3.json().file.id,
    category: 'vertrag',
    title: 'Arbeitsvertrag 2025',
    supersedes_id: doc2Id,
    visibility: 'portal',
  },
});
check(
  'Neue Version mit visibility=portal zieht die Vorgänger nach',
  doc3.statusCode === 201 && visibilityOf(doc2Id) === 'portal' && visibilityOf(docId) === 'portal',
  { v3: doc3.json().document?.visibility, v2: visibilityOf(doc2Id), v1: visibilityOf(docId) },
);
const badVisibility = await app.inject({
  method: 'PATCH',
  url: `/api/documents/${doc2Id}`,
  headers: auth,
  payload: { visibility: 'geheim' },
});
check('Ungültige Sichtbarkeit → 400', badVisibility.statusCode === 400);

const badDoc = await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: { file_id: fileId, category: 'quatsch', title: 'X' },
});
check('Ungültige Dokument-Kategorie → 400', badDoc.statusCode === 400);

const bySource = await app.inject({ method: 'GET', url: '/api/documents?source=portal', headers: auth });
check('Herkunftsfilter source=portal liefert keine HR-Uploads', bySource.json().documents.length === 0);
const byHr = await app.inject({ method: 'GET', url: '/api/documents?source=hr', headers: auth });
check(
  'Herkunftsfilter source=hr liefert die HR-Uploads',
  byHr.json().documents.some((d: { id: number }) => d.id === doc3.json().document.id),
);
const badSource = await app.inject({ method: 'GET', url: '/api/documents?source=mail', headers: auth });
check('Ungültige Herkunft → 400', badSource.statusCode === 400);

// Blättern (Dokumentablage): mit limit eine Seite samt total und offset;
// ohne limit wie bisher alles (Personalakte). Filter wirken über alle Seiten.
{
  const docsGet = async (query: string) =>
    (await app.inject({ method: 'GET', url: `/api/documents?${query}`, headers: auth })).json();
  const all = await docsGet('include_superseded=true');
  const rows = all.documents as { id: number }[];
  check('Dokumente ohne limit: alle, ohne total', rows.length >= 3 && all.total === undefined, all);
  const p1 = await docsGet('include_superseded=true&limit=1');
  const p2 = await docsGet('include_superseded=true&limit=1&offset=1');
  check(
    'Dokumente limit/offset: Seiten in der Sortierung, total über alle Seiten',
    p1.total === rows.length && p1.offset === 0 && p1.documents[0]?.id === rows[0].id &&
      p2.offset === 1 && p2.documents[0]?.id === rows[1].id && p2.documents.length === 1,
    { p1, p2 },
  );
  const lastId = rows[rows.length - 1].id;
  const focused = await docsGet(`include_superseded=true&limit=1&focus_id=${lastId}`);
  check('Dokumente focus_id liefert die Seite des Dokuments', focused.offset === rows.length - 1 && focused.documents[0]?.id === lastId, focused);
  const current = await docsGet('limit=1');
  const searched = await docsGet('search=Musterfrau&include_superseded=true&limit=1');
  check(
    'Dokumente: Filter und Suche zählen über alle Seiten',
    current.total === currentOnly.json().documents.length &&
      searched.total === (await docsGet('search=Musterfrau&include_superseded=true')).documents.length,
    { current: current.total, searched: searched.total },
  );
}

// ---------- Massenbearbeitung ----------
const bulk = await app.inject({
  method: 'POST',
  url: '/api/employees/bulk',
  headers: auth,
  payload: { ids: [empId, werkstudentId], set: { location_id: locationId, status: 'aktiv' } },
});
check('Bulk-Update transaktional', bulk.statusCode === 200 && bulk.json().updated === 2, bulk.json());

const bulkBadField = await app.inject({
  method: 'POST',
  url: '/api/employees/bulk',
  headers: auth,
  payload: { ids: [empId], set: { first_name: 'Hack' } },
});
check('Bulk mit nicht freigegebenem Feld → 400', bulkBadField.statusCode === 400);

const bulkRule = await app.inject({
  method: 'POST',
  url: '/api/employees/bulk',
  headers: auth,
  payload: { ids: [werkstudentId], set: { weekly_hours: 30 } },
});
check('Bulk verletzt Werkstudenten-Limit → 400', bulkRule.statusCode === 400);

// Reiner Abteilungswechsel per Massenbearbeitung: Das Team der alten
// Abteilung wird geloest, statt den Vorgang abzubrechen.
const bulkMove = await app.inject({
  method: 'POST',
  url: '/api/employees/bulk',
  headers: auth,
  payload: { ids: [empId], set: { department_id: depCId } },
});
const movedTeam = (await app.inject({ method: 'GET', url: `/api/employees/${empId}`, headers: auth })).json().employee.team_id as number | null;
check('Bulk-Abteilungswechsel loest unpassendes Team', bulkMove.statusCode === 200 && bulkMove.json().teams_cleared === 1 && movedTeam === null, bulkMove.json());
const bulkBack = await app.inject({
  method: 'POST',
  url: '/api/employees/bulk',
  headers: auth,
  payload: { ids: [empId], set: { department_id: depBId, team_id: teamId } },
});
check('Bulk: Abteilung und Team gemeinsam zurueck', bulkBack.statusCode === 200 && bulkBack.json().teams_cleared === 0, bulkBack.json());

// ---------- CSV-Export ----------
const csv = await app.inject({ method: 'GET', url: '/api/employees/export.csv?status=aktiv', headers: auth });
const csvBody = csv.body;
check(
  'CSV-Export: BOM, Semikolon, Kopfzeile, Inhalt',
  csv.statusCode === 200 &&
    !!csv.headers['content-type']?.toString().includes('text/csv') &&
    csvBody.charCodeAt(0) === 0xfeff &&
    csvBody.includes('first_name;last_name') &&
    csvBody.includes('Erika;Musterfrau'),
  csvBody.slice(0, 120),
);

// ---------- Person löschen: Dateien folgen ----------
// Frank bekommt ein Foto, dazu ein Dokument; nach dem DELETE sind Profil,
// Dokumentzeile und beide files-Zeilen weg. Erikas Dateien bleiben.
const photoUpload = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('frank.png', 'PNGDUMMY', 'image/png'),
});
const photoFileId = photoUpload.json().file.id as number;
const setPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${frankId}`,
  headers: auth,
  payload: { photo_file_id: photoFileId },
});
check('Eigener Bild-Upload als Foto → 200', setPhoto.statusCode === 200 && setPhoto.json().employee.photo_file_id === photoFileId, setPhoto.json());
const frankDocUpload = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('frank_nachweis.pdf', '%PDF-1.4 frank'),
});
const frankDocFileId = frankDocUpload.json().file.id as number;
await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: { employee_id: frankId, file_id: frankDocFileId, category: 'sonstiges', title: 'Nachweis Frank' },
});
const removePhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${frankId}`,
  headers: auth,
  payload: { photo_file_id: null },
});
check('PATCH photo_file_id = null löst das Foto', removePhoto.statusCode === 200 && removePhoto.json().employee.photo_file_id === null);
const fileExists = (id: number) => !!getDb().prepare('SELECT 1 FROM files WHERE id = ?').get(id);
check('Foto entfernt: die nirgends sonst verknüpfte Datei ist mit weg', !fileExists(photoFileId));
// Neues Foto für den folgenden Löschtest; ein Ersetzen räumt das alte ab.
const secondPhotoUpload = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('frank2.png', 'PNGDUMMY2', 'image/png'),
});
const secondPhotoId = secondPhotoUpload.json().file.id as number;
await app.inject({ method: 'PATCH', url: `/api/employees/${frankId}`, headers: auth, payload: { photo_file_id: secondPhotoId } });
const thirdPhotoUpload = await app.inject({
  method: 'POST',
  url: '/api/files',
  headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
  payload: filePart('frank3.png', 'PNGDUMMY3', 'image/png'),
});
const thirdPhotoId = thirdPhotoUpload.json().file.id as number;
await app.inject({ method: 'PATCH', url: `/api/employees/${frankId}`, headers: auth, payload: { photo_file_id: thirdPhotoId } });
check('Foto ersetzt: die alte Datei ist weg, die neue bleibt', !fileExists(secondPhotoId) && fileExists(thirdPhotoId));
const removedAudit = getDb()
  .prepare("SELECT details FROM audit_log WHERE entity = 'employee' AND entity_id = ? AND details LIKE '%removed_file%' ORDER BY id DESC LIMIT 1")
  .pluck()
  .get(frankId) as string | undefined;
check(
  'Foto ersetzt: der Audit-Eintrag nennt die entfernte Datei',
  !!removedAudit && JSON.parse(removedAudit).removed_file?.id === secondPhotoId && typeof JSON.parse(removedAudit).removed_file?.sha256 === 'string' && JSON.parse(removedAudit).removed_file?.name === undefined,
  removedAudit,
);
// Vorschaubild zum aktuellen Foto: Das Loeschen der Person nimmt es mit.
const uploadFileId = async (name: string, content: string, type: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: filePart(name, content, type),
    })
  ).json().file.id as number;
const frankThumbId = await uploadFileId('frank3_vorschau.webp', 'WEBPDUMMY3', 'image/webp');
await app.inject({ method: 'PATCH', url: `/api/employees/${frankId}`, headers: auth, payload: { photo_thumb_file_id: frankThumbId } });
const delFrank = await app.inject({ method: 'DELETE', url: `/api/employees/${frankId}`, headers: auth });
check(
  'Person löschen entfernt Foto, Vorschaubild und Dokumentdatei, fremde Dateien bleiben',
  delFrank.statusCode === 204 &&
    !fileExists(thirdPhotoId) &&
    !fileExists(frankThumbId) &&
    !fileExists(frankDocFileId) &&
    fileExists(fileId),
  { photo: fileExists(thirdPhotoId), thumb: fileExists(frankThumbId), doc: fileExists(frankDocFileId), erika: fileExists(fileId) },
);

// ---------- Vorschaubild des Fotos ----------
// Original und Vorschaubild an Erika. Das Vorschaubild gehoert zum Bereich
// personal (FILE_REFERENCES), Listen signieren es mit stabiler URL, und ein
// neues Foto ohne Vorschaubild raeumt das alte ab.
const erikaPhotoId = await uploadFileId('erika.jpg', 'JPEGDUMMY', 'image/jpeg');
const erikaThumbId = await uploadFileId('erika_vorschau.webp', 'WEBPDUMMY', 'image/webp');
const withThumb = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { photo_file_id: erikaPhotoId, photo_thumb_file_id: erikaThumbId },
});
check(
  'Vorschaubild: PATCH speichert photo_thumb_file_id neben dem Original',
  withThumb.statusCode === 200 &&
    withThumb.json().employee.photo_file_id === erikaPhotoId &&
    withThumb.json().employee.photo_thumb_file_id === erikaThumbId,
  withThumb.json(),
);
const thumbWithoutPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_thumb_file_id: erikaThumbId },
});
check('Vorschaubild ohne Foto → 400', thumbWithoutPhoto.statusCode === 400, thumbWithoutPhoto.json());

// Ohne Recht personal nicht signierbar. Fehlte der Eintrag in FILE_REFERENCES,
// gaelte die Datei als unverknuepfter eigener Upload und ginge durch (200).
const restrictedRoleId = Number(
  getDb().prepare("INSERT INTO admin_roles (name) VALUES ('Smoke ohne Personal')").run().lastInsertRowid,
);
getDb()
  .prepare("INSERT INTO admin_role_permissions (role_id, area, level) VALUES (?, 'kommunikation', 'lesen')")
  .run(restrictedRoleId);
getDb().prepare("UPDATE users SET admin_role_id = ? WHERE email = 'admin@ohrganize.de'").run(restrictedRoleId);
const thumbSignDenied = await app.inject({ method: 'POST', url: `/api/files/${erikaThumbId}/sign`, headers: auth });
getDb().prepare("UPDATE users SET admin_role_id = NULL WHERE email = 'admin@ohrganize.de'").run();
const thumbSign = await app.inject({ method: 'POST', url: `/api/files/${erikaThumbId}/sign`, headers: auth });
check(
  'Vorschaubild gehoert zum Bereich personal (ohne das Recht 403, mit 200)',
  thumbSignDenied.statusCode === 403 && thumbSign.statusCode === 200,
  { denied: thumbSignDenied.statusCode, allowed: thumbSign.statusCode },
);

// Zwei Listenabrufe kurz hintereinander: dieselbe Foto-URL. Faellt der Abruf
// genau auf eine Fenstergrenze, liegt die zweite ein Fenster spaeter.
const chartPhotoUrl = async () =>
  ((await app.inject({ method: 'GET', url: '/api/org/chart', headers: auth })).json().people as ChartPerson[]).find(
    (p) => p.id === empId,
  )?.photo_url ?? null;
const expiresOf = (url: string | null) => Number(new URL(url ?? '/', 'http://smoke').searchParams.get('expires'));
const firstUrl = await chartPhotoUrl();
const secondUrl = await chartPhotoUrl();
check(
  'Organigramm signiert das Vorschaubild',
  !!firstUrl && firstUrl.startsWith(`/api/files/${erikaThumbId}/download?`),
  firstUrl,
);
const chartOriginals = await app.inject({ method: 'GET', url: '/api/org/chart/originals', headers: auth });
const originalUrl = (chartOriginals.json().originals as Record<string, string> | undefined)?.[String(empId)] ?? null;
const originalDownload = await app.inject({ method: 'GET', url: originalUrl ?? '/' });
const auditSignsBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'file.sign'").get() as { n: number }).n;
check(
  'Originale des Organigramms auf Anforderung signiert (kein Selbstsignieren je Karte)',
  chartOriginals.statusCode === 200 &&
    !!originalUrl &&
    originalUrl.startsWith(`/api/files/${erikaPhotoId}/download?`) &&
    originalDownload.statusCode === 200 &&
    originalDownload.body === 'JPEGDUMMY',
  { status: chartOriginals.statusCode, url: originalUrl, download: originalDownload.statusCode },
);
check(
  'Organigramm selbst trägt keine Original-Links mehr',
  !((await app.inject({ method: 'GET', url: '/api/org/chart', headers: auth })).json().people as object[]).some(
    (p) => 'photo_original_url' in p,
  ) &&
    (getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'file.sign'").get() as { n: number }).n === auditSignsBefore,
);
check(
  'Zwei Listenabrufe liefern dieselbe Foto-URL',
  firstUrl === secondUrl || expiresOf(secondUrl) - expiresOf(firstUrl) === 600_000,
  { firstUrl, secondUrl },
);
const validFor = expiresOf(firstUrl) - Date.now();
check(
  'Fotolink endet am Fensterende: mindestens rund 60 s, hoechstens rund elf Minuten',
  expiresOf(firstUrl) % 600_000 === 0 && validFor > 50_000 && validFor <= 660_000,
  { expires: expiresOf(firstUrl), validFor },
);
const thumbDownload = await app.inject({ method: 'GET', url: firstUrl ?? '/' });
check(
  'Fotolink laedt das Vorschaubild, weiter mit Cache-Control no-store',
  thumbDownload.statusCode === 200 &&
    thumbDownload.body === 'WEBPDUMMY' &&
    String(thumbDownload.headers['cache-control']).includes('no-store'),
  { status: thumbDownload.statusCode, cache: thumbDownload.headers['cache-control'] },
);
const directoryUrl = async () =>
  ((await app.inject({ method: 'GET', url: '/api/communication/directory', headers: auth })).json().employees as {
    id: number;
    photo_url?: string | null;
  }[]).find((e) => e.id === empId)?.photo_url ?? null;
const directoryFirst = await directoryUrl();
const directorySecond = await directoryUrl();
check(
  'Verzeichnis: Vorschaubild mit derselben URL bei zwei Abrufen',
  !!directoryFirst &&
    directoryFirst.startsWith(`/api/files/${erikaThumbId}/download?`) &&
    (directoryFirst === directorySecond || expiresOf(directorySecond) - expiresOf(directoryFirst) === 600_000),
  { directoryFirst, directorySecond },
);

// Neues Foto ohne Vorschaubild: Das alte Vorschaubild faellt weg, die Liste
// zeigt das Original.
const erikaNewPhotoId = await uploadFileId('erika_neu.jpg', 'JPEGDUMMY2', 'image/jpeg');
const replacedWithoutThumb = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { photo_file_id: erikaNewPhotoId },
});
check(
  'Foto ersetzt ohne Vorschaubild: altes Foto und altes Vorschaubild sind weg, photo_thumb_file_id ist null',
  replacedWithoutThumb.statusCode === 200 &&
    replacedWithoutThumb.json().employee.photo_thumb_file_id === null &&
    !fileExists(erikaPhotoId) &&
    !fileExists(erikaThumbId) &&
    fileExists(erikaNewPhotoId),
  replacedWithoutThumb.json(),
);
const thumbAudit = getDb()
  .prepare("SELECT details FROM audit_log WHERE entity = 'employee' AND entity_id = ? ORDER BY id DESC LIMIT 1")
  .pluck()
  .get(empId) as string | undefined;
check(
  'Foto ersetzt: der Audit-Eintrag nennt das entfernte Vorschaubild',
  !!thumbAudit && JSON.parse(thumbAudit).removed_thumb_file?.id === erikaThumbId,
  thumbAudit,
);
const fallbackUrl = await chartPhotoUrl();
check(
  'Ohne Vorschaubild signiert die Liste das Original',
  !!fallbackUrl && fallbackUrl.startsWith(`/api/files/${erikaNewPhotoId}/download?`),
  fallbackUrl,
);

// ---------- Audit in derselben Transaktion ----------
// Ein TEMP-Trigger auf derselben Verbindung, über die auch die Routen
// schreiben, weist jeden Audit-Eintrag ab: Die Anfrage scheitert (5xx), und
// von der fachlichen Änderung bleibt nichts stehen. Dateien räumen die Routen
// erst nach dem Commit ab, also bleiben auch files-Zeile und Blob.
{
  const { config } = await import('../../config.js');
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
  const countOf = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const blobExists = (id: number) => {
    const row = getDb().prepare('SELECT stored_name FROM files WHERE id = ?').get(id) as { stored_name: string } | undefined;
    return !!row && fs.existsSync(path.join(config.storageDir, row.stored_name));
  };

  const departmentsBefore = countOf('departments');
  const brokenDep = await withBrokenAudit(() =>
    app.inject({ method: 'POST', url: '/api/departments', headers: auth, payload: { name: 'Audit-Probe' } }),
  );
  check(
    'Audit kaputt: Abteilung anlegen scheitert (5xx), keine Zeile',
    brokenDep.statusCode >= 500 && countOf('departments') === departmentsBefore,
    { status: brokenDep.statusCode },
  );

  const erikaBefore = getDb().prepare('SELECT job_title, updated_at FROM employees WHERE id = ?').get(empId);
  const brokenPatch = await withBrokenAudit(() =>
    app.inject({ method: 'PATCH', url: `/api/employees/${empId}`, headers: auth, payload: { job_title: 'Audit-Probe' } }),
  );
  check(
    'Audit kaputt: Person ändern scheitert (5xx), Akte unverändert',
    brokenPatch.statusCode >= 500 &&
      JSON.stringify(getDb().prepare('SELECT job_title, updated_at FROM employees WHERE id = ?').get(empId)) ===
        JSON.stringify(erikaBefore),
    { status: brokenPatch.statusCode },
  );

  // Gerda mit Foto und Dokument: Weder das Dokument noch die Person
  // verschwinden, solange das Audit scheitert, und ihre Dateien bleiben samt
  // Blob. Danach gelingt das Löschen und zählt beide Dateien.
  const gerda = await app.inject({
    method: 'POST',
    url: '/api/employees',
    headers: auth,
    payload: { first_name: 'Gerda', last_name: 'Probe', employee_type: 'freiberufler' },
  });
  const gerdaId = gerda.json().employee.id as number;
  const gerdaPhotoId = await uploadFileId('gerda.png', 'PNGGERDA', 'image/png');
  const gerdaDocFileId = await uploadFileId('gerda.pdf', '%PDF-1.4 gerda', 'application/pdf');
  await app.inject({ method: 'PATCH', url: `/api/employees/${gerdaId}`, headers: auth, payload: { photo_file_id: gerdaPhotoId } });
  const gerdaDoc = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: auth,
    payload: { employee_id: gerdaId, file_id: gerdaDocFileId, category: 'sonstiges', title: 'Nachweis Gerda' },
  });
  const gerdaDocId = gerdaDoc.json().document.id as number;
  const brokenDocDelete = await withBrokenAudit(() =>
    app.inject({ method: 'DELETE', url: `/api/documents/${gerdaDocId}`, headers: auth }),
  );
  check(
    'Audit kaputt: Dokument löschen scheitert (5xx), Zeile, Datei und Blob bleiben',
    gerda.statusCode === 201 &&
      gerdaDoc.statusCode === 201 &&
      brokenDocDelete.statusCode >= 500 &&
      !!getDb().prepare('SELECT id FROM documents WHERE id = ?').get(gerdaDocId) &&
      blobExists(gerdaDocFileId),
    { status: brokenDocDelete.statusCode },
  );
  const brokenDelete = await withBrokenAudit(() =>
    app.inject({ method: 'DELETE', url: `/api/employees/${gerdaId}`, headers: auth }),
  );
  check(
    'Audit kaputt: Person löschen scheitert (5xx), Profil, Dokument, Dateien und Blobs bleiben',
    brokenDelete.statusCode >= 500 &&
      !!getDb().prepare('SELECT id FROM employees WHERE id = ?').get(gerdaId) &&
      !!getDb().prepare('SELECT id FROM documents WHERE id = ?').get(gerdaDocId) &&
      blobExists(gerdaPhotoId) &&
      blobExists(gerdaDocFileId),
    { status: brokenDelete.statusCode },
  );
  const healedDelete = await app.inject({ method: 'DELETE', url: `/api/employees/${gerdaId}`, headers: auth });
  const deleteAudit = getDb()
    .prepare("SELECT details FROM audit_log WHERE entity = 'employee' AND entity_id = ? AND action = 'delete'")
    .pluck()
    .get(gerdaId) as string | undefined;
  check(
    'Audit heil: Person löschen gelingt, Dateien weg, Eintrag zählt sie',
    healedDelete.statusCode === 204 &&
      !fileExists(gerdaPhotoId) &&
      !fileExists(gerdaDocFileId) &&
      JSON.parse(deleteAudit ?? '{}').files_deleted === 2 &&
      JSON.parse(deleteAudit ?? '{}').files_kept === 0,
    { status: healedDelete.statusCode, deleteAudit },
  );

  // Der Audit-Eintrag sagt vor dem Commit, ob das Aufräumen danach die Datei
  // entfernt: Eine Datei an zwei Dokumenten bleibt beim ersten Löschen
  // (file_deleted false) und geht erst mit dem zweiten.
  const sharedFileId = await uploadFileId('geteilt.pdf', '%PDF-1.4 geteilt', 'application/pdf');
  const sharedDocs = [];
  for (const title of ['Geteilt A', 'Geteilt B']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth,
      payload: { employee_id: empId, file_id: sharedFileId, category: 'sonstiges', title },
    });
    sharedDocs.push(res.json().document.id as number);
  }
  const fileDeletedOf = async (docId: number) => {
    await app.inject({ method: 'DELETE', url: `/api/documents/${docId}`, headers: auth });
    const details = getDb()
      .prepare("SELECT details FROM audit_log WHERE entity = 'document' AND entity_id = ? AND action = 'delete'")
      .pluck()
      .get(docId) as string | undefined;
    return JSON.parse(details ?? '{}').file_deleted as boolean | undefined;
  };
  const firstDeleted = await fileDeletedOf(sharedDocs[0]);
  const keptAfterFirst = blobExists(sharedFileId);
  const secondDeleted = await fileDeletedOf(sharedDocs[1]);
  check(
    'Dokument löschen: file_deleted folgt dem Aufräumen nach dem Commit (geteilte Datei erst beim zweiten)',
    firstDeleted === false && keptAfterFirst && secondDeleted === true && !fileExists(sharedFileId),
    { firstDeleted, keptAfterFirst, secondDeleted },
  );
}

// ---------- Foto: nur eigene, unverknuepfte Bilder ----------
// Listen signieren Fotos fuer alle, die die Person sehen (signPhotoUrl). Eine
// beliebige Datei-ID als Foto verteilte sonst fremde Dateien, etwa eine
// Ausweiskopie aus der Dokumentablage oder eine Entgeltbescheinigung.
type PhotoError = { error?: { message?: string; details?: { field?: string } } };
const NOT_USABLE = 'Diese Datei lässt sich nicht als Foto verwenden.';
const rejectedAs = (res: { statusCode: number; json: () => unknown }, field: string, message: string) => {
  const err = (res.json() as PhotoError).error;
  return res.statusCode === 400 && err?.details?.field === field && !!err.message?.startsWith(message);
};
const photoOf = (id: number) =>
  getDb().prepare('SELECT photo_file_id, photo_thumb_file_id FROM employees WHERE id = ?').get(id) as {
    photo_file_id: number | null;
    photo_thumb_file_id: number | null;
  };

const idScanId = await uploadFileId('Ausweiskopie_Musterfrau.jpg', 'JPEGSCAN', 'image/jpeg');
const idScanDoc = await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: { employee_id: empId, file_id: idScanId, category: 'sonstiges', title: 'Ausweiskopie' },
});
check('Ausweiskopie (Bild) in der Dokumentablage', idScanDoc.statusCode === 201, idScanDoc.json());
const docAsPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_file_id: idScanId },
});
check(
  'Bild aus der Dokumentablage als Foto → 400, das Profil bleibt ohne Foto',
  rejectedAs(docAsPhoto, 'photo_file_id', NOT_USABLE) && photoOf(werkstudentId).photo_file_id === null,
  docAsPhoto.json(),
);

const certScanId = await uploadFileId('Entgeltbescheinigung_Musterfrau.png', 'PNGCERT', 'image/png');
getDb()
  .prepare("INSERT INTO certificates (employee_id, kind, period, file_id, status) VALUES (?, 'entgeltbescheinigung_108', '2026', ?, 'erstellt')")
  .run([empId, certScanId]);
const photoForCert = await uploadFileId('werkstudent.jpg', 'JPEGWS', 'image/jpeg');
const certAsThumb = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_file_id: photoForCert, photo_thumb_file_id: certScanId },
});
check(
  'Bescheinigung als Vorschaubild → 400, auch das Foto daneben wird nicht gespeichert',
  rejectedAs(certAsThumb, 'photo_thumb_file_id', NOT_USABLE) && photoOf(werkstudentId).photo_file_id === null,
  certAsThumb.json(),
);

const otherPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_file_id: erikaNewPhotoId },
});
check('Foto einer anderen Person → 400', rejectedAs(otherPhoto, 'photo_file_id', NOT_USABLE), otherPhoto.json());

const pdfId = await uploadFileId('Lebenslauf.pdf', '%PDF-1.4 cv', 'application/pdf');
const pdfAsPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_file_id: pdfId },
});
check(
  'Eigener Upload, aber kein Bild → 400 mit Hinweis auf Bilddateien',
  rejectedAs(pdfAsPhoto, 'photo_file_id', 'Als Foto sind nur Bilddateien möglich'),
  pdfAsPhoto.json(),
);

// Unverknuepftes Bild, aber nicht von diesem Konto hochgeladen (NULL: vom
// Server erzeugt oder Konto geloescht): ein fremder, laufender Upload.
const foreignId = await uploadFileId('fremd.jpg', 'JPEGFOREIGN', 'image/jpeg');
getDb().prepare('UPDATE files SET uploaded_by = NULL WHERE id = ?').run(foreignId);
const foreignAsPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_file_id: foreignId },
});
check('Fremder Upload als Foto → 400', rejectedAs(foreignAsPhoto, 'photo_file_id', NOT_USABLE), foreignAsPhoto.json());

const unknownAsPhoto = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${werkstudentId}`,
  headers: auth,
  payload: { photo_file_id: 999_999 },
});
check('Unbekannte Datei-ID als Foto → 400 statt Fremdschluesselfehler', rejectedAs(unknownAsPhoto, 'photo_file_id', NOT_USABLE), unknownAsPhoto.json());

const docAsPhotoOnCreate = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Fiona', last_name: 'Foto', employee_type: 'freiberufler', photo_file_id: idScanId },
});
check('POST mit Bild aus der Dokumentablage als Foto → 400', rejectedAs(docAsPhotoOnCreate, 'photo_file_id', NOT_USABLE), docAsPhotoOnCreate.json());
const createWithPhoto = await app.inject({
  method: 'POST',
  url: '/api/employees',
  headers: auth,
  payload: { first_name: 'Fiona', last_name: 'Foto', employee_type: 'freiberufler', photo_file_id: photoForCert },
});
check(
  'POST mit eigenem Bild-Upload als Foto → 201',
  createWithPhoto.statusCode === 201 && createWithPhoto.json().employee.photo_file_id === photoForCert,
  createWithPhoto.json(),
);

// Unveraenderte IDs: Das Formular schickt das bestehende Foto beim Speichern
// mit. Es zaehlt nicht als neu, auch wenn ein anderes Konto es hochgeladen hat
// und es schon verknuepft ist (an dieser Person).
const erikaThumbAgainId = await uploadFileId('erika_neu_vorschau.webp', 'WEBPDUMMY2', 'image/webp');
const addThumb = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { photo_thumb_file_id: erikaThumbAgainId },
});
check('Vorschaubild zum bestehenden Foto ergaenzen → 200', addThumb.statusCode === 200, addThumb.json());
getDb().prepare('UPDATE files SET uploaded_by = NULL WHERE id IN (?, ?)').run([erikaNewPhotoId, erikaThumbAgainId]);
const resave = await app.inject({
  method: 'PATCH',
  url: `/api/employees/${empId}`,
  headers: auth,
  payload: { photo_file_id: erikaNewPhotoId, photo_thumb_file_id: erikaThumbAgainId, phone: '+49 89 123' },
});
check(
  'Erneutes Speichern mit unveraenderten Foto-IDs → 200',
  resave.statusCode === 200 &&
    resave.json().employee.photo_file_id === erikaNewPhotoId &&
    resave.json().employee.photo_thumb_file_id === erikaThumbAgainId &&
    resave.json().employee.phone === '+49 89 123',
  resave.json(),
);

// ---------- Verknuepfen nur, was das Konto lesen darf ----------
// Eine Rolle mit personal, kommunikation und recruiting, aber ohne
// verguetung, haengt eine Entgeltbescheinigung an Dokument, Vertrag,
// Ankuendigung und Bewerberfoto: 403 (sonst laege die Datei danach auch im
// eigenen Bereich und waere signierbar). Eigene Uploads, eine lesbare Datei
// an einem zweiten Dokument und erneutes Speichern bleiben erlaubt.
{
  const salaryCertId = await uploadFileId('Entgeltbescheinigung_2026.pdf', '%PDF-1.4 entgelt', 'application/pdf');
  getDb()
    .prepare("INSERT INTO certificates (employee_id, kind, period, file_id, status) VALUES (?, 'entgeltbescheinigung_108', '2026', ?, 'erstellt')")
    .run([empId, salaryCertId]);
  const sharedDocFileId = await uploadFileId('Hausordnung.pdf', '%PDF-1.4 hausordnung', 'application/pdf');
  const firstShared = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: auth,
    payload: { employee_id: werkstudentId, file_id: sharedDocFileId, category: 'sonstiges', title: 'Hausordnung' },
  });
  check('Dokument mit eigener Datei (volle Rechte) → 201', firstShared.statusCode === 201, firstShared.json());

  // Datensaetze fuer die uebrigen Verknuepfungsrouten, angelegt mit vollen
  // Rechten: Krankmeldung, Trainingsanmeldung, Vorlage, aktueller Vertrag,
  // Stelle.
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
  const sickNote = await post('/api/absences/sick-notes', { employee_id: empId, date_from: '2031-03-03', date_to: '2031-03-05' });
  const training = await post('/api/performance/trainings', { title: 'Erste Hilfe' });
  const registration = await post('/api/performance/training-registrations', {
    training_id: training.json().training?.id,
    employee_id: empId,
  });
  const template = await post('/api/admin/templates', {
    file_id: await uploadFileId('Musterschreiben.pdf', '%PDF-1.4 muster', 'application/pdf'),
    category: 'schreiben',
    title: 'Musterschreiben',
  });
  const freelancerId = createWithPhoto.json().employee.id as number;
  const contract = await post(`/api/employees/${freelancerId}/contracts`, { contract_type: 'werkvertrag', valid_from: isoInDays(-1) });
  const posting = await post('/api/recruiting/postings', { title: 'Probestelle', employment_type: 'vollzeit', seats: 1 });
  check(
    'Vorbereitung: Krankmeldung, Training, Anmeldung, Vorlage, Vertrag und Stelle angelegt',
    [sickNote, training, registration, template, contract, posting].every((r) => r.statusCode === 201),
    [sickNote, training, registration, template, contract, posting].map((r) => [r.statusCode, r.statusCode === 201 ? '' : r.json()]),
  );
  const sickNoteId = sickNote.json().sick_note?.id as number;
  const registrationId = registration.json().registration?.id as number;
  const templateId = template.json().template?.id as number;
  const contractId = contract.json().contract?.id as number;
  const postingId = posting.json().posting?.id as number;

  const linkRoleId = Number(
    getDb().prepare("INSERT INTO admin_roles (name) VALUES ('Smoke ohne Verguetung')").run().lastInsertRowid,
  );
  const grant = getDb().prepare("INSERT INTO admin_role_permissions (role_id, area, level) VALUES (?, ?, 'bearbeiten')");
  for (const area of ['personal', 'kommunikation', 'recruiting', 'abwesenheit', 'leistung', 'verwaltung']) {
    grant.run([linkRoleId, area]);
  }
  // 403 aus assertMayLinkFiles, nicht aus der Bereichspruefung der Route.
  const linkDenied = (res: { statusCode: number; json: () => unknown }) =>
    res.statusCode === 403 &&
    (res.json() as { error?: { message?: string } }).error?.message === 'Für diese Datei haben Sie keine Berechtigung.';
  getDb().prepare("UPDATE users SET admin_role_id = ? WHERE email = 'admin@ohrganize.de'").run(linkRoleId);
  try {
    const documentCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
    const docsBefore = documentCount();
    const certAsDoc = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth,
      payload: { employee_id: empId, file_id: salaryCertId, category: 'sonstiges', title: 'Kopie', visibility: 'portal' },
    });
    check(
      'Ohne verguetung: Entgeltbescheinigung als Dokument → 403, keine Zeile',
      linkDenied(certAsDoc) && documentCount() === docsBefore,
      certAsDoc.json(),
    );
    const certSignDenied = await app.inject({ method: 'POST', url: `/api/files/${salaryCertId}/sign`, headers: auth });
    check('Ohne verguetung: die Bescheinigung bleibt nicht signierbar', certSignDenied.statusCode === 403);

    const ownDocFileId = await uploadFileId('Nachweis_eigen.pdf', '%PDF-1.4 eigen', 'application/pdf');
    const ownDoc = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth,
      payload: { employee_id: empId, file_id: ownDocFileId, category: 'sonstiges', title: 'Eigener Nachweis' },
    });
    check('Ohne verguetung: eigener Upload als Dokument → 201', ownDoc.statusCode === 201, ownDoc.json());
    const secondShared = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth,
      payload: { employee_id: empId, file_id: sharedDocFileId, category: 'sonstiges', title: 'Hausordnung' },
    });
    check(
      'Lesbare Datei eines anderen Dokuments an ein zweites Dokument → 201',
      secondShared.statusCode === 201,
      secondShared.json(),
    );

    const certAsContract = await app.inject({
      method: 'POST',
      url: `/api/employees/${empId}/contracts`,
      headers: auth,
      payload: { contract_type: 'unbefristet', valid_from: '2030-01-01', document_file_id: salaryCertId },
    });
    check('Ohne verguetung: Entgeltbescheinigung als Vertragsdokument → 403', linkDenied(certAsContract), certAsContract.json());

    const announcement = (attachmentIds: number[]) => ({
      title: 'Anhangprobe',
      body: 'Probe',
      audience_type: 'alle',
      audience_id: null,
      publish_at: isoInDays(0),
      expires_at: null,
      requires_ack: false,
      attachment_file_ids: attachmentIds,
    });
    const certAsAttachment = await app.inject({
      method: 'POST',
      url: '/api/communication/announcements',
      headers: auth,
      payload: announcement([salaryCertId]),
    });
    check('Ohne verguetung: Entgeltbescheinigung als Ankuendigungsanhang → 403', linkDenied(certAsAttachment), certAsAttachment.json());
    const ownAttachmentId = await uploadFileId('Aushang.pdf', '%PDF-1.4 aushang', 'application/pdf');
    const withOwnAttachment = await app.inject({
      method: 'POST',
      url: '/api/communication/announcements',
      headers: auth,
      payload: announcement([ownAttachmentId]),
    });
    check('Ohne verguetung: eigener Upload als Anhang → 201', withOwnAttachment.statusCode === 201, withOwnAttachment.json());
    const announcementId = withOwnAttachment.json().announcement?.id as number;
    const resaveAnnouncement = await app.inject({
      method: 'PUT',
      url: `/api/communication/announcements/${announcementId}`,
      headers: auth,
      payload: announcement([ownAttachmentId]),
    });
    check('Ankuendigung mit bestehendem Anhang erneut speichern → 200', resaveAnnouncement.statusCode === 200, resaveAnnouncement.json());

    const certAsCandidatePhoto = await app.inject({
      method: 'POST',
      url: '/api/recruiting/candidates',
      headers: auth,
      payload: { first_name: 'Carla', last_name: 'Kandidat', source: 'website', photo_file_id: salaryCertId },
    });
    check('Ohne verguetung: Entgeltbescheinigung als Bewerberfoto → 403', linkDenied(certAsCandidatePhoto), certAsCandidatePhoto.json());
    const candidatePhotoId = await uploadFileId('carla.jpg', 'JPEGCARLA', 'image/jpeg');
    const withOwnPhoto = await app.inject({
      method: 'POST',
      url: '/api/recruiting/candidates',
      headers: auth,
      payload: { first_name: 'Carla', last_name: 'Kandidat', source: 'website', photo_file_id: candidatePhotoId },
    });
    check('Ohne verguetung: eigener Upload als Bewerberfoto → 201', withOwnPhoto.statusCode === 201, withOwnPhoto.json());

    // Die uebrigen Verknuepfungsrouten mit derselben Bescheinigung.
    const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) =>
      app.inject({ method, url, headers: auth, payload: payload as object });
    const denied: Record<string, Awaited<ReturnType<typeof send>>> = {
      'Krankmeldung anlegen': await send('POST', '/api/absences/sick-notes', {
        employee_id: empId,
        date_from: '2031-04-07',
        date_to: '2031-04-08',
        certificate_file_id: salaryCertId,
      }),
      'AU-Bescheinigung nachtragen': await send('PATCH', `/api/absences/sick-notes/${sickNoteId}`, { certificate_file_id: salaryCertId }),
      'Trainingszertifikat': await send('PUT', `/api/performance/training-registrations/${registrationId}`, {
        certificate_file_id: salaryCertId,
      }),
      'Vorlage anlegen': await send('POST', '/api/admin/templates', { file_id: salaryCertId, category: 'schreiben', title: 'Kopie' }),
      'Vorlage Datei tauschen': await send('PATCH', `/api/admin/templates/${templateId}`, { file_id: salaryCertId }),
      'Vertrag korrigieren': await send('PATCH', `/api/contracts/${contractId}`, { document_file_id: salaryCertId }),
      'Bewerbung mit Lebenslauf': await send('POST', '/api/recruiting/applications', {
        posting_id: postingId,
        candidate: { first_name: 'Lena', last_name: 'Lauf', source: 'website' },
        cv_file_id: salaryCertId,
      }),
      'Bewerbung mit neuer Person samt Foto': await send('POST', '/api/recruiting/applications', {
        posting_id: postingId,
        candidate: { first_name: 'Lena', last_name: 'Lauf', source: 'website', photo_file_id: salaryCertId },
      }),
    };
    const notDenied = Object.entries(denied).filter(([, res]) => !linkDenied(res));
    check(
      'Ohne verguetung: AU, Training, Vorlagen, Vertragskorrektur, Lebenslauf und Bewerberfoto → 403',
      notDenied.length === 0,
      notDenied.map(([name, res]) => [name, res.statusCode, res.json()]),
    );

    // Bestehende Person: Die mitgeschickte (ignorierte) Person wird nicht
    // angelegt, ihr Foto also auch nicht geprueft.
    const carlaId = withOwnPhoto.json().candidate?.id as number;
    const forExisting = await send('POST', '/api/recruiting/applications', {
      posting_id: postingId,
      candidate_id: carlaId,
      candidate: { first_name: 'Ignoriert', last_name: 'Ignoriert', source: 'website', photo_file_id: salaryCertId },
    });
    check('Bewerbung fuer bestehende Person: ignoriertes Foto wird nicht geprueft → 201', forExisting.statusCode === 201, forExisting.json());
    const cvDenied = await send('PATCH', `/api/recruiting/applications/${forExisting.json().application?.id}`, {
      cv_file_id: salaryCertId,
    });
    check('Ohne verguetung: Lebenslauf einer Bewerbung tauschen → 403', linkDenied(cvDenied), cvDenied.json());

    // Bearbeiten bestehender Datensaetze: Die eigene Datei bleibt, die fremde
    // kommt nicht hinzu (PUT, PATCH teilen sich das Schema mit dem Anlegen).
    const editDenied: Record<string, Awaited<ReturnType<typeof send>>> = {
      'Bewerber bearbeiten': await send('PUT', `/api/recruiting/candidates/${carlaId}`, {
        first_name: 'Carla',
        last_name: 'Kandidat',
        source: 'website',
        photo_file_id: salaryCertId,
      }),
      'Ankuendigung bearbeiten': await send(
        'PUT',
        `/api/communication/announcements/${announcementId}`,
        announcement([ownAttachmentId, salaryCertId]),
      ),
      'Dokument Datei tauschen': await send('PATCH', `/api/documents/${ownDoc.json().document?.id}`, { file_id: salaryCertId }),
    };
    const editNotDenied = Object.entries(editDenied).filter(([, res]) => !linkDenied(res));
    check(
      'Ohne verguetung: Bewerber, Ankuendigung und Dokument bearbeiten mit Bescheinigung → 403',
      editNotDenied.length === 0,
      editNotDenied.map(([name, res]) => [name, res.statusCode, res.json()]),
    );

    const unknownAttachment = await app.inject({
      method: 'POST',
      url: '/api/communication/announcements',
      headers: auth,
      payload: announcement([999_999]),
    });
    check('Unbekannte Datei-ID beim Verknuepfen → 404 statt 403', unknownAttachment.statusCode === 404, unknownAttachment.json());
  } finally {
    getDb().prepare("UPDATE users SET admin_role_id = NULL WHERE email = 'admin@ohrganize.de'").run();
  }

  // Wer die Bescheinigung lesen darf (hier Vollzugriff), darf sie weiter
  // verknuepfen: Die Regel schraenkt nur den Fall ohne Leserecht ein.
  const certAsDocFull = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: auth,
    payload: { employee_id: empId, file_id: salaryCertId, category: 'bescheinigung', title: 'Entgeltbescheinigung 2026' },
  });
  check('Mit Leserecht (Vollzugriff): Entgeltbescheinigung als Dokument → 201', certAsDocFull.statusCode === 201, certAsDocFull.json());

  // Freelancer-Rechnungen verlangen selbst verguetung: Eine Rolle nur mit
  // verguetung haengt die Ausweiskopie (Bereich personal) als Beleg an.
  const payRoleId = Number(getDb().prepare("INSERT INTO admin_roles (name) VALUES ('Smoke nur Verguetung')").run().lastInsertRowid);
  getDb()
    .prepare("INSERT INTO admin_role_permissions (role_id, area, level) VALUES (?, 'verguetung', 'bearbeiten')")
    .run(payRoleId);
  getDb().prepare("UPDATE users SET admin_role_id = ? WHERE email = 'admin@ohrganize.de'").run(payRoleId);
  try {
    const invoice = (number: string, fileId: number) =>
      app.inject({
        method: 'POST',
        url: '/api/compensation/freelancer-invoices',
        headers: auth,
        payload: { employee_id: freelancerId, invoice_number: number, invoice_date: '2026-09-30', amount_cents: 120_000, file_id: fileId },
      });
    const scanAsInvoice = await invoice('R-2026-1', idScanId);
    check('Nur verguetung: Ausweiskopie als Rechnungsbeleg → 403', linkDenied(scanAsInvoice), scanAsInvoice.json());
    const ownInvoice = await invoice('R-2026-2', await uploadFileId('Rechnung.pdf', '%PDF-1.4 rechnung', 'application/pdf'));
    check('Nur verguetung: eigener Upload als Rechnungsbeleg → 201', ownInvoice.statusCode === 201, ownInvoice.json());
  } finally {
    getDb().prepare("UPDATE users SET admin_role_id = NULL WHERE email = 'admin@ohrganize.de'").run();
  }
}

// ---------- Auth-Pflicht ----------
const noAuth = await app.inject({ method: 'GET', url: '/api/employees' });
check('Employees-Routen sind auth-pflichtig', noAuth.statusCode === 401);

await app.close();
closeDb();
try {
  fs.rmSync(process.env.OHRGANIZE_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows/WAL-Reste im Tempdir sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Employees-Smoke-Checks bestanden.');
