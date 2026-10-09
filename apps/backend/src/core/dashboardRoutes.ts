import type { FastifyInstance } from 'fastify';
import { ADMIN_AREAS, birthdayMonthDays, permits, type AdminArea } from '@ohrganize/shared';
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
 * Block. Ohne sie sähe z. B. eine Rolle ohne `personal` Namen und Geburtstage
 * der Belegschaft und eine Rolle ohne `abwesenheit` die Abwesenheitstage je
 * Monat. Offene Vorgänge (Anträge, Krankmeldungen, Dokumente) liest das
 * Dashboard aus den Endpunkten der Fachseiten, die der globale Hook prüft.
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
    const yearStart = `${today.slice(0, 4)}-01-01`;

    const permissions = permissionsFor(req.user.admin_role_id);
    // Das Dashboard aggregiert ausschließlich — 'lesen' genügt, sonst wäre eine
    // Nur-Lese-Rolle auf ihrer eigenen Startseite blind.
    const may = (area: AdminArea) => permits(permissions[area], 'lesen');

    const mayPersonal = may('personal');
    const mayAbwesenheit = may('abwesenheit');
    const mayLeistung = may('leistung');
    const mayRecruiting = may('recruiting');
    const mayKommunikation = may('kommunikation');

    const count = (sql: string, ...params: unknown[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;

    // Nur, was das Dashboard anzeigt. Offene Antraege, Krankmeldungen,
    // Dokumente und Gehaltsantraege liest es aus den Endpunkten der Fachseiten
    // (dashboardModel.ts), Zaehler dafuer hier waeren Arbeit ohne Empfaenger.

    // --- Personal (Abteilungen, Geburtstage) --------------------------------
    let byDepartment: unknown[] | undefined;
    let upcomingBirthdays: unknown[] | undefined;
    let birthdays_today: unknown[] | undefined;
    if (mayPersonal) {
      byDepartment = db
        .prepare(
          `SELECT d.id AS department_id, COALESCE(d.name, 'Ohne Abteilung') AS department, COUNT(*) AS count
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id
           WHERE e.status = 'aktiv'
           GROUP BY d.id, d.name ORDER BY count DESC`,
        )
        .all();

      upcomingBirthdays = db
        .prepare(
          `SELECT id, first_name, last_name, birth_date,
                  -- Klammern noetig: || bindet in SQLite staerker als + (sonst
                  -- ergaebe der ELSE-Zweig eine Zahl statt eines Datums-Strings).
                  CASE WHEN substr(birth_date, 6) >= substr(?, 6)
                       THEN substr(?, 1, 4) || '-' || substr(birth_date, 6)
                       ELSE (CAST(substr(?, 1, 4) AS INTEGER) + 1) || '-' || substr(birth_date, 6)
                  END AS next_birthday
           FROM employees
           WHERE status = 'aktiv' AND birth_date IS NOT NULL
           ORDER BY next_birthday LIMIT 5`,
        )
        .all([today, today, today]);

      // Alle, die heute Geburtstag haben (Kopf des Dashboards), ohne die
      // Grenze der Vorschau; die Regel (29. Februar) steht in shared/dashboard.ts.
      const monthDays = birthdayMonthDays(today);
      birthdays_today = db
        .prepare(
          `SELECT id, first_name, last_name FROM employees
           WHERE status = 'aktiv' AND birth_date IS NOT NULL
             AND substr(birth_date, 6, 5) IN (${monthDays.map(() => '?').join(',')})
           ORDER BY last_name, first_name`,
        )
        .all(monthDays);
    }

    // --- Abwesenheit: Tage je Monat ------------------------------------------
    let absenceDaysByMonth: unknown[] | undefined;
    if (mayAbwesenheit) {
      // `date_to >= ?` filtert nichts weg (date_to liegt nie vor date_from,
      // die Routen weisen das ab), gibt dem Planer aber die Grenze fuer den
      // Index (status, date_to); ohne sie las er alle genehmigten Antraege
      // seit Inbetriebnahme (Migration 205_absence_query_indexes).
      absenceDaysByMonth = db
        .prepare(
          `SELECT substr(date_from, 1, 7) AS month, ROUND(SUM(days_counted), 1) AS days
           FROM absence_requests
           WHERE status = 'genehmigt' AND date_from >= ? AND date_from <= ? AND date_to >= ?
           GROUP BY substr(date_from, 1, 7) ORDER BY month`,
        )
        .all([yearStart, `${today.slice(0, 4)}-12-31`, yearStart]);
    }

    // --- Recruiting: Interviews ---------------------------------------------
    let upcomingInterviewsCount: number | undefined;
    let upcomingInterviews: unknown[] | undefined;
    if (mayRecruiting) {
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
           WHERE m.status = 'geplant' AND m.scheduled_date >= ? AND m.scheduled_date <= ?
           ORDER BY m.scheduled_date LIMIT 8`,
        )
        .all([today, addDaysIso(today, 21)]);
    }

    // --- Kommunikation: laufende Umfragen -----------------------------------
    let runningSurveys: unknown[] | undefined;
    if (mayKommunikation) {
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
      // Bereiche und Widgets aus, statt Luecken als Nullwerte zu deuten.
      allowed_areas: ADMIN_AREAS.filter(may),
      stats: {
        ...(mayRecruiting ? { upcomingInterviewsCount } : {}),
      },
      // Neue Felder in snake_case (CLAUDE.md); die aelteren behalten ihren Namen.
      ...(mayPersonal ? { byDepartment, upcomingBirthdays, birthdays_today } : {}),
      ...(mayAbwesenheit ? { absenceDaysByMonth } : {}),
      ...(mayLeistung ? { upcomingMeetings } : {}),
      ...(mayKommunikation ? { runningSurveys } : {}),
      ...(mayRecruiting ? { upcomingInterviews } : {}),
    };
  });
}
