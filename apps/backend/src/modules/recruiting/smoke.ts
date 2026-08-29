/**
 * Smoke-Test des Moduls Recruiting & Bewerbermanagement (fastify.inject gegen
 * eine Wegwerf-DB). Aufruf: npx tsx apps/backend/src/modules/recruiting/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HRMONIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrmonic-recruit-smoke-'));
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

// Fixtures (Kerntabellen gehören dem Personal-Modul; hier nur Testdaten).
const db = getDb();
db.prepare("INSERT INTO locations (id, name, bundesland) VALUES (1, 'München', 'BY')").run();
db.prepare("INSERT INTO departments (id, name) VALUES (1, 'Technik')").run();
db.prepare("INSERT INTO teams (id, name, department_id) VALUES (1, 'Backend', 1)").run();
db.prepare(
  `INSERT INTO employees (id, first_name, last_name, employee_type, status, job_title, department_id)
   VALUES (1, 'Tobias', 'Krämer', 'vollzeit', 'aktiv', 'CTO', 1)`,
).run();

const { auth } = await firstAdminLogin(app, check);

const noAuth = await app.inject({ method: 'GET', url: '/api/recruiting/postings' });
check('Auth-Pflicht auf Modulrouten', noAuth.statusCode === 401);

// ---------------------------------------------------------------------------
// Stufen
// ---------------------------------------------------------------------------
let firstActiveStageId = 0;
{
  const res = await app.inject({ method: 'GET', url: '/api/recruiting/stages', headers: auth });
  const stages = res.json().stages as { id: number; name: string; category: string; sort_order: number }[];
  check('Stufen: 7 Standardstufen geseedet', res.statusCode === 200 && stages.length === 7, stages.length);
  check('Stufen: Terminalstufen vorhanden', stages.some((s) => s.category === 'eingestellt') && stages.some((s) => s.category === 'abgelehnt'));
  firstActiveStageId = stages.find((s) => s.category === 'aktiv')!.id;
}

// ---------------------------------------------------------------------------
// Stellen
// ---------------------------------------------------------------------------
let postingId = 0;
{
  const bad = await app.inject({
    method: 'POST',
    url: '/api/recruiting/postings',
    headers: auth,
    payload: { title: 'X', employment_type: 'vollzeit', seats: 1, salary_min_cents: 500000, salary_max_cents: 400000 },
  });
  check('Stelle: Max < Min Gehalt -> 400', bad.statusCode === 400);

  const created = await app.inject({
    method: 'POST',
    url: '/api/recruiting/postings',
    headers: auth,
    payload: {
      title: 'Senior Backend Entwickler:in', employment_type: 'vollzeit', department_id: 1, team_id: 1,
      location_id: 1, hiring_manager_id: 1, seats: 1, salary_min_cents: 6500000, salary_max_cents: 8500000,
      description: 'Node/TS', requirements: '5 Jahre Erfahrung',
    },
  });
  check('Stelle: anlegen (Entwurf)', created.statusCode === 201 && created.json().posting.status === 'entwurf', created.json());
  postingId = created.json().posting.id as number;
  check('Stelle: angereichert (Abteilung, Hiring Manager)', created.json().posting.department_name === 'Technik' && created.json().posting.hiring_manager_name === 'Tobias Krämer');

  const badTransition = await app.inject({
    method: 'POST',
    url: `/api/recruiting/postings/${postingId}/status`,
    headers: auth,
    payload: { status: 'besetzt' },
  });
  check('Stelle: Entwurf -> besetzt (unzulässig) -> 409', badTransition.statusCode === 409);

  const publish = await app.inject({
    method: 'POST',
    url: `/api/recruiting/postings/${postingId}/status`,
    headers: auth,
    payload: { status: 'veroeffentlicht' },
  });
  check('Stelle: Entwurf -> veröffentlicht', publish.statusCode === 200 && publish.json().posting.status === 'veroeffentlicht' && !!publish.json().posting.published_at);
}

// ---------------------------------------------------------------------------
// Bewerbungen: inline neue:r Kandidat:in + Duplikat
// ---------------------------------------------------------------------------
let applicationId = 0;
{
  const created = await app.inject({
    method: 'POST',
    url: '/api/recruiting/applications',
    headers: auth,
    payload: {
      posting_id: postingId,
      candidate: { first_name: 'Lena', last_name: 'Berg', email: 'lena@example.com', source: 'linkedin' },
      applied_at: '2026-07-01', source: 'linkedin', rating: 4,
    },
  });
  check('Bewerbung: anlegen inkl. neue:r Kandidat:in', created.statusCode === 201, created.json());
  applicationId = created.json().application.id as number;
  const candidateId = created.json().application.candidate_id as number;
  check('Bewerbung: startet in erster aktiver Stufe', created.json().application.stage_id === firstActiveStageId);
  check('Bewerbung: Kandidatendaten angereichert', created.json().application.candidate_last_name === 'Berg');

  const dup = await app.inject({
    method: 'POST',
    url: '/api/recruiting/applications',
    headers: auth,
    payload: { posting_id: postingId, candidate_id: candidateId, applied_at: '2026-07-02' },
  });
  check('Bewerbung: Duplikat (gleiche:r Kandidat:in + Stelle) -> 409', dup.statusCode === 409);

  // Eingang-Event in Timeline
  const detail = await app.inject({ method: 'GET', url: `/api/recruiting/applications/${applicationId}`, headers: auth });
  const events = detail.json().application.events as { kind: string }[];
  check('Bewerbung: Timeline mit Eingang-Ereignis', detail.statusCode === 200 && events.some((e) => e.kind === 'eingang'), events);
}

// ---------------------------------------------------------------------------
// Stufenwechsel + Notiz
// ---------------------------------------------------------------------------
{
  const stages = (await app.inject({ method: 'GET', url: '/api/recruiting/stages', headers: auth })).json().stages as { id: number; category: string; sort_order: number }[];
  const interviewStage = stages.filter((s) => s.category === 'aktiv').sort((a, b) => a.sort_order - b.sort_order)[2];

  const move = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${applicationId}/stage`,
    headers: auth,
    payload: { stage_id: interviewStage.id },
  });
  check('Bewerbung: Stufenwechsel', move.statusCode === 200 && move.json().application.stage_id === interviewStage.id);

  const terminalStage = stages.find((s) => s.category === 'abgelehnt')!;
  const moveToTerminal = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${applicationId}/stage`,
    headers: auth,
    payload: { stage_id: terminalStage.id },
  });
  check('Bewerbung: Move in Terminalstufe -> 400', moveToTerminal.statusCode === 400);

  const note = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${applicationId}/notes`,
    headers: auth,
    payload: { body: 'Starker Eindruck im Screening.' },
  });
  check('Bewerbung: Notiz anlegen', note.statusCode === 201);
}

// ---------------------------------------------------------------------------
// Interview + Scorecard
// ---------------------------------------------------------------------------
let interviewId = 0;
{
  const created = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${applicationId}/interviews`,
    headers: auth,
    // Dynamisch morgen, damit die „anstehend“-Prüfung nicht mit der Zeit verrottet.
    payload: { kind: 'technik', scheduled_at: `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 14:00`, duration_minutes: 60, location: 'Meet-Raum', interviewer_ids: [1] },
  });
  check('Interview: planen', created.statusCode === 201 && created.json().interview.interviewer_names[0] === 'Tobias Krämer', created.json());
  interviewId = created.json().interview.id as number;

  const upcoming = await app.inject({ method: 'GET', url: '/api/recruiting/interviews?upcoming=true', headers: auth });
  check('Interview: Liste anstehend', upcoming.json().interviews.some((i: { id: number }) => i.id === interviewId));

  const feedback = await app.inject({
    method: 'PUT',
    url: `/api/recruiting/interviews/${interviewId}`,
    headers: auth,
    payload: {
      kind: 'technik', scheduled_at: '2026-07-20 14:00', duration_minutes: 60, location: 'Meet-Raum',
      interviewer_ids: [1], status: 'stattgefunden', recommendation: 'ja',
      scorecard: [{ criterion: 'Fachwissen', score: 5 }, { criterion: 'Kultur-Fit', score: 4 }], feedback: 'Top.',
    },
  });
  check('Interview: Feedback/Scorecard', feedback.statusCode === 200 && feedback.json().interview.recommendation === 'ja' && feedback.json().interview.scorecard.length === 2);
}

// ---------------------------------------------------------------------------
// Absage (zweite Bewerbung) und Einstellung (erste Bewerbung)
// ---------------------------------------------------------------------------
{
  // zweite Bewerbung anlegen und ablehnen
  const second = await app.inject({
    method: 'POST',
    url: '/api/recruiting/applications',
    headers: auth,
    payload: { posting_id: postingId, candidate: { first_name: 'Max', last_name: 'Klein', source: 'website' }, applied_at: '2026-07-03' },
  });
  const secondId = second.json().application.id as number;
  const reject = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${secondId}/reject`,
    headers: auth,
    payload: { reason: 'Anforderungsprofil nicht erfüllt' },
  });
  check('Bewerbung: Absage', reject.statusCode === 200 && reject.json().application.status === 'abgelehnt' && reject.json().application.stage_category === 'abgelehnt');

  const rejectHire = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${secondId}/hire`,
    headers: auth,
    payload: { hire_date: '2026-09-01' },
  });
  check('Bewerbung: Einstellung einer abgelehnten -> 409', rejectHire.statusCode === 409);

  // erste Bewerbung einstellen → erzeugt Mitarbeitenden + Stelle wird besetzt
  const empBefore = (db.prepare('SELECT COUNT(*) n FROM employees').get() as { n: number }).n;
  const hire = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${applicationId}/hire`,
    headers: auth,
    payload: { hire_date: '2026-09-01', weekly_hours: 40, annual_leave_days: 30 },
  });
  check('Bewerbung: Einstellung', hire.statusCode === 200 && hire.json().application.status === 'eingestellt', hire.json());
  const employeeId = hire.json().employee_id as number;
  const empAfter = (db.prepare('SELECT COUNT(*) n FROM employees').get() as { n: number }).n;
  check('Einstellung: Mitarbeitender erzeugt (Lebenszyklus-Brücke)', empAfter === empBefore + 1 && !!employeeId);
  const emp = db.prepare('SELECT first_name, last_name, job_title, department_id, hire_date FROM employees WHERE id = ?').get(employeeId) as Record<string, unknown>;
  check('Einstellung: Stammdaten übernommen', emp.first_name === 'Lena' && emp.job_title === 'Senior Backend Entwickler:in' && emp.hire_date === '2026-09-01' && emp.department_id === 1, emp);
  check('Einstellung: Verknüpfung converted_employee_id', hire.json().application.converted_employee_id === employeeId);
  check('Einstellung: Stelle automatisch besetzt', hire.json().posting_closed === true);

  const posting = await app.inject({ method: 'GET', url: `/api/recruiting/postings/${postingId}`, headers: auth });
  check('Stelle: Status besetzt + hired_count', posting.json().posting.status === 'besetzt' && posting.json().posting.hired_count === 1, posting.json().posting);

  const doubleHire = await app.inject({
    method: 'POST',
    url: `/api/recruiting/applications/${applicationId}/hire`,
    headers: auth,
    payload: { hire_date: '2026-09-01' },
  });
  check('Bewerbung: doppelte Einstellung -> 409', doubleHire.statusCode === 409);
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------
{
  const res = await app.inject({ method: 'GET', url: '/api/recruiting/analytics', headers: auth });
  const a = res.json().analytics as {
    stats: { hiresYtd: number; avgTimeToHire: number | null; activeApplications: number };
    funnel: { name: string; count: number }[];
    bySource: { source: string; count: number; hired: number }[];
  };
  check('Analyse: Kennzahlen', res.statusCode === 200 && a.stats.hiresYtd === 1 && a.stats.activeApplications === 0, a.stats);
  check('Analyse: Time-to-Hire als Tage (Eingang → Entscheidung)', typeof a.stats.avgTimeToHire === 'number' && a.stats.avgTimeToHire! >= 0, a.stats.avgTimeToHire);
  check('Analyse: Kanal-Auswertung', a.bySource.some((s) => s.source === 'linkedin' && s.hired === 1), a.bySource);
}

// ---------------------------------------------------------------------------
// Stelle mit Bewerbungen kann nicht gelöscht werden
// ---------------------------------------------------------------------------
{
  const del = await app.inject({ method: 'DELETE', url: `/api/recruiting/postings/${postingId}`, headers: auth });
  check('Stelle: Löschen mit Bewerbungen -> 409', del.statusCode === 409);
}

// Audit-Stichprobe
{
  const auditRows = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity IN ('job_posting','application','interview','candidate','employee')")
    .get() as { c: number };
  check('Audit: Recruiting-Vorgänge protokolliert', auditRows.c >= 6, auditRows);
}

await app.close();
closeDb();
try {
  fs.rmSync(process.env.HRMONIC_DATA_DIR!, { recursive: true, force: true });
} catch {
  // Tempdir-Reste sind unkritisch.
}

if (failures > 0) {
  console.error(`${failures} Smoke-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Recruiting-Smoke-Checks bestanden.');
