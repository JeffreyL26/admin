import type { Migration } from './types.js';

// Nummernkreis 7xx: Verwaltung (HR-Vorlagen, On-/Offboarding).
export const adminMigrations: Migration[] = [
  {
    name: '700_admin_core',
    sql: `
      -- HR-Dokumentverzeichnis der Abteilung: Vorlagen für Schreiben, Verträge,
      -- Formulare usw. — bewusst ohne Mitarbeiter-Bezug (dafür gibt es documents).
      CREATE TABLE hr_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id),
        category TEXT NOT NULL
          CHECK (category IN ('schreiben', 'vertrag', 'formular', 'richtlinie', 'checkliste', 'sonstiges')),
        title TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_hr_templates_category ON hr_templates(category);

      -- Aufgaben-Vorlagen, aus denen neue On-/Offboarding-Prozesse ihre
      -- Checkliste kopieren (pro Prozess danach frei erweiterbar).
      CREATE TABLE onboarding_task_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
        title TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );

      -- Laufende und abgeschlossene On-/Offboarding-Prozesse je Mitarbeiter:in.
      CREATE TABLE onboarding_processes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
        status TEXT NOT NULL DEFAULT 'laufend' CHECK (status IN ('laufend', 'abgeschlossen')),
        target_date TEXT,                             -- erster Arbeitstag bzw. Austrittsdatum
        note TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_onboarding_processes_employee ON onboarding_processes(employee_id, kind);
      CREATE INDEX idx_onboarding_processes_status ON onboarding_processes(status);

      -- Abhakbare Checklisten-Aufgaben eines Prozesses.
      CREATE TABLE onboarding_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_id INTEGER NOT NULL REFERENCES onboarding_processes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        done_by_user_id INTEGER REFERENCES users(id),
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_onboarding_tasks_process ON onboarding_tasks(process_id);

      -- Standard-Checklisten (per Verwaltung anpassbar; Reihenfolge = sort_order).
      INSERT INTO onboarding_task_templates (kind, title, sort_order) VALUES
        ('onboarding',  'Arbeitsvertrag unterschrieben ablegen',            10),
        ('onboarding',  'IT-Zugänge und Hardware bestellen',                20),
        ('onboarding',  'Arbeitsplatz vorbereiten',                         30),
        ('onboarding',  'Handbuch für Führungskräfte freigeben',            40),
        ('onboarding',  'Willkommens-E-Mail mit Plan für den ersten Tag',   50),
        ('onboarding',  'Erstgespräch mit Führungskraft planen',            60),
        ('onboarding',  'Probezeit-Feedback terminieren',                   70),
        ('offboarding', 'Kündigung bzw. Aufhebungsvertrag dokumentieren',   10),
        ('offboarding', 'Resturlaub und Überstunden klären',                20),
        ('offboarding', 'Wissensübergabe organisieren',                     30),
        ('offboarding', 'IT-Zugänge zum Austritt deaktivieren',             40),
        ('offboarding', 'Hardware und Schlüssel zurücknehmen',              50),
        ('offboarding', 'Arbeitszeugnis erstellen',                         60),
        ('offboarding', 'Austrittsgespräch führen',                         70);
    `,
  },
];
