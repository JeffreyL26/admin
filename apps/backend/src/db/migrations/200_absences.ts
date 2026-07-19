import type { Migration } from './types.js';

// Nummernkreis 2xx: Abwesenheitsmanagement.
export const absencesMigrations: Migration[] = [
  {
    name: '200_absences_core',
    sql: `
      -- Konfigurierbare Abwesenheitsarten (Urlaub, Krankheit, Sonderformen).
      CREATE TABLE absence_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL CHECK (category IN ('urlaub', 'krankheit', 'sonder')),
        paid INTEGER NOT NULL DEFAULT 1,              -- bezahlt
        affects_balance INTEGER NOT NULL DEFAULT 0,   -- zählt gegen den Urlaubssaldo
        requires_proof INTEGER NOT NULL DEFAULT 0,    -- Nachweis (z. B. AU) erforderlich
        requires_approval INTEGER NOT NULL DEFAULT 1, -- Genehmigungsworkflow
        color TEXT NOT NULL DEFAULT '#0864C6',
        max_days_per_year REAL,                       -- NULL = unbegrenzt
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Abwesenheitsanträge (HR erfasst heute stellvertretend; Self-Service folgt).
      CREATE TABLE absence_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type_id INTEGER NOT NULL REFERENCES absence_types(id),
        date_from TEXT NOT NULL,                      -- ISO YYYY-MM-DD
        date_to TEXT NOT NULL,
        half_day_start INTEGER NOT NULL DEFAULT 0,    -- erster Tag nur halb
        half_day_end INTEGER NOT NULL DEFAULT 0,      -- letzter Tag nur halb
        days_counted REAL NOT NULL,                   -- berechnete Arbeitstage
        status TEXT NOT NULL DEFAULT 'beantragt'
          CHECK (status IN ('beantragt', 'genehmigt', 'abgelehnt', 'storniert')),
        comment TEXT,
        rejection_reason TEXT,
        decided_by_user_id INTEGER REFERENCES users(id),
        decided_at TEXT,
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_absence_requests_employee ON absence_requests(employee_id, date_from);
      CREATE INDEX idx_absence_requests_status ON absence_requests(status);
      CREATE INDEX idx_absence_requests_range ON absence_requests(date_from, date_to);

      -- Krankmeldungen: AU-Pflicht ab dem 3. Kalendertag, Folgebescheinigungen.
      CREATE TABLE sick_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        absence_request_id INTEGER NOT NULL REFERENCES absence_requests(id) ON DELETE CASCADE,
        certificate_file_id INTEGER REFERENCES files(id),
        certificate_due_date TEXT NOT NULL,           -- 3. Kalendertag der Erkrankung
        received_date TEXT,                           -- Eingang der Bescheinigung
        follow_up_of_id INTEGER REFERENCES sick_notes(id) ON DELETE SET NULL,
        child_sick INTEGER NOT NULL DEFAULT 0,        -- Kind-krank (getrennt ausweisbar)
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sick_notes_request ON sick_notes(absence_request_id);

      -- Betriebsruhe (z. B. zwischen den Jahren) — reduziert gezählte Tage.
      CREATE TABLE company_closures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_from TEXT NOT NULL,
        date_to TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Standard-Abwesenheitsarten (per Verwaltung anpassbar).
      INSERT INTO absence_types
        (name, category, paid, affects_balance, requires_proof, requires_approval, color, max_days_per_year) VALUES
        ('Urlaub',                 'urlaub',    1, 1, 0, 1, '#0864C6', NULL),
        ('Krankheit',              'krankheit', 1, 0, 1, 0, '#C4453C', NULL),
        ('Kind krank',             'krankheit', 1, 0, 1, 0, '#E08A2E', NULL),
        ('Elternzeit',             'sonder',    0, 0, 0, 1, '#7A5EA6', NULL),
        ('Mutterschutz',           'sonder',    1, 0, 0, 0, '#C95D9E', NULL),
        ('Sabbatical',             'sonder',    0, 0, 0, 1, '#4A8F7B', NULL),
        ('Unbezahlter Urlaub',     'sonder',    0, 0, 0, 1, '#8A93A6', NULL),
        ('Bildungsurlaub',         'sonder',    1, 0, 1, 1, '#2E8FA3', 5),
        ('Sonderurlaub Umzug',     'sonder',    1, 0, 0, 1, '#5B7FCC', 1),
        ('Sonderurlaub Hochzeit',  'sonder',    1, 0, 0, 1, '#B08E3E', 1),
        ('Sonderurlaub Todesfall', 'sonder',    1, 0, 0, 1, '#5F6B7A', 2);
    `,
  },
];
