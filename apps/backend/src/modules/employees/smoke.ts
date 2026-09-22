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
const { weekly_hours: werkstudentHours } = getDb()
  .prepare('SELECT weekly_hours FROM employees WHERE id = ?')
  .get(werkstudentId) as { weekly_hours: number | null };
getDb().prepare('UPDATE employees SET weekly_hours = 30 WHERE id = ?').run(werkstudentId);
const leaveOnly = await app.inject({
  method: 'POST',
  url: `/api/employees/${werkstudentId}/contracts`,
  headers: auth,
  payload: { contract_type: 'befristet', valid_from: '2026-01-01', annual_leave_days: 20 },
});
check('Vertrag nur mit Urlaubstagen trotz Alt-Stundenverstoss → 201', leaveOnly.statusCode === 201, leaveOnly.json());
getDb().prepare('DELETE FROM contracts WHERE employee_id = ?').run(werkstudentId);
getDb().prepare('UPDATE employees SET weekly_hours = ? WHERE id = ?').run(werkstudentHours, werkstudentId);

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
const filePart = (name: string, content: string) =>
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n${content}\r\n--${boundary}--\r\n`,
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
  payload: filePart('frank.png', 'PNGDUMMY'),
});
const photoFileId = photoUpload.json().file.id as number;
await app.inject({
  method: 'PATCH',
  url: `/api/employees/${frankId}`,
  headers: auth,
  payload: { photo_file_id: photoFileId },
});
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
await app.inject({ method: 'PATCH', url: `/api/employees/${frankId}`, headers: auth, payload: { photo_file_id: photoFileId } });
const fileExists = (id: number) => !!getDb().prepare('SELECT 1 FROM files WHERE id = ?').get(id);
const delFrank = await app.inject({ method: 'DELETE', url: `/api/employees/${frankId}`, headers: auth });
check(
  'Person löschen entfernt Foto und Dokumentdatei, fremde Dateien bleiben',
  delFrank.statusCode === 204 && !fileExists(photoFileId) && !fileExists(frankDocFileId) && fileExists(fileId),
  { photo: fileExists(photoFileId), doc: fileExists(frankDocFileId), erika: fileExists(fileId) },
);

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
