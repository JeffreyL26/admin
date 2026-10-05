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
const { config } = await import('../../config.js');

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
const put = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url, headers: auth, payload });
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

// --------------------------------------------------- Checklisten-Vorlagen ---
const tplList = await get('/api/admin/onboarding/templates?kind=onboarding');
check('Vorlagen: 7 Standardaufgaben Onboarding', tplList.statusCode === 200 && tplList.json().templates.length === 7, tplList.json());
const tplNew = await post('/api/admin/onboarding/templates', { kind: 'onboarding', title: 'Zugangskarte bestellen' });
check('Vorlage anlegen → 201, ans Ende sortiert', tplNew.statusCode === 201 && tplNew.json().template.sort_order === 80, tplNew.json());
const tplNewId = tplNew.json().template.id as number;
const tplRename = await put(`/api/admin/onboarding/templates/${tplNewId}`, { title: 'Zugangskarte beantragen' });
check('Vorlage umbenennen', tplRename.statusCode === 200 && tplRename.json().template.title === 'Zugangskarte beantragen');
const tplOrderIds = (tplList.json().templates as { id: number }[]).map((t) => t.id);
const reorder = await put('/api/admin/onboarding/templates/order', { kind: 'onboarding', ids: [tplNewId, ...tplOrderIds] });
check('Vorlagen: Reihenfolge setzen', reorder.statusCode === 200 && reorder.json().templates[0].id === tplNewId, reorder.json());
const reorderWrong = await put('/api/admin/onboarding/templates/order', { kind: 'offboarding', ids: [tplNewId] });
check('Vorlagen: fremde Art in der Reihenfolge → 400', reorderWrong.statusCode === 400);
const tplOff = await put(`/api/admin/onboarding/templates/${tplNewId}`, { active: false });
check('Vorlage deaktivieren', tplOff.json().template.active === 0);

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

const delTaskTpl = await del(`/api/admin/onboarding/templates/${tplNewId}`);
check('Vorlage löschen → 204', delTaskTpl.statusCode === 204);
const delTaskTplAgain = await del(`/api/admin/onboarding/templates/${tplNewId}`);
check('Vorlage erneut löschen → 404', delTaskTplAgain.statusCode === 404);

const delTpl = await del(`/api/admin/templates/${tplId}`);
check('Vorlage löschen → 204', delTpl.statusCode === 204);

// ---------- Fachrollen: Kalenderrecht ----------
const roleDefault = await post('/api/admin/roles', { name: 'Außendienst' });
check(
  'Rolle ohne Angabe → can_view_calendar = 1',
  roleDefault.statusCode === 201 && roleDefault.json().role.can_view_calendar === 1,
  roleDefault.json(),
);
const roleNoCal = await post('/api/admin/roles', { name: 'Aushilfe', can_view_calendar: false });
check(
  'Rolle mit can_view_calendar=false → 0',
  roleNoCal.statusCode === 201 && roleNoCal.json().role.can_view_calendar === 0,
  roleNoCal.json(),
);
const roleId = roleDefault.json().role.id as number;
const onlyCal = await patch(`/api/admin/roles/${roleId}`, { can_view_calendar: false });
check(
  'PATCH nur can_view_calendar → 200 und gespeichert',
  onlyCal.statusCode === 200 && onlyCal.json().role.can_view_calendar === 0 && onlyCal.json().role.name === 'Außendienst',
  onlyCal.json(),
);
const nameOnly = await patch(`/api/admin/roles/${roleId}`, { name: 'Außendienst Nord' });
check(
  'PATCH nur Name lässt das Kalenderrecht unangetastet',
  nameOnly.statusCode === 200 && nameOnly.json().role.can_view_calendar === 0,
  nameOnly.json(),
);
const emptyPatch = await patch(`/api/admin/roles/${roleId}`, {});
check('Leerer PATCH → 400', emptyPatch.statusCode === 400);
const listed = await get('/api/admin/roles');
check(
  'Rollenliste trägt can_view_calendar',
  (listed.json().roles as { id: number; can_view_calendar: number }[]).find((r) => r.id === roleId)?.can_view_calendar === 0,
);
await del(`/api/admin/roles/${roleId}`);
await del(`/api/admin/roles/${roleNoCal.json().role.id}`);

