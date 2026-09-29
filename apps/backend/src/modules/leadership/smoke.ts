/**
 * Smoke-Test des Moduls Führung & Bewertung gegen eine Wegwerf-Datenbank
 * (Muster: modules/admin/smoke.ts, modules/performance/smoke.ts). Aufruf:
 *   cd apps/backend && npx tsx src/modules/leadership/smoke.ts
 *
 * Geprüft wird der Weg, den der Kunde tatsächlich geht: HR schaltet
 * Führungskräfte frei, die Zuständigkeit ergibt sich aus der Organisation
 * (manager_id, Abteilungsleitung inkl. Unterabteilungen, Teamleitung) plus
 * manuellen Zuweisungen, Führungskräfte bewerten mit EIGENEM Konto (Rolle
 * „Führungskraft“, keine HR-Bereiche), HR liest den Report. Die Zweitkonten
 * entstehen über die echte Kontoanlage (POST /api/admin/users → Erstpasswort
 * → erzwungener Wechsel), nicht per SQL — so läuft der Inbetriebnahme-Weg für
 * Führungskräfte gleich mit.
 *
 * Testdaten gehen direkt in die Kerntabellen (das Personal-Modul ist hier
 * nicht Gegenstand; es zählt nur das Schema aus 100_employees).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Leader,
  LeaderBreakdown,
  LeaderTeamResponse,
  LeadershipAssignment,
  LeadershipReport,
  Rating,
  RatingCategory,
  RatingDetail,
  RatingPeriod,
  RatingHistoryEntry,
  ScopeSource,
  TeamMember,
} from '@ohrganize/shared';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-leadership-'));
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

const { buildServer } = await import('../../server.js');
const { getDb, closeDb } = await import('../../db/db.js');
const { firstAdminLogin } = await import('../../test/adminSession.js');
const { addDaysIso } = await import('../../core/dates.js');
const { ADMIN_AREAS, periodKeyForDate, shiftPeriod, todayIsoLocal } = await import('@ohrganize/shared');

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

const app = await buildServer();

// ---------------------------------------------------------------------------
// Testdaten: Organisation
// ---------------------------------------------------------------------------
//
//   Technik (Leitung: CTO)              Vertrieb        Personal
//   ├─ CTO                              └─ SALES1       └─ HRSB
//   ├─ TLB   (manager CTO, Team Backend)
//   ├─ DEV1  (manager TLB, Team Backend)
//   ├─ DEV2  (manager TLB, Team Backend)
//   ├─ EXIT1 (manager TLB, Team Backend, ausgeschieden)
//   └─ Plattform (Unterabteilung)
//      └─ PLAT1 (manager CTO)
//   Team Backend (in Technik, Leitung: TLB)
//   Fachrolle „Projektleitung“: SALES1
const db = getDb();
const insDept = db.prepare('INSERT INTO departments (name, parent_id) VALUES (?, ?)');
const DEPT_TECHNIK = Number(insDept.run(['Technik', null]).lastInsertRowid);
const DEPT_PLATTFORM = Number(insDept.run(['Plattform', DEPT_TECHNIK]).lastInsertRowid);
const DEPT_VERTRIEB = Number(insDept.run(['Vertrieb', null]).lastInsertRowid);
const DEPT_PERSONAL = Number(insDept.run(['Personal', null]).lastInsertRowid);

const insEmp = db.prepare(
  `INSERT INTO employees (first_name, last_name, job_title, status, department_id, manager_id,
                          employee_type, hire_date, personnel_number, email)
   VALUES (@first_name, @last_name, @job_title, @status, @department_id, @manager_id,
           'vollzeit', '2021-03-01', @personnel_number, @email)`,
);
let personnelCounter = 1000;
function addEmployee(o: {
  first_name: string;
  last_name: string;
  job_title: string;
  department_id: number;
  manager_id?: number | null;
  status?: 'aktiv' | 'ausgeschieden';
}): number {
  personnelCounter += 1;
  return Number(
    insEmp.run({
      first_name: o.first_name,
      last_name: o.last_name,
      job_title: o.job_title,
      status: o.status ?? 'aktiv',
      department_id: o.department_id,
      manager_id: o.manager_id ?? null,
      personnel_number: `P-${personnelCounter}`,
      email: `${o.first_name}.${o.last_name}@example.org`.toLowerCase(),
    }).lastInsertRowid,
  );
}

const CTO = addEmployee({ first_name: 'Carla', last_name: 'Cheftech', job_title: 'CTO', department_id: DEPT_TECHNIK });
const TLB = addEmployee({ first_name: 'Tim', last_name: 'Leitner', job_title: 'Teamleitung Backend', department_id: DEPT_TECHNIK, manager_id: CTO });
const DEV1 = addEmployee({ first_name: 'Dana', last_name: 'Dorn', job_title: 'Entwicklerin', department_id: DEPT_TECHNIK, manager_id: TLB });
const DEV2 = addEmployee({ first_name: 'Erik', last_name: 'Eberle', job_title: 'Entwickler', department_id: DEPT_TECHNIK, manager_id: TLB });
const PLAT1 = addEmployee({ first_name: 'Paula', last_name: 'Platt', job_title: 'Plattform-Engineer', department_id: DEPT_PLATTFORM, manager_id: CTO });
const SALES1 = addEmployee({ first_name: 'Sven', last_name: 'Verkauf', job_title: 'Account Manager', department_id: DEPT_VERTRIEB });
const EXIT1 = addEmployee({ first_name: 'Xaver', last_name: 'Ausgeschieden', job_title: 'Entwickler', department_id: DEPT_TECHNIK, manager_id: TLB, status: 'ausgeschieden' });
const HRSB = addEmployee({ first_name: 'Hanna', last_name: 'Personal', job_title: 'HR-Sachbearbeitung', department_id: DEPT_PERSONAL });

const TEAM_BACKEND = Number(
  db
    .prepare('INSERT INTO teams (name, department_id, lead_employee_id) VALUES (?, ?, ?)')
    .run(['Backend', DEPT_TECHNIK, TLB]).lastInsertRowid,
);
db.prepare('UPDATE employees SET team_id = ? WHERE id IN (?, ?, ?, ?)').run([TEAM_BACKEND, TLB, DEV1, DEV2, EXIT1]);
db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run([CTO, DEPT_TECHNIK]);

const ROLE_PROJEKTLEITUNG = Number(
  db
    .prepare("INSERT INTO roles (name, description) VALUES ('Projektleitung', 'Smoke-Test')")
    .run().lastInsertRowid,
);
db.prepare('INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)').run([SALES1, ROLE_PROJEKTLEITUNG]);

// ---------------------------------------------------------------------------
// HTTP-Helfer
// ---------------------------------------------------------------------------

type Auth = { authorization: string };

function client(auth: Auth) {
  return {
    auth,
    get: (url: string) => app.inject({ method: 'GET', url, headers: auth }),
    post: (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: auth, payload }),
    put: (url: string, payload?: object) => app.inject({ method: 'PUT', url, headers: auth, payload }),
    patch: (url: string, payload?: object) => app.inject({ method: 'PATCH', url, headers: auth, payload }),
    del: (url: string) => app.inject({ method: 'DELETE', url, headers: auth }),
  };
}
type Client = ReturnType<typeof client>;

const adminSession = await firstAdminLogin(app, check);
const admin = client(adminSession.auth);

/**
 * Passwort der Zweitkonten nach dem erzwungenen Wechsel. Regeln aus
 * core/auth.ts: ≥ 12 Zeichen, weder „ohrganize“ (Produkt- und Firmenname)
 * noch der E-Mail-Lokalteil noch eine gängige Tastenfolge.
 */
const SECOND_PASSWORD = 'Team-Bewertung-4711!';

/**
 * Konto über die echte Kontoanlage erzeugen und den Erstlogin durchlaufen:
 * Erstpasswort aus der Antwort → Login → Wechselzwang sperrt alles andere →
 * eigenes Passwort → mit dem frischen Token weiterarbeiten.
 */
async function loginAs(employeeId: number, email: string, name: string, adminRoleId: number): Promise<Client> {
  const created = await admin.post('/api/admin/users', {
    email,
    name,
    role: 'admin',
    employee_id: employeeId,
    admin_role_id: adminRoleId,
  });
  check(
    `Konto ${email} anlegen → 201 mit Erstpasswort`,
    created.statusCode === 201 && typeof created.json().initial_password === 'string',
    created.json(),
  );
  if (created.statusCode !== 201) throw new Error(`Kontoanlage ${email} fehlgeschlagen`);
  const initialPassword = created.json().initial_password as string;

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: initialPassword },
  });
  check(
    `Login ${email} mit Erstpasswort → 200, Wechselzwang gesetzt`,
    login.statusCode === 200 && login.json().user?.must_change_password === 1,
    login.json(),
  );
  if (login.statusCode !== 200) throw new Error(`Login ${email} fehlgeschlagen`);
  const firstAuth: Auth = { authorization: `Bearer ${login.json().token as string}` };

  const blocked = await app.inject({ method: 'GET', url: '/api/leadership/me/status', headers: firstAuth });
  check(
    `Wechselzwang sperrt /api/leadership/me/status für ${email} (403 PASSWORD_CHANGE_REQUIRED)`,
    blocked.statusCode === 403 && blocked.json()?.error?.code === 'PASSWORD_CHANGE_REQUIRED',
    blocked.json(),
  );

  const changed = await app.inject({
    method: 'PUT',
    url: '/api/auth/password',
    headers: firstAuth,
    payload: { currentPassword: initialPassword, newPassword: SECOND_PASSWORD },
  });
  check(
    `Passwortwechsel ${email} → 200 mit frischem Token`,
    changed.statusCode === 200 && typeof changed.json().token === 'string',
    changed.json(),
  );
  if (changed.statusCode !== 200) throw new Error(`Passwortwechsel ${email} fehlgeschlagen`);
  return client({ authorization: `Bearer ${changed.json().token as string}` });
}

// Vergleichshelfer für Zuständigkeitslisten.
function ids(team: TeamMember[]): number[] {
  return team.map((m) => m.id).sort((a, b) => a - b);
}
function sameSet<T>(actual: readonly T[], expected: readonly T[]): boolean {
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.length === e.length && a.every((v, i) => v === e[i]);
}
function member(team: TeamMember[], id: number): TeamMember | undefined {
  return team.find((m) => m.id === id);
}
function hasSources(m: TeamMember | undefined, expected: ScopeSource[]): boolean {
  return !!m && sameSet(m.sources, expected);
}
async function teamOf(leaderId: number): Promise<TeamMember[]> {
  const res = await admin.get(`/api/leadership/leaders/${leaderId}/team`);
  if (res.statusCode !== 200) throw new Error(`leaders/${leaderId}/team → ${res.statusCode}: ${res.body}`);
  return res.json().team as TeamMember[];
}

// ============================ 1. Migration ============================

const settingsRes = await admin.get('/api/leadership/settings');
const settings0 = settingsRes.json().settings;
check(
  'Einstellungen: Standard quartal / stars5 / uniform_scale 1 / allow_mutual 1 / drei Auto-Quellen an',
  settingsRes.statusCode === 200 &&
    settings0?.period === 'quartal' &&
    settings0?.scale === 'stars5' &&
    settings0?.uniform_scale === 1 &&
    settings0?.allow_mutual === 1 &&
    settings0?.auto_direct_reports === 1 &&
    settings0?.auto_department_head === 1 &&
    settings0?.auto_team_lead === 1,
  settings0,
);

const catRes = await admin.get('/api/leadership/categories');
const cats0 = catRes.json().categories as RatingCategory[];
check(
  'Kategorien: fünf Standardkategorien, Gesamtbewertung zuerst (is_overall 1, effective_scale stars5)',
  catRes.statusCode === 200 &&
    cats0.length === 5 &&
    cats0[0].name === 'Gesamtbewertung' &&
    cats0[0].is_overall === 1 &&
    cats0[0].effective_scale === 'stars5' &&
    cats0.every((c) => c.active === 1 && c.effective_scale === 'stars5' && c.rating_count === 0),
  cats0,
);
check(
  'Kategorien: Namen und Reihenfolge des Standards',
  cats0.map((c) => c.name).join('|') === 'Gesamtbewertung|Leistung|Verhalten|Teamkompetenz|Fachliche Kompetenz',
  cats0.map((c) => c.name),
);
const gesamt = cats0.find((c) => c.is_overall === 1)!;
const leistung = cats0.find((c) => c.name === 'Leistung')!;
const verhalten = cats0.find((c) => c.name === 'Verhalten')!;

