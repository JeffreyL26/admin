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

      -- criteria: JSON-Array [{key, label, description, scale_max}]
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

      -- ================= Entwicklung & Karriere =================
      CREATE TABLE development_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'aktiv'
          CHECK (status IN ('aktiv', 'abgeschlossen', 'abgebrochen')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE development_measures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        due_date TEXT,
        owner_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'offen'
          CHECK (status IN ('offen', 'laufend', 'erledigt', 'verworfen')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Karrierepfade: je Rolle eine Levelleiter (nächster Schritt = Level+1
      -- derselben role_name).
      CREATE TABLE career_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_name TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level >= 1),
        title TEXT NOT NULL,
        requirements TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (role_name, level)
      );

      CREATE TABLE employee_levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        career_level_id INTEGER NOT NULL REFERENCES career_levels(id) ON DELETE CASCADE,
        since_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_employee_levels_employee ON employee_levels(employee_id);

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
];
