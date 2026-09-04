import type { Migration } from './types.js';

// Nummernkreis 6xx: Recruiting & Bewerbermanagement (ATS).
//
// Deckt den Bewerbungslebenszyklus ab, der bislang fehlte: Stellenausschreibung
// → Bewerber:in → mehrstufige Pipeline mit Interviews/Scorecards → Einstellung.
// Die Einstellung erzeugt (dokumentierte Lebenszyklus-Brücke, siehe
// docs/modul-kontrakte.md) einen Mitarbeitenden-Datensatz im Personal-Modul.
export const recruitingMigrations: Migration[] = [
  {
    name: '600_recruiting_core',
    sql: `
      -- ================= Stellenausschreibungen =================
      CREATE TABLE job_postings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        employment_type TEXT NOT NULL DEFAULT 'vollzeit',  -- EmployeeType aus @ohrganize/shared
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        hiring_manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        seats INTEGER NOT NULL DEFAULT 1,               -- Anzahl zu besetzender Stellen
        employment_start TEXT,                          -- gewünschter Eintritt (ISO, optional)
        salary_min_cents INTEGER,
        salary_max_cents INTEGER,
        description TEXT,
        requirements TEXT,
        status TEXT NOT NULL DEFAULT 'entwurf'
          CHECK (status IN ('entwurf','veroeffentlicht','pausiert','besetzt','geschlossen')),
        published_at TEXT,
        closed_at TEXT,
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_job_postings_status ON job_postings(status);

      -- ================= Pipeline-Stufen =================
      -- Konfigurierbar und geordnet. category steuert die Terminalzustände:
      -- 'aktiv' = Kanban-Spalte, 'eingestellt'/'abgelehnt' = Abschluss.
      CREATE TABLE recruiting_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL CHECK (category IN ('aktiv','eingestellt','abgelehnt')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        color TEXT NOT NULL DEFAULT '#0864C6',
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO recruiting_stages (name, category, sort_order, color) VALUES
        ('Eingegangen',      'aktiv',       1, '#8A93A6'),
        ('Sichtung',         'aktiv',       2, '#2E8FA3'),
        ('Telefoninterview', 'aktiv',       3, '#0864C6'),
        ('Interview',        'aktiv',       4, '#5B7FCC'),
        ('Angebot',          'aktiv',       5, '#B08E3E'),
        ('Eingestellt',      'eingestellt', 6, '#3E9B6B'),
        ('Abgelehnt',        'abgelehnt',   7, '#C4453C');

      -- ================= Bewerber:innen =================
      CREATE TABLE candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        city TEXT,
        source TEXT NOT NULL DEFAULT 'sonstiges',   -- CandidateSource aus @ohrganize/shared
        headline TEXT,                              -- aktuelle Position / Kurzprofil
        linkedin_url TEXT,
        photo_file_id INTEGER REFERENCES files(id),
        note TEXT,
        -- DSGVO: Einwilligung zur Speicherung bis (ISO). NULL = unbefristet/unerfasst.
        consent_until TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_candidates_name ON candidates(last_name, first_name);

      -- ================= Bewerbungen =================
      -- Verknüpft Bewerber:in ↔ Stelle. Eine Person kann sich auf mehrere
      -- Stellen bewerben; pro (candidate, posting) höchstens eine Bewerbung.
      CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
        stage_id INTEGER NOT NULL REFERENCES recruiting_stages(id),
        status TEXT NOT NULL DEFAULT 'aktiv'
          CHECK (status IN ('aktiv','eingestellt','abgelehnt','zurueckgezogen')),
        rating INTEGER CHECK (rating BETWEEN 1 AND 5),  -- Gesamtbewertung
        source TEXT,                                    -- Kanal je Bewerbung (überschreibt Kandidat)
        cover_letter TEXT,
        cv_file_id INTEGER REFERENCES files(id),
        salary_expectation_cents INTEGER,
        available_from TEXT,
        applied_at TEXT NOT NULL,                       -- Eingangsdatum (ISO)
        stage_changed_at TEXT NOT NULL,                 -- seit wann in der aktuellen Stufe
        rejection_reason TEXT,
        decided_at TEXT,                                -- Einstellung/Absage
        converted_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (candidate_id, posting_id)
      );
      CREATE INDEX idx_applications_posting ON applications(posting_id, stage_id);
      CREATE INDEX idx_applications_stage ON applications(stage_id);
      CREATE INDEX idx_applications_status ON applications(status);

      -- Verlaufsprotokoll je Bewerbung (Timeline: Eingang, Stufenwechsel, Notizen …).
      CREATE TABLE application_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                             -- ApplicationEventKind
        body TEXT,
        from_stage_id INTEGER REFERENCES recruiting_stages(id),
        to_stage_id INTEGER REFERENCES recruiting_stages(id),
        user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_application_events_app ON application_events(application_id, created_at);

      -- ================= Interviews & Scorecards =================
      CREATE TABLE interviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'telefon'
          CHECK (kind IN ('telefon','video','vor_ort','technik','kennenlernen')),
        scheduled_at TEXT NOT NULL,                     -- ISO 'YYYY-MM-DD HH:MM' oder 'YYYY-MM-DD'
        duration_minutes INTEGER,
        location TEXT,                                  -- Raum oder Videolink
        interviewer_ids TEXT NOT NULL DEFAULT '[]',     -- JSON-Array von employees.id
        status TEXT NOT NULL DEFAULT 'geplant'
          CHECK (status IN ('geplant','stattgefunden','abgesagt')),
        recommendation TEXT CHECK (recommendation IN ('ja','nein','vielleicht')),
        scorecard TEXT NOT NULL DEFAULT '[]',           -- JSON [{criterion, score 1–5}]
        feedback TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_interviews_application ON interviews(application_id);
      CREATE INDEX idx_interviews_scheduled ON interviews(scheduled_at);
    `,
  },
];