const rolesRes = await admin.get('/api/admin/admin-roles');
const adminRoles = rolesRes.json().admin_roles as { id: number; name: string; permissions: Record<string, string> }[];
const fuehrungskraftRole = adminRoles.find((r) => r.name === 'Führungskraft');
check(
  'Admin-Rolle „Führungskraft“ existiert mit allen Bereichen „kein“',
  !!fuehrungskraftRole && ADMIN_AREAS.every((a) => fuehrungskraftRole.permissions[a] === 'kein'),
  fuehrungskraftRole,
);
if (!fuehrungskraftRole) throw new Error('Rolle „Führungskraft“ fehlt — Migration 310 nicht gelaufen?');
check(
  '„Geschäftsführung“ hat fuehrung: bearbeiten',
  adminRoles.find((r) => r.name === 'Geschäftsführung')?.permissions.fuehrung === 'bearbeiten',
  adminRoles.map((r) => [r.name, r.permissions.fuehrung]),
);
check(
  '„Head of HR“ hat fuehrung: bearbeiten (aus benutzer übernommen)',
  adminRoles.find((r) => r.name === 'Head of HR')?.permissions.fuehrung === 'bearbeiten',
);
check(
  '„HR-Sachbearbeitung“ hat fuehrung: kein',
  adminRoles.find((r) => r.name === 'HR-Sachbearbeitung')?.permissions.fuehrung === 'kein',
);

// ============================ 2. Gate der Führungsfunktion ============================

const noAuth = await app.inject({ method: 'GET', url: '/api/leadership/me/status' });
check('Auth-Pflicht auf /api/leadership/me/status → 401', noAuth.statusCode === 401, noAuth.json());

const statusAdmin = await admin.get('/api/leadership/me/status');
check(
  'Standard-Admin ohne Profil: /me/status → 200, is_leader false',
  statusAdmin.statusCode === 200 &&
    statusAdmin.json().is_leader === false &&
    statusAdmin.json().employee_id === null &&
    statusAdmin.json().team_size === 0,
  statusAdmin.json(),
);
const teamAdmin = await admin.get('/api/leadership/me/team');
check(
  'Standard-Admin ohne Profil: /me/team → 403 (kein Personalprofil)',
  teamAdmin.statusCode === 403 && /Personalprofil/.test(teamAdmin.json()?.error?.message ?? ''),
  teamAdmin.json(),
);

const tlb = await loginAs(TLB, 'tim.leitner@example.org', 'Tim Leitner', fuehrungskraftRole.id);

const tlbTeamBefore = await tlb.get('/api/leadership/me/team');
check(
  'TLB vor Freischaltung: /me/team → 403 „nicht freigeschaltet“',
  tlbTeamBefore.statusCode === 403 && /nicht freigeschaltet/.test(tlbTeamBefore.json()?.error?.message ?? ''),
  tlbTeamBefore.json(),
);
const tlbStatusBefore = await tlb.get('/api/leadership/me/status');
check(
  'TLB vor Freischaltung: /me/status → 200, is_leader false, employee_id gesetzt',
  tlbStatusBefore.statusCode === 200 &&
    tlbStatusBefore.json().is_leader === false &&
    tlbStatusBefore.json().employee_id === TLB,
  tlbStatusBefore.json(),
);
const tlbSettings = await tlb.get('/api/leadership/settings');
check('Rolle Führungskraft: Verwaltung GET /api/leadership/settings → 403', tlbSettings.statusCode === 403, tlbSettings.json());
const tlbEmployees = await tlb.get('/api/employees');
check('Rolle Führungskraft: GET /api/employees → 403', tlbEmployees.statusCode === 403, tlbEmployees.json());
const tlbReport = await tlb.get('/api/leadership/report');
check('Rolle Führungskraft: GET /api/leadership/report → 403', tlbReport.statusCode === 403, tlbReport.json());

// ============================ 3. Freischalten ============================

const grantCto = await admin.post('/api/leadership/leaders', { employee_id: CTO, note: 'Technikleitung' });
const ctoLeader = grantCto.json().leader as Leader | undefined;
check(
  'CTO freischalten → 201, ohne Desktop-Konto (user_id null), team_size 4, keine Warnung',
  grantCto.statusCode === 201 &&
    ctoLeader?.employee_id === CTO &&
    ctoLeader?.user_id === null &&
    ctoLeader?.team_size === 4 &&
    ctoLeader?.auto_scope === 1 &&
    ctoLeader?.note === 'Technikleitung' &&
    ctoLeader?.granted_by_name === 'HR Administrator' &&
    (grantCto.json().warnings as string[])?.length === 0,
  grantCto.json(),
);
const grantAgain = await admin.post('/api/leadership/leaders', { employee_id: CTO });
check('CTO erneut freischalten → 409', grantAgain.statusCode === 409, grantAgain.json());
const grantExit = await admin.post('/api/leadership/leaders', { employee_id: EXIT1 });
check('Ausgeschiedene Person freischalten → 400', grantExit.statusCode === 400, grantExit.json());
const grantUnknown = await admin.post('/api/leadership/leaders', { employee_id: 99999 });
check('Unbekannte Person freischalten → 404', grantUnknown.statusCode === 404, grantUnknown.json());

const grantTlb = await admin.post('/api/leadership/leaders', { employee_id: TLB });
const tlbLeader = grantTlb.json().leader as Leader | undefined;
check(
  'TLB freischalten → 201 mit verknüpftem Konto (user_email), team_size 2',
  grantTlb.statusCode === 201 &&
    tlbLeader?.employee_id === TLB &&
    tlbLeader?.user_email === 'tim.leitner@example.org' &&
    tlbLeader?.team_size === 2 &&
    tlbLeader?.department_name === 'Technik',
  grantTlb.json(),
);

const leadersRes = await admin.get('/api/leadership/leaders');
const leaders = leadersRes.json().leaders as Leader[];
check(
  'GET leaders: beide freigeschaltet, team_size CTO 4 / TLB 2, assignment_count 0',
  leadersRes.statusCode === 200 &&
    leaders.length === 2 &&
    leaders.find((l) => l.employee_id === CTO)?.team_size === 4 &&
    leaders.find((l) => l.employee_id === TLB)?.team_size === 2 &&
    leaders.every((l) => l.assignment_count === 0),
  leaders,
);

// ============================ 4. Scope-Ableitung ============================

const ctoTeam = await teamOf(CTO);
check(
  'CTO-Team: TLB, DEV1, DEV2, PLAT1 — nicht CTO selbst, nicht EXIT1, nicht SALES1/HRSB',
  sameSet(ids(ctoTeam), [TLB, DEV1, DEV2, PLAT1]),
  ids(ctoTeam),
);
check('CTO-Team: TLB mit Quellen direkt + abteilung', hasSources(member(ctoTeam, TLB), ['direkt', 'abteilung']), member(ctoTeam, TLB)?.sources);
check(
  'CTO-Team: DEV1/DEV2 nur über abteilung',
  hasSources(member(ctoTeam, DEV1), ['abteilung']) && hasSources(member(ctoTeam, DEV2), ['abteilung']),
  [member(ctoTeam, DEV1)?.sources, member(ctoTeam, DEV2)?.sources],
);
check(
  'CTO-Team: PLAT1 mit direkt + abteilung (Unterabteilung Plattform zählt zur Technik)',
  hasSources(member(ctoTeam, PLAT1), ['direkt', 'abteilung']),
  member(ctoTeam, PLAT1)?.sources,
);
check(
  'CTO-Team: Stammdaten fürs Widget (Abteilung, Team, Personalnummer), keine gegenseitige Verantwortung, unbewertet',
  member(ctoTeam, DEV1)?.department_name === 'Technik' &&
    member(ctoTeam, DEV1)?.team_name === 'Backend' &&
    member(ctoTeam, PLAT1)?.department_name === 'Plattform' &&
    !!member(ctoTeam, DEV1)?.personnel_number &&
    ctoTeam.every((m) => m.mutual === 0 && m.overall === null && m.rated_categories === 0 && m.last_rated_at === null),
  ctoTeam,
);

const tlbTeamRes = await admin.get(`/api/leadership/leaders/${TLB}/team`);
const tlbTeam = tlbTeamRes.json().team as TeamMember[];
check(
  'TLB-Team: DEV1, DEV2 mit direkt + team — nicht TLB selbst, nicht EXIT1',
  tlbTeamRes.statusCode === 200 &&
    sameSet(ids(tlbTeam), [DEV1, DEV2]) &&
    hasSources(member(tlbTeam, DEV1), ['direkt', 'team']) &&
    hasSources(member(tlbTeam, DEV2), ['direkt', 'team']),
  tlbTeam.map((m) => [m.id, m.sources]),
);
check(
  'TLB-Team: Antwort enthält leader, leere assignments und mutual',
  tlbTeamRes.json().leader?.employee_id === TLB &&
    (tlbTeamRes.json().assignments as unknown[]).length === 0 &&
    (tlbTeamRes.json().mutual as unknown[]).length === 0,
  tlbTeamRes.json(),
);
const teamUnknown = await admin.get('/api/leadership/leaders/99999/team');
check('Team einer nicht freigeschalteten Person → 404', teamUnknown.statusCode === 404, teamUnknown.json());

// ============================ 5. Manuelle Zuweisungen ============================

const assignUrl = `/api/leadership/leaders/${TLB}/assignments`;
const a1 = await admin.post(assignUrl, { kind: 'include', target_type: 'role', target_id: ROLE_PROJEKTLEITUNG, note: 'Projektverantwortung' });
const a1Assignment = a1.json().assignment as LeadershipAssignment | undefined;
check(
  'Zuweisung Fachrolle „Projektleitung“ → 201 mit target_name und created_by_name',
  a1.statusCode === 201 &&
    a1Assignment?.kind === 'include' &&
    a1Assignment?.target_type === 'role' &&
    a1Assignment?.target_id === ROLE_PROJEKTLEITUNG &&
    a1Assignment?.target_name === 'Projektleitung' &&
    a1Assignment?.created_by_name === 'HR Administrator' &&
    (a1.json().warnings as string[])?.length === 0,
  a1.json(),
);
let t = await teamOf(TLB);
check('SALES1 nun im TLB-Team mit Quelle zugewiesen', hasSources(member(t, SALES1), ['zugewiesen']) && sameSet(ids(t), [DEV1, DEV2, SALES1]), ids(t));

const a2 = await admin.post(assignUrl, { kind: 'exclude', target_type: 'employee', target_id: DEV2 });
check('Ausnahme Person DEV2 → 201', a2.statusCode === 201 && a2.json().assignment?.kind === 'exclude', a2.json());
t = await teamOf(TLB);
check('DEV2 verschwindet aus dem TLB-Team (Ausnahme schlägt Automatik)', sameSet(ids(t), [DEV1, SALES1]), ids(t));

const tomorrow = addDaysIso(todayIsoLocal(), 1);
const yesterday = addDaysIso(todayIsoLocal(), -1);
const a3 = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: HRSB, valid_from: tomorrow });
check('Befristete Zuweisung HRSB ab morgen → 201', a3.statusCode === 201 && a3.json().assignment?.valid_from === tomorrow, a3.json());
t = await teamOf(TLB);
check('HRSB NICHT im Team (gilt erst ab morgen)', !member(t, HRSB), ids(t));

const a4 = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: HRSB, valid_to: yesterday });
check('Abgelaufene Zuweisung HRSB bis gestern → 201', a4.statusCode === 201 && a4.json().assignment?.valid_to === yesterday, a4.json());
t = await teamOf(TLB);
check('HRSB weiterhin NICHT im Team (bis gestern)', !member(t, HRSB), ids(t));

const listWithAssignments = await admin.get(`/api/leadership/leaders/${TLB}/team`);
check(
  'Vorschau listet alle vier Zuweisungen; GET leaders zählt assignment_count 4',
  (listWithAssignments.json().assignments as LeadershipAssignment[]).length === 4 &&
    ((await admin.get('/api/leadership/leaders')).json().leaders as Leader[]).find((l) => l.employee_id === TLB)?.assignment_count === 4,
  listWithAssignments.json().assignments,
);

const delA3 = await admin.del(`/api/leadership/assignments/${a3.json().assignment.id}`);
const delA4 = await admin.del(`/api/leadership/assignments/${a4.json().assignment.id}`);
check('Befristete Zuweisungen löschen → 204', delA3.statusCode === 204 && delA4.statusCode === 204);
const delA2 = await admin.del(`/api/leadership/assignments/${a2.json().assignment.id}`);
check('Ausnahme löschen → 204', delA2.statusCode === 204);
t = await teamOf(TLB);
check('Effekt weg: DEV2 wieder im Team (direkt + team)', sameSet(ids(t), [DEV1, DEV2, SALES1]) && hasSources(member(t, DEV2), ['direkt', 'team']), ids(t));
const delA2Again = await admin.del(`/api/leadership/assignments/${a2.json().assignment.id}`);
check('Gelöschte Zuweisung erneut löschen → 404', delA2Again.statusCode === 404);

const selfAssign = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: TLB });
check('Zuweisung der Führungskraft auf sich selbst → 400', selfAssign.statusCode === 400, selfAssign.json());
const unknownEmp = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: 99999 });
check('Ziel Person unbekannt → 404', unknownEmp.statusCode === 404, unknownEmp.json());
const unknownDept = await admin.post(assignUrl, { kind: 'include', target_type: 'department', target_id: 99999 });
check('Ziel Abteilung unbekannt → 404', unknownDept.statusCode === 404, unknownDept.json());
const badRange = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: HRSB, valid_from: tomorrow, valid_to: yesterday });
check('valid_from > valid_to → 400', badRange.statusCode === 400, badRange.json());
const badKind = await admin.post(assignUrl, { kind: 'vielleicht', target_type: 'employee', target_id: HRSB });
check('Unbekannte Art → 400', badKind.statusCode === 400, badKind.json());
const assignUnknownLeader = await admin.post('/api/leadership/leaders/99999/assignments', { kind: 'include', target_type: 'employee', target_id: HRSB });
check('Zuweisung an nicht freigeschaltete Person → 404', assignUnknownLeader.statusCode === 404, assignUnknownLeader.json());

