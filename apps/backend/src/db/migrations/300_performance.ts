import type { Migration } from './types.js';

// Nummernkreis 3xx: Leistungsverwaltung & Entwicklung.
//
// ⚠️ KONTRAKT (docs/modul-kontrakte.md): Die Tabellen `skills(id, name, …)`,
// `employee_skills(employee_id, skill_id, level 1–5, …)` und
// `goals(id, employee_id, title, progress 0–100, status)` werden von anderen
// Modulen lesend genutzt — Namen/Spalten nicht ändern, nur ergänzen.
export const performanceMigrations: Migration[] = [
  {
    name: '300_performance_core',
    sql: `
      -- ================= Ziele & OKR =================
      CREATE TABLE goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL DEFAULT 'objective'
          CHECK (kind IN ('objective', 'key_result', 'kpi')),
        -- Key Results hängen unter einem Objective; Objective-Fortschritt wird
        -- serverseitig als Mittel seiner Key Results nachgeführt.
        parent_goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
        metric TEXT,
        target_value TEXT,
        current_value TEXT,
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        period_from TEXT,
        period_to TEXT,
        status TEXT NOT NULL DEFAULT 'aktiv'
          CHECK (status IN ('aktiv', 'erreicht', 'verfehlt', 'abgebrochen')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_goals_employee ON goals(employee_id);
      CREATE INDEX idx_goals_parent ON goals(parent_goal_id);

      -- ================= Beurteilungen =================
      CREATE TABLE review_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'jaehrlich'
          CHECK (kind IN ('jaehrlich', 'halbjaehrlich', 'adhoc')),
        period_from TEXT NOT NULL,
        period_to TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'geplant'
          CHECK (status IN ('geplant', 'laufend', 'abgeschlossen')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- criteria: JSON-Array [{key, label, description, scale, category_id}]
      -- (scale = zentrale Skala aus leadership.ts; category_id verweist auf
      -- eine zentrale Bewertungskategorie, Name/Skala werden übernommen)
      CREATE TABLE review_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        criteria TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- scores: JSON-Array [{key, score, comment}]. reviewer_employee_id NULL
      -- bei Selbstbewertung. 360°: mehrere Zeilen gleicher (cycle, employee)
      -- mit kind='feedback360' und verschiedenen reviewer_employee_id.
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id INTEGER NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        template_id INTEGER NOT NULL REFERENCES review_templates(id),
        reviewer_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        -- Endgültige Form (nur selbst/feedback360): 321_reviews_final_schema.
        kind TEXT NOT NULL DEFAULT 'vorgesetzt'
          CHECK (kind IN ('selbst', 'vorgesetzt', 'feedback360')),
        status TEXT NOT NULL DEFAULT 'offen'
          CHECK (status IN ('offen', 'in_bearbeitung', 'abgeschlossen')),
        scores TEXT NOT NULL DEFAULT '[]',
        overall_score REAL,
        summary TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_reviews_cycle_employee ON reviews(cycle_id, employee_id);

      -- ================= Skills =================
      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE employee_skills (
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
        assessed_at TEXT,
        PRIMARY KEY (employee_id, skill_id)
      );

      -- Soll-Profile je Rolle (Lückenanalyse Soll vs. Ist).
      CREATE TABLE role_skill_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_name TEXT NOT NULL,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        required_level INTEGER NOT NULL CHECK (required_level BETWEEN 1 AND 5),
        UNIQUE (role_name, skill_id)
      );

      -- ================= Trainings =================
      CREATE TABLE trainings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        provider TEXT,
        kind TEXT NOT NULL DEFAULT 'intern' CHECK (kind IN ('intern', 'extern')),
        cost_cents INTEGER,
        mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0, 1)),
        -- NULL = einmalig; sonst Wiederholungsintervall der Pflichtschulung.
        repeat_interval_months INTEGER,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE training_registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'angemeldet'
          CHECK (status IN ('angemeldet', 'teilgenommen', 'abgeschlossen', 'storniert')),
        date TEXT,
        completed_at TEXT,
        certificate_file_id INTEGER REFERENCES files(id),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_training_registrations_training ON training_registrations(training_id);
      CREATE INDEX idx_training_registrations_employee ON training_registrations(employee_id);

      -- ================= Feedback-Zyklen =================
      CREATE TABLE feedback_meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'einzelgespraech'
          CHECK (kind IN ('einzelgespraech', 'probezeitgespraech', 'jahresgespraech', 'sonstiges')),
        scheduled_date TEXT NOT NULL,
        held_date TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'geplant'
          CHECK (status IN ('geplant', 'stattgefunden', 'abgesagt')),
        -- NULL = einmalig; sonst legt der Abschluss automatisch den
        -- Folgetermin in n Monaten an.
        recurrence_months INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_feedback_meetings_employee ON feedback_meetings(employee_id);

      CREATE TABLE feedback_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL REFERENCES feedback_meetings(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        due_date TEXT,
        owner_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'erledigt')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // Bögen nutzen die zentralen Skalen (verschiedene Skalen je Kriterium
    // sind möglich), deshalb ist das Gesamtergebnis ein Anteil der Bestnote
    // in Prozent statt eines Mittels roher Zahlen.
    name: '320_reviews_unified_scales',
    sql: `ALTER TABLE reviews ADD COLUMN overall_percent INTEGER;`,
  },
  {
    // Endgültiges Schema der Beurteilungen: Es gibt nur Selbstbewertung und
    // 360°-Feedback; die Bewertung durch die Führungskraft lebt im Bereich
    // Führung (leadership_ratings). Vorhandene Zeilen der Art 'vorgesetzt'
    // sind Bewertungen durch eine andere Person und laufen als 360°-Feedback
    // weiter, overall_score (Rohmittel auf 5 Sternen) wird in Prozent
    // umgerechnet. Bogen-Kriterien mit scale_max erhalten die passende Skala.
    name: '321_reviews_final_schema',
    sql: `
      CREATE TABLE reviews_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id INTEGER NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        template_id INTEGER NOT NULL REFERENCES review_templates(id),
        reviewer_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'selbst' CHECK (kind IN ('selbst', 'feedback360')),
        status TEXT NOT NULL DEFAULT 'offen'
          CHECK (status IN ('offen', 'in_bearbeitung', 'abgeschlossen')),
        scores TEXT NOT NULL DEFAULT '[]',
        overall_percent INTEGER,
        summary TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO reviews_new (id, cycle_id, employee_id, template_id, reviewer_employee_id, kind, status,
                               scores, overall_percent, summary, completed_at, created_at)
      SELECT id, cycle_id, employee_id, template_id, reviewer_employee_id,
             CASE WHEN kind = 'vorgesetzt' THEN 'feedback360' ELSE kind END,
             status, scores,
             COALESCE(overall_percent, CAST(ROUND((overall_score - 1) / 4.0 * 100) AS INTEGER)),
             summary, completed_at, created_at
      FROM reviews;
      DROP TABLE reviews;
      ALTER TABLE reviews_new RENAME TO reviews;
      CREATE INDEX idx_reviews_cycle_employee ON reviews(cycle_id, employee_id);

      UPDATE review_templates SET criteria = (
        SELECT json_group_array(
          json_set(
            json_remove(value, '$.scale_max'),
            '$.scale', CASE json_extract(value, '$.scale_max')
                         WHEN 10 THEN 'points10' WHEN 3 THEN 'ampel' ELSE 'stars5' END,
            '$.category_id', json_extract(value, '$.category_id')
          )
        ) FROM json_each(review_templates.criteria)
      ) WHERE criteria LIKE '%scale_max%';
    `,
  },
  {
    // Entwicklungspläne und Karrierestufen hatten nie eine Oberfläche; die
    // Routen sind entfernt, die Tabellen fallen weg. Frischinstallationen
    // legen sie seit demselben Stand nicht mehr an (300_performance_core),
    // Bestandsdatenbanken räumen hier auf.
    name: '330_drop_development_plans',
    sql: `
      DROP TABLE IF EXISTS development_measures;
      DROP TABLE IF EXISTS development_plans;
      DROP TABLE IF EXISTS employee_levels;
      DROP TABLE IF EXISTS career_levels;
    `,
  },
];
