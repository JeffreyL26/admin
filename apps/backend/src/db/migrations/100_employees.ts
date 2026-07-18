import type { Migration } from './types.js';

// Nummernkreis 1xx: Personalverwaltung & Stammdaten.
//
// ⚠️ KONTRAKT: '100_employees_core' definiert die Kerntabellen, auf die ALLE
// anderen Module Fremdschlüssel halten (employees, departments, teams,
// locations). Bestehende Spalten niemals ändern/entfernen — nur per neuer
// Migration (101_, 102_, …) ergänzen.
export const employeesMigrations: Migration[] = [
  {
    name: '100_employees_core',
    sql: `
      CREATE TABLE locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        street TEXT,
        zip TEXT,
        city TEXT,
        -- Bundesland-Code (BW…TH) — steuert die Feiertagsberechnung der
        -- zugeordneten Mitarbeitenden.
        bundesland TEXT NOT NULL DEFAULT 'BY',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        head_employee_id INTEGER, -- FK auf employees folgt logisch; SQLite prüft erst bei Nutzung
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        lead_employee_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- Person
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT,                -- dienstlich
        phone TEXT,                -- dienstlich
        photo_file_id INTEGER REFERENCES files(id),
        birth_date TEXT,           -- ISO YYYY-MM-DD
        -- Privatadresse
        private_street TEXT,
        private_zip TEXT,
        private_city TEXT,
        private_phone TEXT,
        private_email TEXT,
        -- Bankverbindung
        iban TEXT,
        bic TEXT,
        -- Steuer & Sozialversicherung
        tax_id TEXT,
        tax_class TEXT,            -- 'I'…'VI'
        church_tax TEXT,           -- z. B. 'keine' | 'ev' | 'rk'
        child_allowances REAL DEFAULT 0,  -- Kinderfreibeträge (0.5-Schritte)
        social_security_number TEXT,
        health_insurance TEXT,
        -- Beschäftigung
        employee_type TEXT NOT NULL DEFAULT 'vollzeit',  -- EmployeeType aus @hrmonic/shared
        status TEXT NOT NULL DEFAULT 'aktiv',            -- 'aktiv' | 'ausgeschieden'
        job_title TEXT,
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        hire_date TEXT,            -- Eintrittsdatum
        exit_date TEXT,            -- Austrittsdatum (NULL = unbefristet aktiv)
        weekly_hours REAL,         -- Wochenarbeitszeit
        annual_leave_days REAL,    -- Jahresurlaubsanspruch in Tagen
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_employees_name ON employees(last_name, first_name);
      CREATE INDEX idx_employees_department ON employees(department_id);
      CREATE INDEX idx_employees_status ON employees(status);
    `,
  },
];
