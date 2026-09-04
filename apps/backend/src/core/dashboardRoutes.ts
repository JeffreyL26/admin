import type { FastifyInstance } from 'fastify';
import { ADMIN_AREAS, permits, type AdminArea } from '@ohrganize/shared';
import { getDb } from '../db/db.js';
import { permissionsFor } from './permissions.js';
import { todayIso, addDaysIso } from './dates.js';

/**
 * Aggregierte Kennzahlen für das Dashboard — bewusst im Core statt in einem
 * Fachmodul, weil hier modulübergreifend gelesen wird (nur SELECTs).
 *
 * SICHERHEIT — bitte nicht wegoptimieren: `/api/dashboard` steht in
 * ALWAYS_ALLOWED (permissions.ts), der globale Hook prüft für diese Route also
 * KEINEN Bereich. Die Rechteprüfung passiert deshalb hier im Handler, Block für
 * Block. Ohne sie sähe z. B. eine Rolle mit `verguetung: 'kein'` die Zahl der
 * offenen Gehaltsanträge auf ihrer Startseite, und eine Rolle ohne
 * `abwesenheit` namentlich, wer heute krank ist.
 *
 * Zwei Regeln dabei:
 * 1. Gesperrte Blöcke werden gar nicht erst abgefragt (kein Datenfluss, der
 *    versehentlich doch in die Antwort rutschen kann — und weniger Last).
 * 2. Gesperrte Blöcke FEHLEN in der Antwort, statt mit 0/[] gefüllt zu werden.
 *    Eine Null wäre eine Falschaussage ("0 offene Anträge", wo in Wahrheit
 *    welche liegen); ein fehlendes Feld kann der Client als "kein Recht"
 *    erkennen. `allowed_areas` sagt ihm zusätzlich, warum.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async (req) => {
    const db = getDb();
    const today = todayIso();
    const in30 = addDaysIso(today, 30);
    const yearStart = `${today.slice(0, 4)}-01-01`;

    const permissions = permissionsFor(req.user.admin_role_id);
    // Das Dashboard aggregiert ausschließlich — 'lesen' genügt, sonst wäre eine
    // Nur-Lese-Rolle auf ihrer eigenen Startseite blind.
    const may = (area: AdminArea) => permits(permissions[area], 'lesen');

    const mayPersonal = may('personal');
    const mayAbwesenheit = may('abwesenheit');
    const mayLeistung = may('leistung');
    const mayVerguetung = may('verguetung');
    const mayRecruiting = may('recruiting');
    const mayKommunikation = may('kommunikation');

    const count = (sql: string, ...params: unknown[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;

    // --- Personal (Belegschaft, Dokumente, Geburtstage) ---------------------
    let headcount: number | undefined;
    let hiresYtd: number | undefined;
    let expiringDocuments: number | undefined;
    let byDepartment: unknown[] | undefined;
    let upcomingBirthdays: unknown[] | undefined;
    if (mayPersonal) {
      headcount = count(`SELECT COUNT(*) n FROM employees WHERE status = 'aktiv'`);
      hiresYtd = count(
        `SELECT COUNT(*) n FROM employees WHERE status = 'aktiv' AND hire_date >= ?`,
        yearStart,
      );
      expiringDocuments = count(
        `SELECT COUNT(*) n FROM documents
         WHERE expiry_date IS NOT NULL AND expiry_date <= ? `,
        in30,
      );

      byDepartment = db
        .prepare(
          `SELECT COALESCE(d.name, 'Ohne Abteilung') AS department, COUNT(*) AS count
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id
           WHERE e.status = 'aktiv'
           GROUP BY d.name ORDER BY count DESC`,
        )
        .all();

      upcomingBirthdays = db
        .prepare(
          `SELECT id, first_name, last_name, birth_date,
                  -- Klammern nötig: || bindet in SQLite stärker als + (sonst
                  -- ergäbe der ELSE-Zweig eine Zahl statt eines Datums-Strings).
                  CASE WHEN substr(birth_date, 6) >= substr(?, 6)
                       THEN substr(?, 1, 4) || '-' || substr(birth_date, 6)
                       ELSE (CAST(substr(?, 1, 4) AS INTEGER) + 1) || '-' || substr(birth_date, 6)
                  END AS next_birthday
           FROM employees
           WHERE status = 'aktiv' AND birth_date IS NOT NULL
           ORDER BY next_birthday LIMIT 5`,
        )
        .all([today, today, today]);
    }

    // --- Abwesenheit --------------------------------------------------------
    // Namen + Abwesenheitsart sind hier fachlich sensibel (Krankheit), deshalb
    // hängt der ganze Block am Bereich 'abwesenheit'.
    let pendingAbsences: number | undefined;
    let missingSickNotes: number | undefined;
    let absentToday: unknown[] | undefined;
    let absenceDaysByMonth: unknown[] | undefined;
    if (mayAbwesenheit) {
      pendingAbsences = count(
        `SELECT COUNT(*) n FROM absence_requests WHERE status = 'beantragt'`,
      );
      missingSickNotes = count(
        `SELECT COUNT(*) n FROM sick_notes s
         JOIN absence_requests r ON r.id = s.absence_request_id
         WHERE s.certificate_file_id IS NULL AND s.certificate_due_date < ? AND r.status != 'storniert'`,
        today,
      );

      absentToday = db
        .prepare(
          `SELECT e.id, e.first_name, e.last_name, t.name AS type_name, t.color, r.date_to
           FROM absence_requests r
           JOIN employees e ON e.id = r.employee_id
           JOIN absence_types t ON t.id = r.type_id
           WHERE r.status = 'genehmigt' AND r.date_from <= ? AND r.date_to >= ?
           ORDER BY e.last_name`,
        )
        .all([today, today]);

      absenceDaysByMonth = db
        .prepare(
          `SELECT substr(date_from, 1, 7) AS month, ROUND(SUM(days_counted), 1) AS days
           FROM absence_requests
           WHERE status = 'genehmigt' AND date_from >= ? AND date_from <= ?
           GROUP BY substr(date_from, 1, 7) ORDER BY month`,
        )
        .all([yearStart, `${today.slice(0, 4)}-12-31`]);
    }

    // --- Vergütung ----------------------------------------------------------
    let openSalaryRequests: number | undefined;
    if (mayVerguetung) {
      openSalaryRequests = count(
        `SELECT COUNT(*) n FROM salary_change_requests WHERE status = 'beantragt'`,
      );
    }

    // --- Recruiting: offene Stellen, aktive Bewerbungen, Interviews ---------
    let openPositions: number | undefined;
    let activeApplications: number | undefined;
    let upcomingInterviewsCount: number | undefined;
    let upcomingInterviews: unknown[] | undefined;
    if (mayRecruiting) {
      openPositions = count(
        `SELECT COUNT(*) n FROM job_postings WHERE status IN ('veroeffentlicht', 'pausiert')`,
      );
      activeApplications = count(
        `SELECT COUNT(*) n FROM applications WHERE status = 'aktiv'`,
      );
      upcomingInterviewsCount = count(
        `SELECT COUNT(*) n FROM interviews WHERE status = 'geplant' AND substr(scheduled_at, 1, 10) >= ?`,
        today,
      );

      upcomingInterviews = db
        .prepare(
          `SELECT i.id, i.kind, i.scheduled_at, p.title AS posting_title,
                  c.first_name, c.last_name
           FROM interviews i
           JOIN applications a ON a.id = i.application_id
           JOIN candidates c ON c.id = a.candidate_id
           JOIN job_postings p ON p.id = a.posting_id
           WHERE i.status = 'geplant' AND substr(i.scheduled_at, 1, 10) >= ?
           ORDER BY i.scheduled_at LIMIT 5`,
        )
        .all([today]);
    }

    // --- Leistung -----------------------------------------------------------
    let upcomingMeetings: unknown[] | undefined;
    if (mayLeistung) {
      upcomingMeetings = db
        .prepare(
          `SELECT m.id, m.kind, m.scheduled_date, e.first_name, e.last_name
           FROM feedback_meetings m JOIN employees e ON e.id = m.employee_id
           WHERE m.status = 'geplant' AND m.scheduled_date <= ?
           ORDER BY m.scheduled_date LIMIT 8`,
        )
        .all([addDaysIso(today, 21)]);
    }

    // --- Kommunikation ------------------------------------------------------
    let activeAnnouncements: unknown[] | undefined;
    let runningSurveys: unknown[] | undefined;
    if (mayKommunikation) {
      activeAnnouncements = db
        .prepare(
          `SELECT id, title, publish_at, requires_ack FROM announcements
           WHERE publish_at <= ? AND (expires_at IS NULL OR expires_at >= ?)
           ORDER BY publish_at DESC LIMIT 5`,
        )
        .all([today, today]);

      runningSurveys = db
        .prepare(
          `SELECT s.id, s.title, s.date_to,
                  (SELECT COUNT(*) FROM survey_participations p WHERE p.survey_id = s.id) AS participations
           FROM surveys s WHERE s.status = 'laufend' ORDER BY s.date_to LIMIT 5`,
        )
        .all();
    }

    return {
      // Welche Bereiche dieses Konto lesen darf. Der Client blendet danach
      // Kacheln und Widgets aus, statt Lücken als Nullwerte zu deuten.
      allowed_areas: ADMIN_AREAS.filter(may),
      stats: {
        ...(mayPersonal ? { headcount, hiresYtd, expiringDocuments } : {}),
        ...(mayAbwesenheit
          ? { pendingAbsences, missingSickNotes, absentTodayCount: absentToday?.length ?? 0 }
          : {}),
        ...(mayVerguetung ? { openSalaryRequests } : {}),
        ...(mayRecruiting ? { openPositions, activeApplications, upcomingInterviewsCount } : {}),
      },
      ...(mayPersonal ? { byDepartment, upcomingBirthdays } : {}),
      ...(mayAbwesenheit ? { absentToday, absenceDaysByMonth } : {}),
      ...(mayLeistung ? { upcomingMeetings } : {}),
      ...(mayKommunikation ? { activeAnnouncements, runningSurveys } : {}),
      ...(mayRecruiting ? { upcomingInterviews } : {}),
    };
  });
}
