/**
 * Smoke-Test des Vergütungs-Moduls gegen eine Wegwerf-Datenbank
 * (Muster: src/test/smoke.ts). Aufruf:
 *   npx tsx apps/backend/src/modules/compensation/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HRMONIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrmonic-comp-smoke-'));
process.env.HRMONIC_LOG_LEVEL = 'silent';

const { buildServer } = await import('../../server.js');
const { getDb, closeDb } = await import('../../db/db.js');
const { firstAdminLogin } = await import('../../test/adminSession.js');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();
const db = getDb();

// Datumsanker: aktueller Monat, damit der Test unabhängig vom realen Datum läuft.
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const monthStart = `${month}-01`;
const [y, m] = month.split('-').map(Number);
const nextMonthStart = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
const day15 = `${month}-15`;

// Testdaten direkt in die Kerntabellen (das Personal-Modul läuft parallel und
// ist hier bewusst nicht Voraussetzung).
const insertEmployee = db.prepare(
  `INSERT INTO employees (first_name, last_name, employee_type, status, hire_date, weekly_hours, iban, tax_id, social_security_number)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const e1 = Number(
  insertEmployee.run('Anna', 'Muster', 'vollzeit', 'aktiv', '2020-01-01', 40, 'DE02120300000000202051', '12345678901', '12 160894 M 007').lastInsertRowid,
);
const e2 = Number(
  insertEmployee.run('Ben', 'Klein', 'minijob', 'aktiv', day15, 5, null, null, null).lastInsertRowid,
);
const e3 = Number(
  insertEmployee.run('Cara', 'Frei', 'freiberufler', 'aktiv', '2023-05-01', null, 'DE02100100100006820101', null, null).lastInsertRowid,
);

// Ziel-Tabelle gemäß Kontrakt (Leistungs-Modul) — falls dessen Migration im
// Test-Setup noch fehlt, wird die Kontrakt-Struktur angelegt.
let goalId: number | null = null;
try {
  db.exec(
    `CREATE TABLE IF NOT EXISTS goals (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       employee_id INTEGER NOT NULL,
       title TEXT NOT NULL,
       progress INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'aktiv'
     )`,
  );
  goalId = Number(
    db
      .prepare(`INSERT INTO goals (employee_id, title, progress, status) VALUES (?, ?, ?, ?)`)
      .run(e1, 'Umsatzziel Q3', 60, 'aktiv').lastInsertRowid,
  );
} catch {
  // Fremdschema weicht ab → Zielkopplungs-Checks werden übersprungen.
}

const { auth } = await firstAdminLogin(app, check);

// ---------------- Gehaltskomponenten ----------------

const c1 = await app.inject({
  method: 'POST',
  url: `/api/compensation/employees/${e1}/components`,
  headers: auth,
  payload: { kind: 'grundgehalt', amount_cents: 500000, valid_from: '2020-01-01' },
});
check('Komponente anlegen → 201', c1.statusCode === 201, c1.json());

const c2 = await app.inject({
  method: 'POST',
  url: `/api/compensation/employees/${e1}/components`,
  headers: auth,
  payload: { kind: 'grundgehalt', amount_cents: 520000, valid_from: monthStart, note: 'Reguläre Anpassung' },
});
check('Nachfolge-Komponente gleicher Art → 201', c2.statusCode === 201, c2.json());

const history = await app.inject({
  method: 'GET',
  url: `/api/compensation/employees/${e1}/salary/history`,
  headers: auth,
});
const histRows = history.json().components as { kind: string; valid_to: string | null; amount_cents: number }[];
const closedRow = histRows.find((r) => r.amount_cents === 500000);
check(
  'Lückenlose Historie: Vorgänger geschlossen (valid_to = Vortag)',
  history.statusCode === 200 && closedRow?.valid_to !== null && closedRow!.valid_to! < monthStart,
  histRows,
);

const overlap = await app.inject({
  method: 'POST',
  url: `/api/compensation/employees/${e1}/components`,
  headers: auth,
  payload: { kind: 'grundgehalt', amount_cents: 510000, valid_from: '2021-06-01' },
});
check('Überschneidung → 409', overlap.statusCode === 409, overlap.json());

const invalid = await app.inject({
  method: 'POST',
  url: `/api/compensation/employees/${e1}/components`,
  headers: auth,
  payload: { kind: 'grundgehalt', amount_cents: -5, valid_from: 'nicht-ein-datum' },
});
check('Validierungsfehler → 400', invalid.statusCode === 400, invalid.json());

const freelancerComp = await app.inject({
  method: 'POST',
  url: `/api/compensation/employees/${e3}/components`,
  headers: auth,
  payload: { kind: 'grundgehalt', amount_cents: 100000, valid_from: '2024-01-01' },
});
check('Gehaltskomponente für Freiberufler:in → 400', freelancerComp.statusCode === 400);

const salary = await app.inject({
  method: 'GET',
  url: `/api/compensation/employees/${e1}/salary`,
  headers: auth,
});
check(
  'Aktuelle Vergütung: Monatsbrutto 5.200 €',
  salary.statusCode === 200 && salary.json().salary.monthly_gross_cents === 520000,
  salary.json(),
);

const overview = await app.inject({ method: 'GET', url: '/api/compensation/salaries', headers: auth });
const overviewRows = overview.json().salaries as { employee_id: number; monthly_gross_cents: number }[];
check(
  'Gesamtübersicht ohne Freiberufler:innen',
  overview.statusCode === 200 &&
    overviewRows.some((r) => r.employee_id === e1 && r.monthly_gross_cents === 520000) &&
    !overviewRows.some((r) => r.employee_id === e3),
  overviewRows,
);

// ---------------- Gehaltsänderungs-Workflow ----------------

const noReason = await app.inject({
  method: 'POST',
  url: '/api/compensation/change-requests',
  headers: auth,
  payload: { employee_id: e1, kind: 'grundgehalt', new_amount_cents: 530000, effective_date: nextMonthStart, reason: '' },
});
check('Änderungsantrag ohne Begründung → 400', noReason.statusCode === 400);

const request = await app.inject({
  method: 'POST',
  url: '/api/compensation/change-requests',
  headers: auth,
  payload: { employee_id: e1, kind: 'grundgehalt', new_amount_cents: 530000, effective_date: nextMonthStart, reason: 'Beförderung zur Teamleitung' },
});
check('Änderungsantrag → 201', request.statusCode === 201, request.json());
const requestId = request.json().request.id as number;

const decide = await app.inject({
  method: 'POST',
  url: `/api/compensation/change-requests/${requestId}/decide`,
  headers: auth,
  payload: { decision: 'genehmigt', decision_note: 'Passt zum Budget' },
});
check('Genehmigung → Status genehmigt', decide.statusCode === 200 && decide.json().request.status === 'genehmigt');

const historyAfter = await app.inject({
  method: 'GET',
  url: `/api/compensation/employees/${e1}/salary/history`,
  headers: auth,
});
check(
  'Genehmigung wendet Komponente an (3 Grundgehalts-Zeilen)',
  (historyAfter.json().components as { kind: string }[]).filter((r) => r.kind === 'grundgehalt').length === 3,
  historyAfter.json(),
);

const decideAgain = await app.inject({
  method: 'POST',
  url: `/api/compensation/change-requests/${requestId}/decide`,
  headers: auth,
  payload: { decision: 'abgelehnt' },
});
check('Doppelte Entscheidung → 409', decideAgain.statusCode === 409);

const auditRes = await app.inject({
  method: 'GET',
  url: `/api/compensation/employees/${e1}/audit`,
  headers: auth,
});
const auditEntries = auditRes.json().entries as { action: string; details: { reason?: string; old_amount_cents?: number; new_amount_cents?: number } | null }[];
const approveEntry = auditEntries.find((a) => a.action === 'salary_change_request.approve');
check(
  'Audit-Trail: wer/wann/was/warum (alter/neuer Betrag + Begründung)',
  auditRes.statusCode === 200 &&
    !!approveEntry &&
    approveEntry.details?.old_amount_cents === 520000 &&
    approveEntry.details?.new_amount_cents === 530000 &&
    approveEntry.details?.reason === 'Beförderung zur Teamleitung',
  auditEntries,
);

// ---------------- Boni ----------------

const badBonus = await app.inject({
  method: 'POST',
  url: '/api/compensation/bonuses',
  headers: auth,
  payload: { employee_id: e1, kind: 'zielbonus', title: 'Ohne Zielbetrag', goal_id: goalId ?? 1, payout_month: month },
});
check('Zielbonus ohne Zielbetrag → 400', badBonus.statusCode === 400);

if (goalId) {
  const goalBonus = await app.inject({
    method: 'POST',
    url: '/api/compensation/bonuses',
    headers: auth,
    payload: { employee_id: e1, kind: 'zielbonus', title: 'Jahresbonus 2026', target_amount_cents: 100000, goal_id: goalId, payout_month: month },
  });
  check('Zielgekoppelter Bonus → 201', goalBonus.statusCode === 201, goalBonus.json());
  check(
    'Serverseitige Berechnung: 100.000 × 60 % = 60.000 Cent',
    goalBonus.json().bonus.payout_cents === 60000 && goalBonus.json().bonus.goal?.progress === 60,
    goalBonus.json(),
  );
} else {
  console.log('~ Zielkopplungs-Checks übersprungen (goals-Fremdschema abweichend)');
}

const goalsApi = await app.inject({
  method: 'GET',
  url: `/api/compensation/goals?employee_id=${e2}`,
  headers: auth,
});
check('Ziel-Auswahl robust (leer für MA ohne Ziele)', goalsApi.statusCode === 200 && goalsApi.json().goals.length === 0);

const fixedBonus = await app.inject({
  method: 'POST',
  url: '/api/compensation/bonuses',
  headers: auth,
  payload: { employee_id: e2, kind: 'einmalzahlung', title: 'Prämie', amount_cents: 20000, payout_month: month },
});
check('Fester Bonus → 201', fixedBonus.statusCode === 201);
const fixedBonusId = fixedBonus.json().bonus.id as number;

const skipStatus = await app.inject({
  method: 'POST',
  url: `/api/compensation/bonuses/${fixedBonusId}/status`,
  headers: auth,
  payload: { status: 'ausgezahlt' },
});
check('Statussprung geplant → ausgezahlt → 409', skipStatus.statusCode === 409);

const release = await app.inject({
  method: 'POST',
  url: `/api/compensation/bonuses/${fixedBonusId}/status`,
  headers: auth,
  payload: { status: 'freigegeben' },
});
check('Freigabe → 200', release.statusCode === 200 && release.json().bonus.status === 'freigegeben');

// E2 bekommt ein Grundgehalt über der Minijob-Grenze (mit Bonus 740 € > 556 €).
await app.inject({
  method: 'POST',
  url: `/api/compensation/employees/${e2}/components`,
  headers: auth,
  payload: { kind: 'grundgehalt', amount_cents: 54000, valid_from: day15 },
});

// ---------------- Abrechnungslauf ----------------

const run = await app.inject({
  method: 'POST',
  url: '/api/compensation/payroll-runs',
  headers: auth,
  payload: { month },
});
check('Abrechnungslauf anlegen → 201', run.statusCode === 201, run.json());
const runId = run.json().run.id as number;
const items = run.json().items as {
  employee_id: number;
  gross_cents: number;
  bonus_cents: number;
  flags: string[];
  warnings: string[];
}[];
const itemE1 = items.find((i) => i.employee_id === e1);
const itemE2 = items.find((i) => i.employee_id === e2);
check('Lauf enthält Angestellte, keine Freiberufler:innen', !!itemE1 && !!itemE2 && !items.some((i) => i.employee_id === e3), items);
check('E1: Brutto 5.200 € + Flag Gehaltsänderung', itemE1?.gross_cents === 520000 && !!itemE1?.flags.includes('gehaltsaenderung'), itemE1);
check('E2: Flag Neueintritt', !!itemE2?.flags.includes('neueintritt'), itemE2);
check(
  'E2: Warnungen (IBAN, Steuer-ID, SV-Nummer, Minijob-Grenze)',
  !!itemE2 &&
    itemE2.warnings.some((w) => w.includes('IBAN')) &&
    itemE2.warnings.some((w) => w.includes('Steuer-ID')) &&
    itemE2.warnings.some((w) => w.includes('SV-Nummer')) &&
    itemE2.warnings.some((w) => w.includes('Minijob')),
  itemE2,
);
check('E2: freigegebener Bonus im Lauf', itemE2?.bonus_cents === 20000, itemE2);

const dupRun = await app.inject({
  method: 'POST',
  url: '/api/compensation/payroll-runs',
  headers: auth,
  payload: { month },
});
check('Zweiter Lauf im selben Monat → 409', dupRun.statusCode === 409);

const earlyExport = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.datev`,
  headers: auth,
});
check('Export im Status offen → 409', earlyExport.statusCode === 409);

const toChecked = await app.inject({
  method: 'POST',
  url: `/api/compensation/payroll-runs/${runId}/status`,
  headers: auth,
  payload: { status: 'geprueft' },
});
check('Statuswechsel offen → geprueft', toChecked.statusCode === 200 && toChecked.json().run.status === 'geprueft');

const datev = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.datev`,
  headers: auth,
});
check(
  'DATEV-LODAS-Export: Kopf + Bewegungsdaten mit Komma-Dezimale',
  datev.statusCode === 200 &&
    datev.body.includes('[Allgemein]') &&
    datev.body.includes('Ziel=LODAS') &&
    datev.body.includes('[Bewegungsdaten]') &&
    datev.body.includes('5200,00'),
  datev.body.slice(0, 300),
);

const runAfterExport = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}`,
  headers: auth,
});
check('Export setzt Status auf exportiert', runAfterExport.json().run.status === 'exportiert');

const csv = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.csv`,
  headers: auth,
});
check(
  'CSV-Export: BOM + Semikolon',
  csv.statusCode === 200 && csv.body.charCodeAt(0) === 0xfeff && csv.body.includes(';Muster;'),
  csv.body.slice(0, 120),
);

// ---------------- Freiberufler ----------------

const badRate = await app.inject({
  method: 'POST',
  url: '/api/compensation/freelancer-rates',
  headers: auth,
  payload: { employee_id: e1, description: 'Beratung', rate_cents: 12000, unit: 'stunde', valid_from: '2026-01-01' },
});
check('Honorarsatz für Angestellte → 400', badRate.statusCode === 400);

const rate = await app.inject({
  method: 'POST',
  url: '/api/compensation/freelancer-rates',
  headers: auth,
  payload: { employee_id: e3, description: 'Entwicklung', rate_cents: 11000, unit: 'stunde', valid_from: '2026-01-01' },
});
check('Honorarsatz für Freiberufler:in → 201', rate.statusCode === 201);

const invoice = await app.inject({
  method: 'POST',
  url: '/api/compensation/freelancer-invoices',
  headers: auth,
  payload: { employee_id: e3, invoice_number: 'RE-2026-001', invoice_date: today, period: month, amount_cents: 264000, hours: 24 },
});
check('Rechnung erfassen → 201', invoice.statusCode === 201, invoice.json());
const invoiceId = invoice.json().invoice.id as number;

const dupInvoice = await app.inject({
  method: 'POST',
  url: '/api/compensation/freelancer-invoices',
  headers: auth,
  payload: { employee_id: e3, invoice_number: 'RE-2026-001', invoice_date: today, amount_cents: 1000 },
});
check('Doppelte Rechnungsnummer je MA → 409', dupInvoice.statusCode === 409);

const invoiceList = await app.inject({ method: 'GET', url: '/api/compensation/freelancer-invoices', headers: auth });
check('Offene Posten: Summe 2.640 €', invoiceList.json().open_cents === 264000, invoiceList.json());

const paidTooEarly = await app.inject({
  method: 'POST',
  url: `/api/compensation/freelancer-invoices/${invoiceId}/status`,
  headers: auth,
  payload: { status: 'bezahlt', paid_date: today },
});
check('Statussprung offen → bezahlt → 409', paidTooEarly.statusCode === 409);

await app.inject({
  method: 'POST',
  url: `/api/compensation/freelancer-invoices/${invoiceId}/status`,
  headers: auth,
  payload: { status: 'geprueft' },
});
const paidNoDate = await app.inject({
  method: 'POST',
  url: `/api/compensation/freelancer-invoices/${invoiceId}/status`,
  headers: auth,
  payload: { status: 'bezahlt' },
});
check('Bezahlt ohne Zahldatum → 400', paidNoDate.statusCode === 400);

const paid = await app.inject({
  method: 'POST',
  url: `/api/compensation/freelancer-invoices/${invoiceId}/status`,
  headers: auth,
  payload: { status: 'bezahlt', paid_date: today },
});
check('Bezahlt mit Zahldatum → 200', paid.statusCode === 200 && paid.json().invoice.status === 'bezahlt');

// ---------------- Bescheinigungen ----------------

const cert = await app.inject({
  method: 'POST',
  url: '/api/compensation/certificates',
  headers: auth,
  payload: { employee_id: e1, kind: 'entgeltbescheinigung_108', period: String(y) },
});
check('Bescheinigung erstellen → 201 + file_id', cert.statusCode === 201 && !!cert.json().certificate.file_id, cert.json());
const certId = cert.json().certificate.id as number;

const sign = await app.inject({
  method: 'POST',
  url: `/api/compensation/certificates/${certId}/sign`,
  headers: auth,
});
check('Signierte URL', sign.statusCode === 200 && typeof sign.json().url === 'string');

const download = await app.inject({ method: 'GET', url: sign.json().url as string });
check(
  'Download (öffentlich, signiert) liefert HTML-Bescheinigung',
  download.statusCode === 200 && download.body.includes('Entgeltbescheinigung') && download.body.includes('Muster'),
  download.body.slice(0, 200),
);

const handover = await app.inject({
  method: 'POST',
  url: `/api/compensation/certificates/${certId}/status`,
  headers: auth,
  payload: { status: 'ausgehaendigt' },
});
check('Statuswechsel erstellt → ausgehaendigt', handover.statusCode === 200);

const handoverAgain = await app.inject({
  method: 'POST',
  url: `/api/compensation/certificates/${certId}/status`,
  headers: auth,
  payload: { status: 'ausgehaendigt' },
});
check('Doppelte Aushändigung → 409', handoverAgain.statusCode === 409);

await app.close();
closeDb();
try {
  fs.rmSync(process.env.HRMONIC_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows hält WAL-Dateien gelegentlich noch kurz — Tempdir-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Vergütungs-Smoke-Checks bestanden.');