// ============================ 6. Gegenseitige Verantwortung ============================

const mutualAssign = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: CTO });
const mutualWarnings = (mutualAssign.json().warnings ?? []) as string[];
check(
  'TLB zuständig für CTO → 201 mit Warnung „Gegenseitige Verantwortung mit Carla Cheftech“',
  mutualAssign.statusCode === 201 &&
    mutualWarnings.length === 1 &&
    /Gegenseitige Verantwortung/.test(mutualWarnings[0]) &&
    mutualWarnings[0].includes('Carla Cheftech'),
  mutualAssign.json(),
);
const ctoTeamMutual = await teamOf(CTO);
check('Im CTO-Team trägt TLB mutual 1 (übrige 0)', member(ctoTeamMutual, TLB)?.mutual === 1 && ctoTeamMutual.filter((m) => m.mutual === 1).length === 1, ctoTeamMutual.map((m) => [m.id, m.mutual]));
const tlbTeamMutualRes = await admin.get(`/api/leadership/leaders/${TLB}/team`);
const tlbMutualList = tlbTeamMutualRes.json().mutual as { employee_id: number }[];
check(
  'leaders/TLB/team: mutual enthält CTO, CTO im Team mit Quelle zugewiesen und mutual 1',
  tlbMutualList.length === 1 &&
    tlbMutualList[0].employee_id === CTO &&
    hasSources(member(tlbTeamMutualRes.json().team, CTO), ['zugewiesen']) &&
    member(tlbTeamMutualRes.json().team, CTO)?.mutual === 1,
  tlbTeamMutualRes.json(),
);

const delMutual = await admin.del(`/api/leadership/assignments/${mutualAssign.json().assignment.id}`);
check('Gegenseitige Zuweisung löschen → 204', delMutual.statusCode === 204);
const forbidMutual = await admin.put('/api/leadership/settings', { allow_mutual: false });
check('PUT settings allow_mutual false → 200', forbidMutual.statusCode === 200 && forbidMutual.json().settings?.allow_mutual === 0, forbidMutual.json());
const mutualDenied = await admin.post(assignUrl, { kind: 'include', target_type: 'employee', target_id: CTO });
check(
  'Dieselbe Zuweisung bei verbotener Gegenseitigkeit → 409',
  mutualDenied.statusCode === 409 && /[Gg]egenseitige Verantwortung/.test(mutualDenied.json()?.error?.message ?? ''),
  mutualDenied.json(),
);
const afterDenied = await admin.get(`/api/leadership/leaders/${TLB}/team`);
check(
  'Abgelehnte Zuweisung ist nicht gespeichert (Transaktion zurückgerollt), mutual leer',
  !(afterDenied.json().assignments as LeadershipAssignment[]).some((a) => a.target_type === 'employee' && a.target_id === CTO) &&
    (afterDenied.json().mutual as unknown[]).length === 0,
  afterDenied.json(),
);
const allowMutual = await admin.put('/api/leadership/settings', { allow_mutual: true });
check('PUT settings allow_mutual true → 200', allowMutual.statusCode === 200 && allowMutual.json().settings?.allow_mutual === 1);
const emptyPatch = await admin.put('/api/leadership/settings', {});
check('PUT settings ohne Änderungen → 400', emptyPatch.statusCode === 400, emptyPatch.json());

// ============================ 7. Bewertungen (als TLB-Konto) ============================

const period = periodKeyForDate(todayIsoLocal(), 'quartal');
const rate = (employeeId: number, body: object) => tlb.put(`/api/leadership/me/employees/${employeeId}/ratings`, body);

const save1 = await rate(DEV1, {
  period_key: period,
  ratings: [
    { category_id: gesamt.id, score: 4, comment: 'Solide Arbeit' },
    { category_id: leistung.id, score: 5, comment: 'Sehr gut' },
  ],
});
const save1Ratings = (save1.json().ratings ?? []) as Rating[];
check(
  'Bewertung DEV1 speichern → 200, 2 Bewertungen in Version 1 auf stars5, Gesamt zuerst',
  save1.statusCode === 200 &&
    save1Ratings.length === 2 &&
    save1Ratings.every((r) => r.version === 1 && r.scale === 'stars5' && r.period_key === period && r.period_kind === 'quartal' && r.employee_id === DEV1 && r.leader_employee_id === TLB) &&
    save1Ratings[0].category_id === gesamt.id &&
    save1Ratings[0].score === 4 &&
    save1Ratings[0].created_by_name === 'Tim Leitner' &&
    save1Ratings[1].category_id === leistung.id &&
    save1Ratings[1].score === 5,
  save1.json(),
);

const noComment = await rate(DEV1, { period_key: period, ratings: [{ category_id: gesamt.id, score: 4, comment: '   ' }] });
check('Ohne Kommentar → 400 (Pflichtkommentar)', noComment.statusCode === 400 && /Kommentar/.test(noComment.json()?.error?.message ?? ''), noComment.json());
const tooHigh = await rate(DEV1, { period_key: period, ratings: [{ category_id: gesamt.id, score: 6, comment: 'x' }] });
check('Wert 6 auf 5-Sterne-Skala → 400', tooHigh.statusCode === 400, tooHigh.json());
const tooLow = await rate(DEV1, { period_key: period, ratings: [{ category_id: gesamt.id, score: 0, comment: 'x' }] });
check('Wert 0 → 400', tooLow.statusCode === 400, tooLow.json());
const future = await rate(DEV1, { period_key: shiftPeriod(period, 1), ratings: [{ category_id: gesamt.id, score: 3, comment: 'x' }] });
check('Zukünftiges Quartal → 400', future.statusCode === 400 && /zukünftig/i.test(future.json()?.error?.message ?? ''), future.json());
const wrongCadence = await rate(DEV1, { period_key: periodKeyForDate(todayIsoLocal(), 'monat'), ratings: [{ category_id: gesamt.id, score: 3, comment: 'x' }] });
check('Monatsschlüssel bei Quartalskadenz → 400', wrongCadence.statusCode === 400, wrongCadence.json());
const junkKey = await rate(DEV1, { period_key: 'kaputt', ratings: [{ category_id: gesamt.id, score: 3, comment: 'x' }] });
check('Unlesbarer Zeitraum → 400', junkKey.statusCode === 400, junkKey.json());
const duplicate = await rate(DEV1, {
  period_key: period,
  ratings: [
    { category_id: gesamt.id, score: 3, comment: 'a' },
    { category_id: gesamt.id, score: 4, comment: 'b' },
  ],
});
check('Doppelte Kategorie → 400', duplicate.statusCode === 400, duplicate.json());
const emptyList = await rate(DEV1, { period_key: period, ratings: [] });
check('Leere Blockliste → 400', emptyList.statusCode === 400, emptyList.json());
const unknownCategory = await rate(DEV1, { period_key: period, ratings: [{ category_id: 99999, score: 3, comment: 'x' }] });
check('Unbekannte Kategorie → 404', unknownCategory.statusCode === 404, unknownCategory.json());

const delA1 = await admin.del(`/api/leadership/assignments/${a1Assignment!.id}`);
check('Rollen-Zuweisung löschen → 204', delA1.statusCode === 204);
const outOfScope = await rate(SALES1, { period_key: period, ratings: [{ category_id: gesamt.id, score: 3, comment: 'x' }] });
check('SALES1 nach Löschen der Rollen-Zuweisung → 403', outOfScope.statusCode === 403, outOfScope.json());
const outOfScope2 = await rate(HRSB, { period_key: period, ratings: [{ category_id: gesamt.id, score: 3, comment: 'x' }] });
check('HRSB (nie im Bereich) → 403', outOfScope2.statusCode === 403, outOfScope2.json());
const detailOutOfScope = await tlb.get(`/api/leadership/me/employees/${HRSB}`);
check('Detail einer Person außerhalb des Bereichs → 403', detailOutOfScope.statusCode === 403, detailOutOfScope.json());
const outOfScopeSelf = await rate(TLB, { period_key: period, ratings: [{ category_id: gesamt.id, score: 3, comment: 'x' }] });
check('Sich selbst bewerten → 403', outOfScopeSelf.statusCode === 403, outOfScopeSelf.json());

const historyCount = () => (db.prepare('SELECT COUNT(*) AS n FROM leadership_rating_history').get() as { n: number }).n;
const historyBefore = historyCount();
const saveSame = await rate(DEV1, {
  period_key: period,
  ratings: [
    { category_id: gesamt.id, score: 4, comment: '  Solide Arbeit ' },
    { category_id: leistung.id, score: 5, comment: 'Sehr gut' },
  ],
});
check(
  'Unveränderter erneuter PUT → 200, Version bleibt 1, Protokoll wächst nicht',
  saveSame.statusCode === 200 &&
    (saveSame.json().ratings as Rating[]).every((r) => r.version === 1) &&
    historyBefore === 2 &&
    historyCount() === 2,
  { historyBefore, historyAfter: historyCount(), ratings: saveSame.json() },
);

const saveChanged = await rate(DEV1, {
  period_key: period,
  ratings: [
    { category_id: gesamt.id, score: 3, comment: 'Nachgebessert: solide, aber Luft nach oben' },
    { category_id: leistung.id, score: 5, comment: 'Sehr gut' },
  ],
});
const changedRatings = (saveChanged.json().ratings ?? []) as Rating[];
check(
  'Geänderter Wert → 200, Gesamt Version 2 (score 3), Leistung bleibt Version 1',
  saveChanged.statusCode === 200 &&
    changedRatings.find((r) => r.category_id === gesamt.id)?.version === 2 &&
    changedRatings.find((r) => r.category_id === gesamt.id)?.score === 3 &&
    changedRatings.find((r) => r.category_id === leistung.id)?.version === 1 &&
    historyCount() === 3,
  saveChanged.json(),
);

const detail = await tlb.get(`/api/leadership/me/employees/${DEV1}?period=${period}`);
const d = detail.json();
const history = (d.history ?? []) as RatingHistoryEntry[];
const changedEntry = history.find((h) => h.change_kind === 'geaendert');
check(
  'Detail: Protokoll mit 3 Einträgen (2× erstellt, 1× geändert mit previous_score 4), neueste zuerst',
  detail.statusCode === 200 &&
    history.length === 3 &&
    history.filter((h) => h.change_kind === 'erstellt').length === 2 &&
    history[0].change_kind === 'geaendert' &&
    changedEntry?.previous_score === 4 &&
    changedEntry?.previous_comment === 'Solide Arbeit' &&
    changedEntry?.score === 3 &&
    changedEntry?.version === 2 &&
    changedEntry?.changed_by_name === 'Tim Leitner' &&
    history.every((h) => h.category_name && h.period_key === period && h.scale === 'stars5'),
  history,
);
check(
  'Detail: ratings[0] ist Gesamtbewertung v2 mit updated_by_name, all_ratings enthält beide',
  (d.ratings as Rating[])?.length === 2 &&
    (d.ratings as Rating[])[0].category_id === gesamt.id &&
    (d.ratings as Rating[])[0].version === 2 &&
    (d.ratings as Rating[])[0].updated_by_name === 'Tim Leitner' &&
    (d.all_ratings as Rating[])?.length === 2,
  d.ratings,
);
check(
  'Detail: periods enthält aktuellen Zeitraum (zuerst), period/current_period stimmen',
  Array.isArray(d.periods) &&
    d.periods[0]?.key === period &&
    d.periods.length >= 12 &&
    d.period?.key === period &&
    d.current_period?.key === period,
  d.periods,
);
check(
  'Detail: employee.overall.score 3 (stars5), rated_categories 2, Quellen direkt + team, Kategorien nur aktive',
  d.employee?.id === DEV1 &&
    d.employee?.overall?.score === 3 &&
    d.employee?.overall?.scale === 'stars5' &&
    d.employee?.rated_categories === 2 &&
    hasSources(d.employee, ['direkt', 'team']) &&
    (d.categories as RatingCategory[]).length === 5 &&
    d.settings?.scale === 'stars5',
  d.employee,
);
const detailDefault = await tlb.get(`/api/leadership/me/employees/${DEV1}`);
check('Detail ohne period = aktueller Zeitraum', detailDefault.statusCode === 200 && detailDefault.json().period?.key === period);
const detailBadPeriod = await tlb.get(`/api/leadership/me/employees/${DEV1}?period=kaputt`);
check('Detail mit ungültigem Zeitraum → 400', detailBadPeriod.statusCode === 400, detailBadPeriod.json());

