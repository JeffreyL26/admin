/**
 * Leert vor `npm run seed -- --force` alle Fachdaten und alle Konten bis auf
 * das Startkonto (users.is_start_account). Eigene Datei, damit der Setup-Test (src/test/setupSmoke.ts)
 * genau diese Schritte gegen einen Stand mit Eigentuemer des Assistenten
 * pruefen kann; seed.ts selbst laeuft beim Import los. Ohne eigene
 * Transaktion: seed.ts ruft es in `inTransaction`, der Test in einer, die er
 * zurueckrollt.
 */
import { getDb } from '../db/db.js';

export function resetForReseed(): void {
  const db = getDb();
  // Reihenfolge egal: FKs kaskadieren größtenteils; Rest explizit.
  const tables = [
    // Recruiting (Kinder → Eltern; recruiting_stages bleibt, da per Migration geseedet)
    'interviews', 'application_events', 'applications', 'candidates', 'job_postings',
    'distribution_list_members', 'distribution_lists', 'survey_participations', 'survey_responses',
    'survey_questions', 'surveys', 'announcement_acks', 'announcement_attachments',
    'announcements', 'meeting_protocols', 'certificates', 'freelancer_invoices',
    'freelancer_rates', 'payroll_items', 'payroll_runs', 'bonuses',
    'salary_change_requests', 'salary_components', 'feedback_actions',
    'feedback_meetings', 'training_registrations', 'trainings', 'role_skill_profiles',
    'employee_skills', 'skills', 'reviews', 'review_templates',
    'review_cycles', 'goals', 'sick_notes', 'absence_requests', 'company_closures',
    'documents', 'contracts',
    // Verwaltung (onboarding_task_templates bleibt, da per Migration geseedet)
    'onboarding_tasks', 'onboarding_processes', 'hr_templates',
    // Führung & Bewertung (Kinder → Eltern). Das Protokoll trägt nur einen
    // Trigger gegen UPDATE, DELETE ist erlaubt, sonst ließe sich die Dev-DB
    // nie neu seeden. rating_categories und leadership_settings bleiben, da
    // per Migration angelegt; Zusatzkategorien und verstellte Einstellungen
    // werden direkt unter der Schleife zurückgesetzt.
    'leadership_rating_history', 'leadership_ratings', 'leadership_assignments', 'leadership_leaders',
    // Stammdaten-Änderungsanträge (Kinder → Eltern). Die Kaskade über
    // employees träfe sie zwar ohnehin, aber die Liste ist die
    // Bestandsaufnahme dessen, was der Seed anfasst: Sie soll vollständig
    // sein, damit beim nächsten Modul niemand raten muss.
    'employee_change_request_fields', 'employee_change_requests',
    'employees', 'teams', 'departments', 'locations',
    'audit_log', 'files',
  ];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  // Selbst angelegte Bewertungskategorien entfernen (die fünf Standard-
  // kategorien kommen aus der Migration) und die Einstellungen auf den
  // Auslieferungsstand bringen: Die Demo-Bewertungen in seed.ts setzen
  // quartalsweise Bewertung auf der 5-Sterne-Skala voraus.
  db.prepare(
    `DELETE FROM rating_categories WHERE is_overall = 0 AND name NOT IN
       ('Gesamtbewertung', 'Leistung', 'Verhalten', 'Teamkompetenz', 'Fachliche Kompetenz')`,
  ).run();
  db.prepare(
    `UPDATE leadership_settings
     SET period = 'quartal', uniform_scale = 1, scale = 'stars5', allow_mutual = 1,
         auto_direct_reports = 1, auto_department_head = 1, auto_team_lead = 1,
         updated_at = datetime('now')
     WHERE id = 1`,
  ).run();
  // Eigentuemer des Einrichtungs-Assistenten loesen: user_id verweist auf ein
  // Konto, das Loeschen unten scheiterte sonst am Fremdschluessel. Nur die
  // Verknuepfung, die Bestaetigung der Abwesenheitsarten bleibt stehen; ein
  // neu geseedeter Stand beginnt ohne Eigentuemer.
  db.prepare('UPDATE setup_confirmations SET user_id = NULL').run();
  // Benutzerkonten bis auf das Startkonto entfernen (Kennzeichen
  // is_start_account, dieselbe Regel wie im Einrichtungs-Assistenten, nicht die
  // Adresse): Die Mitarbeitenden-Konten legt seed.ts neu an und verknüpft sie
  // mit den frischen Profilen.
  db.prepare('DELETE FROM users WHERE is_start_account = 0').run();
}
