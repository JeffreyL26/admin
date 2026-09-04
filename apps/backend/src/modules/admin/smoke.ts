/**
 * Smoke-Test Verwaltung (HR-Vorlagen, On-/Offboarding) gegen eine Wegwerf-Datenbank.
 * Aufruf: npx tsx apps/backend/src/modules/admin/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-admin-'));
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

// Testdaten direkt in die Wegwerf-DB (Kerntabellen gehören dem Personal-Modul).
const db = getDb();
db.prepare("INSERT INTO departments (name) VALUES ('Technik')").run();
db.prepare(
  `INSERT INTO employees (first_name, last_name, status, department_id, job_title)
   VALUES ('Anna', 'Adler', 'aktiv', 1, 'Entwicklerin')`,
).run();
db.prepare(
  `INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256)
   VALUES ('musterschreiben.docx', 'x-1.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1234, 'abc')`,
).run();
db.prepare(
  `INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256)
   VALUES ('musterschreiben-v2.docx', 'x-2.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1300, 'def')`,
).run();

const { token, auth } = await firstAdminLogin(app, check);
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: auth, payload });
const patch = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url, headers: auth, payload });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: auth });

// -------------------------------------------------------------- HR-Vorlagen ---
const tpl = await post('/api/admin/templates', {
  file_id: 1,
  category: 'schreiben',
  title: 'Abmahnung (Muster)',
  description: 'Vorlage für arbeitsrechtliche Schreiben',
});
check('Vorlage anlegen → 201', tpl.statusCode === 201 && tpl.json().template.original_name === 'musterschreiben.docx', tpl.json());
const tplId = tpl.json().template.id as number;

const tplBadFile = await post('/api/admin/templates', {
  file_id: 999,
  category: 'schreiben',
  title: 'Kaputt',
});
check('Vorlage mit unbekannter Datei → 404', tplBadFile.statusCode === 404);

const tplSearch = await get('/api/admin/templates?search=abmahn&category=schreiben');
check('Vorlagen-Suche findet Treffer', tplSearch.json().templates.length === 1, tplSearch.json());
const tplSearchMiss = await get('/api/admin/templates?search=zeugnis');
check('Vorlagen-Suche ohne Treffer', tplSearchMiss.json().templates.length === 0);

const tplPatch = await patch(`/api/admin/templates/${tplId}`, { file_id: 2, title: 'Abmahnung (Muster, v2)' });
check(
  'Vorlage bearbeiten: Datei tauschen',
  tplPatch.statusCode === 200 && tplPatch.json().template.original_name === 'musterschreiben-v2.docx',
  tplPatch.json(),
);

// ----------------------------------------------------------- On-/Offboarding ---
const proc = await post('/api/admin/onboarding', {
  employee_id: 1,
  kind: 'onboarding',
  target_date: '2026-09-01',
});
check(
  'Onboarding starten → 201 mit kopierter Checkliste (7 Standardaufgaben)',
  proc.statusCode === 201 && proc.json().tasks.length === 7,
  proc.json(),
);
const procId = proc.json().process.id as number;
const tasks = proc.json().tasks as { id: number; title: string }[];
check(
  'Checkliste enthält „Handbuch für Führungskräfte freigeben“',
  tasks.some((t) => t.title === 'Handbuch für Führungskräfte freigeben'),
  tasks.map((t) => t.title),
);

const dupe = await post('/api/admin/onboarding', { employee_id: 1, kind: 'onboarding' });
check('Zweites laufendes Onboarding derselben Person → 409', dupe.statusCode === 409);
const off = await post('/api/admin/onboarding', { employee_id: 1, kind: 'offboarding' });
check('Paralleles Offboarding ist erlaubt → 201', off.statusCode === 201);
await del(`/api/admin/onboarding/${off.json().process.id}`);

const list = await get('/api/admin/onboarding?status=laufend');
check(
  'Laufende Prozesse mit Fortschritt gelistet',
  list.json().processes.length === 1 && list.json().processes[0].total_tasks === 7 && list.json().processes[0].done_tasks === 0,
  list.json(),
);

const completeTooEarly = await post(`/api/admin/onboarding/${procId}/complete`);
check('Abschließen mit offenen Aufgaben → 409', completeTooEarly.statusCode === 409);

const checkTask = await patch(`/api/admin/onboarding/tasks/${tasks[0].id}`, { done: true });
check(
  'Aufgabe abhaken setzt done_at und done_by',
  checkTask.statusCode === 200 && checkTask.json().task.done === 1 && !!checkTask.json().task.done_at && checkTask.json().task.done_by_name === 'HR Administrator',
  checkTask.json(),
);
const uncheck = await patch(`/api/admin/onboarding/tasks/${tasks[0].id}`, { done: false });
check('Aufgabe wieder öffnen', uncheck.json().task.done === 0 && uncheck.json().task.done_at === null);

const extra = await post(`/api/admin/onboarding/${procId}/tasks`, { title: 'Zugangskarte bestellen' });
check('Zusätzliche Aufgabe → 201', extra.statusCode === 201, extra.json());
const delExtra = await del(`/api/admin/onboarding/tasks/${extra.json().task.id}`);
check('Aufgabe entfernen → 204', delExtra.statusCode === 204);

for (const t of tasks) await patch(`/api/admin/onboarding/tasks/${t.id}`, { done: true });
const complete = await post(`/api/admin/onboarding/${procId}/complete`);
check(
  'Abschließen nach komplettem Abhaken',
  complete.statusCode === 200 && complete.json().process.status === 'abgeschlossen' && !!complete.json().process.completed_at,
  complete.json(),
);
const patchAfterComplete = await patch(`/api/admin/onboarding/tasks/${tasks[1].id}`, { done: false });
check('Abgeschlossener Prozess ist eingefroren → 409', patchAfterComplete.statusCode === 409);

const listDone = await get('/api/admin/onboarding?status=abgeschlossen&kind=onboarding');
check('Abgeschlossene Prozesse gefiltert', listDone.json().processes.length === 1);

// Nach Abschluss ist ein neues Onboarding derselben Person wieder möglich.
const again = await post('/api/admin/onboarding', { employee_id: 1, kind: 'onboarding' });
check('Neues Onboarding nach Abschluss → 201', again.statusCode === 201);
const delProc = await del(`/api/admin/onboarding/${again.json().process.id}`);
check('Prozess löschen → 204', delProc.statusCode === 204);

const delTpl = await del(`/api/admin/templates/${tplId}`);
check('Vorlage löschen → 204', delTpl.statusCode === 204);

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
console.log('Alle Smoke-Checks des Verwaltungsmoduls bestanden.');