const myTeam = await tlb.get('/api/leadership/me/team');
const myTeamMembers = (myTeam.json().team ?? []) as TeamMember[];
check(
  '/me/team: DEV1 mit overall 3 und last_rated_at, DEV2 unbewertet; Zeitraum und Kategorien dabei',
  myTeam.statusCode === 200 &&
    sameSet(ids(myTeamMembers), [DEV1, DEV2]) &&
    member(myTeamMembers, DEV1)?.overall?.score === 3 &&
    !!member(myTeamMembers, DEV1)?.last_rated_at &&
    member(myTeamMembers, DEV1)?.rated_categories === 2 &&
    member(myTeamMembers, DEV2)?.overall === null &&
    myTeam.json().period?.key === period &&
    myTeam.json().current_period?.key === period &&
    (myTeam.json().categories as RatingCategory[]).length === 5,
  myTeam.json(),
);
const myTeamBody = myTeam.json();
check(
  '/me/team: Bereichskopf — 2 Personen, Abteilung Technik, Team Backend',
  myTeamBody.scope?.total === 2 &&
    JSON.stringify(myTeamBody.scope?.departments) ===
      JSON.stringify([{ id: DEPT_TECHNIK, name: 'Technik', count: 2 }]) &&
    JSON.stringify(myTeamBody.scope?.teams) === JSON.stringify([{ id: TEAM_BACKEND, name: 'Backend', count: 2 }]),
  myTeamBody.scope,
);
check(
  '/me/team: vier Verlaufsspalten in der eingestellten Kadenz, aktueller Zeitraum zuerst',
  (myTeamBody.history_periods as RatingPeriod[])?.map((p) => p.key).join(',') ===
    [period, shiftPeriod(period, -1), shiftPeriod(period, -2), shiftPeriod(period, -3)].join(',') &&
    (myTeamBody.history_periods as RatingPeriod[]).every((p) => p.kind === 'quartal'),
  myTeamBody.history_periods,
);
const dev1History = member(myTeamMembers, DEV1)?.history ?? [];
check(
  '/me/team: Verlauf je Person — DEV1 mit Gesamtbewertung 3 (stars5, 2 Kategorien) im aktuellen Zeitraum, DEV2 leer',
  dev1History.length === 1 &&
    dev1History[0].period_key === period &&
    dev1History[0].score === 3 &&
    dev1History[0].scale === 'stars5' &&
    dev1History[0].category_count === 2 &&
    !!dev1History[0].updated_at &&
    member(myTeamMembers, DEV2)?.history?.length === 0,
  myTeamMembers.map((m) => [m.id, m.history]),
);

const myTeamPrev = await tlb.get(`/api/leadership/me/team?period=${shiftPeriod(period, -1)}`);
check(
  '/me/team im Vorquartal: DEV1 dort unbewertet',
  myTeamPrev.statusCode === 200 && member(myTeamPrev.json().team, DEV1)?.overall === null,
  myTeamPrev.json().team,
);
check(
  '/me/team im Vorquartal: Verlaufsfenster wandert mit — aktueller Zeitraum nicht dabei, DEV1 ohne Verlauf',
  (myTeamPrev.json().history_periods as RatingPeriod[])[0]?.key === shiftPeriod(period, -1) &&
    !(myTeamPrev.json().history_periods as RatingPeriod[]).some((p) => p.key === period) &&
    member(myTeamPrev.json().team, DEV1)?.history?.length === 0,
  { periods: myTeamPrev.json().history_periods, history: member(myTeamPrev.json().team, DEV1)?.history },
);
const myStatus = await tlb.get('/api/leadership/me/status');
check(
  '/me/status: is_leader true, team_size 2, rated_count 1, aktueller Zeitraum',
  myStatus.statusCode === 200 &&
    myStatus.json().is_leader === true &&
    myStatus.json().employee_id === TLB &&
    myStatus.json().team_size === 2 &&
    myStatus.json().rated_count === 1 &&
    myStatus.json().period?.key === period,
  myStatus.json(),
);

// ============================ 8. Protokoll unveränderlich ============================

let immutableError = '';
try {
  db.prepare('UPDATE leadership_rating_history SET score = 1').run();
} catch (err) {
  immutableError = err instanceof Error ? err.message : String(err);
}
check('UPDATE auf leadership_rating_history wirft „unveränderlich“ (Trigger)', immutableError.includes('unveränderlich'), immutableError);
check(
  'Protokoll nach dem Versuch unverändert',
  (db.prepare('SELECT COUNT(*) AS n FROM leadership_rating_history WHERE score = 1').get() as { n: number }).n === 0 && historyCount() === 3,
);

// ============================ 8b. Gesprächsprotokolle in „Mein Team“ ============================
//
// Die HR gibt Protokolle je Stufe frei; die zuständige Führungskraft liest sie
// nur lesend unter „Mein Team“. Zuständig ist allein scopeFor (heutiger Bereich).

{
  const tlbScope = ((await tlb.get('/api/leadership/me/team')).json().team as TeamMember[]).map((m) => m.id);
  const MEET_IN = DEV2;
  const MEET_OUT = [SALES1, HRSB].find((id) => !tlbScope.includes(id)) as number;
  check(
    'Vorbedingung: DEV2 im Bereich von TLB, ein Außenstehender, EXIT1 und TLB selbst nicht',
    tlbScope.includes(MEET_IN) && MEET_OUT !== undefined && !tlbScope.includes(EXIT1) && !tlbScope.includes(TLB),
    tlbScope,
  );

  async function addMeeting(
    employeeId: number,
    visibility: string,
    followUp: string | null,
    content: string,
    meetingDate: string = yesterday,
  ): Promise<number> {
    const res = await admin.post('/api/communication/meetings', {
      employee_id: employeeId,
      meeting_date: meetingDate,
      occasion: 'einzelgespraech',
      participants: 'Tim Leitner, HR',
      content,
      agreements: 'Vereinbarung zu ' + content,
      follow_up_date: followUp,
      visibility,
    });
    if (res.statusCode !== 201) throw new Error(`Protokoll anlegen (${content}) → ${res.statusCode}: ${res.body}`);
    return res.json().meeting.id as number;
  }

  // Gesprächsdaten bewusst NICHT in ID-Reihenfolge: mShared ist später
  // angelegt, aber älter. So prüft die Sortierung wirklich das Datum.
  const daysAgo = (n: number) => addDaysIso(todayIsoLocal(), -n);
  const mOnlyHr = await addMeeting(MEET_IN, 'nur_hr', yesterday, 'nur HR');
  const mLeader = await addMeeting(MEET_IN, 'hr_vorgesetzte', yesterday, 'Fuehrung', daysAgo(10));
  const mShared = await addMeeting(MEET_IN, 'hr_vorgesetzte_mitarbeiter', null, 'Person und Fuehrung', daysAgo(20));
  const mFuture = await addMeeting(MEET_IN, 'hr_vorgesetzte', addDaysIso(todayIsoLocal(), 30), 'Fuehrung spaeter', daysAgo(5));
  const mOutside = await addMeeting(MEET_OUT, 'hr_vorgesetzte', yesterday, 'Fremder Bereich');
  const mExit = await addMeeting(EXIT1, 'hr_vorgesetzte', yesterday, 'Ausgeschieden');
  const mOwn = await addMeeting(TLB, 'hr_vorgesetzte', yesterday, 'Eigenes');

  // Liste einer Person: nur die Stufen, die die Führung erreichen.
  const meetRes = await tlb.get(`/api/leadership/me/employees/${MEET_IN}/meetings`);
  type Row = Record<string, unknown> & { id: number; released_to_employee: number; visible_to_employee: number };
  const meetRows = (meetRes.json().meetings ?? []) as Row[];
  check(
    'Führungskraft liest die Protokolle der Stufen 2 und 3, nie „nur HR“',
    meetRes.statusCode === 200 && sameSet(meetRows.map((m) => m.id), [mLeader, mShared, mFuture]) && !meetRows.some((m) => m.id === mOnlyHr),
    meetRows.map((m) => m.id),
  );
  check(
    'Stufe 3 für die Person freigegeben, aber ohne Konto nicht sichtbar; Stufe 2 weder noch; weder Autor noch Sichtbarkeitsfeld',
    meetRows.find((m) => m.id === mShared)?.released_to_employee === 1 &&
      meetRows.find((m) => m.id === mShared)?.visible_to_employee === 0 &&
      meetRows.find((m) => m.id === mLeader)?.released_to_employee === 0 &&
      meetRows.find((m) => m.id === mLeader)?.visible_to_employee === 0 &&
      meetRows.find((m) => m.id === mLeader)?.content === 'Fuehrung' &&
      meetRows.every((m) => !('created_by_user_id' in m) && !('visibility' in m) && !('created_at' in m)),
    meetRows,
  );
  check(
    'Liste nach Gesprächsdatum, neueste zuerst (nicht nach Anlage)',
    meetRows.map((m) => m.id).join() === [mFuture, mLeader, mShared].join(),
    meetRows.map((m) => [m.id, m.meeting_date]),
  );
  // Mit Portalkonto sieht die Person Stufe 3 tatsächlich: das Kennzeichen folgt.
  db.prepare(
    "INSERT INTO users (email, name, password_hash, role, employee_id) VALUES ('erik.portal@example.org', 'Erik Eberle', 'x', 'mitarbeiter', ?)",
  ).run(MEET_IN);
  const withPortal = ((await tlb.get(`/api/leadership/me/employees/${MEET_IN}/meetings`)).json().meetings ?? []) as Row[];
  check(
    'Mit Portalkonto: visible_to_employee = 1 nur für Stufe 3',
    withPortal.find((m) => m.id === mShared)?.visible_to_employee === 1 &&
      withPortal.find((m) => m.id === mLeader)?.visible_to_employee === 0,
    withPortal,
  );
  db.prepare("DELETE FROM users WHERE email = 'erik.portal@example.org'").run();

  // Bereichsgrenzen: 403 wie bei den übrigen /me-Routen.
  const outRes = await tlb.get(`/api/leadership/me/employees/${MEET_OUT}/meetings`);
  check('Person außerhalb des Bereichs → 403', outRes.statusCode === 403 && !JSON.stringify(outRes.json()).includes('Fremder Bereich'), outRes.json());
  const exitRes = await tlb.get(`/api/leadership/me/employees/${EXIT1}/meetings`);
  check('Ausgeschiedene Person → 403 (nur aktive Profile im Bereich)', exitRes.statusCode === 403, exitRes.json());
  const ownRes = await tlb.get(`/api/leadership/me/employees/${TLB}/meetings`);
  check('Eigenes Profil → 403 (eigene Protokolle nur über das Portal)', ownRes.statusCode === 403, ownRes.json());
  const badId = await tlb.get('/api/leadership/me/employees/abc/meetings');
  check('Ungültige ID → 400', badId.statusCode === 400, badId.json());

  // Fällige Wiedervorlagen: nur fällig, nur Bereich, nur Stufe 2/3.
  const dueRes = await tlb.get('/api/leadership/me/meetings/follow-ups');
  const dueRows = (dueRes.json().meetings ?? []) as Array<Record<string, unknown> & { id: number }>;
  const dueIds = dueRows.map((m) => m.id);
  check(
    'Wiedervorlagen liefern nur die Felder der Karte, keinen Protokolltext',
    dueRows.every((m) => !('content' in m) && !('agreements' in m) && !('participants' in m)),
    dueRows,
  );
  check(
    'Wiedervorlagen: nur das fällige Stufe-2-Protokoll im Bereich (nicht nur HR, nicht künftig, nicht fremd, nicht ausgeschieden, nicht eigen)',
    dueRes.statusCode === 200 &&
      sameSet(dueIds, [mLeader]) &&
      ![mOnlyHr, mFuture, mShared, mOutside, mExit, mOwn].some((id) => dueIds.includes(id)),
    dueIds,
  );
  check(
    'Wiedervorlage trägt den Namen der Person',
    (dueRes.json().meetings as Array<{ first_name: string; last_name: string }>)[0]?.last_name === 'Eberle',
    dueRes.json().meetings,
  );

  // Ein Konto ohne freigeschaltete Führungsfunktion kommt auf keine der beiden Routen.
  const adminMeet = await admin.get(`/api/leadership/me/employees/${MEET_IN}/meetings`);
  const adminDue = await admin.get('/api/leadership/me/meetings/follow-ups');
  check('Konto ohne Führungsfunktion: beide Leserouten → 403', adminMeet.statusCode === 403 && adminDue.statusCode === 403, [adminMeet.statusCode, adminDue.statusCode]);
  const anonMeet = await app.inject({ method: 'GET', url: `/api/leadership/me/employees/${MEET_IN}/meetings` });
  check('Ohne Anmeldung → 401', anonMeet.statusCode === 401, anonMeet.json());

  // Nur lesen: es gibt keine Schreibroute für die Führung.
  const putMeet = await tlb.put(`/api/leadership/me/employees/${MEET_IN}/meetings`, { content: 'x' });
  check('Keine Schreibroute für die Führung (PUT → 404, Route existiert nicht)', putMeet.statusCode === 404, putMeet.statusCode);

  // Ausnahme schlägt jede Quelle: nach „exclude“ ist die Person weg, danach wieder da.
  const exclude = await admin.post(`/api/leadership/leaders/${TLB}/assignments`, {
    kind: 'exclude',
    target_type: 'employee',
    target_id: MEET_IN,
  });
  check('Ausnahme für DEV2 anlegen → 201', exclude.statusCode === 201, exclude.json());
  const excludedMeet = await tlb.get(`/api/leadership/me/employees/${MEET_IN}/meetings`);
  const excludedDue = await tlb.get('/api/leadership/me/meetings/follow-ups');
  check(
    'Nach Ausnahme: Protokolle 403 und Wiedervorlage verschwunden (nur heutiger Bereich)',
    excludedMeet.statusCode === 403 && (excludedDue.json().meetings as unknown[]).length === 0,
    [excludedMeet.statusCode, excludedDue.json()],
  );
  const restore = await admin.del(`/api/leadership/assignments/${exclude.json().assignment.id as number}`);
  check('Ausnahme entfernen → 204', restore.statusCode === 204, restore.body);
  const restoredMeet = await tlb.get(`/api/leadership/me/employees/${MEET_IN}/meetings`);
  check(
    'Nach Entfernen der Ausnahme sieht TLB wieder alle freigegebenen Protokolle, auch ältere',
    restoredMeet.statusCode === 200 && (restoredMeet.json().meetings as unknown[]).length === 3,
    restoredMeet.json(),
  );

  // HR-Seite: wen erreicht ein Protokoll dieser Person heute?
  const rec = await admin.get(`/api/communication/meetings/recipients?employee_id=${MEET_IN}`);
  const recLeaders = (rec.json().leaders ?? []) as Array<{ employee_id: number; name: string; sources: string[]; has_account: number }>;
  check(
    'Empfänger: TLB (mit Konto) und CTO (ohne Konto) mit Quellen',
    rec.statusCode === 200 &&
      sameSet(recLeaders.map((l) => l.employee_id), [TLB, CTO]) &&
      recLeaders.find((l) => l.employee_id === TLB)?.has_account === 1 &&
      recLeaders.find((l) => l.employee_id === TLB)?.name === 'Tim Leitner' &&
      recLeaders.find((l) => l.employee_id === CTO)?.has_account === 0 &&
      recLeaders.find((l) => l.employee_id === TLB)?.sources.includes('team') === true,
    recLeaders,
  );
  const recNobody = await admin.get(`/api/communication/meetings/recipients?employee_id=${EXIT1}`);
  check('Empfänger einer ausgeschiedenen Person: leer', recNobody.statusCode === 200 && (recNobody.json().leaders as unknown[]).length === 0, recNobody.json());
  const recUnknown = await admin.get('/api/communication/meetings/recipients?employee_id=99999');
  check('Empfänger unbekannter Person → 404', recUnknown.statusCode === 404, recUnknown.json());
  const recMissing = await admin.get('/api/communication/meetings/recipients');
  check('Empfänger ohne employee_id → 400', recMissing.statusCode === 400, recMissing.json());
  const recTlb = await tlb.get(`/api/communication/meetings/recipients?employee_id=${MEET_IN}`);
  check('Rolle Führungskraft (Bereich kommunikation: kein) → 403 auf Empfänger', recTlb.statusCode === 403, recTlb.json());
  const listTlb = await tlb.get('/api/communication/meetings');
  check('Rolle Führungskraft: HR-Liste der Protokolle bleibt 403', listTlb.statusCode === 403, listTlb.json());

  // Rechtegrenzen mit eigenen Wegwerf-Profilen (spätere Abschnitte verknüpfen
  // SALES1, HRSB und PLAT1 selbst mit Konten).
  const SELF = addEmployee({ first_name: 'Fritz', last_name: 'Fuehrungsadmin', job_title: 'HR', department_id: DEPT_PERSONAL });
  const COMM = addEmployee({ first_name: 'Klara', last_name: 'Kommunikation', job_title: 'HR', department_id: DEPT_PERSONAL });
  const roleOf = async (name: string, permissions: Record<string, string>) => {
    const res = await admin.post('/api/admin/admin-roles', { name, permissions });
    if (res.statusCode !== 201) throw new Error(`Rolle ${name} → ${res.statusCode}: ${res.body}`);
    return res.json().admin_role.id as number;
  };

  // Selbstschutz: `fuehrung: bearbeiten` ohne `kommunikation` darf sich nicht
  // selbst freischalten, sonst läse das Konto über „Mein Team“ Protokolle.
  const selfAdmin = await loginAs(
    SELF,
    'fritz.fuehrung@example.org',
    'Fritz Fuehrungsadmin',
    await roleOf('Führungsverwaltung', { fuehrung: 'bearbeiten' }),
  );
  const selfGrant = await selfAdmin.post('/api/leadership/leaders', { employee_id: SELF });
  check('Selbst freischalten → 403 (Selbstschutz)', selfGrant.statusCode === 403, selfGrant.json());
  check('Eigenes Profil wurde nicht freigeschaltet', !db.prepare('SELECT 1 FROM leadership_leaders WHERE employee_id = ?').get(SELF));
  // Von jemand anderem freigeschaltet: Zuständigkeit ändert das Konto trotzdem nicht selbst.
  const grantSelfByAdmin = await admin.post('/api/leadership/leaders', { employee_id: SELF });
  check('HR schaltet SELF frei → 201', grantSelfByAdmin.statusCode === 201, grantSelfByAdmin.json());
  const selfAssign = await selfAdmin.post(`/api/leadership/leaders/${SELF}/assignments`, {
    kind: 'include',
    target_type: 'department',
    target_id: DEPT_TECHNIK,
  });
  check('Sich selbst eine Abteilung zuweisen → 403', selfAssign.statusCode === 403, selfAssign.json());
  const selfPatch = await selfAdmin.patch(`/api/leadership/leaders/${SELF}`, { auto_scope: true });
  check('Eigene Freischaltung ändern → 403', selfPatch.statusCode === 403, selfPatch.json());
  const selfExclusion = await admin.post(`/api/leadership/leaders/${SELF}/assignments`, {
    kind: 'exclude',
    target_type: 'employee',
    target_id: COMM,
  });
  const dropOwnExclusion = await selfAdmin.del(`/api/leadership/assignments/${selfExclusion.json().assignment?.id as number}`);
  check('Eigene Ausnahme entfernen (erweitert den Bereich) → 403', dropOwnExclusion.statusCode === 403, dropOwnExclusion.json());
  const otherAssign = await selfAdmin.post(`/api/leadership/leaders/${TLB}/assignments`, {
    kind: 'include',
    target_type: 'employee',
    target_id: SALES1,
  });
  check('Fremde Führungskraft zuweisen bleibt erlaubt → 201', otherAssign.statusCode === 201, otherAssign.json());
  await admin.del(`/api/leadership/assignments/${otherAssign.json().assignment?.id as number}`);
  const selfRevoke = await selfAdmin.del(`/api/leadership/leaders/${SELF}`);
  check('Eigene Freischaltung entziehen bleibt erlaubt → 204', selfRevoke.statusCode === 204, selfRevoke.body);

  // Empfängerliste ohne `fuehrung: lesen`: Namen und Erreichbarkeit, keine Quellen.
  const commReader = await loginAs(
    COMM,
    'klara.komm@example.org',
    'Klara Kommunikation',
    await roleOf('Protokolle lesen', { kommunikation: 'lesen' }),
  );
  const recNoFuehrung = await commReader.get(`/api/communication/meetings/recipients?employee_id=${MEET_IN}`);
  const recNoFuehrungLeaders = (recNoFuehrung.json().leaders ?? []) as Array<Record<string, unknown>>;
  check(
    'Empfänger ohne fuehrung:lesen: Namen und has_account, aber keine Quellen',
    recNoFuehrung.statusCode === 200 &&
      recNoFuehrungLeaders.length === 2 &&
      recNoFuehrungLeaders.every((l) => typeof l.name === 'string' && 'has_account' in l && !('sources' in l)),
    recNoFuehrung.json(),
  );
  const leadersForComm = await commReader.get('/api/leadership/leaders');
  check('Dieselbe Rolle: GET /api/leadership/leaders bleibt 403', leadersForComm.statusCode === 403, leadersForComm.json());

  // Aufräumen: spätere Abschnitte rechnen mit einer unberührten Organisation.
  // Die Konten bleiben (Audit und Freischaltung verweisen auf sie), nur ihre
  // Profile verschwinden wieder aus der Organisation.
  db.prepare('UPDATE users SET employee_id = NULL WHERE employee_id IN (?, ?)').run([SELF, COMM]);
  db.prepare('DELETE FROM employees WHERE id IN (?, ?)').run([SELF, COMM]);
  db.prepare('DELETE FROM meeting_protocols').run();
}

