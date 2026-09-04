/**
 * Smoke-Test des Moduls Kommunikation & Engagement (fastify.inject gegen eine
 * Wegwerf-DB). Aufruf: npx tsx apps/backend/src/modules/communication/smoke.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-comm-smoke-'));
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

// ---------------------------------------------------------------------------
// Testdaten direkt in die Wegwerf-DB (Kerntabellen gehören dem Personal-Modul;
// hier nur Fixtures für den isolierten Modultest).
// ---------------------------------------------------------------------------
const db = getDb();
db.prepare("INSERT INTO locations (id, name, bundesland) VALUES (1, 'München', 'BY')").run();
db.prepare("INSERT INTO departments (id, name) VALUES (1, 'Engineering')").run();
db.prepare("INSERT INTO departments (id, name) VALUES (2, 'Vertrieb')").run();
db.prepare("INSERT INTO teams (id, name, department_id) VALUES (1, 'Platform', 1)").run();
const insertEmp = db.prepare(
  `INSERT INTO employees (id, first_name, last_name, email, phone, job_title, department_id, team_id, location_id, status, iban, birth_date, private_street)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
insertEmp.run(1, 'Anna', 'Adler', 'anna@firma.de', '089-1', 'Entwicklerin', 1, 1, 1, 'aktiv', 'DE00123', '1990-01-01', 'Geheimweg 1');
insertEmp.run(2, 'Bernd', 'Bauer', 'bernd@firma.de', '089-2', 'Vertriebler', 2, null, 1, 'aktiv', 'DE00456', '1985-05-05', 'Geheimweg 2');
insertEmp.run(3, 'Clara', 'Croft', 'clara@firma.de', '089-3', 'Ex-Kollegin', 1, 1, 1, 'ausgeschieden', null, null, null);

// Skill-Tabellen des Leistungs-Moduls (Kontrakt-Schema) — falls dessen
// Migration schon existiert, sind sie bereits da (IF NOT EXISTS deckt beides ab).
db.exec(`
  CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS employee_skills (
    employee_id INTEGER NOT NULL, skill_id INTEGER NOT NULL, level INTEGER NOT NULL
  );
`);
const skillId = Number(db.prepare("INSERT INTO skills (name) VALUES ('TypeScript')").run().lastInsertRowid);
db.prepare('INSERT INTO employee_skills (employee_id, skill_id, level) VALUES (1, ?, 4)').run(skillId);

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
const { auth } = await firstAdminLogin(app, check);

const noAuth = await app.inject({ method: 'GET', url: '/api/communication/directory' });
check('Auth-Pflicht auf Modulrouten', noAuth.statusCode === 401);

// ---------------------------------------------------------------------------
// Verzeichnis
// ---------------------------------------------------------------------------
{
  const res = await app.inject({ method: 'GET', url: '/api/communication/directory', headers: auth });
  const emps = res.json().employees as Record<string, unknown>[];
  check('Verzeichnis: nur aktive Mitarbeitende', res.statusCode === 200 && emps.length === 2, emps);
  const anna = emps.find((e) => e.id === 1)!;
  check('Verzeichnis: dienstliche Felder vorhanden', anna.email === 'anna@firma.de' && anna.department_name === 'Engineering');
  const serialized = JSON.stringify(emps);
  check(
    'Verzeichnis: KEINE privaten Daten in der Antwort',
    !serialized.includes('DE00123') && !serialized.includes('Geheimweg') && !serialized.includes('1990-01-01') &&
      !('iban' in anna) && !('birth_date' in anna) && !('private_street' in anna),
    anna,
  );
  check('Verzeichnis: Skills mit Level', JSON.stringify(anna.skills) === '[{"name":"TypeScript","level":4}]', anna.skills);

  const search = await app.inject({ method: 'GET', url: '/api/communication/directory?search=Bauer', headers: auth });
  check('Verzeichnis: Suche', search.json().employees.length === 1 && search.json().employees[0].id === 2);

  const bySkill = await app.inject({ method: 'GET', url: '/api/communication/directory?skill=Type', headers: auth });
  check('Verzeichnis: Skill-Filter', bySkill.json().employees.length === 1 && bySkill.json().employees[0].id === 1);

  const byDept = await app.inject({ method: 'GET', url: '/api/communication/directory?department_id=2', headers: auth });
  check('Verzeichnis: Abteilungs-Filter', byDept.json().employees.length === 1 && byDept.json().employees[0].id === 2);

  // Feld-Sichtbarkeit: phone ausblenden -> serverseitig entfernt.
  const put = await app.inject({
    method: 'PUT',
    url: '/api/communication/directory/fields',
    headers: auth,
    payload: { fields: [{ field_key: 'phone', visible: false }] },
  });
  check('Sichtbarkeit: PUT ok', put.statusCode === 200);
  const hidden = await app.inject({ method: 'GET', url: '/api/communication/directory', headers: auth });
  const empAfter = (hidden.json().employees as Record<string, unknown>[])[0];
  check('Sichtbarkeit: unsichtbares Feld fehlt serverseitig', !('phone' in empAfter) && 'email' in empAfter, empAfter);
  const badField = await app.inject({
    method: 'PUT',
    url: '/api/communication/directory/fields',
    headers: auth,
    payload: { fields: [{ field_key: 'iban', visible: true }] },
  });
  check('Sichtbarkeit: unbekanntes Feld -> 400', badField.statusCode === 400);
  await app.inject({
    method: 'PUT',
    url: '/api/communication/directory/fields',
    headers: auth,
    payload: { fields: [{ field_key: 'phone', visible: true }] },
  });
}

// ---------------------------------------------------------------------------
// Ankündigungen
// ---------------------------------------------------------------------------
{
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/communication/announcements',
    headers: auth,
    payload: { title: '', body: 'x', audience_type: 'alle', audience_id: null, publish_at: '2026-07-01', expires_at: null, requires_ack: false },
  });
  check('Ankündigung: leerer Titel -> 400', invalid.statusCode === 400 && invalid.json().error.code === 'VALIDATION_ERROR');

  const badAudience = await app.inject({
    method: 'POST',
    url: '/api/communication/announcements',
    headers: auth,
    payload: { title: 'T', body: 'x', audience_type: 'abteilung', audience_id: null, publish_at: '2026-07-01', expires_at: null, requires_ack: false },
  });
  check('Ankündigung: abteilung ohne audience_id -> 400', badAudience.statusCode === 400);

  const created = await app.inject({
    method: 'POST',
    url: '/api/communication/announcements',
    headers: auth,
    payload: {
      title: 'Sommerfest', body: 'Es gibt Grillgut.', audience_type: 'abteilung', audience_id: 1,
      publish_at: '2026-07-01', expires_at: null, requires_ack: true, attachment_file_ids: [],
    },
  });
  check('Ankündigung: anlegen', created.statusCode === 201, created.json());
  const annId = created.json().announcement.id as number;
  check('Ankündigung: Status aktiv + Empfängerzahl', created.json().announcement.status === 'aktiv' && created.json().announcement.recipients === 1, created.json().announcement);

  const planned = await app.inject({
    method: 'POST',
    url: '/api/communication/announcements',
    headers: auth,
    payload: { title: 'Zukunft', body: 'kommt noch', audience_type: 'alle', audience_id: null, publish_at: '2099-01-01', expires_at: null, requires_ack: false },
  });
  check('Ankündigung: Status geplant', planned.json().announcement.status === 'geplant');

  // Lesebestätigung (Modell für Web-Client): direkt eintragen, Quote prüfen.
  db.prepare('INSERT INTO announcement_acks (announcement_id, employee_id) VALUES (?, 1)').run(annId);
  const detail = await app.inject({ method: 'GET', url: `/api/communication/announcements/${annId}`, headers: auth });
  check('Ankündigung: Lesequote (1/1)', detail.json().announcement.ack_count === 1 && detail.json().announcement.recipients === 1);

  const del = await app.inject({ method: 'DELETE', url: `/api/communication/announcements/${planned.json().announcement.id}`, headers: auth });
  check('Ankündigung: löschen', del.statusCode === 204);
}

// ---------------------------------------------------------------------------
// Umfragen (Anonymität + Mindestteilnehmerzahl)
// ---------------------------------------------------------------------------
{
  const badQuestion = await app.inject({
    method: 'POST',
    url: '/api/communication/surveys',
    headers: auth,
    payload: {
      title: 'Kaputt', description: null, audience_type: 'alle', audience_id: null,
      date_from: '2026-07-01', date_to: '2026-07-31', min_participants: null,
      questions: [{ kind: 'einfachauswahl', text: 'Nur eine Option?', options: ['Ja'] }],
    },
  });
  check('Umfrage: Auswahlfrage mit <2 Optionen -> 400', badQuestion.statusCode === 400);

  const created = await app.inject({
    method: 'POST',
    url: '/api/communication/surveys',
    headers: auth,
    payload: {
      title: 'Stimmung', description: 'Quartalsbefragung', audience_type: 'alle', audience_id: null,
      date_from: '2026-07-01', date_to: '2026-07-31', min_participants: 2,
      questions: [
        { kind: 'skala', text: 'Wie zufrieden sind Sie?', scale_max: 5 },
        { kind: 'einfachauswahl', text: 'Homeoffice-Tage?', options: ['0-1', '2-3', '4-5'] },
        { kind: 'freitext', text: 'Was sollen wir verbessern?' },
      ],
    },
  });
  check('Umfrage: anlegen (Entwurf)', created.statusCode === 201 && created.json().survey.status === 'entwurf', created.json());
  const surveyId = created.json().survey.id as number;
  const questions = created.json().survey.questions as { id: number; kind: string }[];

  const earlyResponse = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/responses`,
    headers: auth,
    payload: { employee_id: 1, answers: [{ question_id: questions[0].id, value: 4 }] },
  });
  check('Umfrage: Antwort im Entwurf -> 409', earlyResponse.statusCode === 409);

  const start = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/status`,
    headers: auth,
    payload: { status: 'laufend' },
  });
  check('Umfrage: Entwurf -> laufend', start.statusCode === 200 && start.json().survey.status === 'laufend');

  const invalidTransition = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/status`,
    headers: auth,
    payload: { status: 'laufend' },
  });
  check('Umfrage: laufend -> laufend -> 409', invalidTransition.statusCode === 409);

  const editRunning = await app.inject({
    method: 'PUT',
    url: `/api/communication/surveys/${surveyId}`,
    headers: auth,
    payload: {
      title: 'Umbenannt', description: null, audience_type: 'alle', audience_id: null,
      date_from: '2026-07-01', date_to: '2026-07-31', min_participants: 2,
      questions: [{ kind: 'freitext', text: 'x' }],
    },
  });
  check('Umfrage: laufende Umfrage bearbeiten -> 409', editRunning.statusCode === 409);

  const r1 = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/responses`,
    headers: auth,
    payload: {
      employee_id: 1,
      answers: [
        { question_id: questions[0].id, value: 4 },
        { question_id: questions[1].id, value: '2-3' },
        { question_id: questions[2].id, value: 'Mehr Kaffee.' },
      ],
    },
  });
  check('Umfrage: Antwort 1 erfasst', r1.statusCode === 201, r1.json());

  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/responses`,
    headers: auth,
    payload: { employee_id: 1, answers: [{ question_id: questions[0].id, value: 5 }] },
  });
  check('Umfrage: Doppelteilnahme -> 409 (Konfliktfall)', duplicate.statusCode === 409 && duplicate.json().error.code === 'CONFLICT');

  const badValue = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/responses`,
    headers: auth,
    payload: { employee_id: 2, answers: [{ question_id: questions[0].id, value: 99 }] },
  });
  check('Umfrage: ungültiger Skalenwert -> 400', badValue.statusCode === 400);

  const locked = await app.inject({ method: 'GET', url: `/api/communication/surveys/${surveyId}/results`, headers: auth });
  check(
    'Umfrage: Ergebnisse unter Mindestteilnehmerzahl gesperrt (403 + Code + Restzahl)',
    locked.statusCode === 403 &&
      locked.json().error.code === 'MIN_PARTICIPANTS_NOT_REACHED' &&
      locked.json().error.details.missing === 1,
    locked.json(),
  );

  const r2 = await app.inject({
    method: 'POST',
    url: `/api/communication/surveys/${surveyId}/responses`,
    headers: auth,
    payload: {
      employee_id: 2,
      answers: [
        { question_id: questions[0].id, value: 2 },
        { question_id: questions[1].id, value: '2-3' },
      ],
    },
  });
  check('Umfrage: Antwort 2 erfasst', r2.statusCode === 201 && r2.json().participation.participant_count === 2);

  const results = await app.inject({ method: 'GET', url: `/api/communication/surveys/${surveyId}/results`, headers: auth });
  const resultQs = results.json().results?.questions as {
    kind: string; average?: number; distribution?: { value: number; count: number }[];
    frequencies?: { option: string; count: number }[]; texts?: string[];
  }[];
  check('Umfrage: Ergebnisse ab Mindestteilnehmerzahl', results.statusCode === 200, results.json());
  check('Umfrage: Skala-Aggregation (Ø 3, Verteilung)', resultQs?.[0]?.average === 3 && resultQs[0].distribution?.find((d) => d.value === 4)?.count === 1, resultQs?.[0]);
  check('Umfrage: Auswahl-Häufigkeiten', resultQs?.[1]?.frequencies?.find((f) => f.option === '2-3')?.count === 2, resultQs?.[1]);
  check('Umfrage: Freitextliste', JSON.stringify(resultQs?.[2]?.texts) === '["Mehr Kaffee."]', resultQs?.[2]);

  const anonRows = db.prepare('SELECT * FROM survey_responses WHERE survey_id = ?').all(surveyId) as Record<string, unknown>[];
  check('Umfrage: Antworten OHNE employee_id gespeichert (Anonymität)', anonRows.length === 2 && anonRows.every((r) => !('employee_id' in r)));
}

// ---------------------------------------------------------------------------
// Gespräche
// ---------------------------------------------------------------------------
{
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/communication/meetings',
    headers: auth,
    payload: { employee_id: 1, meeting_date: '2026-07-10', occasion: 'kaffeeklatsch', visibility: 'nur_hr' },
  });
  check('Gespräch: ungültiger Anlass -> 400', invalid.statusCode === 400);

  const created = await app.inject({
    method: 'POST',
    url: '/api/communication/meetings',
    headers: auth,
    payload: {
      employee_id: 1, meeting_date: '2026-07-10', occasion: 'probezeit',
      participants: 'Anna Adler, HR', content: 'Verlauf gut.', agreements: 'Übernahme geplant.',
      follow_up_date: '2026-07-15', visibility: 'hr_vorgesetzte',
    },
  });
  check('Gespräch: anlegen', created.statusCode === 201 && created.json().meeting.first_name === 'Anna', created.json());
  const meetingId = created.json().meeting.id as number;

  const followUps = await app.inject({ method: 'GET', url: '/api/communication/meetings/follow-ups', headers: auth });
  check(
    'Gespräch: fällige Wiedervorlage (15.07. <= heute)',
    followUps.statusCode === 200 && followUps.json().meetings.some((m: { id: number }) => m.id === meetingId),
    followUps.json(),
  );

  const updated = await app.inject({
    method: 'PUT',
    url: `/api/communication/meetings/${meetingId}`,
    headers: auth,
    payload: {
      employee_id: 1, meeting_date: '2026-07-10', occasion: 'probezeit',
      participants: 'Anna Adler, HR', content: 'Verlauf gut.', agreements: 'Übernahme erfolgt.',
      follow_up_date: null, visibility: 'nur_hr',
    },
  });
  check('Gespräch: aktualisieren (Wiedervorlage erledigt)', updated.statusCode === 200 && updated.json().meeting.follow_up_date === null);

  const list = await app.inject({ method: 'GET', url: '/api/communication/meetings?employee_id=1', headers: auth });
  check('Gespräch: Liste mit MA-Filter', list.json().meetings.length === 1);
}

// ---------------------------------------------------------------------------
// Kanäle
// ---------------------------------------------------------------------------
{
  const created = await app.inject({
    method: 'POST',
    url: '/api/communication/channels',
    headers: auth,
    payload: { name: 'Allgemein', topic: 'Firmenweite Infos', audience_type: 'alle', audience_id: null },
  });
  check('Kanal: anlegen', created.statusCode === 201 && created.json().channel.recipients === 2, created.json());
  const channelId = created.json().channel.id as number;

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/communication/channels',
    headers: auth,
    payload: { name: 'Allgemein', topic: null, audience_type: 'alle', audience_id: null },
  });
  check('Kanal: doppelter Name -> 409 (Konfliktfall)', duplicate.statusCode === 409);

  const msg = await app.inject({
    method: 'POST',
    url: `/api/communication/channels/${channelId}/messages`,
    headers: auth,
    payload: { body: 'Willkommen im Kanal!' },
  });
  check('Kanal: Nachricht senden', msg.statusCode === 201 && msg.json().message.sent_by_name === 'HR Administrator', msg.json());

  const history = await app.inject({ method: 'GET', url: `/api/communication/channels/${channelId}/messages`, headers: auth });
  check('Kanal: Verlauf', history.json().messages.length === 1);

  const archive = await app.inject({
    method: 'PUT',
    url: `/api/communication/channels/${channelId}`,
    headers: auth,
    payload: { name: 'Allgemein', topic: 'Firmenweite Infos', audience_type: 'alle', audience_id: null, archived: true },
  });
  check('Kanal: archivieren', archive.statusCode === 200 && archive.json().channel.archived === true);

  const msgArchived = await app.inject({
    method: 'POST',
    url: `/api/communication/channels/${channelId}/messages`,
    headers: auth,
    payload: { body: 'Geht das noch?' },
  });
  check('Kanal: Senden in archivierten Kanal -> 409', msgArchived.statusCode === 409);
}

// Audit-Stichprobe
{
  const auditRows = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity IN ('announcement','survey','meeting_protocol','channel')")
    .get() as { c: number };
  check('Audit: fachliche Änderungen protokolliert', auditRows.c >= 6, auditRows);
}

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
console.log('Alle Kommunikations-Smoke-Checks bestanden.');
