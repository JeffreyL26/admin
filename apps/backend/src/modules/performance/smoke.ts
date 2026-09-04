/**
 * Smoke-Test des Leistungs-Moduls gegen eine Wegwerf-Datenbank
 * (Muster: src/test/smoke.ts). Aufruf:
 *   npx tsx apps/backend/src/modules/performance/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-perf-smoke-'));
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

// Testdaten: Mitarbeitende direkt in die Kerntabelle (das Personal-Modul wird
// parallel entwickelt; hier zählt nur das Tabellen-Schema aus 100_employees_core).
const db = getDb();
const insEmp = db.prepare(
  `INSERT INTO employees (first_name, last_name, job_title, status) VALUES (?, ?, ?, 'aktiv')`,
);
const anna = Number(insEmp.run('Anna', 'Adler', 'Entwickler:in').lastInsertRowid);
const ben = Number(insEmp.run('Ben', 'Berg', 'Entwickler:in').lastInsertRowid);
const clara = Number(insEmp.run('Clara', 'Cornelius', 'Designer:in').lastInsertRowid);

const { auth } = await firstAdminLogin(app, check);

// Auth-Pflicht des Moduls
const noAuth = await app.inject({ method: 'GET', url: '/api/performance/goals' });
check('Auth-Pflicht auf Modulrouten', noAuth.statusCode === 401);

// ============================ Ziele & OKR ============================

const objRes = await app.inject({
  method: 'POST',
  url: '/api/performance/goals',
  headers: auth,
  payload: {
    employee_id: anna,
    title: 'Kundenzufriedenheit steigern',
    kind: 'objective',
    period_from: '2026-01-01',
    period_to: '2026-12-31',
  },
});
check('Objective anlegen → 201', objRes.statusCode === 201, objRes.json());
const objectiveId = objRes.json().goal.id as number;

const kr1Res = await app.inject({
  method: 'POST',
  url: '/api/performance/goals',
  headers: auth,
  payload: {
    employee_id: anna,
    title: 'NPS von 30 auf 50',
    kind: 'key_result',
    parent_goal_id: objectiveId,
    metric: 'NPS',
    target_value: '50',
    progress: 40,
  },
});
const kr2Res = await app.inject({
  method: 'POST',
  url: '/api/performance/goals',
  headers: auth,
  payload: {
    employee_id: anna,
    title: 'Antwortzeit Support < 4h',
    kind: 'key_result',
    parent_goal_id: objectiveId,
    progress: 80,
  },
});
check('Key Results anlegen', kr1Res.statusCode === 201 && kr2Res.statusCode === 201);
const kr1Id = kr1Res.json().goal.id as number;

let goalsRes = await app.inject({
  method: 'GET',
  url: `/api/performance/goals?employee_id=${anna}`,
  headers: auth,
});
let objective = (goalsRes.json().goals as { id: number; progress: number }[]).find((g) => g.id === objectiveId);
check('Objective-Fortschritt = Ø der KRs (60)', objective?.progress === 60, objective);

const progRes = await app.inject({
  method: 'POST',
  url: `/api/performance/goals/${kr1Id}/progress`,
  headers: auth,
  payload: { progress: 100, status: 'erreicht' },
});
check(
  'KR-Update führt Objective nach (90)',
  progRes.statusCode === 200 && progRes.json().parent?.progress === 90,
  progRes.json(),
);

const noTitle = await app.inject({
  method: 'POST',
  url: '/api/performance/goals',
  headers: auth,
  payload: { employee_id: anna, title: '', kind: 'kpi' },
});
check('Validierung: leerer Titel → 400', noTitle.statusCode === 400 && noTitle.json().error.code === 'VALIDATION_ERROR');

const kpiRes = await app.inject({
  method: 'POST',
  url: '/api/performance/goals',
  headers: auth,
  payload: { employee_id: anna, title: 'Deployment-Frequenz', kind: 'kpi', metric: 'Deploys/Woche', target_value: '5' },
});
const krUnderKpi = await app.inject({
  method: 'POST',
  url: '/api/performance/goals',
  headers: auth,
  payload: { employee_id: anna, title: 'Ungültig', kind: 'key_result', parent_goal_id: kpiRes.json().goal.id },
});
check('Konflikt: KR unter KPI → 409', krUnderKpi.statusCode === 409, krUnderKpi.json());

const objProgress = await app.inject({
  method: 'POST',
  url: `/api/performance/goals/${objectiveId}/progress`,
  headers: auth,
  payload: { progress: 10 },
});
check('Konflikt: manueller Fortschritt am Objective mit KRs → 409', objProgress.statusCode === 409);

// ============================ Beurteilungen ============================

const badCycle = await app.inject({
  method: 'POST',
  url: '/api/performance/review-cycles',
  headers: auth,
  payload: { name: 'Kaputt', period_from: '2026-12-31', period_to: '2026-01-01' },
});
check('Validierung: Zyklus mit Ende vor Beginn → 400', badCycle.statusCode === 400);

const cycleRes = await app.inject({
  method: 'POST',
  url: '/api/performance/review-cycles',
  headers: auth,
  payload: { name: 'Jahresgespräch 2026', kind: 'jaehrlich', period_from: '2026-01-01', period_to: '2026-12-31', status: 'laufend' },
});
check('Zyklus anlegen', cycleRes.statusCode === 201);
const cycleId = cycleRes.json().cycle.id as number;

const tmplRes = await app.inject({
  method: 'POST',
  url: '/api/performance/review-templates',
  headers: auth,
  payload: {
    name: 'Standardbogen',
    criteria: [
      { key: 'qualitaet', label: 'Arbeitsqualität', scale_max: 5 },
      { key: 'teamwork', label: 'Zusammenarbeit', scale_max: 5 },
    ],
  },
});
check('Bogen anlegen', tmplRes.statusCode === 201);
const templateId = tmplRes.json().template.id as number;

const dupKeys = await app.inject({
  method: 'POST',
  url: '/api/performance/review-templates',
  headers: auth,
  payload: { name: 'Doppelt', criteria: [{ key: 'a', label: 'A', scale_max: 5 }, { key: 'a', label: 'B', scale_max: 5 }] },
});
check('Validierung: doppelte Kriterien-Keys → 400', dupKeys.statusCode === 400);

const selfRes = await app.inject({
  method: 'POST',
  url: '/api/performance/reviews',
  headers: auth,
  payload: { cycle_id: cycleId, employee_id: anna, template_id: templateId, kind: 'selbst' },
});
check('Selbstbewertung anlegen', selfRes.statusCode === 201);
const selfId = selfRes.json().review.id as number;

const dupSelf = await app.inject({
  method: 'POST',
  url: '/api/performance/reviews',
  headers: auth,
  payload: { cycle_id: cycleId, employee_id: anna, template_id: templateId, kind: 'selbst' },
});
check('Konflikt: zweite Selbstbewertung im Zyklus → 409', dupSelf.statusCode === 409);

const earlyComplete = await app.inject({
  method: 'POST',
  url: `/api/performance/reviews/${selfId}/complete`,
  headers: auth,
});
check('Abschluss ohne vollständige Bewertung → 400', earlyComplete.statusCode === 400);

const badScore = await app.inject({
  method: 'PUT',
  url: `/api/performance/reviews/${selfId}`,
  headers: auth,
  payload: { scores: [{ key: 'qualitaet', score: 9 }] },
});
check('Validierung: Score über Skala → 400', badScore.statusCode === 400);

await app.inject({
  method: 'PUT',
  url: `/api/performance/reviews/${selfId}`,
  headers: auth,
  payload: { scores: [{ key: 'qualitaet', score: 4, comment: 'Solide' }, { key: 'teamwork', score: 5 }], summary: 'Gutes Jahr' },
});
const selfComplete = await app.inject({
  method: 'POST',
  url: `/api/performance/reviews/${selfId}/complete`,
  headers: auth,
});
check('Abschluss mit Gesamtergebnis 4.5', selfComplete.statusCode === 200 && selfComplete.json().review.overall_score === 4.5, selfComplete.json());

// 360°: zwei Reviewer:innen für dieselbe Person im selben Zyklus
for (const [reviewer, scores] of [
  [ben, [3, 4]],
  [clara, [5, 4]],
] as [number, number[]][]) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/performance/reviews',
    headers: auth,
    payload: { cycle_id: cycleId, employee_id: anna, template_id: templateId, reviewer_employee_id: reviewer, kind: 'feedback360' },
  });
  check(`360°-Review (Reviewer ${reviewer}) anlegen`, r.statusCode === 201);
  const rid = r.json().review.id as number;
  await app.inject({
    method: 'PUT',
    url: `/api/performance/reviews/${rid}`,
    headers: auth,
    payload: { scores: [{ key: 'qualitaet', score: scores[0] }, { key: 'teamwork', score: scores[1] }] },
  });
  const done = await app.inject({ method: 'POST', url: `/api/performance/reviews/${rid}/complete`, headers: auth });
  check(`360°-Review (Reviewer ${reviewer}) abschließen`, done.statusCode === 200);
}

const dup360 = await app.inject({
  method: 'POST',
  url: '/api/performance/reviews',
  headers: auth,
  payload: { cycle_id: cycleId, employee_id: anna, template_id: templateId, reviewer_employee_id: ben, kind: 'feedback360' },
});
check('Konflikt: 360° doppelt mit derselben Reviewerin → 409', dup360.statusCode === 409);

const aggRes = await app.inject({
  method: 'GET',
  url: `/api/performance/reviews/aggregate/${cycleId}/${anna}`,
  headers: auth,
});
const agg = aggRes.json().aggregate;
const qual = agg?.criteria?.find((c: { key: string }) => c.key === 'qualitaet');
check('Aggregat: 3 Reviews, Ø qualitaet = 4', agg?.reviews_count === 3 && qual?.avg_score === 4, agg);

const overview = await app.inject({
  method: 'GET',
  url: `/api/performance/review-cycles/${cycleId}/overview`,
  headers: auth,
});
const part = (overview.json().participants as { employee_id: number; reviews_completed: number }[]).find(
  (p) => p.employee_id === anna,
);
check('Zyklus-Übersicht: 3/3 abgeschlossen', part?.reviews_completed === 3, overview.json());

// ============================ Entwicklung & Karriere ============================

const planRes = await app.inject({
  method: 'POST',
  url: '/api/performance/development-plans',
  headers: auth,
  payload: { employee_id: anna, title: 'Weg zur Seniorität', goal: 'Senior-Level erreichen' },
});
check('Entwicklungsplan anlegen', planRes.statusCode === 201);
const planId = planRes.json().plan.id as number;

const measureRes = await app.inject({
  method: 'POST',
  url: `/api/performance/development-plans/${planId}/measures`,
  headers: auth,
  payload: { title: 'Architektur-Schulung besuchen', due_date: '2026-09-30', owner_employee_id: ben },
});
check('Maßnahme anlegen', measureRes.statusCode === 201);
const measureDone = await app.inject({
  method: 'PUT',
  url: `/api/performance/development-measures/${measureRes.json().measure.id}`,
  headers: auth,
  payload: { status: 'erledigt' },
});
check('Maßnahme erledigen', measureDone.statusCode === 200 && measureDone.json().measure.status === 'erledigt');

const lvl1 = await app.inject({
  method: 'POST',
  url: '/api/performance/career-levels',
  headers: auth,
  payload: { role_name: 'Entwickler:in', level: 1, title: 'Junior Developer', requirements: '1 Jahr Erfahrung' },
});
const lvl2 = await app.inject({
  method: 'POST',
  url: '/api/performance/career-levels',
  headers: auth,
  payload: { role_name: 'Entwickler:in', level: 2, title: 'Developer', requirements: '3 Jahre Erfahrung, eigenständige Projekte' },
});
check('Karrierestufen anlegen', lvl1.statusCode === 201 && lvl2.statusCode === 201);

const dupLvl = await app.inject({
  method: 'POST',
  url: '/api/performance/career-levels',
  headers: auth,
  payload: { role_name: 'Entwickler:in', level: 1, title: 'Nochmal Junior' },
});
check('Konflikt: doppeltes Level je Rolle → 409', dupLvl.statusCode === 409);

await app.inject({
  method: 'POST',
  url: '/api/performance/employee-levels',
  headers: auth,
  payload: { employee_id: anna, career_level_id: lvl1.json().level.id, since_date: '2025-01-01' },
});
const empLevel = await app.inject({ method: 'GET', url: `/api/performance/employee-levels/${anna}`, headers: auth });
check(
  'Aktuelles Level + nächster Schritt (Level 2)',
  empLevel.json().current?.level === 1 && empLevel.json().next?.level === 2,
  empLevel.json(),
);

// ============================ Skills ============================

const skillRes = await app.inject({
  method: 'POST',
  url: '/api/performance/skills',
  headers: auth,
  payload: { name: 'TypeScript', category: 'Technik' },
});
check('Skill anlegen', skillRes.statusCode === 201);
const skillId = skillRes.json().skill.id as number;

const dupSkill = await app.inject({
  method: 'POST',
  url: '/api/performance/skills',
  headers: auth,
  payload: { name: 'TypeScript' },
});
check('Konflikt: doppelter Skill-Name → 409', dupSkill.statusCode === 409);

const badLevel = await app.inject({
  method: 'PUT',
  url: '/api/performance/employee-skills',
  headers: auth,
  payload: { employee_id: anna, skill_id: skillId, level: 7 },
});
check('Validierung: Level 7 → 400', badLevel.statusCode === 400);

const setSkill = await app.inject({
  method: 'PUT',
  url: '/api/performance/employee-skills',
  headers: auth,
  payload: { employee_id: anna, skill_id: skillId, level: 3 },
});
check('Skill-Level setzen (Upsert)', setSkill.statusCode === 200 && setSkill.json().employee_skill.level === 3);

const matrix = await app.inject({ method: 'GET', url: '/api/performance/skills/matrix', headers: auth });
const cell = (matrix.json().levels as { employee_id: number; skill_id: number; level: number }[]).find(
  (l) => l.employee_id === anna && l.skill_id === skillId,
);
check('Matrix enthält gesetztes Level', matrix.statusCode === 200 && cell?.level === 3, matrix.json());

await app.inject({
  method: 'POST',
  url: '/api/performance/role-skill-profiles',
  headers: auth,
  payload: { role_name: 'Entwickler:in', skill_id: skillId, required_level: 5 },
});
const gap = await app.inject({ method: 'GET', url: `/api/performance/skills/gap/${anna}`, headers: auth });
const gapEntry = (gap.json().gaps as { skill_id: number; gap: number; current_level: number }[])[0];
check(
  'Lückenanalyse: Soll 5, Ist 3, Lücke 2 (Rolle aus Jobtitel)',
  gap.json().role_name === 'Entwickler:in' && gapEntry?.gap === 2 && gapEntry?.current_level === 3,
  gap.json(),
);

// ============================ Trainings ============================

const trainingRes = await app.inject({
  method: 'POST',
  url: '/api/performance/trainings',
  headers: auth,
  payload: {
    title: 'Datenschutz-Grundschulung',
    kind: 'intern',
    mandatory: true,
    repeat_interval_months: 12,
    cost_cents: 15000,
  },
});
check('Pflichttraining anlegen', trainingRes.statusCode === 201);
const trainingId = trainingRes.json().training.id as number;

const regRes = await app.inject({
  method: 'POST',
  url: '/api/performance/training-registrations',
  headers: auth,
  payload: { training_id: trainingId, employee_id: anna, date: '2025-03-01' },
});
check('Anmeldung anlegen', regRes.statusCode === 201);

const dupReg = await app.inject({
  method: 'POST',
  url: '/api/performance/training-registrations',
  headers: auth,
  payload: { training_id: trainingId, employee_id: anna },
});
check('Konflikt: doppelte aktive Anmeldung → 409', dupReg.statusCode === 409);

const regDone = await app.inject({
  method: 'PUT',
  url: `/api/performance/training-registrations/${regRes.json().registration.id}`,
  headers: auth,
  payload: { status: 'abgeschlossen', completed_at: '2025-03-01' },
});
check('Anmeldung abschließen', regDone.statusCode === 200 && regDone.json().registration.completed_at === '2025-03-01');

const dueRes = await app.inject({ method: 'GET', url: '/api/performance/trainings/due', headers: auth });
const dueList = dueRes.json().due as { employee_id: number; due_status: string; due_date: string | null }[];
const annaDue = dueList.find((d) => d.employee_id === anna);
const benDue = dueList.find((d) => d.employee_id === ben);
check(
  'Fälligkeit: Anna überfällig (Abschluss 2025-03-01 + 12 Monate < heute)',
  annaDue?.due_status === 'ueberfaellig' && annaDue?.due_date === '2026-03-01',
  dueList,
);
check('Fälligkeit: Ben nie absolviert → überfällig', benDue?.due_status === 'ueberfaellig' && benDue?.due_date === null);

// ============================ Feedback-Gespräche ============================

const meetingRes = await app.inject({
  method: 'POST',
  url: '/api/performance/feedback-meetings',
  headers: auth,
  payload: { employee_id: anna, kind: 'einzelgespraech', scheduled_date: '2026-01-15', recurrence_months: 3 },
});
check('Gespräch anlegen', meetingRes.statusCode === 201);
const meetingId = meetingRes.json().meeting.id as number;

const reminders1 = await app.inject({ method: 'GET', url: '/api/performance/feedback/reminders', headers: auth });
check(
  'Erinnerungen: Gespräch in der Vergangenheit ist überfällig',
  (reminders1.json().overdue as { id: number }[]).some((m) => m.id === meetingId),
  reminders1.json(),
);

const completeRes = await app.inject({
  method: 'POST',
  url: `/api/performance/feedback-meetings/${meetingId}/complete`,
  headers: auth,
  payload: { held_date: '2026-01-20', notes: 'Gutes Gespräch, Fokusthemen vereinbart.' },
});
check(
  'Abschluss legt Folgetermin an (+3 Monate)',
  completeRes.statusCode === 200 && completeRes.json().follow_up?.scheduled_date === '2026-04-20',
  completeRes.json(),
);

const doubleComplete = await app.inject({
  method: 'POST',
  url: `/api/performance/feedback-meetings/${meetingId}/complete`,
  headers: auth,
  payload: {},
});
check('Konflikt: Gespräch doppelt abschließen → 409', doubleComplete.statusCode === 409);

const actionRes = await app.inject({
  method: 'POST',
  url: `/api/performance/feedback-meetings/${meetingId}/actions`,
  headers: auth,
  payload: { title: 'Mentoring-Programm prüfen', due_date: '2026-08-01', owner_employee_id: ben },
});
check('Maßnahme zum Gespräch anlegen', actionRes.statusCode === 201);

const reminders2 = await app.inject({ method: 'GET', url: '/api/performance/feedback/reminders', headers: auth });
check(
  'Erinnerungen: offene Maßnahme gelistet',
  (reminders2.json().open_actions as { id: number }[]).some((a) => a.id === actionRes.json().action.id),
);

const actionDone = await app.inject({
  method: 'PUT',
  url: `/api/performance/feedback-actions/${actionRes.json().action.id}`,
  headers: auth,
  payload: { status: 'erledigt' },
});
check('Maßnahme erledigen', actionDone.statusCode === 200 && actionDone.json().action.status === 'erledigt');

// Audit-Log wurde befüllt
const auditCount = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity IN ('goal', 'review', 'training', 'feedback_meeting')`)
  .get() as { n: number };
check('Audit-Log enthält Modul-Einträge', auditCount.n > 0, auditCount);

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
console.log('Alle Performance-Smoke-Checks bestanden.');