// ============================ 9. Kategorien ============================

const newCat = await admin.post('/api/leadership/categories', { name: 'Pünktlichkeit', description: 'Termintreue' });
const puenktlichkeit = newCat.json().category as RatingCategory | undefined;
check(
  'POST „Pünktlichkeit“ → 201, aktiv, effective_scale stars5, ans Ende sortiert',
  newCat.statusCode === 201 &&
    puenktlichkeit?.name === 'Pünktlichkeit' &&
    puenktlichkeit?.active === 1 &&
    puenktlichkeit?.is_overall === 0 &&
    puenktlichkeit?.effective_scale === 'stars5' &&
    puenktlichkeit?.sort_order === 6 &&
    puenktlichkeit?.rating_count === 0,
  newCat.json(),
);
const teamWithNewCat = await tlb.get('/api/leadership/me/team');
check(
  'Neue Kategorie erscheint in /me/team categories (als TLB) mit effective_scale stars5',
  (teamWithNewCat.json().categories as RatingCategory[]).some((c) => c.name === 'Pünktlichkeit' && c.effective_scale === 'stars5'),
  teamWithNewCat.json().categories,
);
const dupExact = await admin.post('/api/leadership/categories', { name: 'Pünktlichkeit' });
check('Duplikat → 409', dupExact.statusCode === 409, dupExact.json());
const dupCase = await admin.post('/api/leadership/categories', { name: 'pünktlichkeit' });
check('Duplikat in anderer Schreibweise → 409', dupCase.statusCode === 409, dupCase.json());
const dupTrim = await admin.post('/api/leadership/categories', { name: '  Leistung ' });
check('Duplikat mit Leerzeichen → 409', dupTrim.statusCode === 409, dupTrim.json());
const emptyName = await admin.post('/api/leadership/categories', { name: '   ' });
check('Leerer Name → 400', emptyName.statusCode === 400, emptyName.json());

const deactivateOverall = await admin.patch(`/api/leadership/categories/${gesamt.id}`, { active: false });
check('PATCH active false auf Gesamtbewertung → 409', deactivateOverall.statusCode === 409, deactivateOverall.json());
const renameOverall = await admin.patch(`/api/leadership/categories/${gesamt.id}`, { name: 'Gesamteindruck' });
check('Gesamtbewertung umbenennen → 200', renameOverall.statusCode === 200 && renameOverall.json().category?.name === 'Gesamteindruck', renameOverall.json());
const renameBack = await admin.patch(`/api/leadership/categories/${gesamt.id}`, { name: 'Gesamtbewertung' });
check('… und zurück', renameBack.statusCode === 200 && renameBack.json().category?.name === 'Gesamtbewertung');
const renameClash = await admin.patch(`/api/leadership/categories/${verhalten.id}`, { name: 'leistung' });
check('Umbenennen auf vorhandenen Namen → 409', renameClash.statusCode === 409, renameClash.json());
const patchUnknown = await admin.patch('/api/leadership/categories/99999', { name: 'x' });
check('PATCH unbekannte Kategorie → 404', patchUnknown.statusCode === 404);

const delOverall = await admin.del(`/api/leadership/categories/${gesamt.id}`);
check('DELETE Gesamtbewertung → 409', delOverall.statusCode === 409, delOverall.json());
const delRated = await admin.del(`/api/leadership/categories/${leistung.id}`);
check('DELETE Leistung (bewertet) → 409 mit Hinweis auf Deaktivieren', delRated.statusCode === 409 && /[Dd]eaktivieren/.test(delRated.json()?.error?.message ?? ''), delRated.json());
const catsWithCount = (await admin.get('/api/leadership/categories')).json().categories as RatingCategory[];
check('rating_count: Gesamt 1, Leistung 1, übrige 0', catsWithCount.find((c) => c.id === gesamt.id)?.rating_count === 1 && catsWithCount.find((c) => c.id === leistung.id)?.rating_count === 1 && catsWithCount.filter((c) => c.rating_count === 0).length === 4, catsWithCount.map((c) => [c.name, c.rating_count]));

