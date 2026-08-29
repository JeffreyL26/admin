/**
 * Demo-Daten für HRMONIC — realistische deutsche Beispieldaten über alle Module.
 *
 * Aufruf:  npm run seed            (bricht ab, wenn bereits Mitarbeitende existieren)
 *          npm run seed -- --force (leert alle Fachtabellen und seedet neu)
 *
 * Bewusst eingebaute Demo-Fälle:
 * - laufende Krankheit ohne AU (Frist überschritten) + Langzeitkrankheit > 42 Tage
 * - Team-Urlaubskonflikt im August (Vertrieb Neukunden)
 * - Umfrage unter der Mindestteilnehmerzahl (Ergebnisse gesperrt)
 * - Minijob über der Verdienstgrenze + fehlende IBAN (Abrechnungs-Warnungen)
 * - ablaufendes Zertifikat (Erinnerung), überfällige Pflichtschulungen
 */
import bcrypt from 'bcryptjs';
import { getDb, closeDb, inTransaction } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultAdmin } from '../core/auth.js';
import { storeFile } from '../core/files.js';
import { holidaysForYear, type Bundesland } from '../core/holidays.js';
import { eachDay, isWeekend } from '../core/dates.js';

const FORCE = process.argv.includes('--force');

migrate();
ensureDefaultAdmin();
const db = getDb();

const employeeCount = (db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }).n;
if (employeeCount > 0 && !FORCE) {
  console.error(
    `Es existieren bereits ${employeeCount} Mitarbeitende. Mit "npm run seed -- --force" neu seeden.`,
  );
  process.exit(1);
}

if (FORCE) {
  // Reihenfolge egal: FKs kaskadieren größtenteils; Rest explizit.
  const tables = [
    // Recruiting (Kinder → Eltern; recruiting_stages bleibt, da per Migration geseedet)
    'interviews', 'application_events', 'applications', 'candidates', 'job_postings',
    'channel_messages', 'channels', 'survey_participations', 'survey_responses',
    'survey_questions', 'surveys', 'announcement_acks', 'announcement_attachments',
    'announcements', 'meeting_protocols', 'certificates', 'freelancer_invoices',
    'freelancer_rates', 'payroll_items', 'payroll_runs', 'bonuses',
    'salary_change_requests', 'salary_components', 'feedback_actions',
    'feedback_meetings', 'training_registrations', 'trainings', 'role_skill_profiles',
    'employee_skills', 'skills', 'employee_levels', 'career_levels',
    'development_measures', 'development_plans', 'reviews', 'review_templates',
    'review_cycles', 'goals', 'sick_notes', 'absence_requests', 'company_closures',
    'documents', 'contracts',
    // Verwaltung (onboarding_task_templates bleibt, da per Migration geseedet)
    'onboarding_tasks', 'onboarding_processes', 'hr_templates',
    'employees', 'teams', 'departments', 'locations',
    'audit_log', 'files',
  ];
  inTransaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    // Benutzerkonten bis auf den Standard-Admin entfernen — die Mitarbeitenden-
    // Accounts werden unten neu angelegt und auf die frischen Profile verknüpft.
    db.prepare("DELETE FROM users WHERE email != 'admin@hrmonic.de'").run();
  });
  console.log('Bestehende Fachdaten gelöscht (--force).');
}

