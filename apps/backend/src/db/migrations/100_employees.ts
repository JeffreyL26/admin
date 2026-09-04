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
        employee_type TEXT NOT NULL DEFAULT 'vollzeit',  -- EmployeeType aus @ohrganize/shared
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
  {
    name: '101_contracts_documents',
    sql: `
      -- Vertragshistorie: pro Mitarbeiter beliebig viele Versionen mit
      -- Gültigkeitszeitraum. valid_to IS NULL = aktuell offene Version.
      -- Neue Versionen schließen die vorherige (valid_to = Vortag) — es wird
      -- nie überschrieben, nur die offene Version darf korrigiert werden.
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        contract_type TEXT NOT NULL,          -- unbefristet|befristet|ausbildung|werkvertrag|praktikum
        valid_from TEXT NOT NULL,             -- ISO YYYY-MM-DD
        valid_to TEXT,                        -- NULL = offen
        probation_end TEXT,
        notice_period_weeks INTEGER,
        weekly_hours REAL,
        annual_leave_days REAL,
        fixed_term_reason TEXT,               -- Befristungsgrund (TzBfG)
        document_file_id INTEGER REFERENCES files(id),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_contracts_employee ON contracts(employee_id, valid_from);

      -- Dokumentenverwaltung: employee_id NULL = allgemeines Dokument.
      -- Versionierung über supersedes_id (neue Version zeigt auf die alte).
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id),
        category TEXT NOT NULL DEFAULT 'sonstiges',  -- vertrag|zeugnis|zertifikat|bescheinigung|sonstiges
        title TEXT NOT NULL,
        note TEXT,
        expiry_date TEXT,                     -- ISO YYYY-MM-DD, NULL = läuft nicht ab
        reminder_days INTEGER NOT NULL DEFAULT 30,
        version INTEGER NOT NULL DEFAULT 1,
        supersedes_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_documents_employee ON documents(employee_id);
      CREATE INDEX idx_documents_expiry ON documents(expiry_date);

      -- Volltextsuche über Dokument-Metadaten (Titel, Notiz, Kategorie,
      -- Original-Dateiname, Mitarbeitername). rowid = documents.id.
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        title, note, category, original_name, employee_name
      );

      CREATE TRIGGER trg_documents_fts_insert AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts (rowid, title, note, category, original_name, employee_name)
        VALUES (
          new.id,
          new.title,
          coalesce(new.note, ''),
          new.category,
          coalesce((SELECT original_name FROM files WHERE id = new.file_id), ''),
          coalesce((SELECT first_name || ' ' || last_name FROM employees WHERE id = new.employee_id), '')
        );
      END;

      CREATE TRIGGER trg_documents_fts_update AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE rowid = old.id;
        INSERT INTO documents_fts (rowid, title, note, category, original_name, employee_name)
        VALUES (
          new.id,
          new.title,
          coalesce(new.note, ''),
          new.category,
          coalesce((SELECT original_name FROM files WHERE id = new.file_id), ''),
          coalesce((SELECT first_name || ' ' || last_name FROM employees WHERE id = new.employee_id), '')
        );
      END;

      CREATE TRIGGER trg_documents_fts_delete AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE rowid = old.id;
      END;
    `,
  },
  {
    // Fachrollen liegen bewusst im 1xx-Kreis, obwohl sie fachlich zur
    // Berechtigungssteuerung der Abwesenheiten gehören: Migrationen laufen
    // alphabetisch nach `name`, und '201_absence_type_eligibility' hält einen
    // Fremdschlüssel auf `roles`. Das FK-Ziel muss also vor 201_ existieren.
    name: '102_employee_roles',
    sql: `
      -- Frei anlegbare Fachrollen. Unabhängig von users.role (admin/mitarbeiter)
      -- und von employees.employee_type — beide bleiben unangetastet.
      CREATE TABLE roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE employee_roles (
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (employee_id, role_id)
      );
      CREATE INDEX idx_employee_roles_role ON employee_roles(role_id);

      -- Startbestand: je Beschäftigungsart eine gleichnamige Rolle …
      INSERT INTO roles (name, description) VALUES
        ('Vollzeit',        'Automatisch aus der Beschäftigungsart übernommen'),
        ('Teilzeit',        'Automatisch aus der Beschäftigungsart übernommen'),
        ('Minijob',         'Automatisch aus der Beschäftigungsart übernommen'),
        ('Werkstudent',     'Automatisch aus der Beschäftigungsart übernommen'),
        ('Praktikant',      'Automatisch aus der Beschäftigungsart übernommen'),
        ('Freiberufler',    'Automatisch aus der Beschäftigungsart übernommen'),
        ('Auszubildender',  'Automatisch aus der Beschäftigungsart übernommen');

      -- … und zuweisen. Mapping employee_type -> Rollenname. Ist employees noch
      -- leer (Frischinstallation), liefert das SELECT schlicht keine Zeilen.
      INSERT INTO employee_roles (employee_id, role_id)
      SELECT e.id, r.id FROM employees e JOIN roles r ON r.name = CASE e.employee_type
        WHEN 'vollzeit' THEN 'Vollzeit'  WHEN 'teilzeit' THEN 'Teilzeit'
        WHEN 'minijob' THEN 'Minijob'    WHEN 'werkstudent' THEN 'Werkstudent'
        WHEN 'praktikant' THEN 'Praktikant' WHEN 'freiberufler' THEN 'Freiberufler'
        WHEN 'auszubildender' THEN 'Auszubildender' END
      WHERE r.name IS NOT NULL;
    `,
  },
  {
    name: '103_documents_source',
    sql: `
      -- Herkunft eines Dokuments: von HR abgelegt oder von der Person selbst
      -- über das Portal hochgeladen. NOT NULL braucht in SQLite bei ADD COLUMN
      -- zwingend einen Default — Bestand ist per Definition 'hr'.
      ALTER TABLE documents ADD COLUMN uploaded_by_user_id INTEGER REFERENCES users(id);
      ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'hr'
        CHECK (source IN ('hr','portal'));
    `,
  },
  {
    name: '104_personnel_number',
    // Personalnummer: freiwillig, weil Betriebe sie sehr unterschiedlich
    // handhaben (aus der Lohnbuchhaltung übernommen, eigenes Schema, oder gar
    // nicht). Deshalb TEXT und nicht INTEGER — führende Nullen und Präfixe wie
    // "P-0042" sind in der Praxis üblich und dürfen nicht verlorengehen.
    //
    // Eindeutig, aber nur wo gesetzt: Der partielle UNIQUE-Index lässt beliebig
    // viele NULL-Zeilen zu und verhindert trotzdem doppelte Nummern.
    sql: `
      ALTER TABLE employees ADD COLUMN personnel_number TEXT;
      CREATE UNIQUE INDEX idx_employees_personnel_number
        ON employees(personnel_number) WHERE personnel_number IS NOT NULL;
    `,
  },
  {
    // Die Dokumentenliste wertet supersedes_id doppelt je Ergebniszeile aus
    // (korreliertes EXISTS für is_superseded plus der Default-Filter „nur
    // aktuelle Versionen" in documentRoutes.ts). Ohne Index scannt jedes
    // dieser Subselects die komplette Tabelle — die Liste wächst quadratisch
    // mit dem Archivbestand. Partiell, weil die Subselects auf
    // s.supersedes_id = d.id nie NULL-Zeilen treffen und die meisten
    // Dokumente keine Neuversion haben — der Index bleibt so klein.
    name: '105_documents_supersedes_index',
    sql: `
      CREATE INDEX idx_documents_supersedes
        ON documents(supersedes_id) WHERE supersedes_id IS NOT NULL;
    `,
  },
];