// Deaktivierte Kategorie: verschwindet aus der Maske und ist nicht bewertbar.
const deactivate = await admin.patch(`/api/leadership/categories/${verhalten.id}`, { active: false });
check('Verhalten deaktivieren → 200', deactivate.statusCode === 200 && deactivate.json().category?.active === 0);
const teamWithoutInactive = await tlb.get('/api/leadership/me/team');
check(
  'Inaktive Kategorie fehlt in /me/team, bleibt in der Verwaltungsliste',
  !(teamWithoutInactive.json().categories as RatingCategory[]).some((c) => c.id === verhalten.id) &&
    ((await admin.get('/api/leadership/categories')).json().categories as RatingCategory[]).some((c) => c.id === verhalten.id && c.active === 0),
);
const rateInactive = await rate(DEV1, { period_key: period, ratings: [{ category_id: verhalten.id, score: 3, comment: 'x' }] });
check('NEUE Bewertung in inaktiver Kategorie → 400', rateInactive.statusCode === 400 && /deaktiviert/.test(rateInactive.json()?.error?.message ?? ''), rateInactive.json());
// Bestehende Bewertung in einer inzwischen deaktivierten Kategorie bleibt
// annehmbar: Die Maske sendet immer alle Blöcke — sonst wäre mit der
// Deaktivierung auch die Gesamtbewertung eingefroren. Unveränderte Werte
// erzeugen dabei wie überall keine neue Version (Protokoll bleibt bei 3).
await admin.patch(`/api/leadership/categories/${leistung.id}`, { active: false });
const editInactive = await rate(DEV1, {
  period_key: period,
  ratings: [
    { category_id: gesamt.id, score: 3, comment: 'Nachgebessert: solide, aber Luft nach oben' },
    { category_id: leistung.id, score: 5, comment: 'Sehr gut' },
  ],
});
check(
  'Bestehende Bewertung in deaktivierter Kategorie wird weiter angenommen → 200, ohne neue Version',
  editInactive.statusCode === 200 &&
    (editInactive.json().ratings as Rating[]).find((r) => r.category_id === leistung.id)?.version === 1 &&
    historyCount() === 3,
  editInactive.json(),
);
await admin.patch(`/api/leadership/categories/${leistung.id}`, { active: true });
await admin.patch(`/api/leadership/categories/${verhalten.id}`, { active: true });

const delNew = await admin.del(`/api/leadership/categories/${puenktlichkeit!.id}`);
check('DELETE Pünktlichkeit (unbewertet) → 204', delNew.statusCode === 204);
const delNewAgain = await admin.del(`/api/leadership/categories/${puenktlichkeit!.id}`);
check('DELETE erneut → 404', delNewAgain.statusCode === 404);

const allIds = ((await admin.get('/api/leadership/categories')).json().categories as RatingCategory[]).map((c) => c.id);
const reorderIncomplete = await admin.post('/api/leadership/categories/reorder', { ids: allIds.slice(1) });
check('Reorder mit unvollständiger Liste → 400', reorderIncomplete.statusCode === 400, reorderIncomplete.json());
const reorderDup = await admin.post('/api/leadership/categories/reorder', { ids: [...allIds.slice(1), allIds[1]] });
check('Reorder mit doppelter ID → 400', reorderDup.statusCode === 400, reorderDup.json());
const reversed = [...allIds].reverse();
const reorderFull = await admin.post('/api/leadership/categories/reorder', { ids: reversed });
const reordered = (reorderFull.json().categories ?? []) as RatingCategory[];
check(
  'Reorder mit vollständiger Liste → 200; Gesamtbewertung bleibt trotzdem vorn, Rest in neuer Reihenfolge',
  reorderFull.statusCode === 200 &&
    reordered[0]?.id === gesamt.id &&
    reordered.slice(1).map((c) => c.id).join(',') === reversed.filter((id) => id !== gesamt.id).join(','),
  reordered.map((c) => [c.id, c.name, c.sort_order]),
);
await admin.post('/api/leadership/categories/reorder', { ids: allIds });

// ============================ 10. Skala ============================

const toAmpel = await admin.put('/api/leadership/settings', { scale: 'ampel' });
check('PUT settings scale ampel → 200', toAmpel.statusCode === 200 && toAmpel.json().settings?.scale === 'ampel', toAmpel.json());
const catsAmpel = (await admin.get('/api/leadership/categories')).json().categories as RatingCategory[];
check('Alle Kategorien effective_scale ampel', catsAmpel.every((c) => c.effective_scale === 'ampel'), catsAmpel.map((c) => c.effective_scale));
const badScale = await admin.put('/api/leadership/settings', { scale: 'smileys' });
check('Unbekannte Skala → 400', badScale.statusCode === 400, badScale.json());

const ampelTooHigh = await rate(DEV2, { period_key: period, ratings: [{ category_id: gesamt.id, score: 4, comment: 'x' }] });
check('Ampel: Wert 4 → 400', ampelTooHigh.statusCode === 400, ampelTooHigh.json());
const ampelSave = await rate(DEV2, { period_key: period, ratings: [{ category_id: gesamt.id, score: 3, comment: 'Läuft rund' }] });
check(
  'DEV2 Gesamt 3 auf Ampel → 200, gespeichert mit scale ampel',
  ampelSave.statusCode === 200 && (ampelSave.json().ratings as Rating[])?.[0]?.scale === 'ampel' && (ampelSave.json().ratings as Rating[])?.[0]?.score === 3,
  ampelSave.json(),
);

const uniformOff = await admin.put('/api/leadership/settings', { uniform_scale: false });
check('PUT settings uniform_scale false → 200', uniformOff.statusCode === 200 && uniformOff.json().settings?.uniform_scale === 0);
const leistungPoints = await admin.patch(`/api/leadership/categories/${leistung.id}`, { scale: 'points10' });
check('PATCH Leistung scale points10 → effective_scale points10', leistungPoints.statusCode === 200 && leistungPoints.json().category?.effective_scale === 'points10' && leistungPoints.json().category?.scale === 'points10', leistungPoints.json());
const catsMixed = (await admin.get('/api/leadership/categories')).json().categories as RatingCategory[];
check(
  'Gesamt bleibt ampel, Leistung points10, übrige ampel',
  catsMixed.find((c) => c.id === gesamt.id)?.effective_scale === 'ampel' &&
    catsMixed.find((c) => c.id === leistung.id)?.effective_scale === 'points10' &&
    catsMixed.filter((c) => c.id !== leistung.id).every((c) => c.effective_scale === 'ampel'),
  catsMixed.map((c) => [c.name, c.effective_scale]),
);
const teamMixed = await tlb.get('/api/leadership/me/team');
check(
  '/me/team liefert die gemischten Skalen und settings.uniform_scale 0',
  (teamMixed.json().categories as RatingCategory[]).find((c) => c.id === leistung.id)?.effective_scale === 'points10' && teamMixed.json().settings?.uniform_scale === 0,
  teamMixed.json().settings,
);
const pointsSave = await rate(DEV2, { period_key: period, ratings: [{ category_id: leistung.id, score: 8, comment: 'Stark' }] });
check('DEV2 Leistung 8 auf points10 → 200 mit scale points10', pointsSave.statusCode === 200 && (pointsSave.json().ratings as Rating[]).find((r) => r.category_id === leistung.id)?.scale === 'points10', pointsSave.json());

const uniformBack = await admin.put('/api/leadership/settings', { uniform_scale: true, scale: 'stars5' });
check('Zurück auf uniform stars5 → 200', uniformBack.statusCode === 200 && uniformBack.json().settings?.uniform_scale === 1 && uniformBack.json().settings?.scale === 'stars5');
const leistungReset = await admin.patch(`/api/leadership/categories/${leistung.id}`, { scale: null });
check('Leistung ohne eigene Skala → effective_scale stars5', leistungReset.statusCode === 200 && leistungReset.json().category?.scale === null && leistungReset.json().category?.effective_scale === 'stars5', leistungReset.json());

// ============================ 11. Report (als Standard-Admin) ============================

const reportRes = await admin.get(`/api/leadership/report?period=${period}`);
const report = reportRes.json() as LeadershipReport;
check(
  'Report → 200, Skala stars5, Kategorie Gesamtbewertung, Zeitraum = aktuell, beide Führungskräfte',
  reportRes.statusCode === 200 &&
    report.scale === 'stars5' &&
    report.category?.is_overall === 1 &&
    report.period?.key === period &&
    report.current_period?.key === period &&
    report.leaders?.length === 2,
  report,
);
const rowTlb = report.leaders?.find((l) => l.employee_id === TLB);
const percentSum = rowTlb?.distribution.reduce((sum, d) => sum + d.percent, 0);
check(
  'Report TLB: team_size 2, rated_count 1, other_scale_count 1 (Ampel-Bewertung von DEV2)',
  rowTlb?.team_size === 2 && rowTlb?.rated_count === 1 && rowTlb?.other_scale_count === 1,
  rowTlb,
);
check(
  'Report TLB: Verteilung 5 Stufen (beste zuerst), Prozentsumme 100, „3 von 5“ = 1 Person / 100 %',
  rowTlb?.distribution.length === 5 &&
    rowTlb?.distribution[0].score === 5 &&
    percentSum === 100 &&
    rowTlb?.distribution.find((d) => d.score === 3)?.count === 1 &&
    rowTlb?.distribution.find((d) => d.score === 3)?.percent === 100 &&
    rowTlb?.distribution.find((d) => d.score === 3)?.label === '3 von 5' &&
    rowTlb?.distribution.find((d) => d.score === 3)?.tone === 'yellow',
  rowTlb?.distribution,
);
check('Report TLB: average_normalized 0,5', rowTlb?.average_normalized !== null && Math.abs((rowTlb?.average_normalized ?? 0) - 0.5) < 1e-9, rowTlb?.average_normalized);
const rowCto = report.leaders?.find((l) => l.employee_id === CTO);
check(
  'Report CTO: team_size 4, rated_count 0, alle Anteile 0, average null',
  rowCto?.team_size === 4 &&
    rowCto?.rated_count === 0 &&
    rowCto?.other_scale_count === 0 &&
    rowCto?.average_normalized === null &&
    rowCto?.distribution.every((d) => d.count === 0 && d.percent === 0),
  rowCto,
);
const reportBad = await admin.get('/api/leadership/report?period=kaputt');
check('Report mit ungültigem Zeitraum → 400', reportBad.statusCode === 400, reportBad.json());
const reportMonth = await admin.get(`/api/leadership/report?period=${periodKeyForDate(todayIsoLocal(), 'monat')}`);
check('Report mit Monatsschlüssel bei Quartalskadenz → 400', reportMonth.statusCode === 400, reportMonth.json());
const reportPrev = await admin.get(`/api/leadership/report?period=${shiftPeriod(period, -1)}`);
check(
  'Report Vorquartal → 200 mit rated_count 0',
  reportPrev.statusCode === 200 &&
    (reportPrev.json() as LeadershipReport).period.key === shiftPeriod(period, -1) &&
    (reportPrev.json() as LeadershipReport).leaders.every((l) => l.rated_count === 0),
  reportPrev.json(),
);
const reportDefault = await admin.get('/api/leadership/report');
check('Report ohne period = aktueller Zeitraum', reportDefault.statusCode === 200 && (reportDefault.json() as LeadershipReport).period.key === period);

// ================ 11b. Aufschlüsselung eines Report-Widgets ================

const bdRes = await admin.get(`/api/leadership/leaders/${TLB}/breakdown?period=${period}`);
const bd = bdRes.json() as LeaderBreakdown;
check(
  'Breakdown → 200 mit Führungskraft, Gesamtbewertungs-Kategorie und 6 Spalten (neueste zuerst)',
  bdRes.statusCode === 200 &&
    bd.leader.employee_id === TLB &&
    bd.category.is_overall === 1 &&
    bd.periods.length === 6 &&
    bd.periods[0].key === period &&
    bd.periods[1].key === shiftPeriod(period, -1) &&
    bd.periods.every((p) => p.kind === 'quartal'),
  { leader: bd.leader, periods: bd.periods?.map((p) => p.key), category: bd.category?.name },
);
const bdDev1 = bd.rows.find((r) => r.employee_id === DEV1);
const bdDev2 = bd.rows.find((r) => r.employee_id === DEV2);
check(
  'Breakdown-Zeilen: DEV1 und DEV2 mit Personalnummer, Quellen und former = 0',
  bd.rows.length === 2 &&
    bdDev1?.personnel_number === (db.prepare('SELECT personnel_number AS n FROM employees WHERE id = ?').get(DEV1) as { n: string }).n &&
    bdDev1?.former === 0 &&
    bdDev1?.sources.includes('direkt') &&
    bdDev2?.former === 0,
  bd.rows.map((r) => [r.last_name, r.personnel_number, r.former, r.sources]),
);
check(
  'Breakdown-Zellen: DEV1 Gesamtbewertung 3 auf stars5 mit 2 Kategorien, nur im aktuellen Zeitraum',
  bdDev1?.cells.length === 1 &&
    bdDev1?.cells[0].period_key === period &&
    bdDev1?.cells[0].score === 3 &&
    bdDev1?.cells[0].scale === 'stars5' &&
    bdDev1?.cells[0].category_count === 2,
  bdDev1?.cells,
);
check(
  'Breakdown-Zellen: DEV2 trägt seine Ampel-Bewertung (Skala je Zeile, nicht umgedeutet)',
  bdDev2?.cells.length === 1 && bdDev2?.cells[0].scale === 'ampel' && bdDev2?.cells[0].score === 3,
  bdDev2?.cells,
);
const bdCols = (await admin.get(`/api/leadership/leaders/${TLB}/breakdown?columns=2`)).json() as LeaderBreakdown;
check('Breakdown columns=2 → zwei Spalten', bdCols.periods.length === 2, bdCols.periods.map((p) => p.key));
const bdColsBad = await admin.get(`/api/leadership/leaders/${TLB}/breakdown?columns=99`);
check('Breakdown columns=99 → 400', bdColsBad.statusCode === 400, bdColsBad.json());
const bdPeriodBad = await admin.get(`/api/leadership/leaders/${TLB}/breakdown?period=${periodKeyForDate(todayIsoLocal(), 'monat')}`);
check('Breakdown mit falscher Kadenz → 400', bdPeriodBad.statusCode === 400);
const bdNoLeader = await admin.get(`/api/leadership/leaders/${DEV1}/breakdown`);
check('Breakdown für Nicht-Führungskraft → 404', bdNoLeader.statusCode === 404);