// ---------- Audit in derselben Transaktion ----------
// Jede Änderung schreibt ihren Audit-Eintrag in derselben Transaktion wie die
// Änderung selbst. Ein Trigger, der jeden Audit-Eintrag abweist, muss die
// Anfrage deshalb scheitern lassen, OHNE dass die Änderung gespeichert ist
// (früher blieb sie stehen, nur der Eintrag fehlte). TEMP: Der Trigger gilt
// nur auf dieser Verbindung, über die auch die Routen schreiben. Solange er
// aktiv ist, läuft keine Route, die bewusst nur auditiert (Anmeldung).
{
  const auditCount = () => (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  const breakAudit = () =>
    db.exec("CREATE TEMP TRIGGER audit_kaputt BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit kaputt'); END;");
  const repairAudit = () => db.exec('DROP TRIGGER IF EXISTS audit_kaputt');
  const failed = (res: { statusCode: number }) => res.statusCode >= 500;

  // Vorlage mit echtem Blob: Ein Rollback darf weder Datensatz noch Blob kosten.
  const blobA = path.join(config.storageDir, 'audit-probe-a.txt');
  fs.writeFileSync(blobA, 'Probe A');
  const fileA = Number(
    db
      .prepare(
        `INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256)
         VALUES ('probe-a.txt', 'audit-probe-a.txt', 'text/plain', 7, 'sha-probe-a')`,
      )
      .run().lastInsertRowid,
  );
  const fileB = Number(
    db
      .prepare(
        `INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256)
         VALUES ('probe-b.txt', 'audit-probe-b.txt', 'text/plain', 7, 'sha-probe-b')`,
      )
      .run().lastInsertRowid,
  );
  const probeTpl = (await post('/api/admin/templates', { file_id: fileA, category: 'formular', title: 'Audit-Probe' })).json()
    .template.id as number;
  const probeRole = (await post('/api/admin/roles', { name: 'Audit-Probe' })).json().role.id as number;
  const probeAdminRole = (
    await post('/api/admin/admin-roles', { name: 'Audit-Probe', permissions: { personal: 'lesen' } })
  ).json().admin_role.id as number;
  const emptyAdminRole = (
    await post('/api/admin/admin-roles', { name: 'Audit-Probe leer', permissions: { personal: 'lesen' } })
  ).json().admin_role.id as number;
  const probeUser = await post('/api/admin/users', {
    email: 'audit.probe@example.org',
    name: 'Audit Probe',
    role: 'admin',
    admin_role_id: probeAdminRole,
  });
  check('Audit-Probe: Konto angelegt', probeUser.statusCode === 201, probeUser.json());
  const probeUserId = probeUser.json().user.id as number;
  const userRow = () =>
    db.prepare('SELECT admin_role_id, password_hash FROM users WHERE id = ?').get(probeUserId) as
      | { admin_role_id: number | null; password_hash: string }
      | undefined;
  const userBefore = userRow();
  const processCount = () => (db.prepare('SELECT COUNT(*) AS n FROM onboarding_processes').get() as { n: number }).n;
  const processesBefore = processCount();
  const auditBefore = auditCount();

  const results: Record<string, number> = {};
  breakAudit();
  try {
    results.rolePatch = (await patch(`/api/admin/roles/${probeRole}`, { name: 'Audit-Probe neu' })).statusCode;
    results.employeeRoles = (await put('/api/admin/employees/1/roles', { role_ids: [probeRole] })).statusCode;
    results.tplSwap = (await patch(`/api/admin/templates/${probeTpl}`, { file_id: fileB })).statusCode;
    results.tplDelete = (await del(`/api/admin/templates/${probeTpl}`)).statusCode;
    results.processCreate = (await post('/api/admin/onboarding', { employee_id: 1, kind: 'offboarding' })).statusCode;
    results.adminRolePatch = (
      await patch(`/api/admin/admin-roles/${probeAdminRole}`, { name: 'Audit-Probe neu', permissions: { personal: 'bearbeiten' } })
    ).statusCode;
    results.adminRoleDelete = (await del(`/api/admin/admin-roles/${emptyAdminRole}`)).statusCode;
    results.userPatch = (await patch(`/api/admin/users/${probeUserId}`, { admin_role_id: null })).statusCode;
    results.userReset = (await post(`/api/admin/users/${probeUserId}/reset-password`)).statusCode;
    results.userCreate = (
      await post('/api/admin/users', { email: 'audit.neu@example.org', name: 'Audit Neu', role: 'admin', admin_role_id: probeAdminRole })
    ).statusCode;
    results.userDelete = (await del(`/api/admin/users/${probeUserId}`)).statusCode;
  } finally {
    repairAudit();
  }
  check('Audit kaputt: jede Änderung scheitert mit 5xx', Object.values(results).every((s) => failed({ statusCode: s })), results);
  check('Audit kaputt: kein Audit-Eintrag dazugekommen', auditCount() === auditBefore, auditCount() - auditBefore);

  const roleNow = db.prepare('SELECT name FROM roles WHERE id = ?').get(probeRole) as { name: string } | undefined;
  check('Audit kaputt: Fachrolle unverändert', roleNow?.name === 'Audit-Probe', roleNow);
  const assigned = db.prepare('SELECT COUNT(*) AS n FROM employee_roles WHERE employee_id = 1 AND role_id = ?').get(probeRole) as {
    n: number;
  };
  check('Audit kaputt: Rollenzuweisung nicht gespeichert', assigned.n === 0, assigned);
  const tplNow = db.prepare('SELECT file_id FROM hr_templates WHERE id = ?').get(probeTpl) as { file_id: number } | undefined;
  check('Audit kaputt: Vorlage steht noch mit ihrer Datei', tplNow?.file_id === fileA, tplNow);
  check(
    'Audit kaputt: Datensatz und Blob der Vorlagendatei sind noch da',
    !!db.prepare('SELECT id FROM files WHERE id = ?').get(fileA) && fs.existsSync(blobA),
  );
  check('Audit kaputt: kein Prozess angelegt', processCount() === processesBefore, processCount());
  const adminRoleNow = db.prepare('SELECT name FROM admin_roles WHERE id = ?').get(probeAdminRole) as { name: string } | undefined;
  const levelNow = db
    .prepare("SELECT level FROM admin_role_permissions WHERE role_id = ? AND area = 'personal'")
    .get(probeAdminRole) as { level: string } | undefined;
  check(
    'Audit kaputt: Admin-Rolle samt Rechten unverändert',
    adminRoleNow?.name === 'Audit-Probe' && levelNow?.level === 'lesen',
    { adminRoleNow, levelNow },
  );
  check('Audit kaputt: leere Admin-Rolle nicht gelöscht', !!db.prepare('SELECT id FROM admin_roles WHERE id = ?').get(emptyAdminRole));
  const userAfter = userRow();
  check(
    'Audit kaputt: Konto weder geändert, zurückgesetzt noch gelöscht',
    !!userAfter && userAfter.admin_role_id === probeAdminRole && userAfter.password_hash === userBefore?.password_hash,
    userAfter,
  );
  check(
    'Audit kaputt: kein Konto angelegt',
    !db.prepare('SELECT id FROM users WHERE email = ?').get('audit.neu@example.org'),
  );

  // Ohne Trigger gelingt dasselbe, und der Eintrag nennt weiterhin die
  // entfernte Datei; ihr Blob verschwindet erst nach dem Commit.
  const swapped = await patch(`/api/admin/templates/${probeTpl}`, { file_id: fileB });
  const swapAudit = db
    .prepare("SELECT details FROM audit_log WHERE entity = 'hr_template' AND entity_id = ? AND action = 'update' ORDER BY id DESC")
    .get(probeTpl) as { details: string } | undefined;
  check(
    'Audit heil: Datei tauschen, Eintrag nennt die entfernte Datei',
    swapped.statusCode === 200 &&
      swapAudit?.details === JSON.stringify({ changed: { file_id: fileB }, removed_file: { id: fileA, sha256: 'sha-probe-a' } }),
    swapAudit,
  );
  check(
    'Audit heil: Datensatz und Blob der ersetzten Datei entfernt',
    !db.prepare('SELECT id FROM files WHERE id = ?').get(fileA) && !fs.existsSync(blobA),
  );
  const deleted = await del(`/api/admin/users/${probeUserId}`);
  check(
    'Audit heil: Konto löschen mit Eintrag',
    deleted.statusCode === 204 &&
      !!db.prepare("SELECT id FROM audit_log WHERE entity = 'user' AND entity_id = ? AND action = 'delete'").get(probeUserId),
    deleted.statusCode,
  );
}

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
