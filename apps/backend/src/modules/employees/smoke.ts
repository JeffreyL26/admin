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
const { closeDb } = await import('../../db/db.js');
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

const badDoc = await app.inject({
  method: 'POST',
  url: '/api/documents',
  headers: auth,
  payload: { file_id: fileId, category: 'quatsch', title: 'X' },
});
check('Ungültige Dokument-Kategorie → 400', badDoc.statusCode === 400);

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