// Ehemals Verantwortete bleiben sichtbar: Ohne sie verschwänden abgegebene
// Bewertungen aus dem Report, sobald sich die Organisation ändert.
const excludeDev1 = await admin.post(`/api/leadership/leaders/${TLB}/assignments`, {
  kind: 'exclude',
  target_type: 'employee',
  target_id: DEV1,
});
check('DEV1 vorübergehend ausnehmen → 201', excludeDev1.statusCode === 201, excludeDev1.json());
const bdFormer = (await admin.get(`/api/leadership/leaders/${TLB}/breakdown?period=${period}`)).json() as LeaderBreakdown;
const formerDev1 = bdFormer.rows.find((r) => r.employee_id === DEV1);
check(
  'Ausgenommene Person erscheint weiter als „ehemals“ (former = 1, keine Quellen), Bewertung bleibt',
  formerDev1?.former === 1 && formerDev1?.sources.length === 0 && formerDev1?.cells[0]?.score === 3,
  formerDev1,
);
check(
  'Ehemalige stehen hinter den aktuell Verantworteten',
  bdFormer.rows[bdFormer.rows.length - 1].employee_id === DEV1,
  bdFormer.rows.map((r) => [r.last_name, r.former]),
);
await admin.del(`/api/leadership/assignments/${excludeDev1.json().assignment.id}`);

const bdDetailRes = await admin.get(`/api/leadership/leaders/${TLB}/employees/${DEV1}/ratings?period=${period}`);
const bdDetail = bdDetailRes.json() as RatingDetail;
check(
  'Detail → 200: Person, Führungskraft, Zeitraum und beide Kategorien mit Kommentar (Gesamtbewertung zuerst)',
  bdDetailRes.statusCode === 200 &&
    bdDetail.employee.id === DEV1 &&
    bdDetail.leader?.employee_id === TLB &&
    bdDetail.period.key === period &&
    bdDetail.ratings.length === 2 &&
    bdDetail.ratings[0].category_id === gesamt.id &&
    bdDetail.ratings[0].comment.length > 0 &&
    bdDetail.ratings[1].category_id === leistung.id,
  bdDetail.ratings?.map((r) => [r.category_name, r.score, r.version, r.comment]),
);
check(
  'Detail-Protokoll ist auf den Zeitraum gefiltert und enthält die Korrektur',
  bdDetail.history.length === 3 &&
    bdDetail.history.every((h) => h.period_key === period) &&
    bdDetail.history.some((h) => h.change_kind === 'geaendert' && h.previous_score === 4),
  bdDetail.history?.map((h) => [h.category_name, h.change_kind, h.version]),
);
const bdDetailEmpty = await admin.get(
  `/api/leadership/leaders/${TLB}/employees/${DEV1}/ratings?period=${shiftPeriod(period, -1)}`,
);
check(
  'Detail eines unbewerteten Zeitraums → 200 mit leeren Listen',
  bdDetailEmpty.statusCode === 200 &&
    (bdDetailEmpty.json() as RatingDetail).ratings.length === 0 &&
    (bdDetailEmpty.json() as RatingDetail).history.length === 0,
  bdDetailEmpty.json(),
);
const bdNoLeaderDetail = await admin.get(`/api/leadership/leaders/${DEV1}/employees/${DEV2}/ratings`);
check('Detail mit Nicht-Führungskraft im Pfad → 404', bdNoLeaderDetail.statusCode === 404, bdNoLeaderDetail.json());
const bdForeign = await admin.get(`/api/leadership/leaders/${TLB}/employees/${HRSB}/ratings`);
check(
  'Detail einer Person außerhalb des Bereichs und ohne Bewertung → 404 (keine Stammdaten-Preisgabe)',
  bdForeign.statusCode === 404,
  bdForeign.json(),
);
const bdAncientPeriod = await admin.get(`/api/leadership/leaders/${TLB}/breakdown?period=0001-Q1`);
check('Breakdown mit Zeitraum vor 1900 → 400 statt 500', bdAncientPeriod.statusCode === 400, bdAncientPeriod.json());

// Zeitraum, in dem NUR eine Unterkategorie bewertet wurde: Die Zelle bleibt
// erreichbar (score null), sonst wären Bewertung und Kommentar unsichtbar.
const prevPeriod = shiftPeriod(period, -1);
const onlySub = await tlb.put(`/api/leadership/me/employees/${DEV2}/ratings`, {
  period_key: prevPeriod,
  ratings: [{ category_id: leistung.id, score: 4, comment: 'Nur Leistung erfasst' }],
});
check('Nur Unterkategorie im Vorzeitraum bewerten → 200', onlySub.statusCode === 200, onlySub.json());
const bdSub = (await admin.get(`/api/leadership/leaders/${TLB}/breakdown?period=${period}`)).json() as LeaderBreakdown;
const subCell = bdSub.rows.find((r) => r.employee_id === DEV2)?.cells.find((c) => c.period_key === prevPeriod);
check(
  'Zelle ohne Gesamtbewertung: score/scale null, category_count 1, Zeitstempel gesetzt',
  subCell !== undefined && subCell.score === null && subCell.scale === null && subCell.category_count === 1 && !!subCell.updated_at,
  subCell,
);
const subDetail = await admin.get(`/api/leadership/leaders/${TLB}/employees/${DEV2}/ratings?period=${prevPeriod}`);
check(
  'Detail dieser Zelle liefert die Unterkategorie samt Kommentar',
  subDetail.statusCode === 200 &&
    (subDetail.json() as RatingDetail).ratings.length === 1 &&
    (subDetail.json() as RatingDetail).ratings[0].comment === 'Nur Leistung erfasst',
  subDetail.json(),
);
// Zellen-Zeitstempel ist das Maximum über alle Kategorien des Zeitraums.
const dev1Cell = bdSub.rows.find((r) => r.employee_id === DEV1)?.cells.find((c) => c.period_key === period);
const maxStamp = (db
  .prepare('SELECT MAX(updated_at) AS m FROM leadership_ratings WHERE leader_employee_id = ? AND employee_id = ? AND period_key = ?')
  .get([TLB, DEV1, period]) as { m: string }).m;
check('Zellen-Zeitstempel = jüngster Stand aller Kategorien', dev1Cell?.updated_at === maxStamp, { cell: dev1Cell?.updated_at, max: maxStamp });

const bdDetailUnknown = await admin.get(`/api/leadership/leaders/${TLB}/employees/99999/ratings`);
check('Detail unbekannter Person → 404', bdDetailUnknown.statusCode === 404);

// ============================ 12. Entziehen ============================

const revoke = await admin.del(`/api/leadership/leaders/${TLB}`);
check('DELETE leaders/TLB → 204', revoke.statusCode === 204, revoke.body);
const revokedTeam = await tlb.get('/api/leadership/me/team');
check('TLB-Konto nach Entzug: /me/team → 403', revokedTeam.statusCode === 403, revokedTeam.json());
const revokedStatus = await tlb.get('/api/leadership/me/status');
check('TLB-Konto nach Entzug: /me/status is_leader false', revokedStatus.statusCode === 200 && revokedStatus.json().is_leader === false, revokedStatus.json());
const revokeAgain = await admin.del(`/api/leadership/leaders/${TLB}`);
check('Erneuter Entzug → 404', revokeAgain.statusCode === 404);
check('GET leaders enthält nur noch CTO', ((await admin.get('/api/leadership/leaders')).json().leaders as Leader[]).map((l) => l.employee_id).join(',') === String(CTO));

const adminRatings = await admin.get(`/api/leadership/employees/${DEV1}/ratings`);
const adminRatingList = (adminRatings.json().ratings ?? []) as Rating[];
check(
  'Bewertungen bleiben: GET employees/DEV1/ratings liefert 2 Bewertungen mit leader_name und 3 Protokollzeilen',
  adminRatings.statusCode === 200 &&
    adminRatingList.length === 2 &&
    adminRatingList.every((r) => r.leader_name === 'Tim Leitner' && r.leader_employee_id === TLB) &&
    adminRatingList[0].category_id === gesamt.id &&
    adminRatingList[0].version === 2 &&
    (adminRatings.json().history as RatingHistoryEntry[]).length === 3,
  adminRatings.json(),
);
const adminRatingsUnknown = await admin.get('/api/leadership/employees/99999/ratings');
check('Bewertungen unbekannter Person → 404', adminRatingsUnknown.statusCode === 404);
const adminRatingsNone = await admin.get(`/api/leadership/employees/${HRSB}/ratings`);
check('Bewertungen einer unbewerteten Person → 200 mit leeren Listen', adminRatingsNone.statusCode === 200 && adminRatingsNone.json().ratings.length === 0 && adminRatingsNone.json().history.length === 0);

// ============================ 13. Rechte: Rolle mit fuehrung „lesen“ ============================

const readerPermissions = Object.fromEntries(ADMIN_AREAS.map((a) => [a, a === 'fuehrung' ? 'lesen' : 'kein']));
const readerRole = await admin.post('/api/admin/admin-roles', {
  name: 'Report-Leser',
  description: 'Nur Satisfaction-Report',
  permissions: readerPermissions,
});
check('Rolle „Report-Leser“ (fuehrung lesen) → 201', readerRole.statusCode === 201 && readerRole.json().admin_role?.permissions?.fuehrung === 'lesen', readerRole.json());
const reader = await loginAs(HRSB, 'report.leser@example.org', 'Rita Report', readerRole.json().admin_role.id as number);

const readerReport = await reader.get(`/api/leadership/report?period=${period}`);
check('Report-Leser: GET /api/leadership/report → 200', readerReport.statusCode === 200 && (readerReport.json() as LeadershipReport).leaders.length === 1, readerReport.json());
const readerLeaders = await reader.get('/api/leadership/leaders');
check('Report-Leser: GET /api/leadership/leaders → 200 (lesen)', readerLeaders.statusCode === 200);
const readerBreakdown = await reader.get(`/api/leadership/leaders/${CTO}/breakdown`);
check('Report-Leser: GET breakdown → 200 (lesen)', readerBreakdown.statusCode === 200, readerBreakdown.json());
const readerDetail = await reader.get(`/api/leadership/leaders/${CTO}/employees/${PLAT1}/ratings`);
check('Report-Leser: GET Detail → 200 (lesen)', readerDetail.statusCode === 200, readerDetail.json());
const leaderRoleBreakdown = await tlb.get(`/api/leadership/leaders/${CTO}/breakdown`);
check('Rolle „Führungskraft“ (fuehrung kein): GET breakdown → 403', leaderRoleBreakdown.statusCode === 403, leaderRoleBreakdown.json());
const readerGrant = await reader.post('/api/leadership/leaders', { employee_id: TLB });
check('Report-Leser: POST /api/leadership/leaders → 403', readerGrant.statusCode === 403, readerGrant.json());
const readerSettings = await reader.put('/api/leadership/settings', { scale: 'ampel' });
check('Report-Leser: PUT /api/leadership/settings → 403', readerSettings.statusCode === 403, readerSettings.json());
const readerCategory = await reader.post('/api/leadership/categories', { name: 'Neu' });
check('Report-Leser: POST /api/leadership/categories → 403', readerCategory.statusCode === 403);
const readerEmployees = await reader.get('/api/employees');
check('Report-Leser: GET /api/employees → 403 (personal kein)', readerEmployees.statusCode === 403);
const readerStatus = await reader.get('/api/leadership/me/status');
check('Report-Leser (HRSB nicht freigeschaltet): /me/status → 200, is_leader false', readerStatus.statusCode === 200 && readerStatus.json().is_leader === false && readerStatus.json().employee_id === HRSB, readerStatus.json());
check('TLB wurde durch den abgelehnten POST nicht freigeschaltet', !db.prepare('SELECT 1 FROM leadership_leaders WHERE employee_id = ?').get(TLB));

// ---------------------------------------------------------------------------
// Review-Befunde: Verknüpfungsschutz, Foto-Rechte, gegenseitige Verantwortung
// an ALLEN Stellen, die Zuständigkeit verändern
// ---------------------------------------------------------------------------

// Rolle „Nur Benutzer“: darf Konten verwalten (benutzer bearbeiten), aber
// keine Führungskräfte (fuehrung kein).
const onlyUsersRole = await admin.post('/api/admin/admin-roles', {
  name: 'Nur Benutzer',
  permissions: { benutzer: 'bearbeiten' },
});
check('Rolle „Nur Benutzer“ → 201', onlyUsersRole.statusCode === 201, onlyUsersRole.json());
const hrUser = await loginAs(SALES1, 'sven.verkauf@example.org', 'Sven Verkauf', onlyUsersRole.json().admin_role.id);

