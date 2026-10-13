/**
 * Smoke-Test des Vergütungs-Moduls gegen eine Wegwerf-Datenbank
 * (Muster: src/test/smoke.ts). Aufruf:
 *   npx tsx apps/backend/src/modules/compensation/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { DATEV_LOHNART_DEFAULTS } from '@ohrganize/shared';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-comp-smoke-'));
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
// Gueltige Pruefziffern (Steuer-ID, SV-Nummer): Der DATEV-Pruefbericht unten darf fuer E1 keine Warnung melden.
const e1 = Number(
  insertEmployee.run('Anna', 'Muster', 'vollzeit', 'aktiv', '2020-01-01', 40, 'DE02120300000000202051', '86095742719', '15 070649 C 103').lastInsertRowid,
);
const e2 = Number(
  insertEmployee.run('Ben', 'Klein', 'minijob', 'aktiv', day15, 5, null, null, null).lastInsertRowid,
);
const e3 = Number(
  insertEmployee.run('Cara', 'Frei', 'freiberufler', 'aktiv', '2023-05-01', null, 'DE02100100100006820101', null, null).lastInsertRowid,
);
// Ohne Eintrittsdatum: Arbeitgeberbescheinigung muss abgewiesen werden.
const e4 = Number(
  insertEmployee.run('Dora', 'Ohne', 'vollzeit', 'aktiv', null, 40, null, null, null).lastInsertRowid,
);
// Personalnummer (Migration 104) fuer CSV, LODAS und Bescheinigung; E2 bleibt ohne (Rueckfall auf die ID).
// P-0042 ist keine LODAS-Mitarbeiternummer (Ziffern): Der Export verlangt
// unten die betriebliche Personalnummer, vorher sperrt ihn der Pruefbericht.
db.prepare('UPDATE employees SET personnel_number = ? WHERE id = ?').run('P-0042', e1);
db.prepare(
  `UPDATE employees SET birth_date = '1988-03-02', private_street = 'Baustraße 27a', private_zip = '80331',
     private_city = 'München', tax_class = 'III', church_tax = 'rk', child_allowances = 1.5, bic = 'BYLADEM1001'
   WHERE id = ?`,
).run(e1);
// Befristeter Vertrag fuer E1: Die Arbeitgeberbescheinigung liest die Befristung aus contracts.
db.prepare(
  `INSERT INTO contracts (employee_id, contract_type, valid_from, valid_to) VALUES (?, 'befristet', '2020-01-01', '2027-12-31')`,
).run(e1);

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

// Ueberschneidung mit der Historie schon beim Anlegen (nicht erst bei der Genehmigung).
const overlapRequest = await app.inject({
  method: 'POST',
  url: '/api/compensation/change-requests',
  headers: auth,
  payload: { employee_id: e1, kind: 'grundgehalt', new_amount_cents: 540000, effective_date: '2021-06-01', reason: 'Rückwirkend' },
});
check('Änderungsantrag mit Überschneidung → 409', overlapRequest.statusCode === 409, overlapRequest.json());

// Vier-Augen-Prinzip: Wer den Antrag gestellt hat, genehmigt ihn nicht selbst.
const selfDecide = await app.inject({
  method: 'POST',
  url: `/api/compensation/change-requests/${requestId}/decide`,
  headers: auth,
  payload: { decision: 'genehmigt', decision_note: 'Passt zum Budget' },
});
check('Selbstgenehmigung des eigenen Antrags → 403', selfDecide.statusCode === 403, selfDecide.json());

// Zweites Admin-Konto direkt in die Wegwerf-DB (wie me/smoke.ts) — die
// Entscheidung braucht seit dem Vier-Augen-Prinzip eine andere Person.
db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('zweit@test.de', 'Zweit Admin', ?, 'admin')").run(
  bcrypt.hashSync('geheim123', 10),
);
const secondLogin = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { email: 'zweit@test.de', password: 'geheim123' },
});
const auth2 = { authorization: `Bearer ${secondLogin.json().token as string}` };

const decide = await app.inject({
  method: 'POST',
  url: `/api/compensation/change-requests/${requestId}/decide`,
  headers: auth2,
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

// Audit in derselben Transaktion: Scheitert der Audit-Eintrag, bleibt auch
// die fachliche Änderung ungespeichert. Der TEMP-Trigger gilt nur auf dieser
// Verbindung, also genau der des Servers.
const atomicRequest = await app.inject({
  method: 'POST',
  url: '/api/compensation/change-requests',
  headers: auth,
  payload: { employee_id: e1, kind: 'grundgehalt', new_amount_cents: 560000, effective_date: '2099-01-01', reason: 'Audit-Probe' },
});
check('Zweiter Änderungsantrag → 201', atomicRequest.statusCode === 201, atomicRequest.json());
const atomicRequestId = atomicRequest.json().request.id as number;
const countRows = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const componentsBefore = countRows('SELECT COUNT(*) AS n FROM salary_components WHERE employee_id = ?', e1);
const bonusesBefore = countRows('SELECT COUNT(*) AS n FROM bonuses');
const auditBefore = countRows('SELECT COUNT(*) AS n FROM audit_log');
db.exec("CREATE TEMP TRIGGER audit_kaputt BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit kaputt'); END;");
try {
  const brokenDecide = await app.inject({
    method: 'POST',
    url: `/api/compensation/change-requests/${atomicRequestId}/decide`,
    headers: auth2,
    payload: { decision: 'genehmigt' },
  });
  const storedStatus = (
    db.prepare('SELECT status FROM salary_change_requests WHERE id = ?').get(atomicRequestId) as { status: string }
  ).status;
  check(
    'Audit scheitert: Genehmigung 5xx, weder Entscheid noch Gehaltskomponente gespeichert',
    brokenDecide.statusCode >= 500 &&
      storedStatus === 'beantragt' &&
      countRows('SELECT COUNT(*) AS n FROM salary_components WHERE employee_id = ?', e1) === componentsBefore,
    { status: brokenDecide.statusCode, storedStatus },
  );
  const brokenBonus = await app.inject({
    method: 'POST',
    url: '/api/compensation/bonuses',
    headers: auth,
    payload: { employee_id: e1, kind: 'einmalzahlung', title: 'Audit-Probe', amount_cents: 1000, payout_month: month },
  });
  check(
    'Audit scheitert: Bonus 5xx und nicht angelegt',
    brokenBonus.statusCode >= 500 && countRows('SELECT COUNT(*) AS n FROM bonuses') === bonusesBefore,
    brokenBonus.statusCode,
  );
  check('Audit scheitert: kein Audit-Eintrag', countRows('SELECT COUNT(*) AS n FROM audit_log') === auditBefore);
} finally {
  db.exec('DROP TRIGGER audit_kaputt');
}
// Ohne Trigger geht derselbe Entscheid durch; abgelehnt, damit die folgenden
// Prüfungen keinen offenen Antrag und keine weitere Komponente sehen.
const atomicReject = await app.inject({
  method: 'POST',
  url: `/api/compensation/change-requests/${atomicRequestId}/decide`,
  headers: auth2,
  payload: { decision: 'abgelehnt', decision_note: 'Nur Probe' },
});
check('Ohne Trigger: Entscheid → 200', atomicReject.statusCode === 200, atomicReject.json());

// ---------------- Boni ----------------

const badBonus = await app.inject({
  method: 'POST',
  url: '/api/compensation/bonuses',
  headers: auth,
  payload: { employee_id: e1, kind: 'zielbonus', title: 'Ohne Zielbetrag', goal_id: goalId ?? 1, payout_month: month },
});
check('Zielbonus ohne Zielbetrag → 400', badBonus.statusCode === 400);

const freelancerBonus = await app.inject({
  method: 'POST',
  url: '/api/compensation/bonuses',
  headers: auth,
  payload: { employee_id: e3, kind: 'einmalzahlung', title: 'Prämie', amount_cents: 10000, payout_month: month },
});
check('Bonus für Freiberufler:in → 400', freelancerBonus.statusCode === 400, freelancerBonus.json());

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
  // Die Liste liest das Ziel per JOIN statt je Zeile: gleiche Form und
  // gleicher Betrag wie beim Anlegen, keine Hilfsspalten in der Antwort.
  const created = goalBonus.json().bonus as Record<string, unknown>;
  const listed = (
    await app.inject({ method: 'GET', url: `/api/compensation/bonuses?employee_id=${e1}`, headers: auth })
  ).json().bonuses as Record<string, unknown>[];
  const listedGoalBonus = listed.find((b) => b.id === created.id);
  const { payout_cents: _payout, goal: _goal, ...createdColumns } = created;
  check(
    'Bonusliste: Ziel und Betrag wie beim Anlegen, Felder in derselben Form',
    !!listedGoalBonus &&
      listedGoalBonus.payout_cents === 60000 &&
      JSON.stringify(listedGoalBonus.goal) === JSON.stringify(created.goal) &&
      Object.keys(listedGoalBonus).join() ===
        [...Object.keys(createdColumns), 'first_name', 'last_name', 'payout_cents', 'goal'].join(),
    listedGoalBonus,
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

// Offenen Lauf verwerfen: Vormonat anlegen, verwerfen, weg.
const prevMonth = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
const prevRun = await app.inject({
  method: 'POST',
  url: '/api/compensation/payroll-runs',
  headers: auth,
  payload: { month: prevMonth },
});
check('Lauf Vormonat → 201', prevRun.statusCode === 201, prevRun.json());
const prevRunId = prevRun.json().run.id as number;
const discard = await app.inject({ method: 'DELETE', url: `/api/compensation/payroll-runs/${prevRunId}`, headers: auth });
const discarded = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${prevRunId}`, headers: auth });
check('Offenen Lauf verwerfen → 204, danach 404', discard.statusCode === 204 && discarded.statusCode === 404);
check(
  'Verwerfen ist auditiert',
  !!db.prepare(`SELECT 1 FROM audit_log WHERE action = 'payroll_run.delete' AND entity_id = ?`).get(prevRunId),
);

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

// ---------------- DATEV-Export ----------------

// Ab Werk sind Berater- und Mandantennummer leer: Der Pruefbericht sperrt
// den Export (409 mit Bericht), nichts wird als exportiert markiert.
const checkEmpty = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/datev-check`, headers: auth });
const emptyReport = checkEmpty.json().report as { error_count: number; issues: { level: string; message: string; employee_id?: number }[]; pnr_mode: string };
check(
  'DATEV-Pruefbericht ab Werk: Fehler fuer Berater, Mandant, nicht gespeicherte Lohnarten (Grundgehalt, Bonus) und P-0042',
  checkEmpty.statusCode === 200 &&
    emptyReport.error_count === 5 &&
    emptyReport.issues.some((i) => i.level === 'fehler' && /Beraternummer/.test(i.message)) &&
    emptyReport.issues.some((i) => i.level === 'fehler' && /Mandantennummer/.test(i.message)) &&
    emptyReport.issues.some((i) => i.level === 'fehler' && /Grundgehalt/.test(i.message)) &&
    emptyReport.issues.some((i) => i.level === 'fehler' && /Einmalzahlung/.test(i.message)) &&
    emptyReport.issues.some((i) => i.level === 'fehler' && i.employee_id === e1 && /Personalnummer/.test(i.message)),
  emptyReport,
);
const blockedExport = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/export.datev`, headers: auth });
check(
  'Gesperrter Export → 409 DATEV_EXPORT_BLOCKED mit den Fehlern DIESER Datei (ohne die Grundgehalt-Lohnart der Stammdaten)',
  blockedExport.statusCode === 409 &&
    blockedExport.json().error.code === 'DATEV_EXPORT_BLOCKED' &&
    blockedExport.json().error.details.error_count === 4 &&
    !JSON.stringify(blockedExport.json().error.details.issues).includes('Grundgehalt'),
  blockedExport.json(),
);
check(
  'Gesperrter Export laesst den Status auf geprueft',
  (db.prepare('SELECT status FROM payroll_runs WHERE id = ?').get(runId) as { status: string }).status === 'geprueft',
);

const badSettings = await app.inject({
  method: 'PUT',
  url: '/api/settings/datev',
  headers: auth,
  payload: { datevBeraterNr: '12', datevLohnarten: { grundgehalt: '12345' } },
});
check('Einstellungen: ungueltige Beraternummer und Lohnart → 400', badSettings.statusCode === 400, badSettings.json());

// Die alte Einstellungsseite speicherte die Demonummern mit; Migration 403
// entfernt sie (hier nachgestellt: Zeilen setzen, Migrations-SQL ausfuehren).
db.prepare(`INSERT INTO app_settings (key, value) VALUES ('datevBeraterNr', '"1000001"'), ('datevMandantenNr', '"10001"')`).run();
const { compensationMigrations } = await import('../../db/migrations/400_compensation.js');
db.exec(compensationMigrations.find((mig) => mig.name === '403_datev_demo_numbers')!.sql);
check(
  'Migration 403: gespeicherte Demonummern 1000001/10001 entfernt',
  !db.prepare(`SELECT 1 FROM app_settings WHERE key IN ('datevBeraterNr', 'datevMandantenNr')`).get(),
);

const settingsOk = await app.inject({
  method: 'PUT',
  url: '/api/settings/datev',
  headers: auth,
  payload: {
    datevBeraterNr: '28547',
    datevMandantenNr: '90909',
    datevBetrieblichePnr: true,
    // Lohnarten gelten erst gespeichert (kein stiller Rueckfall auf die Vorschlaege).
    datevLohnarten: { ...DATEV_LOHNART_DEFAULTS, abzug_sonstig: '12' },
  },
});
check('Einstellungen: DATEV-Nummern und betriebliche Personalnummer gesetzt', settingsOk.statusCode === 200, settingsOk.json());
const partialLohnart = await app.inject({ method: 'PUT', url: '/api/settings/datev', headers: auth, payload: { datevLohnarten: { vwl: '511' } } });
check(
  'Einstellungen: Lohnarten werden zusammengefuehrt, ein Teilaufruf loescht die anderen nicht',
  partialLohnart.json().settings.datevLohnarten.abzug_sonstig === '12' && partialLohnart.json().settings.datevLohnarten.vwl === '511',
  partialLohnart.json().settings.datevLohnarten,
);
const datevViaGeneric = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { datevBeraterNr: '9999' } });
check(
  'Allgemeine Einstellungen schreiben keine DATEV-Nummern (eigene Route)',
  datevViaGeneric.statusCode === 200 && datevViaGeneric.json().settings.datevBeraterNr === '28547',
  datevViaGeneric.json(),
);

// Rechte: Der Export fuehrt Stamm- und Abwesenheitsdaten zusammen; eine
// Rolle mit Verguetung, aber ohne Personal, bekommt ihn nicht.
const payrollOnlyRole = Number(
  db.prepare(`INSERT INTO admin_roles (name) VALUES ('Nur Vergütung')`).run().lastInsertRowid,
);
db.prepare(
  `INSERT INTO admin_role_permissions (role_id, area, level) VALUES (?, 'verguetung', 'bearbeiten'), (?, 'abwesenheit', 'lesen')`,
).run(payrollOnlyRole, payrollOnlyRole);
db.prepare(
  "INSERT INTO users (email, name, password_hash, role, admin_role_id) VALUES ('lohn@test.de', 'Nur Lohn', ?, 'admin', ?)",
).run(bcrypt.hashSync('geheim123', 10), payrollOnlyRole);
const payrollLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lohn@test.de', password: 'geheim123' } });
const authPayroll = { authorization: `Bearer ${payrollLogin.json().token as string}` };
const checkNoPersonal = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/datev-check`, headers: authPayroll });
const exportNoPersonal = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.datev?kind=stammdaten&scope=alle`,
  headers: authPayroll,
});
check(
  'Rolle ohne Bereich Personal: Pruefbericht und Export → 403 (keine IBAN, Steuer-ID, SV-Nummer)',
  checkNoPersonal.statusCode === 403 && exportNoPersonal.statusCode === 403 && /Personal/.test(exportNoPersonal.json().error.message),
  { check: checkNoPersonal.json(), export: exportNoPersonal.json() },
);
const headExport = await app.inject({ method: 'HEAD', url: `/api/compensation/payroll-runs/${runId}/export.datev`, headers: auth });
check('Export per HEAD wird nicht ausgefuehrt (kein Status, keine Pruefsumme)', headExport.statusCode === 404, headExport.statusCode);

const checkOk = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/datev-check`, headers: auth });
const okReport = checkOk.json().report as typeof emptyReport & { warning_count: number; lohnarten_in_use: { key: string; number: string }[] };
check(
  'DATEV-Pruefbericht: keine Fehler, Warnungen fuer E2 (IBAN, Steuer-ID, SV-Nummer, Minijob), betriebliche PNr',
  okReport.error_count === 0 &&
    okReport.pnr_mode === 'betrieblich' &&
    ['IBAN fehlt', 'Steuer-ID fehlt', 'SV-Nummer fehlt', 'Minijob'].every((m) =>
      okReport.issues.some((i) => i.employee_id === e2 && i.level === 'warnung' && i.message.includes(m)),
    ) &&
    !okReport.issues.some((i) => i.employee_id === e1 && /IBAN|Steuer-ID|SV-Nummer/.test(i.message)),
  okReport,
);
check(
  'DATEV-Pruefbericht: Dateien des Programms (Bewegungsdaten, Stammdaten)',
  (checkOk.json().files as { kind: string }[]).map((f) => f.kind).join() === 'bewegungsdaten,stammdaten',
  checkOk.json().files,
);

const datev = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.datev`,
  headers: auth,
});
const datevBody = datev.rawPayload.toString('latin1');
check(
  'DATEV-LODAS-Bewegungsdaten: Kopf laut Schnittstellenhandbuch, Windows-1252, Dateiname',
  datev.statusCode === 200 &&
    datev.headers['content-type'] === 'text/plain; charset=windows-1252' &&
    datev.headers['content-disposition'] === `attachment; filename="lodas_bewegungsdaten_${month}.txt"` &&
    datevBody.includes('[Allgemein]\r\nZiel=LODAS\r\nVersion_SST=1.0\r\nBeraterNr=28547\r\nMandantenNr=90909\r\n') &&
    datevBody.includes('Stringbegrenzer="\r\n') &&
    datevBody.includes('BetrieblichePNrVerwenden=Ja') &&
    !datevBody.includes('Datum='),
  datevBody.slice(0, 400),
);
check(
  'LODAS-Bewegungsdaten: Satzbeschreibung mit echten Feldnamen, Schluessel pnr_betriebliche#psd',
  datevBody.includes('1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;pnr_betriebliche#psd;bs_nr#bwd;bs_wert_butab#bwd;la_eigene#bwd;'),
  datevBody,
);
check(
  'LODAS-Bewegungsdaten: nur der Bonus als Bruttobezug (BS 2), Festbezuege nicht (Vorgabe Stammdaten)',
  datevBody.includes(`1;01.${String(m).padStart(2, '0')}.${y};"${e2}";2;200,00;420;`) &&
    !datevBody.includes('5200,00'),
  datevBody,
);
check(
  'LODAS-Bewegungsdaten: Hinweisdaten mit Warnungen zu dieser Datei (ohne Stammdatenwarnungen)',
  datevBody.includes('[Hinweisdaten]') &&
    datevBody.includes(`"Klein, Ben (${e2}): Keine Personalnummer gepflegt, die Profil-ID wird`) &&
    !datevBody.includes('IBAN fehlt'),
  datevBody,
);
check(
  'Jeder Export hinterlaesst einen Audit-Eintrag mit Pruefsumme',
  !!db
    .prepare(`SELECT 1 FROM audit_log WHERE action = 'payroll_run.export_file' AND entity_id = ? AND details LIKE '%sha256%'`)
    .get(runId),
);

const runAfterExport = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}`,
  headers: auth,
});
check('Export setzt Status auf exportiert', runAfterExport.json().run.status === 'exportiert');

const stammdaten = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.datev?kind=stammdaten&scope=alle`,
  headers: auth,
});
const stammBody = stammdaten.rawPayload.toString('latin1');
check(
  'LODAS-Stammdaten: Mitarbeiter, Bank, Steuer, Festbezug fuer E1 (Umlaute in Windows-1252)',
  stammdaten.statusCode === 200 &&
    stammBody.includes('StammdatenGueltigAb=') &&
    stammBody.includes('1;"P-0042";"Muster";"Anna";"Baustra\xdfe";"27a";80331;"M\xfcnchen";02.03.1988;"15070649C103";') &&
    stammBody.includes('2;"P-0042";"DE02120300000000202051";"BYLADEM1001";') &&
    stammBody.includes('3;"P-0042";"86095742719";3;1,5;11;') &&
    stammBody.includes('6;"P-0042";1;200;5200,00;'),
  stammBody,
);
check('LODAS-Stammdaten: Neueintritt E2 mit Personengruppe 109', stammBody.includes(`4;"${e2}";109;;`), stammBody);
check('LODAS-Stammdaten: Stammdatenwarnung (IBAN) in den Hinweisdaten', stammBody.includes(`"Klein, Ben (${e2}): IBAN fehlt"`), stammBody);
const stammChanges = await app.inject({
  method: 'GET',
  url: `/api/compensation/payroll-runs/${runId}/export.datev?kind=stammdaten`,
  headers: auth,
});
check(
  'LODAS-Stammdaten (nur Aenderungen): E1 mit Gehaltsaenderung und E2 mit Neueintritt',
  stammChanges.rawPayload.toString('latin1').includes('1;"P-0042";') && stammChanges.rawPayload.toString('latin1').includes(`1;"${e2}";`),
);

// Lohn und Gehalt: elf Spalten, keine Stammdaten. Die Personalnummer ist dort
// immer die Mitarbeiternummer (Ziffern), P-0042 bleibt gesperrt.
await app.inject({ method: 'PUT', url: '/api/settings/datev', headers: auth, payload: { datevProgramm: 'lug', datevFestbezuege: 'bewegungsdaten' } });
const lugBlocked = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/export.datev`, headers: auth });
check('Lohn und Gehalt mit P-0042 → 409 (nur Ziffern)', lugBlocked.statusCode === 409, lugBlocked.json());
db.prepare('UPDATE employees SET personnel_number = ? WHERE id = ?').run('42', e1);
const lug = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/export.datev`, headers: auth });
const lugBody = lug.rawPayload.toString('latin1');
check(
  'Lohn und Gehalt: elf Felder, Grundgehalt und Bonus als Wert',
  lug.statusCode === 200 &&
    lug.headers['content-disposition'] === `attachment; filename="lug_bewegungsdaten_${month}.txt"` &&
    lugBody.split('\r\n').filter(Boolean).every((l) => l.split(';').length === 11) &&
    lugBody.includes('42;;;200;;;5200,00;;;;') &&
    lugBody.includes(`${e2};;;420;;;200,00;;;;`),
  lugBody,
);
const lugStamm = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/export.datev?kind=stammdaten`, headers: auth });
check('Lohn und Gehalt kennt keine Stammdaten → 400', lugStamm.statusCode === 400, lugStamm.json());
await app.inject({ method: 'PUT', url: '/api/settings/datev', headers: auth, payload: { datevProgramm: 'lodas', datevFestbezuege: 'stammdaten' } });
db.prepare('UPDATE employees SET personnel_number = ? WHERE id = ?').run('P-0042', e1);

// Fehltage: Urlaub ueber die erste Monatshaelfte, darin Betriebsruhe am 8. und
// 9. und eine Krankheit an einem Arbeitstag. Wie im Urlaubskonto fallen
// Betriebsruhe, Wochenenden und Feiertage weg, und der kranke Tag steht
// einmal da, als Krankheit.
const { isWeekend: weekend } = await import('../../core/dates.js');
const { isHoliday: holiday } = await import('../../core/holidays.js');
const typeId = (name: string) => (db.prepare('SELECT id FROM absence_types WHERE name = ?').get(name) as { id: number }).id;
const urlaubId = typeId('Urlaub');
const krankId = typeId('Krankheit');
const dayOf = (d: number) => `${month}-${String(d).padStart(2, '0')}`;
const workday = (d: number) => !weekend(dayOf(d)) && !holiday(dayOf(d), 'DE', 'BY') && d !== 8 && d !== 9;
const sickDay = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14].find(workday)!;
db.prepare(`INSERT INTO company_closures (date_from, date_to, name) VALUES (?, ?, 'Smoke-Betriebsruhe')`).run(dayOf(8), dayOf(9));
db.prepare(
  `INSERT INTO absence_requests (employee_id, type_id, date_from, date_to, days_counted, status) VALUES (?, ?, ?, ?, 5, 'genehmigt'), (?, ?, ?, ?, 1, 'genehmigt')`,
).run(e1, urlaubId, dayOf(1), dayOf(14), e1, krankId, dayOf(sickDay), dayOf(sickDay));
await app.inject({
  method: 'PUT',
  url: '/api/settings/datev',
  headers: auth,
  payload: { datevAusfallschluessel: { [String(urlaubId)]: 'U', [String(krankId)]: 'K' } },
});
const kal = (await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${runId}/export.datev`, headers: auth })).rawPayload.toString('latin1');
const kalLines = kal.split('\r\n').filter((l) => l.startsWith(`2;01.${String(m).padStart(2, '0')}.${y};"P-0042";`));
const kalDays = kalLines.map((l) => l.split(';')[3]);
const expectedDays = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14].filter(workday).map((d) => String(d).padStart(2, '0'));
check(
  'Kalendarium: ohne Betriebsruhe (8., 9.), Wochenende und Feiertage, je Tag ein Satz',
  JSON.stringify(kalDays) === JSON.stringify(expectedDays),
  { kalDays, expectedDays },
);
check(
  'Kalendarium: Krankheit im Urlaub steht einmal da, als Krankheit',
  kalLines.filter((l) => l.split(';')[3] === String(sickDay).padStart(2, '0')).map((l) => l.split(';')[4]).join() === '"K"',
  kalLines,
);

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
check('CSV: Personalnummer in erster Spalte', csv.body.includes('P-0042;Muster;'), csv.body.slice(0, 200));
check(
  'CSV-Export hinterlaesst wie DATEV eine Pruefsumme im Audit',
  !!db
    .prepare(`SELECT 1 FROM audit_log WHERE action = 'payroll_run.export_file' AND entity_id = ? AND details LIKE '%"program":"csv"%' AND details LIKE '%sha256%'`)
    .get(runId),
);

const exportedDiscard = await app.inject({ method: 'DELETE', url: `/api/compensation/payroll-runs/${runId}`, headers: auth });
check('Exportierten Lauf verwerfen → 409', exportedDiscard.statusCode === 409);

// Statuswechsel nur fuer die Monatsdatei und nur mit verguetung: bearbeiten.
// Ein neuer Lauf fuer den Vormonat, geprueft, dann: Stammdaten (kein
// Wechsel), Bewegungsdaten mit einer Lese-Rolle (kein Wechsel), mit
// Bearbeitungsrecht (Wechsel).
const statusRun = (await app.inject({ method: 'POST', url: '/api/compensation/payroll-runs', headers: auth, payload: { month: prevMonth } })).json().run.id as number;
await app.inject({ method: 'POST', url: `/api/compensation/payroll-runs/${statusRun}/status`, headers: auth, payload: { status: 'geprueft' } });
const statusOf = () => (db.prepare('SELECT status FROM payroll_runs WHERE id = ?').get(statusRun) as { status: string }).status;
await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${statusRun}/export.datev?kind=stammdaten&scope=alle`, headers: auth });
check('Stammdatenexport laesst den Lauf auf geprueft', statusOf() === 'geprueft', statusOf());
const readerRole = Number(db.prepare(`INSERT INTO admin_roles (name) VALUES ('Lohn lesen')`).run().lastInsertRowid);
db.prepare(
  `INSERT INTO admin_role_permissions (role_id, area, level) VALUES (?, 'verguetung', 'lesen'), (?, 'personal', 'lesen'), (?, 'abwesenheit', 'lesen')`,
).run(readerRole, readerRole, readerRole);
db.prepare(
  "INSERT INTO users (email, name, password_hash, role, admin_role_id) VALUES ('lohnlesen@test.de', 'Lohn Lesen', ?, 'admin', ?)",
).run(bcrypt.hashSync('geheim123', 10), readerRole);
const readerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lohnlesen@test.de', password: 'geheim123' } });
const authReader = { authorization: `Bearer ${readerLogin.json().token as string}` };
const readerExport = await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${statusRun}/export.datev`, headers: authReader });
check(
  'Lese-Rolle bekommt die Datei, stellt den Lauf aber nicht um',
  readerExport.statusCode === 200 && statusOf() === 'geprueft',
  { status: readerExport.statusCode, run: statusOf() },
);
await app.inject({ method: 'GET', url: `/api/compensation/payroll-runs/${statusRun}/export.datev`, headers: auth });
check('Bewegungsdaten mit Bearbeitungsrecht setzen den Lauf auf exportiert', statusOf() === 'exportiert', statusOf());
const headCsv = await app.inject({ method: 'HEAD', url: `/api/compensation/payroll-runs/${statusRun}/export.csv`, headers: auth });
check('CSV-Export per HEAD wird nicht ausgefuehrt', headCsv.statusCode === 404, headCsv.statusCode);

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

const badFile = await app.inject({
  method: 'POST',
  url: '/api/compensation/freelancer-invoices',
  headers: auth,
  payload: { employee_id: e3, invoice_number: 'RE-2026-002', invoice_date: today, amount_cents: 1000, file_id: 999999 },
});
check('Rechnung mit unbekannter file_id → 400', badFile.statusCode === 400, badFile.json());

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

const certFileId = cert.json().certificate.file_id as number;
const certDocs = db
  .prepare(`SELECT category, visibility, source, title FROM documents WHERE employee_id = ? AND file_id = ?`)
  .all(e1, certFileId) as { category: string; visibility: string; source: string; title: string }[];
check(
  'Aushändigung legt genau EIN Portal-Dokument (bescheinigung) an',
  certDocs.length === 1 &&
    certDocs[0]!.category === 'bescheinigung' &&
    certDocs[0]!.visibility === 'portal' &&
    certDocs[0]!.source === 'hr' &&
    certDocs[0]!.title.includes('Entgeltbescheinigung'),
  certDocs,
);

const agCert = await app.inject({
  method: 'POST',
  url: '/api/compensation/certificates',
  headers: auth,
  payload: { employee_id: e1, kind: 'arbeitgeberbescheinigung', period: String(y) },
});
check('Arbeitgeberbescheinigung → 201', agCert.statusCode === 201, agCert.json());
const agSign = await app.inject({ method: 'POST', url: `/api/compensation/certificates/${agCert.json().certificate.id}/sign`, headers: auth });
const agBody = (await app.inject({ method: 'GET', url: agSign.json().url as string })).body;
check(
  'Arbeitgeberbescheinigung: befristet aus Vertrag, Personalnummer aus Stammdaten',
  agBody.includes('befristeten') && agBody.includes('31.12.2027') && agBody.includes('Personalnummer P-0042'),
  agBody.slice(0, 600),
);

const noHire = await app.inject({
  method: 'POST',
  url: '/api/compensation/certificates',
  headers: auth,
  payload: { employee_id: e4, kind: 'arbeitgeberbescheinigung', period: String(y) },
});
check('Arbeitgeberbescheinigung ohne Eintrittsdatum → 400', noHire.statusCode === 400, noHire.json());

await app.close();
closeDb();
try {
  fs.rmSync(process.env.OHRGANIZE_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Windows hält WAL-Dateien gelegentlich noch kurz — Tempdir-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Vergütungs-Smoke-Checks bestanden.');
