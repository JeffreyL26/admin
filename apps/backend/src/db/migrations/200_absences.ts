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
  {
    // Setzt '102_employee_roles' voraus (Tabelle roles) — läuft alphabetisch
    // danach, deshalb liegen die Rollen im 1xx-Kreis.
    name: '201_absence_type_eligibility',
    sql: `
      -- Rollen-Allowlist je Art. KEINE Zeile für eine Art ⇒ alle Rollen dürfen.
      CREATE TABLE absence_type_roles (
        type_id INTEGER NOT NULL REFERENCES absence_types(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (type_id, role_id)
      );

      -- Personenregel, schlägt die Rollenregel.
      CREATE TABLE absence_type_employee_rules (
        type_id INTEGER NOT NULL REFERENCES absence_types(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
        PRIMARY KEY (type_id, employee_id)
      );

      -- Sichtbarkeit im Portal-Firmenkalender.
      ALTER TABLE absence_types ADD COLUMN portal_visibility TEXT NOT NULL DEFAULT 'name'
        CHECK (portal_visibility IN ('name','neutral'));

      -- Neue Art "Home Office" (Beispiel des Auftraggebers; keine Saldowirkung).
      INSERT INTO absence_types
        (name, category, paid, affects_balance, requires_proof, requires_approval, color, max_days_per_year)
      VALUES ('Home Office', 'sonder', 1, 0, 0, 1, '#3E8E7E', NULL);
    `,
  },
  {
    name: '202_krankheit_neutral',
    // BITTE NICHT ZURÜCKDREHEN — Gesundheitsdaten, Art. 9 DSGVO.
    //
    // Der Portal-Firmenkalender (modules/me/calendarRoutes.ts) zeigt Namen und
    // Abwesenheitsart firmenweit an und maskiert nur Arten mit
    // portal_visibility = 'neutral'. Die Spalte wurde in 201 mit
    // DEFAULT 'name' angelegt — NACHDEM 200 'Krankheit', 'Kind krank' und
    // 'Mutterschutz' eingefügt hat. Alle drei haben requires_approval = 0,
    // werden also sofort selbst genehmigt und erfüllen damit den
    // Kalenderfilter. Ergebnis im Auslieferungszustand: jede Krankmeldung
    // steht namentlich im Kalender der gesamten Belegschaft.
    //
    // Gesundheitsdaten sind besondere Kategorien personenbezogener Daten
    // (Art. 9 Abs. 1 DSGVO) — die Kolleg:innen dürfen sehen, DASS jemand
    // abwesend ist, nicht WARUM. Mutterschutz gehört fachlich zwar in die
    // Kategorie 'sonder', lässt aber ebenso unmittelbar auf Gesundheits- und
    // Schwangerschaftsdaten schließen und wird deshalb gleich behandelt.
    //
    // Neue Arten fangen die Route-Defaults in modules/absences/routes.ts ab
    // (kategorieabhängiger Default); diese Migration räumt den Bestand auf.
    sql: `
      UPDATE absence_types SET portal_visibility = 'neutral'
        WHERE category = 'krankheit' OR name = 'Mutterschutz';
    `,
  },
  {
    // Urlaub bekommt die Signalfarbe von "genehmigt"/Erfolg (--success, siehe
    // design/tokens.css), damit sie sofort als "positiv/gebucht" lesbar ist.
    // Sabbatical trug bislang fast dieselbe Grün-/Petrol-Nuance wie Home
    // Office (#4A8F7B vs. #3E8E7E) — im Kalenderbalken kaum zu unterscheiden.
    // Es übernimmt deshalb Urlaubs bisheriges Blau: ein Farbtausch statt einer
    // neu erfundenen Farbe, damit die Palette in sich stimmig bleibt.
    name: '203_absence_type_colors',
    sql: `
      UPDATE absence_types SET color = '#178A4C' WHERE name = 'Urlaub';
      UPDATE absence_types SET color = '#0864C6' WHERE name = 'Sabbatical';
    `,
  },
];