const TODAY = '2026-07-19';
const adminId = (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id;

function insert(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

/** Arbeitstage im Zeitraum (Mo–Fr, ohne Feiertage des Bundeslands, ohne Betriebsruhe). */
function countDays(from: string, to: string, land: Bundesland, halfStart = false, halfEnd = false): number {
  const years = new Set(eachDay(from, to).map((d) => d.slice(0, 4)));
  const holidays = new Set(
    [...years].flatMap((y) => holidaysForYear(Number(y), land).map((h) => h.date)),
  );
  const closures = new Set(eachDay('2026-12-24', '2026-12-31'));
  const days = eachDay(from, to).filter((d) => !isWeekend(d) && !holidays.has(d) && !closures.has(d));
  let n = days.length;
  if (halfStart && days.length > 0) n -= 0.5;
  if (halfEnd && days.length > 1) n -= 0.5;
  return n;
}

function demoFile(name: string, content: string): number {
  return storeFile(Buffer.from(content, 'utf8'), name, 'text/plain', adminId).id;
}

console.log('Seede Demo-Daten …');

inTransaction(() => {
  // ======================= Organisation =======================
  const locMuc = insert('locations', { name: 'München (Zentrale)', street: 'Leopoldstraße 128', zip: '80802', city: 'München', bundesland: 'BY' });
  const locHh = insert('locations', { name: 'Hamburg', street: 'Speicherstadt 14', zip: '20457', city: 'Hamburg', bundesland: 'HH' });
  const locK = insert('locations', { name: 'Köln', street: 'Mediapark 5', zip: '50670', city: 'Köln', bundesland: 'NW' });

  const depGf = insert('departments', { name: 'Geschäftsführung', parent_id: null });
  const depHr = insert('departments', { name: 'Personal', parent_id: depGf });
  const depTech = insert('departments', { name: 'Technik', parent_id: depGf });
  const depSales = insert('departments', { name: 'Vertrieb', parent_id: depGf });
  const depMkt = insert('departments', { name: 'Marketing', parent_id: depGf });
  const depFin = insert('departments', { name: 'Finanzen', parent_id: depGf });

  const teamBackend = insert('teams', { name: 'Backend', department_id: depTech });
  const teamFrontend = insert('teams', { name: 'Frontend', department_id: depTech });
  const teamOps = insert('teams', { name: 'IT-Betrieb', department_id: depTech });
  const teamNeu = insert('teams', { name: 'Neukunden', department_id: depSales });
  const teamBestand = insert('teams', { name: 'Bestandskunden', department_id: depSales });
  const teamContent = insert('teams', { name: 'Content & Kampagnen', department_id: depMkt });
  const teamBuch = insert('teams', { name: 'Buchhaltung', department_id: depFin });

  // ======================= Mitarbeitende =======================
  interface E {
    first: string; last: string; type: string; title: string;
    dep: number; team?: number; loc: number; hire: string; exit?: string;
    hours?: number; leave?: number; birth: string; tax_class?: string;
    church?: string; kids?: number; insurance?: string; noIban?: boolean;
    status?: string;
  }
  const KK = ['Techniker Krankenkasse', 'AOK Bayern', 'Barmer', 'DAK-Gesundheit', 'IKK classic'];
  const defs: E[] = [
    { first: 'Sabine', last: 'Berger', type: 'vollzeit', title: 'Geschäftsführerin', dep: depGf, loc: locMuc, hire: '2015-01-01', hours: 40, leave: 30, birth: '1975-03-12', tax_class: 'I', church: 'rk', insurance: KK[0] },
    { first: 'Jürgen', last: 'Wilms', type: 'vollzeit', title: 'Leiter Personal', dep: depHr, loc: locMuc, hire: '2017-04-01', hours: 40, leave: 30, birth: '1980-07-22', tax_class: 'III', church: 'ev', kids: 2, insurance: KK[1] },
    { first: 'Melanie', last: 'Sonntag', type: 'teilzeit', title: 'HR-Referentin', dep: depHr, loc: locMuc, hire: '2020-09-01', hours: 25, leave: 28, birth: '1990-11-05', tax_class: 'IV', kids: 1, insurance: KK[2] },
    { first: 'Tobias', last: 'Krämer', type: 'vollzeit', title: 'CTO', dep: depTech, loc: locMuc, hire: '2016-02-01', hours: 40, leave: 30, birth: '1982-01-30', tax_class: 'IV', kids: 2, insurance: KK[0] },
    { first: 'Anna', last: 'Lindqvist', type: 'vollzeit', title: 'Teamlead Backend', dep: depTech, team: teamBackend, loc: locMuc, hire: '2018-06-01', hours: 40, leave: 30, birth: '1988-05-17', tax_class: 'I', insurance: KK[0] },
    { first: 'Deniz', last: 'Aydin', type: 'vollzeit', title: 'Senior Entwickler', dep: depTech, team: teamBackend, loc: locMuc, hire: '2019-03-01', hours: 40, leave: 30, birth: '1991-09-02', tax_class: 'I', insurance: KK[3] },
    { first: 'Marta', last: 'Kowalczyk', type: 'vollzeit', title: 'Entwicklerin', dep: depTech, team: teamBackend, loc: locHh, hire: '2022-01-15', hours: 40, leave: 28, birth: '1995-12-08', tax_class: 'I', insurance: KK[2] },
    { first: 'Felix', last: 'Brandt', type: 'vollzeit', title: 'Teamlead Frontend', dep: depTech, team: teamFrontend, loc: locMuc, hire: '2019-10-01', hours: 40, leave: 30, birth: '1987-02-14', tax_class: 'IV', kids: 1, insurance: KK[1] },
    { first: 'Leonie', last: 'Vogt', type: 'teilzeit', title: 'Entwicklerin', dep: depTech, team: teamFrontend, loc: locK, hire: '2021-05-01', hours: 30, leave: 28, birth: '1993-06-26', tax_class: 'I', insurance: KK[4] },
    { first: 'Samuel', last: 'Okafor', type: 'vollzeit', title: 'DevOps Engineer', dep: depTech, team: teamOps, loc: locHh, hire: '2023-02-01', hours: 40, leave: 28, birth: '1994-04-19', tax_class: 'I', insurance: KK[0] },
    { first: 'Katrin', last: 'Albrecht', type: 'vollzeit', title: 'Leiterin Vertrieb', dep: depSales, loc: locMuc, hire: '2017-08-01', hours: 40, leave: 30, birth: '1983-10-03', tax_class: 'II', kids: 1, insurance: KK[2] },
    { first: 'Björn', last: 'Petersen', type: 'vollzeit', title: 'Account Executive', dep: depSales, team: teamNeu, loc: locHh, hire: '2020-03-01', hours: 40, leave: 28, birth: '1989-08-11', tax_class: 'I', insurance: KK[3] },
    { first: 'Aylin', last: 'Şahin', type: 'vollzeit', title: 'Account Executive', dep: depSales, team: teamNeu, loc: locMuc, hire: '2021-11-01', hours: 40, leave: 28, birth: '1992-03-29', tax_class: 'I', insurance: KK[1] },
    { first: 'Christian', last: 'Maurer', type: 'vollzeit', title: 'Account Manager', dep: depSales, team: teamBestand, loc: locK, hire: '2018-01-01', hours: 40, leave: 30, birth: '1986-12-01', tax_class: 'III', kids: 3, insurance: KK[1] },
    { first: 'Nora', last: 'Hentschel', type: 'vollzeit', title: 'Marketing Managerin', dep: depMkt, team: teamContent, loc: locMuc, hire: '2020-06-01', hours: 40, leave: 28, birth: '1990-01-24', tax_class: 'I', insurance: KK[2] },
    { first: 'Pavel', last: 'Novák', type: 'teilzeit', title: 'Content Creator', dep: depMkt, team: teamContent, loc: locK, hire: '2022-04-01', hours: 20, leave: 24, birth: '1996-07-07', tax_class: 'I', insurance: KK[4] },
    { first: 'Ingrid', last: 'Schäfer', type: 'vollzeit', title: 'Leiterin Finanzen', dep: depFin, loc: locMuc, hire: '2016-09-01', hours: 40, leave: 30, birth: '1978-04-15', tax_class: 'IV', church: 'rk', insurance: KK[1] },
    { first: 'Halil', last: 'Demir', type: 'vollzeit', title: 'Buchhalter', dep: depFin, team: teamBuch, loc: locMuc, hire: '2021-02-01', hours: 40, leave: 28, birth: '1993-11-18', tax_class: 'I', insurance: KK[0], noIban: true },
    { first: 'Franziska', last: 'Ottl', type: 'auszubildender', title: 'Auszubildende Kauffrau für Büromanagement', dep: depHr, loc: locMuc, hire: '2025-09-01', hours: 38, leave: 27, birth: '2006-02-09', tax_class: 'I', insurance: KK[1] },
    { first: 'Jonas', last: 'Weidner', type: 'werkstudent', title: 'Werkstudent Backend', dep: depTech, team: teamBackend, loc: locMuc, hire: '2025-10-01', hours: 18, leave: 12, birth: '2002-05-21', tax_class: 'I', insurance: KK[0] },
    { first: 'Charlotte', last: 'Fromm', type: 'werkstudent', title: 'Werkstudentin Marketing', dep: depMkt, team: teamContent, loc: locK, hire: '2026-03-01', hours: 16, leave: 10, birth: '2003-09-14', tax_class: 'I', insurance: KK[2] },
    { first: 'Emre', last: 'Yıldız', type: 'praktikant', title: 'Praktikant Vertrieb', dep: depSales, team: teamNeu, loc: locMuc, hire: '2026-06-01', exit: '2026-11-30', hours: 38, leave: 10, birth: '2004-01-27', tax_class: 'I', insurance: KK[3] },
    { first: 'Renate', last: 'Huber', type: 'minijob', title: 'Empfang & Office', dep: depGf, loc: locMuc, hire: '2019-05-01', hours: 9, leave: 8, birth: '1969-06-30', tax_class: 'I', insurance: KK[1] },
    { first: 'Dieter', last: 'Kranz', type: 'minijob', title: 'Hausmeisterdienste', dep: depGf, loc: locMuc, hire: '2021-08-01', hours: 10, leave: 8, birth: '1963-03-08', tax_class: 'I', insurance: KK[4] },
    { first: 'Vera', last: 'Simonis', type: 'freiberufler', title: 'UX/UI-Designerin', dep: depTech, team: teamFrontend, loc: locK, hire: '2024-01-01', birth: '1985-08-23' },
    { first: 'Matthias', last: 'Roth', type: 'freiberufler', title: 'Cloud-Architektur-Berater', dep: depTech, team: teamOps, loc: locHh, hire: '2025-06-01', birth: '1979-10-12' },
    { first: 'Sandra', last: 'Ebert', type: 'vollzeit', title: 'Sales Development Rep', dep: depSales, team: teamNeu, loc: locMuc, hire: '2026-04-15', hours: 40, leave: 28, birth: '1998-05-06', tax_class: 'I', insurance: KK[0] },
    { first: 'Oliver', last: 'Grunwald', type: 'vollzeit', title: 'Systemadministrator', dep: depTech, team: teamOps, loc: locMuc, hire: '2018-11-01', exit: '2026-03-31', status: 'ausgeschieden', hours: 40, leave: 30, birth: '1984-09-09', tax_class: 'I', insurance: KK[3] },
  ];

  const ids: number[] = [];
  defs.forEach((e, i) => {
    const id = insert('employees', {
      first_name: e.first,
      last_name: e.last,
      email: `${e.first.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}.${e.last.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@hrmonic.de`,
      phone: `+49 89 900${String(100 + i)}`,
      birth_date: e.birth,
      private_street: ['Amselweg 3', 'Gartenstraße 12', 'Lindenallee 7', 'Am Bach 21', 'Ringstraße 45'][i % 5],
      private_zip: ['80331', '20095', '50667', '85049', '82031'][i % 5],
      private_city: ['München', 'Hamburg', 'Köln', 'Ingolstadt', 'Grünwald'][i % 5],
      private_email: `${e.first.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}.${e.last.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@mail.de`,
      iban: e.noIban || e.type === 'freiberufler' ? null : `DE${String(10 + i)}3704004405480${String(10000 + i * 7)}`,
      bic: e.noIban || e.type === 'freiberufler' ? null : 'COBADEFFXXX',
      tax_id: e.type === 'freiberufler' ? null : `${50000000000 + i * 137}`,
      tax_class: e.tax_class ?? null,
      church_tax: e.church ?? 'keine',
      child_allowances: e.kids ?? 0,
      social_security_number: e.type === 'freiberufler' ? null : `${String(10 + i)} ${e.birth.slice(8, 10)}${e.birth.slice(5, 7)}${e.birth.slice(2, 4)} ${e.last[0]} ${String(100 + i)}`,
      health_insurance: e.insurance ?? null,
      employee_type: e.type,
      status: e.status ?? 'aktiv',
      job_title: e.title,
      department_id: e.dep,
      team_id: e.team ?? null,
      location_id: e.loc,
      hire_date: e.hire,
      exit_date: e.exit ?? null,
      weekly_hours: e.hours ?? null,
      annual_leave_days: e.leave ?? null,
    });
    ids.push(id);
  });

  const [GF, HRL, HRR, CTO, TLB, DEV1, DEV2, TLF, DEV3, OPS1, VTL, AE1, AE2, AM1, MKT, CC, FIN, BUCH, AZUBI, WS1, WS2, PRAKT, MJ1, MJ2, FREI1, FREI2, SDR, EXIT] = ids;

  // Vorgesetzte + Abteilungs-/Teamleitungen
  const setMgr = db.prepare('UPDATE employees SET manager_id = ? WHERE id = ?');
  for (const [mgr, subs] of [
    [GF, [HRL, CTO, VTL, MKT, FIN]],
    [HRL, [HRR, AZUBI]],
    [CTO, [TLB, TLF, OPS1, FREI2]],
    [TLB, [DEV1, DEV2, WS1]],
    [TLF, [DEV3, FREI1]],
    [VTL, [AE1, AE2, AM1, PRAKT, SDR]],
    [MKT, [CC, WS2]],
    [FIN, [BUCH]],
  ] as [number, number[]][]) {
    for (const s of subs) setMgr.run(mgr, s);
  }
  db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run(GF, depGf);
  db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run(HRL, depHr);
  db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run(CTO, depTech);
  db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run(VTL, depSales);
  db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run(MKT, depMkt);
  db.prepare('UPDATE departments SET head_employee_id = ? WHERE id = ?').run(FIN, depFin);
  db.prepare('UPDATE teams SET lead_employee_id = ? WHERE id = ?').run(TLB, teamBackend);
  db.prepare('UPDATE teams SET lead_employee_id = ? WHERE id = ?').run(TLF, teamFrontend);

  // ======================= Benutzerkonten =======================
  // Rollout-Setup: 3 zusätzliche Admin-Accounts für die HR-Administration
  // (Desktop) und 4 Mitarbeitenden-Accounts für das Web-Portal.
  //
  // NUR DEV: Diese Konten haben fest dokumentierte Passwörter. Auf einem
  // Kundensystem darf "npm run seed" deshalb nie laufen — dort entstehen
  // Konten über POST /api/admin/users mit serverseitig erzeugtem Passwort
  // (siehe docs/inbetriebnahme.md).
  //
  // Der Standard-Admin admin@hrmonic.de existiert bereits über
  // ensureDefaultAdmin() und behält sein ZUFÄLLIG erzeugtes Initialpasswort
  // aus <dataDir>/initial-admin-password.txt samt Wechselzwang — seed setzt
  // es bewusst nicht zurück, damit auch im Dev kein zweites bekanntes
  // Vollzugriffs-Passwort entsteht.
  const account = (
    email: string,
    name: string,
    role: 'admin' | 'mitarbeiter',
    password: string,
    employeeId: number | null,
  ) =>
    insert('users', {
      email,
      name,
      role,
      password_hash: bcrypt.hashSync(password, 10),
      employee_id: employeeId,
    });
  // Admins (verwalten und genehmigen; über das verknüpfte Profil auch portalfähig)
  account('sabine.berger@hrmonic.de', 'Sabine Berger', 'admin', 'hrmonic2026', GF);
  account('jurgen.wilms@hrmonic.de', 'Jürgen Wilms', 'admin', 'hrmonic2026', HRL);
  account('melanie.sonntag@hrmonic.de', 'Melanie Sonntag', 'admin', 'hrmonic2026', HRR);
  // Mitarbeitende (Web-Portal, Self-Service)
  account('deniz.aydin@hrmonic.de', 'Deniz Aydin', 'mitarbeiter', 'portal2026', DEV1);
  account('marta.kowalczyk@hrmonic.de', 'Marta Kowalczyk', 'mitarbeiter', 'portal2026', DEV2);
  account('leonie.vogt@hrmonic.de', 'Leonie Vogt', 'mitarbeiter', 'portal2026', DEV3);
  account('samuel.okafor@hrmonic.de', 'Samuel Okafor', 'mitarbeiter', 'portal2026', OPS1);

  // ======================= Verträge =======================
  const contractByType: Record<string, string> = {
    vollzeit: 'unbefristet', teilzeit: 'unbefristet', minijob: 'unbefristet',
    werkstudent: 'befristet', praktikant: 'praktikum', freiberufler: 'werkvertrag',
    auszubildender: 'ausbildung',
  };
  defs.forEach((e, i) => {
    insert('contracts', {
      employee_id: ids[i],
      contract_type: contractByType[e.type],
      valid_from: e.hire,
      valid_to: e.exit ?? null,
      probation_end: e.type === 'vollzeit' || e.type === 'teilzeit' ? `${e.hire.slice(0, 4)}-${e.hire.slice(5, 7)}-${e.hire.slice(8, 10)}` : null,
      notice_period_weeks: e.type === 'freiberufler' ? null : 4,
      weekly_hours: e.hours ?? null,
      annual_leave_days: e.leave ?? null,
      fixed_term_reason: e.type === 'werkstudent' ? 'Befristung für die Dauer der Immatrikulation' : e.type === 'praktikum' ? 'Pflichtpraktikum' : null,
    });
  });
  // Historie-Beispiel: Leonie Vogt wechselte 2024 von 40 auf 30 Stunden.
  insert('contracts', { employee_id: DEV3, contract_type: 'unbefristet', valid_from: '2021-05-01', valid_to: '2024-06-30', notice_period_weeks: 4, weekly_hours: 40, annual_leave_days: 30, note: 'Ursprünglicher Vollzeitvertrag' });
  db.prepare(`UPDATE contracts SET valid_from = '2024-07-01', note = 'Wechsel auf Teilzeit (30 h) auf eigenen Wunsch' WHERE employee_id = ? AND valid_to IS NULL`).run(DEV3);

  // ======================= Dokumente =======================
  const doc = (emp: number | null, cat: string, title: string, expiry: string | null = null) =>
    insert('documents', {
      employee_id: emp, category: cat, title,
      file_id: demoFile(`${title.replace(/[^A-Za-zÄÖÜäöüß0-9]+/g, '_')}.txt`, `HRMONIC Demo-Dokument\n${title}\nErstellt für Demozwecke.`),
      expiry_date: expiry, reminder_days: 30,
    });
  doc(DEV1, 'vertrag', 'Arbeitsvertrag Deniz Aydin');
  doc(DEV1, 'zertifikat', 'AWS Solutions Architect', '2026-08-05');
  doc(TLB, 'zeugnis', 'Arbeitszeugnis Vorarbeitgeber');
  doc(WS1, 'bescheinigung', 'Immatrikulationsbescheinigung WS 2025/26', '2026-09-30');
  doc(AZUBI, 'vertrag', 'Ausbildungsvertrag');
  doc(MJ1, 'bescheinigung', 'Befreiung Rentenversicherungspflicht');
  doc(OPS1, 'zertifikat', 'Kubernetes CKA', '2026-06-30'); // bereits abgelaufen
  doc(null, 'sonstiges', 'Betriebsvereinbarung Mobiles Arbeiten');

  // ======================= Abwesenheiten =======================
  const typeId = (name: string) =>
    (db.prepare('SELECT id FROM absence_types WHERE name = ?').get(name) as { id: number }).id;
  const tUrlaub = typeId('Urlaub');
  const tKrank = typeId('Krankheit');
  const tKind = typeId('Kind krank');
  const tBildung = typeId('Bildungsurlaub');
  const tHochzeit = typeId('Sonderurlaub Hochzeit');

  insert('company_closures', { date_from: '2026-12-24', date_to: '2026-12-31', name: 'Betriebsruhe Jahreswechsel' });

  const landOf = (emp: number): Bundesland => {
    const row = db.prepare('SELECT l.bundesland AS b FROM employees e LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ?').get(emp) as { b: string | null };
    return (row.b ?? 'BY') as Bundesland;
  };
  const req = (emp: number, type: number, from: string, to: string, status: string, opts: { comment?: string; rejection?: string; halfStart?: boolean } = {}) =>
    insert('absence_requests', {
      employee_id: emp, type_id: type, date_from: from, date_to: to,
      half_day_start: opts.halfStart ? 1 : 0, half_day_end: 0,
      days_counted: countDays(from, to, landOf(emp), opts.halfStart),
      status, comment: opts.comment ?? null, rejection_reason: opts.rejection ?? null,
      decided_by_user_id: status === 'beantragt' ? null : adminId,
      decided_at: status === 'beantragt' ? null : `${TODAY} 09:00:00`,
      created_by_user_id: adminId,
    });

  // Genommene und geplante Urlaube
  req(DEV1, tUrlaub, '2026-03-30', '2026-04-10', 'genehmigt', { comment: 'Osterurlaub' });
  req(TLB, tUrlaub, '2026-05-11', '2026-05-15', 'genehmigt');
  req(MKT, tUrlaub, '2026-06-02', '2026-06-05', 'genehmigt', { halfStart: true });
  req(FIN, tUrlaub, '2026-02-16', '2026-02-20', 'genehmigt', { comment: 'Faschingswoche' });
  // Sommer: Konflikt im Team Neukunden (Björn + Aylin + Praktikant überlappend)
  req(AE1, tUrlaub, '2026-08-03', '2026-08-14', 'genehmigt', { comment: 'Sommerurlaub Dänemark' });
  req(AE2, tUrlaub, '2026-08-10', '2026-08-21', 'genehmigt', { comment: 'Sommerurlaub' });
  req(PRAKT, tUrlaub, '2026-08-10', '2026-08-12', 'genehmigt');
  req(VTL, tUrlaub, '2026-09-14', '2026-09-25', 'genehmigt');
  req(DEV2, tUrlaub, '2026-08-24', '2026-09-04', 'genehmigt');
  req(TLF, tUrlaub, '2026-07-27', '2026-07-31', 'genehmigt');
  // Offene Anträge (Demo Genehmigungsworkflow)
  req(DEV3, tUrlaub, '2026-09-07', '2026-09-11', 'beantragt', { comment: 'Herbstferien' });
  req(OPS1, tUrlaub, '2026-10-05', '2026-10-16', 'beantragt');
  req(WS1, tBildung, '2026-11-02', '2026-11-04', 'beantragt', { comment: 'Seminar Datenbanksysteme' });
  // Abgelehnt / storniert
  req(BUCH, tUrlaub, '2026-07-20', '2026-07-24', 'abgelehnt', { rejection: 'Monatsabschluss — bitte Ausweichtermin wählen' });
  req(CC, tUrlaub, '2026-07-06', '2026-07-10', 'storniert');
  req(AM1, tHochzeit, '2026-06-12', '2026-06-12', 'genehmigt', { comment: 'Eigene Hochzeit' });

  // Krankheit: abgeschlossen mit AU
  const sickDone = req(DEV2, tKrank, '2026-05-04', '2026-05-08', 'genehmigt');
  insert('sick_notes', {
    absence_request_id: sickDone, certificate_due_date: '2026-05-06', received_date: '2026-05-05',
    certificate_file_id: demoFile('AU_Kowalczyk_Mai.txt', 'Arbeitsunfähigkeitsbescheinigung (Demo)'),
  });
  // Kind krank
  const sickChild = req(TLF, tKind, '2026-06-18', '2026-06-19', 'genehmigt');
  insert('sick_notes', {
    absence_request_id: sickChild, certificate_due_date: '2026-06-20', received_date: '2026-06-19', child_sick: 1,
    certificate_file_id: demoFile('AU_Kind_Brandt.txt', 'Ärztliche Bescheinigung Kind (Demo)'),
  });
  // Laufende Krankheit OHNE AU — Frist 18.07. überschritten (Demo-Warnung)
  const sickOpen = req(SDR, tKrank, '2026-07-16', '2026-07-22', 'genehmigt');
  insert('sick_notes', { absence_request_id: sickOpen, certificate_due_date: '2026-07-18' });
  // Langzeitkrankheit > 42 Tage (Lohnfortzahlung endet — Payroll-Flag)
  const sickLong = req(MJ2, tKrank, '2026-05-20', '2026-07-31', 'genehmigt', { comment: 'Reha nach OP' });
  const sn1 = insert('sick_notes', {
    absence_request_id: sickLong, certificate_due_date: '2026-05-22', received_date: '2026-05-21',
    certificate_file_id: demoFile('AU_Kranz_1.txt', 'Erstbescheinigung (Demo)'),
  });
  insert('sick_notes', {
    absence_request_id: sickLong, certificate_due_date: '2026-06-22', received_date: '2026-06-20', follow_up_of_id: sn1,
    certificate_file_id: demoFile('AU_Kranz_2.txt', 'Folgebescheinigung (Demo)'),
  });

  // ======================= Ziele & OKR =======================
  const okr1 = insert('goals', { employee_id: CTO, title: 'Plattform-Stabilität auf Enterprise-Niveau', kind: 'objective', period_from: '2026-01-01', period_to: '2026-12-31', progress: 60, status: 'aktiv', description: 'Verfügbarkeit und Performance als Verkaufsargument etablieren.' });
  insert('goals', { employee_id: CTO, title: 'Uptime ≥ 99,9 %', kind: 'key_result', parent_goal_id: okr1, metric: 'Uptime %', target_value: '99,9', current_value: '99,85', progress: 80, status: 'aktiv' });
  insert('goals', { employee_id: CTO, title: 'P95-Antwortzeit < 250 ms', kind: 'key_result', parent_goal_id: okr1, metric: 'ms', target_value: '250', current_value: '310', progress: 40, status: 'aktiv' });
  insert('goals', { employee_id: CTO, title: 'Incident-Postmortems binnen 48 h', kind: 'key_result', parent_goal_id: okr1, metric: '%', target_value: '100', current_value: '60', progress: 60, status: 'aktiv' });
  const okr2 = insert('goals', { employee_id: VTL, title: 'Neukundenwachstum DACH', kind: 'objective', period_from: '2026-01-01', period_to: '2026-12-31', progress: 55, status: 'aktiv' });
  insert('goals', { employee_id: VTL, title: '24 Neukunden-Abschlüsse', kind: 'key_result', parent_goal_id: okr2, metric: 'Abschlüsse', target_value: '24', current_value: '13', progress: 55, status: 'aktiv' });
  const gMkt = insert('goals', { employee_id: MKT, title: 'Marketing Qualified Leads +30 %', kind: 'kpi', metric: 'MQL/Quartal', target_value: '390', current_value: '350', progress: 75, period_from: '2026-01-01', period_to: '2026-12-31', status: 'aktiv' });
  insert('goals', { employee_id: HRR, title: 'Time-to-Hire unter 35 Tage', kind: 'kpi', metric: 'Tage', target_value: '35', current_value: '34', progress: 100, period_from: '2026-01-01', period_to: '2026-06-30', status: 'erreicht' });
  const gAe1 = insert('goals', { employee_id: AE1, title: 'Quota 480 T€ Neugeschäft', kind: 'kpi', metric: '€', target_value: '480000', current_value: '265000', progress: 55, period_from: '2026-01-01', period_to: '2026-12-31', status: 'aktiv' });

  // ======================= Skills =======================
  const skillIds: Record<string, number> = {};
  for (const [name, cat] of [
    ['TypeScript', 'Entwicklung'], ['React', 'Entwicklung'], ['Node.js', 'Entwicklung'],
    ['SQL', 'Entwicklung'], ['Kubernetes', 'Betrieb'], ['Projektmanagement', 'Methoden'],
    ['Kommunikation', 'Soft Skills'], ['Verhandlungsführung', 'Vertrieb'],
    ['Content-Marketing', 'Marketing'], ['DATEV', 'Finanzen'], ['Arbeitsrecht', 'HR'],
    ['UX-Design', 'Design'],
  ] as [string, string][]) {
    skillIds[name] = insert('skills', { name, category: cat });
  }
  const skill = (emp: number, name: string, level: number) =>
    insert('employee_skills', { employee_id: emp, skill_id: skillIds[name], level, assessed_at: '2026-05-01' });
  skill(TLB, 'TypeScript', 5); skill(TLB, 'Node.js', 5); skill(TLB, 'SQL', 4); skill(TLB, 'Projektmanagement', 3);
  skill(DEV1, 'TypeScript', 4); skill(DEV1, 'Node.js', 4); skill(DEV1, 'SQL', 4); skill(DEV1, 'Kubernetes', 2);
  skill(DEV2, 'TypeScript', 3); skill(DEV2, 'Node.js', 3); skill(DEV2, 'SQL', 2);
  skill(TLF, 'TypeScript', 4); skill(TLF, 'React', 5); skill(TLF, 'UX-Design', 3);
  skill(DEV3, 'React', 4); skill(DEV3, 'TypeScript', 3);
  skill(OPS1, 'Kubernetes', 4); skill(OPS1, 'Node.js', 2); skill(OPS1, 'SQL', 3);
  skill(WS1, 'TypeScript', 2); skill(WS1, 'SQL', 2);
  skill(VTL, 'Verhandlungsführung', 5); skill(VTL, 'Kommunikation', 5); skill(VTL, 'Projektmanagement', 4);
  skill(AE1, 'Verhandlungsführung', 4); skill(AE1, 'Kommunikation', 4);
  skill(AE2, 'Verhandlungsführung', 3); skill(AE2, 'Kommunikation', 4);
  skill(MKT, 'Content-Marketing', 5); skill(MKT, 'Kommunikation', 4);
  skill(FIN, 'DATEV', 5); skill(BUCH, 'DATEV', 4);
  skill(HRL, 'Arbeitsrecht', 4); skill(HRL, 'Kommunikation', 5); skill(HRR, 'Arbeitsrecht', 3);
  skill(FREI1, 'UX-Design', 5); skill(FREI1, 'React', 3);

  for (const [role, reqs] of [
    ['Senior Entwickler:in', [['TypeScript', 4], ['Node.js', 4], ['SQL', 3], ['Projektmanagement', 2]]],
    ['Entwickler:in', [['TypeScript', 3], ['Node.js', 3], ['SQL', 2]]],
    ['Account Executive', [['Verhandlungsführung', 4], ['Kommunikation', 4]]],
  ] as [string, [string, number][]][]) {
    for (const [name, lvl] of reqs) insert('role_skill_profiles', { role_name: role, skill_id: skillIds[name], required_level: lvl });
  }

  // Karrierepfade
  const lvl = (role: string, level: number, title: string, reqs: string) =>
    insert('career_levels', { role_name: role, level, title, requirements: reqs });
  lvl('Entwicklung', 1, 'Junior Developer', 'Grundlagen TypeScript/SQL, Pairing mit Senior');
  const lMid = lvl('Entwicklung', 2, 'Developer', 'Eigenständige Features, Code-Reviews, TS/Node Level 3');
  const lSen = lvl('Entwicklung', 3, 'Senior Developer', 'Architekturentscheidungen, Mentoring, TS/Node Level 4+');
  lvl('Entwicklung', 4, 'Staff Engineer', 'Teamübergreifende Initiativen, technische Strategie');
  insert('employee_levels', { employee_id: DEV2, career_level_id: lMid, since_date: '2023-01-01' });
  insert('employee_levels', { employee_id: DEV1, career_level_id: lSen, since_date: '2024-07-01' });

  const plan = insert('development_plans', { employee_id: DEV2, title: 'Weg zur Senior-Entwicklerin', goal: 'Beförderung auf Senior Level bis Mitte 2027', status: 'aktiv' });
  insert('development_measures', { plan_id: plan, title: 'SQL-Vertiefung (Fenster-Funktionen, Query-Tuning)', due_date: '2026-09-30', owner_employee_id: TLB, status: 'laufend' });
  insert('development_measures', { plan_id: plan, title: 'Feature-Lead für Release 4.2', due_date: '2026-11-15', owner_employee_id: DEV2, status: 'offen' });

  // ======================= Trainings =======================
  const trDsgvo = insert('trainings', { title: 'Datenschutz-Grundschulung (DSGVO)', kind: 'intern', mandatory: 1, repeat_interval_months: 12, description: 'Jährliche Pflichtschulung für alle Mitarbeitenden.' });
  const trErste = insert('trainings', { title: 'Erste-Hilfe-Kurs', provider: 'Johanniter', kind: 'extern', cost_cents: 6500, mandatory: 1, repeat_interval_months: 24 });
  const trReact = insert('trainings', { title: 'React Advanced Patterns', provider: 'workshops.de', kind: 'extern', cost_cents: 89000 });
  const trLead = insert('trainings', { title: 'Führung für neue Teamleads', kind: 'intern', description: '2-tägiger interner Workshop.' });
  const reg = (tr: number, emp: number, status: string, completed?: string) =>
    insert('training_registrations', { training_id: tr, employee_id: emp, status, date: completed ?? null, completed_at: completed ?? null, certificate_file_id: completed && tr !== trDsgvo ? demoFile('Zertifikat.txt', 'Teilnahmezertifikat (Demo)') : null });
  // DSGVO: ok / überfällig / nie absolviert
  reg(trDsgvo, TLB, 'abgeschlossen', '2026-03-10');
  reg(trDsgvo, DEV1, 'abgeschlossen', '2026-03-10');
  reg(trDsgvo, HRL, 'abgeschlossen', '2026-02-01');
  reg(trDsgvo, DEV2, 'abgeschlossen', '2025-05-20'); // > 12 Monate → überfällig
  reg(trDsgvo, VTL, 'abgeschlossen', '2025-06-15');  // > 12 Monate → überfällig
  reg(trErste, MJ1, 'abgeschlossen', '2025-01-20');
  reg(trErste, OPS1, 'abgeschlossen', '2024-09-01'); // fast 24 Monate → bald fällig
  reg(trReact, DEV3, 'abgeschlossen', '2026-04-22');
  reg(trReact, TLF, 'angemeldet');
  reg(trLead, TLB, 'teilgenommen');
  reg(trLead, TLF, 'angemeldet');

  // ======================= Beurteilungen =======================
  const cyc = insert('review_cycles', { name: 'Jahresgespräche 2026', kind: 'jaehrlich', period_from: '2026-01-01', period_to: '2026-12-31', status: 'laufend' });
  const tpl = insert('review_templates', {
    name: 'Standardbogen',
    criteria: JSON.stringify([
      { key: 'fachkompetenz', label: 'Fachkompetenz', description: 'Beherrschung der fachlichen Anforderungen', scale_max: 5 },
      { key: 'qualitaet', label: 'Arbeitsqualität', description: 'Sorgfalt, Verlässlichkeit, Ergebnisse', scale_max: 5 },
      { key: 'zusammenarbeit', label: 'Zusammenarbeit', description: 'Teamarbeit und Kommunikation', scale_max: 5 },
      { key: 'eigenverantwortung', label: 'Eigenverantwortung', description: 'Initiative und Selbstorganisation', scale_max: 5 },
      { key: 'entwicklung', label: 'Entwicklung', description: 'Lernbereitschaft und Wachstum', scale_max: 5 },
    ]),
  });
  const review = (emp: number, reviewer: number | null, kind: string, status: string, scores?: [number, number, number, number, number], summary?: string) => {
    const keys = ['fachkompetenz', 'qualitaet', 'zusammenarbeit', 'eigenverantwortung', 'entwicklung'];
    const sc = scores ? keys.map((k, i) => ({ key: k, score: scores[i] })) : [];
    const overall = scores ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return insert('reviews', {
      cycle_id: cyc, employee_id: emp, template_id: tpl, reviewer_employee_id: reviewer,
      kind, status, scores: JSON.stringify(sc), overall_score: status === 'abgeschlossen' ? overall : null,
      summary: summary ?? null, completed_at: status === 'abgeschlossen' ? '2026-06-30' : null,
    });
  };
  review(DEV1, TLB, 'vorgesetzt', 'abgeschlossen', [5, 4, 4, 5, 4], 'Sehr starkes Jahr; Architekturthemen weiter ausbauen.');
  review(DEV1, null, 'selbst', 'abgeschlossen', [4, 4, 4, 5, 5]);
  review(DEV2, TLB, 'vorgesetzt', 'in_bearbeitung', [4, 4, 3, 3, 4]);
  review(AE1, VTL, 'vorgesetzt', 'offen');
  // 360° für Teamlead Frontend
  review(TLF, CTO, 'feedback360', 'abgeschlossen', [4, 4, 5, 4, 4]);
  review(TLF, DEV3, 'feedback360', 'abgeschlossen', [4, 5, 5, 4, 4]);
  review(TLF, MKT, 'feedback360', 'abgeschlossen', [4, 4, 4, 4, 3]);

  // ======================= Feedback-Gespräche =======================
  insert('feedback_meetings', { employee_id: DEV1, kind: 'einzelgespraech', scheduled_date: '2026-07-28', recurrence_months: 1, status: 'geplant' });
  insert('feedback_meetings', { employee_id: DEV2, kind: 'einzelgespraech', scheduled_date: '2026-07-10', recurrence_months: 1, status: 'geplant' }); // überfällig
  insert('feedback_meetings', { employee_id: SDR, kind: 'probezeitgespraech', scheduled_date: '2026-08-14', status: 'geplant' });
  insert('feedback_meetings', { employee_id: PRAKT, kind: 'sonstiges', scheduled_date: '2026-08-31', status: 'geplant' });
  const fm = insert('feedback_meetings', { employee_id: DEV3, kind: 'einzelgespraech', scheduled_date: '2026-06-24', held_date: '2026-06-24', status: 'stattgefunden', recurrence_months: 2, notes: 'Zufrieden mit Teilzeitmodell; möchte mehr Design-System-Arbeit übernehmen.' });
  insert('feedback_actions', { meeting_id: fm, title: 'Design-System-Verantwortung übertragen', due_date: '2026-07-15', owner_employee_id: TLF, status: 'offen' }); // überfällig
  insert('feedback_actions', { meeting_id: fm, title: 'Storybook-Setup evaluieren', due_date: '2026-07-01', owner_employee_id: DEV3, status: 'erledigt' });

  // ======================= Vergütung =======================
  const sal = (emp: number, kind: string, cents: number, from: string, to: string | null = null, note: string | null = null) =>
    insert('salary_components', { employee_id: emp, kind, amount_cents: cents, valid_from: from, valid_to: to, note });
  // Grundgehälter (Monatsbrutto)
  sal(GF, 'grundgehalt', 1450000, '2024-01-01'); sal(GF, 'sachbezug_dienstwagen', 68000, '2024-01-01');
  sal(HRL, 'grundgehalt', 720000, '2025-01-01'); sal(HRL, 'vwl', 4000, '2025-01-01');
  sal(HRR, 'grundgehalt', 330000, '2025-01-01', null, '25 h/Woche');
  // Gehaltshistorie CTO: Erhöhung zum 01.01.2026
  sal(CTO, 'grundgehalt', 1050000, '2024-01-01', '2025-12-31');
  sal(CTO, 'grundgehalt', 1120000, '2026-01-01', null, 'Reguläre Anpassung 2026');
  sal(TLB, 'grundgehalt', 830000, '2025-07-01'); sal(TLB, 'zulage_funktion', 40000, '2025-07-01', null, 'Teamleitung');
  sal(DEV1, 'grundgehalt', 760000, '2026-01-01'); sal(DEV1, 'bav_entgeltumwandlung', 20000, '2026-01-01');
  sal(DEV2, 'grundgehalt', 580000, '2026-01-01'); sal(DEV2, 'sachbezug_jobticket', 4900, '2026-01-01');
  sal(TLF, 'grundgehalt', 810000, '2025-07-01'); sal(TLF, 'zulage_funktion', 40000, '2025-07-01', null, 'Teamleitung');
  sal(DEV3, 'grundgehalt', 480000, '2024-07-01', null, '30 h/Woche');
  sal(OPS1, 'grundgehalt', 640000, '2026-01-01'); sal(OPS1, 'zulage_schicht', 25000, '2026-01-01', null, 'Rufbereitschaft');
  sal(VTL, 'grundgehalt', 880000, '2025-01-01'); sal(VTL, 'sachbezug_dienstwagen', 52000, '2025-01-01');
  sal(AE1, 'grundgehalt', 560000, '2025-01-01');
  sal(AE2, 'grundgehalt', 540000, '2025-01-01');
  sal(AM1, 'grundgehalt', 590000, '2025-01-01'); sal(AM1, 'vwl', 4000, '2025-01-01');
  sal(MKT, 'grundgehalt', 610000, '2026-01-01');
  sal(CC, 'grundgehalt', 240000, '2025-01-01', null, '20 h/Woche');
  sal(FIN, 'grundgehalt', 850000, '2025-01-01');
  sal(BUCH, 'grundgehalt', 520000, '2026-01-01');
  sal(AZUBI, 'grundgehalt', 115000, '2025-09-01', null, '1. Ausbildungsjahr');
  sal(WS1, 'stundenlohn', 1700, '2025-10-01');
  sal(WS2, 'stundenlohn', 1550, '2026-03-01');
  sal(PRAKT, 'grundgehalt', 210000, '2026-06-01', null, 'Pflichtpraktikum');
  sal(MJ1, 'stundenlohn', 1450, '2026-01-01'); // 14,50 € × 9 h × 4,33 ≈ 565 € → über Minijob-Grenze!
  sal(MJ2, 'stundenlohn', 1300, '2026-01-01');
  sal(SDR, 'grundgehalt', 460000, '2026-04-15');

  // Offener Gehaltsänderungsantrag (Demo Workflow)
  insert('salary_change_requests', {
    employee_id: DEV2, kind: 'grundgehalt', new_amount_cents: 620000, effective_date: '2026-09-01',
    reason: 'Sehr gute Leistung im Release 4.1, Übernahme von Feature-Lead-Verantwortung',
    status: 'beantragt', requested_by_user_id: adminId,
  });
  // Genehmigte Historie (für Audit-Demo)
  insert('salary_change_requests', {
    employee_id: CTO, kind: 'grundgehalt', new_amount_cents: 1120000, effective_date: '2026-01-01',
    reason: 'Reguläre Jahresanpassung laut Vergütungsband', status: 'genehmigt',
    requested_by_user_id: adminId, decided_by_user_id: adminId, decided_at: '2025-12-10 10:00:00',
  });

  // Boni
  insert('bonuses', { employee_id: MKT, kind: 'zielbonus', title: 'Zielbonus MQL 2026', target_amount_cents: 400000, goal_id: gMkt, payout_month: '2027-01', status: 'geplant' });
  insert('bonuses', { employee_id: AE1, kind: 'zielbonus', title: 'Zielbonus Quota 2026', target_amount_cents: 600000, goal_id: gAe1, payout_month: '2027-01', status: 'geplant' });
  insert('bonuses', { employee_id: AE2, kind: 'provision', title: 'Provision Q2 (Abschluss TechCorp)', amount_cents: 180000, payout_month: '2026-07', status: 'freigegeben' });
  insert('bonuses', { employee_id: DEV1, kind: 'einmalzahlung', title: 'Sonderprämie Migration', amount_cents: 150000, payout_month: '2026-06', status: 'ausgezahlt' });

  // Freiberufler
  insert('freelancer_rates', { employee_id: FREI1, description: 'UX/UI-Design', rate_cents: 9500, unit: 'stunde', valid_from: '2024-01-01' });
  insert('freelancer_rates', { employee_id: FREI2, description: 'Cloud-Beratung', rate_cents: 120000, unit: 'tag', valid_from: '2025-06-01' });
  insert('freelancer_invoices', { employee_id: FREI1, invoice_number: '2026-014', invoice_date: '2026-06-30', period: '2026-06', amount_cents: 649800, hours: 68.4, status: 'bezahlt', paid_date: '2026-07-10' });
  insert('freelancer_invoices', { employee_id: FREI1, invoice_number: '2026-017', invoice_date: '2026-07-15', period: '2026-07 (Teil 1)', amount_cents: 361000, hours: 38, status: 'offen' });
  insert('freelancer_invoices', { employee_id: FREI2, invoice_number: 'R-2026-089', invoice_date: '2026-07-01', period: '2026-06', amount_cents: 960000, status: 'geprueft', note: '8 Beratungstage' });

  // Bescheinigung (Demo)
  insert('certificates', { employee_id: DEV1, kind: 'arbeitgeberbescheinigung', period: '2026', status: 'angefordert', note: 'Für Mietvertrag' });

  // ======================= Kommunikation =======================
  const ann1 = insert('announcements', {
    title: 'Sommerfest am 21. August in München', body: 'Liebe Kolleginnen und Kollegen,\n\nunser Sommerfest findet am Freitag, 21. August ab 15 Uhr im Biergarten am Flaucher statt. Partner:innen und Kinder sind herzlich willkommen!\n\nBitte bestätigt kurz, ob ihr dabei seid.\n\nEuer HR-Team',
    audience_type: 'alle', publish_at: '2026-07-01', expires_at: '2026-08-21', requires_ack: 1, created_by_user_id: adminId,
  });
  for (const emp of [HRL, HRR, CTO, TLB, DEV1, DEV3, TLF, VTL, AE2, MKT, FIN, BUCH, AZUBI, WS1, MJ1]) {
    insert('announcement_acks', { announcement_id: ann1, employee_id: emp });
  }
  insert('announcements', {
    title: 'Neue Reisekostenrichtlinie ab Juli', body: 'Ab 1. Juli gilt die aktualisierte Reisekostenrichtlinie: Bahnreisen 1. Klasse ab 3 h Fahrzeit, Verpflegungspauschalen nach BMF. Details im Anhang bzw. im Wiki.',
    audience_type: 'abteilung', audience_id: depSales, publish_at: '2026-06-15', requires_ack: 0, created_by_user_id: adminId,
  });
  insert('announcements', {
    title: 'Wartung HR-Systeme (erledigt)', body: 'Die Wartungsarbeiten sind abgeschlossen.',
    audience_type: 'alle', publish_at: '2026-05-02', expires_at: '2026-05-09', requires_ack: 0, created_by_user_id: adminId,
  });
  insert('announcements', {
    title: 'Neuer Standort-Parkplatz Köln', body: 'Ab 1. August stehen am Standort Köln zehn zusätzliche Stellplätze in der Tiefgarage Mediapark zur Verfügung. Zuteilung über das Office-Team.',
    audience_type: 'standort', audience_id: locK, publish_at: '2026-08-01', requires_ack: 0, created_by_user_id: adminId,
  });

  // Umfragen: eine auswertbar (9 Teilnahmen), eine unter der Schwelle (3)
  const sv1 = insert('surveys', { title: 'Pulse-Check Q3/2026', description: 'Kurzer Stimmungscheck — 2 Minuten, anonym.', audience_type: 'alle', date_from: '2026-07-01', date_to: '2026-07-31', status: 'laufend', created_by_user_id: adminId });
  const q1 = insert('survey_questions', { survey_id: sv1, kind: 'skala', text: 'Wie zufrieden bist du aktuell mit deiner Arbeitssituation?', scale_max: 5, sort_order: 1 });
  const q2 = insert('survey_questions', { survey_id: sv1, kind: 'skala', text: 'Wie gut ist deine aktuelle Arbeitsbelastung zu bewältigen?', scale_max: 5, sort_order: 2 });
  const q3 = insert('survey_questions', { survey_id: sv1, kind: 'einfachauswahl', text: 'Wie oft arbeitest du im Homeoffice?', options: JSON.stringify(['Nie', '1–2 Tage/Woche', '3–4 Tage/Woche', 'Vollständig remote']), sort_order: 3 });
  const q4 = insert('survey_questions', { survey_id: sv1, kind: 'freitext', text: 'Was sollten wir als Nächstes verbessern?', sort_order: 4 });
  const answers: [number, number, string, string][] = [
    [4, 4, '1–2 Tage/Woche', 'Mehr Fokuszeit ohne Meetings.'],
    [5, 4, '3–4 Tage/Woche', 'Die neuen Monitore sind super!'],
    [3, 2, '1–2 Tage/Woche', 'Workload im Vertrieb ist aktuell sehr hoch.'],
    [4, 3, 'Nie', 'Kantine könnte mehr vegetarische Optionen bieten.'],
    [4, 4, '1–2 Tage/Woche', ''],
    [5, 5, 'Vollständig remote', 'Bitte das Remote-Setup so beibehalten.'],
    [3, 3, '3–4 Tage/Woche', 'Onboarding-Doku aktualisieren.'],
    [4, 4, '1–2 Tage/Woche', 'Mehr teamübergreifende Events wie das Sommerfest.'],
    [2, 2, 'Nie', 'Bessere Abstimmung zwischen Vertrieb und Technik.'],
  ];
  answers.forEach((a) => {
    insert('survey_responses', {
      survey_id: sv1,
      answers: JSON.stringify([
        { question_id: q1, value: a[0] }, { question_id: q2, value: a[1] },
        { question_id: q3, value: a[2] }, ...(a[3] ? [{ question_id: q4, value: a[3] }] : []),
      ]),
    });
  });
  [HRL, HRR, CTO, TLB, DEV1, DEV2, TLF, VTL, MKT].forEach((emp) =>
    insert('survey_participations', { survey_id: sv1, employee_id: emp }),
  );
  const sv2 = insert('surveys', { title: 'Feedback Onboarding-Prozess', description: 'Für alle, die in den letzten 12 Monaten gestartet sind.', audience_type: 'alle', date_from: '2026-07-10', date_to: '2026-08-10', status: 'laufend', created_by_user_id: adminId });
  const q5 = insert('survey_questions', { survey_id: sv2, kind: 'skala', text: 'Wie gut hat dich das Onboarding auf deine Rolle vorbereitet?', scale_max: 5, sort_order: 1 });
  [[4], [5], [3]].forEach((v) => insert('survey_responses', { survey_id: sv2, answers: JSON.stringify([{ question_id: q5, value: v[0] }]) }));
  [SDR, WS2, PRAKT].forEach((emp) => insert('survey_participations', { survey_id: sv2, employee_id: emp }));

  // Gesprächsprotokolle
  insert('meeting_protocols', {
    employee_id: DEV2, meeting_date: '2026-07-08', occasion: 'einzelgespraech',
    participants: 'Marta Kowalczyk, Anna Lindqvist (Teamlead), Jürgen Wilms (HR)',
    content: 'Gespräch über Entwicklungsperspektive und Gehaltswunsch. Marta strebt Senior-Level an.',
    agreements: 'Entwicklungsplan aufgesetzt; Gehaltsänderungsantrag zum 01.09. eingereicht.',
    follow_up_date: '2026-09-15', visibility: 'hr_vorgesetzte', created_by_user_id: adminId,
  });
  insert('meeting_protocols', {
    employee_id: SDR, meeting_date: '2026-07-01', occasion: 'probezeit',
    participants: 'Sandra Ebert, Katrin Albrecht',
    content: 'Zwischenstand Probezeit: sehr guter Start, Pipeline-Aufbau über Plan.',
    agreements: 'Probezeitgespräch final am 14.08.', follow_up_date: '2026-08-14',
    visibility: 'hr_vorgesetzte_mitarbeiter', created_by_user_id: adminId,
  });
  insert('meeting_protocols', {
    employee_id: MJ2, meeting_date: '2026-06-05', occasion: 'rueckkehr',
    participants: 'Dieter Kranz, Jürgen Wilms',
    content: 'BEM-Gespräch nach längerer Erkrankung; stufenweise Wiedereingliederung besprochen.',
    agreements: 'Wiedereingliederungsplan ab September prüfen.', follow_up_date: '2026-08-25',
    visibility: 'nur_hr', created_by_user_id: adminId,
  });

  // Kanäle
  const ch1 = insert('channels', { name: 'Allgemein', topic: 'Unternehmensweite Neuigkeiten', audience_type: 'alle' });
  const ch2 = insert('channels', { name: 'Technik-News', topic: 'Releases, Wartungsfenster, Incidents', audience_type: 'abteilung', audience_id: depTech });
  const ch3 = insert('channels', { name: 'Standort München', topic: 'Alles rund um die Zentrale', audience_type: 'standort', audience_id: locMuc });
  insert('channels', { name: 'Projekt Phoenix (2025)', topic: 'Archiviert', audience_type: 'alle', archived: 1 });
  const msg = (ch: number, body: string, at: string) =>
    insert('channel_messages', { channel_id: ch, body, sent_by_user_id: adminId, sent_at: at });
  msg(ch1, 'Herzlich willkommen im neuen HRMONIC-Kanal! Hier informieren wir künftig über alles Wichtige.', '2026-06-01 09:00:00');
  msg(ch1, 'Reminder: Bitte die Pulse-Umfrage Q3 ausfüllen — dauert nur 2 Minuten und ist anonym. 🙌', '2026-07-06 10:30:00');
  msg(ch1, 'Das Sommerfest rückt näher — bitte Teilnahme in der Ankündigung bestätigen!', '2026-07-15 14:00:00');
  msg(ch2, 'Wartungsfenster am Samstag 06–08 Uhr: Deployment Release 4.1.', '2026-07-08 16:45:00');
  msg(ch2, 'Release 4.1 ist live. Danke an alle Beteiligten! 🎉', '2026-07-13 09:12:00');
  msg(ch3, 'Die Tiefgarage ist am Montag wegen Reinigung gesperrt — bitte auf die Ausweichplätze ausweichen.', '2026-07-17 08:00:00');

  // ======================= Recruiting =======================
  const stageId = (name: string) =>
    (db.prepare('SELECT id FROM recruiting_stages WHERE name = ?').get(name) as { id: number }).id;
  const stEingang = stageId('Eingegangen');
  const stSichtung = stageId('Sichtung');
  const stTelefon = stageId('Telefoninterview');
  const stInterview = stageId('Interview');
  const stAngebot = stageId('Angebot');
  const stEingestellt = stageId('Eingestellt');
  const stAbgelehnt = stageId('Abgelehnt');

  const posting = (row: Record<string, unknown>) =>
    insert('job_postings', { created_by_user_id: adminId, ...row });
  const pBackend = posting({
    title: 'Senior Backend Entwickler:in (m/w/d)', employment_type: 'vollzeit', department_id: depTech,
    team_id: teamBackend, location_id: locMuc, hiring_manager_id: CTO, seats: 1,
    employment_start: '2026-10-01', salary_min_cents: 6500000, salary_max_cents: 8500000,
    description: 'Verantwortung für unsere Kern-APIs (Node.js/TypeScript, SQLite/PostgreSQL) und die technische Weiterentwicklung der Plattform.',
    requirements: 'Mind. 5 Jahre Backend-Erfahrung, sehr gute TypeScript-Kenntnisse, Erfahrung mit relationalen Datenbanken.',
    status: 'veroeffentlicht', published_at: '2026-06-02',
  });
  const pAE = posting({
    title: 'Account Executive Neukunden (m/w/d)', employment_type: 'vollzeit', department_id: depSales,
    team_id: teamNeu, location_id: locHh, hiring_manager_id: VTL, seats: 2,
    employment_start: '2026-09-01', salary_min_cents: 5000000, salary_max_cents: 6500000,
    description: 'Aufbau und Abschluss von Neukundengeschäft im DACH-Raum.',
    requirements: 'Vertriebserfahrung im B2B-SaaS-Umfeld, Abschlussstärke, Reisebereitschaft.',
    status: 'veroeffentlicht', published_at: '2026-06-15',
  });
  const pWerk = posting({
    title: 'Werkstudent:in Frontend (m/w/d)', employment_type: 'werkstudent', department_id: depTech,
    team_id: teamFrontend, location_id: locK, hiring_manager_id: TLF, seats: 1,
    salary_min_cents: 1600, salary_max_cents: 1900,
    description: 'Mitarbeit an unserem React-Frontend und Design-System (max. 20 h/Woche).',
    requirements: 'Immatrikulation, erste React-Erfahrung, Interesse an UI/UX.',
    status: 'veroeffentlicht', published_at: '2026-07-01',
  });
  posting({
    title: 'People & Culture Manager:in (m/w/d)', employment_type: 'vollzeit', department_id: depHr,
    location_id: locMuc, hiring_manager_id: HRL, seats: 1, salary_min_cents: 5500000, salary_max_cents: 7000000,
    description: 'Verantwortung für Recruiting, Onboarding und Mitarbeiterentwicklung.',
    requirements: 'Erfahrung im HR-Management, Kenntnisse im Arbeitsrecht.',
    status: 'entwurf',
  });

  // Bewerber:innen
  const cand = (row: Record<string, unknown>) => insert('candidates', row);
  const cLena = cand({ first_name: 'Lena', last_name: 'Brandt', email: 'lena.brandt@example.com', phone: '+49 151 2345678', city: 'München', source: 'linkedin', headline: 'Backend-Entwicklerin bei ScaleUp GmbH', linkedin_url: 'https://www.linkedin.com/in/lenabrandt', consent_until: '2027-06-01' });
  const cJan = cand({ first_name: 'Jan', last_name: 'Ostermann', email: 'jan.ostermann@example.com', phone: '+49 160 9988776', city: 'Nürnberg', source: 'stellenportal', headline: 'Senior Software Engineer', consent_until: '2027-06-01' });
  const cPriya = cand({ first_name: 'Priya', last_name: 'Sharma', email: 'priya.sharma@example.com', city: 'Berlin', source: 'empfehlung', headline: 'Fullstack-Entwicklerin, Fokus Node.js', consent_until: '2027-06-01' });
  const cTom = cand({ first_name: 'Tom', last_name: 'Berger', email: 'tom.berger@example.com', city: 'München', source: 'website', headline: 'Backend-Entwickler', consent_until: '2027-06-01' });
  const cSofia = cand({ first_name: 'Sofia', last_name: 'Klein', email: 'sofia.klein@example.com', city: 'Augsburg', source: 'personalvermittlung', headline: 'Java-Entwicklerin', consent_until: '2027-06-01' });
  const cMarco = cand({ first_name: 'Marco', last_name: 'Rossi', email: 'marco.rossi@example.com', phone: '+49 176 5544332', city: 'Hamburg', source: 'linkedin', headline: 'Account Executive, SaaS', consent_until: '2027-06-01' });
  const cNadine = cand({ first_name: 'Nadine', last_name: 'Vogel', email: 'nadine.vogel@example.com', city: 'Hamburg', source: 'stellenportal', headline: 'Sales Managerin', consent_until: '2027-06-01' });
  const cKevin = cand({ first_name: 'Kevin', last_name: 'Wolf', email: 'kevin.wolf@example.com', city: 'Bremen', source: 'website', headline: 'Junior Sales', consent_until: '2027-06-01' });
  const cLaura = cand({ first_name: 'Laura', last_name: 'Fischer', email: 'laura.fischer@example.com', city: 'Köln', source: 'hochschule', headline: 'Studentin Medieninformatik (5. Semester)', consent_until: '2027-06-01' });

  // Bewerbungen inkl. Timeline (Eingang + optional Stufenwechsel/Notiz).
  const application = (
    candidate: number, postingId: number, stage: number, appliedAt: string,
    opts: { rating?: number; source?: string; status?: string; salary?: number; available?: string; rejection?: string; converted?: number; decided?: string } = {},
  ) => {
    const id = insert('applications', {
      candidate_id: candidate, posting_id: postingId, stage_id: stage,
      status: opts.status ?? 'aktiv', rating: opts.rating ?? null, source: opts.source ?? null,
      salary_expectation_cents: opts.salary ?? null, available_from: opts.available ?? null,
      applied_at: appliedAt, stage_changed_at: appliedAt, rejection_reason: opts.rejection ?? null,
      decided_at: opts.decided ?? null, converted_employee_id: opts.converted ?? null,
    });
    insert('application_events', { application_id: id, kind: 'eingang', to_stage_id: stEingang, user_id: adminId, created_at: `${appliedAt} 08:30:00` });
    return id;
  };
  const event = (appId: number, kind: string, body: string | null, from: number | null, to: number | null, at: string) =>
    insert('application_events', { application_id: appId, kind, body, from_stage_id: from, to_stage_id: to, user_id: adminId, created_at: at });
  const interview = (appId: number, kind: string, at: string, opts: { status?: string; recommendation?: string; scorecard?: [string, number][]; feedback?: string; location?: string; interviewers?: number[]; duration?: number } = {}) =>
    insert('interviews', {
      application_id: appId, kind, scheduled_at: at, duration_minutes: opts.duration ?? 45,
      location: opts.location ?? null, interviewer_ids: JSON.stringify(opts.interviewers ?? []),
      status: opts.status ?? 'geplant', recommendation: opts.recommendation ?? null,
      scorecard: JSON.stringify((opts.scorecard ?? []).map(([criterion, score]) => ({ criterion, score }))),
      feedback: opts.feedback ?? null,
    });

  // Backend-Pipeline (gut gefüllt für die Kanban-Demo)
  application(cTom, pBackend, stSichtung, '2026-07-10', { rating: 3, source: 'website', salary: 7200000 });
  const aJan = application(cJan, pBackend, stTelefon, '2026-06-28', { rating: 4, source: 'stellenportal', salary: 7500000, available: '2026-10-01' });
  event(aJan, 'stufenwechsel', null, stSichtung, stTelefon, '2026-07-02 11:00:00');
  interview(aJan, 'telefon', '2026-07-08 10:00', { status: 'stattgefunden', recommendation: 'ja', duration: 30, interviewers: [CTO], scorecard: [['Fachkompetenz', 4], ['Kommunikation', 4]], feedback: 'Solider Eindruck, weiter in die nächste Runde.' });
  const aLena = application(cLena, pBackend, stInterview, '2026-06-20', { rating: 5, source: 'linkedin', salary: 8000000, available: '2026-11-01' });
  event(aLena, 'stufenwechsel', null, stSichtung, stTelefon, '2026-06-25 09:30:00');
  event(aLena, 'notiz', 'Sehr überzeugendes Portfolio, starke Systemdesign-Kenntnisse.', null, null, '2026-06-26 14:00:00');
  event(aLena, 'stufenwechsel', null, stTelefon, stInterview, '2026-07-05 16:00:00');
  interview(aLena, 'telefon', '2026-07-01 14:00', { status: 'stattgefunden', recommendation: 'ja', duration: 30, interviewers: [CTO], scorecard: [['Fachkompetenz', 5], ['Kommunikation', 4]], feedback: 'Top-Kandidatin.' });
  interview(aLena, 'technik', '2026-07-22 13:00', { status: 'geplant', duration: 90, location: 'Videocall (Zoom)', interviewers: [TLB, DEV1] });
  const aPriya = application(cPriya, pBackend, stAngebot, '2026-06-10', { rating: 5, source: 'empfehlung', salary: 7800000, available: '2026-09-15' });
  event(aPriya, 'stufenwechsel', null, stSichtung, stTelefon, '2026-06-14 10:00:00');
  event(aPriya, 'stufenwechsel', null, stTelefon, stInterview, '2026-06-24 10:00:00');
  event(aPriya, 'stufenwechsel', null, stInterview, stAngebot, '2026-07-09 10:00:00');
  interview(aPriya, 'vor_ort', '2026-07-07 11:00', { status: 'stattgefunden', recommendation: 'ja', duration: 120, location: 'München, Raum Isar', interviewers: [CTO, TLB, DEV1], scorecard: [['Fachkompetenz', 5], ['Kommunikation', 5], ['Kultur-Fit', 4]], feedback: 'Einstellungsempfehlung des gesamten Panels.' });
  const aSofia = application(cSofia, pBackend, stAbgelehnt, '2026-06-30', { rating: 2, source: 'personalvermittlung', status: 'abgelehnt', rejection: 'Schwerpunkt liegt auf Java; gesuchtes Node.js-Profil nicht ausreichend abgedeckt.', decided: '2026-07-06 09:00:00' });
  event(aSofia, 'absage', 'Schwerpunkt liegt auf Java; gesuchtes Node.js-Profil nicht ausreichend abgedeckt.', stSichtung, stAbgelehnt, '2026-07-06 09:00:00');

  // Vertriebs-Pipeline
  const aMarco = application(cMarco, pAE, stInterview, '2026-06-22', { rating: 4, source: 'linkedin', salary: 6000000 });
  event(aMarco, 'stufenwechsel', null, stSichtung, stTelefon, '2026-06-27 10:00:00');
  event(aMarco, 'stufenwechsel', null, stTelefon, stInterview, '2026-07-06 10:00:00');
  interview(aMarco, 'video', '2026-07-21 15:00', { status: 'geplant', duration: 45, location: 'Google Meet', interviewers: [VTL] });
  application(cNadine, pAE, stSichtung, '2026-07-12', { rating: 3, source: 'stellenportal' });
  application(cKevin, pAE, stEingang, '2026-07-16', { source: 'website' });
  // Bereits eingestellt (eine von zwei Stellen besetzt) → verknüpft mit Sandra Ebert (SDR).
  const cSandra = cand({ first_name: 'Sandra', last_name: 'Ebert', email: 'sandra.ebert@example.com', city: 'München', source: 'stellenportal', headline: 'Sales Development Rep', consent_until: '2027-06-01' });
  const aHired = application(cSandra, pAE, stEingestellt, '2026-03-02', { rating: 5, source: 'stellenportal', status: 'eingestellt', decided: '2026-04-01 12:00:00', converted: SDR });
  event(aHired, 'einstellung', 'Eingestellt zum 15.04.2026', null, stEingestellt, '2026-04-01 12:00:00');

  // Werkstudenten-Pipeline
  application(cLaura, pWerk, stTelefon, '2026-07-14', { rating: 4, source: 'hochschule' });

  // ======================= Verwaltung =======================
  // HR-Dokumentverzeichnis: zentrale Vorlagen der Abteilung.
  const hrTpl = (category: string, title: string, description: string) =>
    insert('hr_templates', {
      category, title, description,
      file_id: demoFile(
        `${title.replace(/[^A-Za-zÄÖÜäöüß0-9]+/g, '_')}.txt`,
        `HRMONIC Demo-Vorlage\n${title}\n${description}`,
      ),
    });
  hrTpl('schreiben', 'Willkommensschreiben neue Mitarbeitende', 'Anschreiben zum ersten Arbeitstag mit Agenda und Ansprechpartnern.');
  hrTpl('schreiben', 'Abmahnung (Muster)', 'Arbeitsrechtlich geprüftes Muster — vor Versand mit der Geschäftsführung abstimmen.');
  hrTpl('schreiben', 'Arbeitgeberbescheinigung', 'Standardbescheinigung für Behörden, Banken und Vermieter.');
  hrTpl('vertrag', 'Arbeitsvertrag unbefristet (Vorlage)', 'Basisvertrag Vollzeit/Teilzeit mit Standardklauseln.');
  hrTpl('formular', 'Urlaubsantrag (Formular)', 'Für die Übergangszeit, bis alle Anträge digital gestellt werden.');
  hrTpl('richtlinie', 'Handbuch für Führungskräfte', 'Leitfaden für neue Führungskräfte — wird im Onboarding freigegeben.');

  // On-/Offboarding: Checklisten aus den Standard-Vorlagen des Prozesstyps.
  const processFor = (
    emp: number, kind: string, target: string | null, note: string | null,
    doneCount: number, status: 'laufend' | 'abgeschlossen' = 'laufend',
  ) => {
    const pid = insert('onboarding_processes', {
      employee_id: emp, kind, status, target_date: target, note,
      completed_at: status === 'abgeschlossen' ? '2026-04-24 10:00:00' : null,
    });
    const taskTemplates = db
      .prepare('SELECT title, sort_order FROM onboarding_task_templates WHERE kind = ? AND active = 1 ORDER BY sort_order, id')
      .all(kind) as { title: string; sort_order: number }[];
    taskTemplates.forEach((t, i) => {
      const done = status === 'abgeschlossen' || i < doneCount;
      insert('onboarding_tasks', {
        process_id: pid, title: t.title, sort_order: t.sort_order,
        done: done ? 1 : 0,
        done_at: done ? '2026-07-10 09:00:00' : null,
        done_by_user_id: done ? adminId : null,
      });
    });
    return pid;
  };
  processFor(PRAKT, 'onboarding', '2026-06-01', 'Praktikum Vertrieb, befristet bis 30.11.', 4);
  processFor(SDR, 'onboarding', '2026-04-15', null, 0, 'abgeschlossen');
  processFor(EXIT, 'offboarding', '2026-03-31', 'Arbeitszeugnis noch ausstehend.', 6);
});

const stats = {
  Mitarbeitende: (db.prepare('SELECT COUNT(*) n FROM employees').get() as { n: number }).n,
  Verträge: (db.prepare('SELECT COUNT(*) n FROM contracts').get() as { n: number }).n,
  Abwesenheitsanträge: (db.prepare('SELECT COUNT(*) n FROM absence_requests').get() as { n: number }).n,
  Ziele: (db.prepare('SELECT COUNT(*) n FROM goals').get() as { n: number }).n,
  Gehaltskomponenten: (db.prepare('SELECT COUNT(*) n FROM salary_components').get() as { n: number }).n,
  Ankündigungen: (db.prepare('SELECT COUNT(*) n FROM announcements').get() as { n: number }).n,
  Stellen: (db.prepare('SELECT COUNT(*) n FROM job_postings').get() as { n: number }).n,
  Bewerbungen: (db.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n,
  'HR-Vorlagen': (db.prepare('SELECT COUNT(*) n FROM hr_templates').get() as { n: number }).n,
  'On-/Offboarding': (db.prepare('SELECT COUNT(*) n FROM onboarding_processes').get() as { n: number }).n,
};
console.log('Demo-Daten angelegt:', stats);
console.log(`
Benutzerkonten (NUR Dev — auf Kundensystemen niemals seeden):
  HR-Administration (Desktop-App, Passwort "hrmonic2026"):
    sabine.berger@hrmonic.de · jurgen.wilms@hrmonic.de · melanie.sonntag@hrmonic.de
  admin@hrmonic.de: Zufallspasswort aus <dataDir>/initial-admin-password.txt,
    Wechsel beim ersten Login erzwungen.
  Mitarbeitenden-Portal (Web, Passwort "portal2026"):
    deniz.aydin@hrmonic.de · marta.kowalczyk@hrmonic.de · leonie.vogt@hrmonic.de · samuel.okafor@hrmonic.de`);
closeDb();