// CTO ist freigeschaltet und hat kein Konto: Ein Zweitkonto daran zu hängen
// wäre der Weg, in CTOs Namen zu bewerten.
const puppet = await hrUser.post('/api/admin/users', {
  email: 'puppet@example.org',
  name: 'Puppet',
  role: 'admin',
  employee_id: CTO,
  admin_role_id: fuehrungskraftRole.id,
});
check(
  'Konto mit freigeschaltetem Profil ohne fuehrung:bearbeiten → 403',
  puppet.statusCode === 403 && /freigeschaltet/.test(puppet.json()?.error?.message ?? ''),
  puppet.json(),
);
const platAccount = await admin.post('/api/admin/users', {
  email: 'paula.platt@example.org',
  name: 'Paula Platt',
  role: 'admin',
  employee_id: PLAT1,
  admin_role_id: fuehrungskraftRole.id,
});
check('Konto für PLAT1 (nicht freigeschaltet) → 201', platAccount.statusCode === 201, platAccount.json());
const platUserId = platAccount.json().user.id as number;
const relinkForbidden = await hrUser.patch(`/api/admin/users/${platUserId}`, { employee_id: CTO });
check('PATCH employee_id auf freigeschaltetes Profil ohne fuehrung:bearbeiten → 403', relinkForbidden.statusCode === 403, relinkForbidden.json());
const unlinkAllowed = await hrUser.patch(`/api/admin/users/${platUserId}`, { employee_id: null });
check('PATCH employee_id lösen (kein freigeschaltetes Profil) → 200', unlinkAllowed.statusCode === 200 && unlinkAllowed.json().user?.employee_id === null, unlinkAllowed.json());
const relinkAdmin = await admin.patch(`/api/admin/users/${platUserId}`, { employee_id: CTO });
check('Vollzugriff verknüpft freigeschaltetes Profil → 200', relinkAdmin.statusCode === 200 && relinkAdmin.json().user?.employee_id === CTO, relinkAdmin.json());
const leadersWithAccount = (await admin.get('/api/leadership/leaders')).json().leaders as Leader[];
check('CTO hat jetzt ein Desktop-Konto', leadersWithAccount.find((l) => l.employee_id === CTO)?.user_email === 'paula.platt@example.org', leadersWithAccount);
// Halbes Update darf es nicht geben: Scheitert der Rollenteil, bleibt auch die Verknüpfung unverändert.
const halfUpdate = await hrUser.patch(`/api/admin/users/${platUserId}`, { employee_id: null, admin_role_id: readerRole.json().admin_role.id });
check('PATCH mit gültigem employee_id, aber unzulässiger Rolle → 403', halfUpdate.statusCode === 403, halfUpdate.json());
check(
  '… und die Verknüpfung blieb unverändert (keine halbe Änderung)',
  (db.prepare('SELECT employee_id FROM users WHERE id = ?').get(platUserId) as { employee_id: number | null }).employee_id === CTO,
);
await admin.patch(`/api/admin/users/${platUserId}`, { employee_id: null });

// Fotos: signierte URLs nur für Konten, die sie auch selbst signieren dürften.
const photoFile = Number(
  db
    .prepare(`INSERT INTO files (original_name, stored_name, mime_type, size_bytes, sha256) VALUES ('foto.jpg', 'x-foto.jpg', 'image/jpeg', 10, 'abc')`)
    .run().lastInsertRowid,
);
db.prepare('UPDATE employees SET photo_file_id = ? WHERE id IN (?, ?)').run([photoFile, CTO, PLAT1]);
const reportWithPhoto = (await admin.get('/api/leadership/report')).json() as LeadershipReport;
const reportReaderPhoto = (await reader.get('/api/leadership/report')).json() as LeadershipReport;
check(
  'Report: Foto-URL nur mit personal:lesen (Vollzugriff ja, Report-Leser nein)',
  typeof reportWithPhoto.leaders.find((l) => l.employee_id === CTO)?.photo_url === 'string' &&
    reportReaderPhoto.leaders.find((l) => l.employee_id === CTO)?.photo_url === null,
  { admin: reportWithPhoto.leaders.map((l) => l.photo_url), reader: reportReaderPhoto.leaders.map((l) => l.photo_url) },
);
const teamPreviewReader = (await reader.get(`/api/leadership/leaders/${CTO}/team`)).json() as LeaderTeamResponse;
const teamPreviewAdmin = (await admin.get(`/api/leadership/leaders/${CTO}/team`)).json() as LeaderTeamResponse;
check(
  'Zuständigkeits-Vorschau: Foto-URL nur mit personal:lesen',
  teamPreviewReader.team.find((m) => m.id === PLAT1)?.photo_url === null &&
    typeof teamPreviewAdmin.team.find((m) => m.id === PLAT1)?.photo_url === 'string',
  { reader: teamPreviewReader.team.map((m) => [m.id, m.photo_url]) },
);

// Gegenseitige Verantwortung: Einstellungen, Ausnahme entfernen, Automatik.
const regrantTlb = await admin.post('/api/leadership/leaders', { employee_id: TLB });
check('TLB erneut freischalten → 201', regrantTlb.statusCode === 201, regrantTlb.json());
const includeCto = await admin.post(`/api/leadership/leaders/${TLB}/assignments`, { kind: 'include', target_type: 'employee', target_id: CTO });
check('TLB include CTO → 201 mit Hinweis (Paar entsteht, zugelassen)', includeCto.statusCode === 201 && includeCto.json().warnings.length === 1, includeCto.json());
const forbidWithPairs = await admin.put('/api/leadership/settings', { allow_mutual: false });
check('allow_mutual=false bei bestehendem Paar → 409', forbidWithPairs.statusCode === 409 && /Paare bestehen/.test(forbidWithPairs.json()?.error?.message ?? ''), forbidWithPairs.json());
const excludeTlb = await admin.post(`/api/leadership/leaders/${CTO}/assignments`, { kind: 'exclude', target_type: 'employee', target_id: TLB });
check('CTO exclude TLB → 201 (Paar aufgelöst)', excludeTlb.statusCode === 201 && excludeTlb.json().warnings.length === 0, excludeTlb.json());
const forbidNow = await admin.put('/api/leadership/settings', { allow_mutual: false });
check('allow_mutual=false ohne Paar → 200', forbidNow.statusCode === 200 && forbidNow.json().settings?.allow_mutual === 0, forbidNow.json());
const removeExclude = await admin.del(`/api/leadership/assignments/${excludeTlb.json().assignment.id}`);
check('Ausnahme entfernen, die ein verbotenes Paar wiederherstellt → 409', removeExclude.statusCode === 409, removeExclude.json());
check('… Ausnahme besteht weiterhin (Rollback)', !!db.prepare('SELECT 1 FROM leadership_assignments WHERE id = ?').get(excludeTlb.json().assignment.id));
const autoOff = await admin.patch(`/api/leadership/leaders/${CTO}`, { auto_scope: false });
check('CTO Automatik aus → 200', autoOff.statusCode === 200 && autoOff.json().leader?.auto_scope === 0, autoOff.json());
const removeExcludeNow = await admin.del(`/api/leadership/assignments/${excludeTlb.json().assignment.id}`);
check('Ausnahme entfernen bei ausgeschalteter Automatik → 204', removeExcludeNow.statusCode === 204, removeExcludeNow.body);
const autoOnForbidden = await admin.patch(`/api/leadership/leaders/${CTO}`, { auto_scope: true });
check('Automatik einschalten, die ein verbotenes Paar erzeugt → 409', autoOnForbidden.statusCode === 409, autoOnForbidden.json());
check('… Automatik blieb aus (Rollback)', (db.prepare('SELECT auto_scope FROM leadership_leaders WHERE employee_id = ?').get(CTO) as { auto_scope: number }).auto_scope === 0);
const allowAgain = await admin.put('/api/leadership/settings', { allow_mutual: true });
check('allow_mutual=true → 200', allowAgain.statusCode === 200);
const autoOnAllowed = await admin.patch(`/api/leadership/leaders/${CTO}`, { auto_scope: true });
check('Automatik einschalten bei zugelassener Gegenseitigkeit → 200 mit Hinweis', autoOnAllowed.statusCode === 200 && autoOnAllowed.json().warnings?.length === 1, autoOnAllowed.json());
await admin.del(`/api/leadership/assignments/${includeCto.json().assignment.id}`);

// Auswahllisten der Einrichtung hängen am Bereich fuehrung, nicht an personal/verwaltung.
const lookupReader = await reader.get('/api/leadership/lookup');
check(
  'GET /api/leadership/lookup für Report-Leser → 200 mit aktiven Personen, Abteilungen, Teams, Rollen',
  lookupReader.statusCode === 200 &&
    lookupReader.json().employees.some((e: { id: number }) => e.id === DEV1) &&
    !lookupReader.json().employees.some((e: { id: number }) => e.id === EXIT1) &&
    lookupReader.json().departments.length >= 3 &&
    lookupReader.json().teams.length >= 1 &&
    lookupReader.json().roles.some((r: { name: string }) => r.name === 'Projektleitung'),
  lookupReader.json(),
);
const reportOpen = (await admin.get('/api/leadership/report')).json() as LeadershipReport;
check(
  'Report liefert open_count je Führungskraft (heutiger Bereich ohne Gesamtbewertung)',
  reportOpen.leaders.every((l) => typeof l.open_count === 'number' && l.open_count <= l.team_size),
  reportOpen.leaders.map((l) => [l.last_name, l.team_size, l.rated_count, l.open_count]),
);

// Skalenwechsel im Protokoll: previous_scale hält die Skala der Vorversion fest.
await admin.put('/api/leadership/settings', { scale: 'points10' });
const rescored = await tlb.put(`/api/leadership/me/employees/${DEV1}/ratings`, {
  period_key: period,
  ratings: [{ category_id: gesamt.id, score: 3, comment: 'Nachgebessert: solide, aber Luft nach oben' }],
});
const rescoredHistory = (await tlb.get(`/api/leadership/me/employees/${DEV1}`)).json().history as RatingHistoryEntry[];
check(
  'Gleicher Rohwert auf neuer Skala → neue Version mit previous_scale stars5 und scale points10',
  rescored.statusCode === 200 &&
    rescoredHistory[0]?.change_kind === 'geaendert' &&
    rescoredHistory[0]?.scale === 'points10' &&
    rescoredHistory[0]?.previous_scale === 'stars5' &&
    rescoredHistory[0]?.previous_score === 3,
  rescoredHistory[0],
);
await admin.put('/api/leadership/settings', { scale: 'stars5' });

// Einstellungen liefern bestehende Paare — auch aus Organisationsänderungen.
const settingsWithPairs = await admin.get('/api/leadership/settings');
check('GET settings liefert mutual_pairs (Array)', settingsWithPairs.statusCode === 200 && Array.isArray(settingsWithPairs.json().mutual_pairs), settingsWithPairs.json());

// Löschregeln: Profil der FÜHRUNGSKRAFT löschen → Bewertungen über andere
// bleiben, verlieren nur die Zuordnung. (TLB hat Konto und Zuweisungen:
// users.employee_id ist ON DELETE SET NULL, Zuweisungen kaskadieren.)
const ratingsBeforeDelete = ((await admin.get(`/api/leadership/employees/${DEV1}/ratings`)).json() as { ratings: Rating[]; history: RatingHistoryEntry[] });
const delLeader = await admin.del(`/api/employees/${TLB}`);
check('Profil der Führungskraft TLB löschen → 204', delLeader.statusCode === 204, delLeader.body);
const ratingsAfterDelete = ((await admin.get(`/api/leadership/employees/${DEV1}/ratings`)).json() as { ratings: Rating[]; history: RatingHistoryEntry[] });
check(
  'Bewertungen über DEV1 bleiben mit leader_employee_id null und Beschriftung „(gelöschte Führungskraft)“; Protokoll vollständig',
  ratingsAfterDelete.ratings.length === ratingsBeforeDelete.ratings.length &&
    ratingsAfterDelete.ratings.every((r) => r.leader_employee_id === null && r.leader_name === '(gelöschte Führungskraft)') &&
    ratingsAfterDelete.history.length === ratingsBeforeDelete.history.length,
  { before: ratingsBeforeDelete.ratings.length, after: ratingsAfterDelete.ratings.map((r) => [r.leader_employee_id, r.leader_name]), history: ratingsAfterDelete.history.length },
);
// Bewertete Person löschen → ihre Bewertungen und ihr Protokoll verschwinden (DSGVO).
const delRatedPerson = await admin.del(`/api/employees/${DEV1}`);
check('Profil der bewerteten Person DEV1 löschen → 204', delRatedPerson.statusCode === 204, delRatedPerson.body);
check(
  'Bewertungen und Protokoll über DEV1 sind weg',
  (db.prepare('SELECT COUNT(*) AS n FROM leadership_ratings WHERE employee_id = ?').get(DEV1) as { n: number }).n === 0 &&
    (db.prepare('SELECT COUNT(*) AS n FROM leadership_rating_history WHERE employee_id = ?').get(DEV1) as { n: number }).n === 0,
);

// Audit-Log wurde befüllt
const auditCount = db
  .prepare(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE entity IN ('leadership_leader', 'leadership_assignment', 'leadership_rating', 'leadership_settings', 'rating_category')`,
  )
  .get() as { n: number };
check('Audit-Log enthält Einträge des Moduls', auditCount.n > 0, auditCount);

// ---------------------------------------------------------------------------

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
console.log('Alle Smoke-Checks des Moduls Führung & Bewertung bestanden.');
