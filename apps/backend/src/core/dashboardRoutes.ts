import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/db.js';
import { todayIso, addDaysIso } from './dates.js';

/**
 * Aggregierte Kennzahlen für das Dashboard — bewusst im Core statt in einem
 * Fachmodul, weil hier modulübergreifend gelesen wird (nur SELECTs).
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async () => {
    const db = getDb();
    const today = todayIso();
    const in30 = addDaysIso(today, 30);
    const yearStart = `${today.slice(0, 4)}-01-01`;

    const count = (sql: string, ...params: unknown[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;

    const headcount = count(`SELECT COUNT(*) n FROM employees WHERE status = 'aktiv'`);
    const hiresYtd = count(
      `SELECT COUNT(*) n FROM employees WHERE status = 'aktiv' AND hire_date >= ?`,
      yearStart,
    );
    const pendingAbsences = count(
      `SELECT COUNT(*) n FROM absence_requests WHERE status = 'beantragt'`,
    );
    const missingSickNotes = count(
      `SELECT COUNT(*) n FROM sick_notes s
       JOIN absence_requests r ON r.id = s.absence_request_id
       WHERE s.certificate_file_id IS NULL AND s.certificate_due_date < ? AND r.status != 'storniert'`,
      today,
    );
    const expiringDocuments = count(
      `SELECT COUNT(*) n FROM documents
       WHERE expiry_date IS NOT NULL AND expiry_date <= ? `,
      in30,
    );
    const openSalaryRequests = count(
      `SELECT COUNT(*) n FROM salary_change_requests WHERE status = 'beantragt'`,
    );
    // Recruiting: offene Stellen, aktive Bewerbungen, anstehende Interviews.
    const openPositions = count(
      `SELECT COUNT(*) n FROM job_postings WHERE status IN ('veroeffentlicht', 'pausiert')`,
    );
    const activeApplications = count(
      `SELECT COUNT(*) n FROM applications WHERE status = 'aktiv'`,
    );
    const upcomingInterviewsCount = count(
      `SELECT COUNT(*) n FROM interviews WHERE status = 'geplant' AND substr(scheduled_at, 1, 10) >= ?`,
      today,
    );

    const absentToday = db
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, t.name AS type_name, t.color, r.date_to
         FROM absence_requests r
         JOIN employees e ON e.id = r.employee_id
         JOIN absence_types t ON t.id = r.type_id
         WHERE r.status = 'genehmigt' AND r.date_from <= ? AND r.date_to >= ?
         ORDER BY e.last_name`,
      )
      .all([today, today]);

    const byDepartment = db
      .prepare(
        `SELECT COALESCE(d.name, 'Ohne Abteilung') AS department, COUNT(*) AS count
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.status = 'aktiv'
         GROUP BY d.name ORDER BY count DESC`,
      )
      .all();

    const absenceDaysByMonth = db
      .prepare(
        `SELECT substr(date_from, 1, 7) AS month, ROUND(SUM(days_counted), 1) AS days
         FROM absence_requests
         WHERE status = 'genehmigt' AND date_from >= ? AND date_from <= ?
         GROUP BY substr(date_from, 1, 7) ORDER BY month`,
      )
      .all([yearStart, `${today.slice(0, 4)}-12-31`]);

    const upcomingMeetings = db
      .prepare(
        `SELECT m.id, m.kind, m.scheduled_date, e.first_name, e.last_name
         FROM feedback_meetings m JOIN employees e ON e.id = m.employee_id
         WHERE m.status = 'geplant' AND m.scheduled_date <= ?
         ORDER BY m.scheduled_date LIMIT 8`,
      )
      .all([addDaysIso(today, 21)]);

    const upcomingBirthdays = db
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

    const activeAnnouncements = db
      .prepare(
        `SELECT id, title, publish_at, requires_ack FROM announcements
         WHERE publish_at <= ? AND (expires_at IS NULL OR expires_at >= ?)
         ORDER BY publish_at DESC LIMIT 5`,
      )
      .all([today, today]);

    const runningSurveys = db
      .prepare(
        `SELECT s.id, s.title, s.date_to,
                (SELECT COUNT(*) FROM survey_participations p WHERE p.survey_id = s.id) AS participations
         FROM surveys s WHERE s.status = 'laufend' ORDER BY s.date_to LIMIT 5`,
      )
      .all();

    const upcomingInterviews = db
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

    return {
      stats: {
        headcount,
        hiresYtd,
        pendingAbsences,
        missingSickNotes,
        expiringDocuments,
        openSalaryRequests,
        openPositions,
        activeApplications,
        upcomingInterviewsCount,
        absentTodayCount: absentToday.length,
      },
      absentToday,
      byDepartment,
      absenceDaysByMonth,
      upcomingMeetings,
      upcomingBirthdays,
      activeAnnouncements,
      runningSurveys,
      upcomingInterviews,
    };
  });
}
