import type { Migration } from './types.js';

// Nummernkreis 3xx (Leistung): Führung & Bewertung — Führungskräfte bewerten
// die ihnen zugeordneten Mitarbeitenden je Zeitraum auf einer zentralen Skala.
//
// Zugriffsmodell in Kurzform (ausführlich: CLAUDE.md → Führung & Bewertung):
// - Der Rechtebereich `fuehrung` (Admin-Rolle) regelt die VERWALTUNG:
//   Freischaltungen, Zuständigkeiten, Skala, Kategorien, Report.
// - Die Führungsfunktion selbst („Mein Team“, /api/leadership/me/*) hängt an
//   der Freischaltung des PERSONALPROFILS (`leadership_leaders`), nicht an der
//   Admin-Rolle: Ein Konto sieht sie genau dann, wenn sein `users.employee_id`
//   dort steht. So kann auch ein Konto ohne jeden HR-Bereich (Rolle
//   „Führungskraft“) sein Team bewerten — und ein HR-Sachbearbeiter ebenso,
//   sobald ihn jemand mit `fuehrung: bearbeiten` freischaltet.
export const leadershipMigrations: Migration[] = [
  {
    name: '310_leadership_ratings',
    sql: `
      -- ================= Unternehmensweite Einstellungen =================
      -- Genau eine Zeile (id = 1). Typisierte Spalten statt JSON in
      -- app_settings: Die CHECK-Bedingungen halten die Datenbank selbst
      -- frei von Werten, die kein Client versteht.
      CREATE TABLE leadership_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        -- Kadenz der Bewertung; ausgeliefert wird quartalsweise.
        period TEXT NOT NULL DEFAULT 'quartal'
          CHECK (period IN ('monat', 'quartal', 'halbjahr', 'jahr')),
        -- 1 = alle Kategorien nutzen dieselbe Skala (Vergleichbarkeit, Standard);
        -- 0 = Kategorien dürfen eine eigene Skala tragen (rating_categories.scale).
        uniform_scale INTEGER NOT NULL DEFAULT 1 CHECK (uniform_scale IN (0, 1)),
        scale TEXT NOT NULL DEFAULT 'stars5'
          CHECK (scale IN ('stars5', 'ampel', 'points10', 'schulnote')),
        -- Gegenseitige Verantwortung (A bewertet B und B bewertet A) zulassen?
        allow_mutual INTEGER NOT NULL DEFAULT 1 CHECK (allow_mutual IN (0, 1)),
        -- Automatische Zuordnung aus der Organisation, je Quelle abschaltbar.
        auto_direct_reports INTEGER NOT NULL DEFAULT 1 CHECK (auto_direct_reports IN (0, 1)),
        auto_department_head INTEGER NOT NULL DEFAULT 1 CHECK (auto_department_head IN (0, 1)),
        auto_team_lead INTEGER NOT NULL DEFAULT 1 CHECK (auto_team_lead IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO leadership_settings (id) VALUES (1);

      -- ================= Bewertungskategorien =================
      -- Zentral und für alle Führungskräfte gleich. Genau eine Kategorie ist
      -- die Gesamtbewertung (partieller Unique-Index) — sie ist die Grundlage
      -- des Reports und kann weder gelöscht noch deaktiviert werden.
      CREATE TABLE rating_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        is_overall INTEGER NOT NULL DEFAULT 0 CHECK (is_overall IN (0, 1)),
        -- Eigene Skala; nur wirksam, wenn leadership_settings.uniform_scale = 0.
        scale TEXT CHECK (scale IS NULL OR scale IN ('stars5', 'ampel', 'points10', 'schulnote')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_rating_categories_overall
        ON rating_categories(is_overall) WHERE is_overall = 1;

      INSERT INTO rating_categories (name, description, sort_order, is_overall) VALUES
        ('Gesamtbewertung',     'Gesamteindruck im Zeitraum — Grundlage des Satisfaction-Reports', 1, 1),
        ('Leistung',            'Arbeitsergebnisse, Zielerreichung, Qualität',                      2, 0),
        ('Verhalten',           'Zuverlässigkeit, Umgang mit Kolleg:innen und Kund:innen',           3, 0),
        ('Teamkompetenz',       'Zusammenarbeit, Kommunikation, Unterstützung im Team',              4, 0),
        ('Fachliche Kompetenz', 'Fachwissen, Methodensicherheit, Weiterentwicklung',                 5, 0);

      -- ================= Freigeschaltete Führungskräfte =================
      -- Schlüssel ist das Personalprofil, nicht das Konto: Personalverantwortung
      -- ist eine Eigenschaft der Person in der Organisation; das Konto ist nur
      -- der Login dazu (users.employee_id). Ein Profil ohne Konto darf bereits
      -- freigeschaltet werden — die Oberfläche weist dann auf das fehlende
      -- Konto hin.
      CREATE TABLE leadership_leaders (
        employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        -- 1 = Zuständigkeit automatisch aus der Organisation ableiten
        --     (manager_id, Abteilungsleitung inkl. Unterabteilungen, Teamleitung).
        auto_scope INTEGER NOT NULL DEFAULT 1 CHECK (auto_scope IN (0, 1)),
        note TEXT,
        granted_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ================= Manuelle Zuständigkeiten =================
      -- Für komplexe oder fluide Strukturen: Mehrere Verantwortliche je Person,
      -- Zuständigkeit für ganze Abteilungen/Teams/Fachrollen, zeitlich
      -- begrenzte Verantwortung (Projekt, Vertretung) und Ausnahmen aus der
      -- automatischen Ableitung. Genau EIN Ziel je Zeile (CHECK); jedes Ziel
      -- hat seinen eigenen Fremdschlüssel, damit ein gelöschtes Ziel die
      -- Zuweisung mitnimmt statt eine Leiche zu hinterlassen.
      CREATE TABLE leadership_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leader_employee_id INTEGER NOT NULL
          REFERENCES leadership_leaders(employee_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('include', 'exclude')),
        target_employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        target_department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
        target_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        target_role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
        valid_from TEXT,   -- ISO YYYY-MM-DD, NULL = ab sofort
        valid_to TEXT,     -- ISO YYYY-MM-DD, NULL = unbefristet
        note TEXT,
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (
          (target_employee_id IS NOT NULL) + (target_department_id IS NOT NULL)
          + (target_team_id IS NOT NULL) + (target_role_id IS NOT NULL) = 1
        )
      );
      CREATE INDEX idx_leadership_assignments_leader ON leadership_assignments(leader_employee_id);
      CREATE INDEX idx_leadership_assignments_employee
        ON leadership_assignments(target_employee_id) WHERE target_employee_id IS NOT NULL;

      -- ================= Bewertungen =================
      -- Eine Zeile je (Führungskraft, Person, Kategorie, Zeitraum). Speichern
      -- ist ein Upsert: Die Zeile trägt immer den aktuellen Stand; jede Version
      -- landet zusätzlich unveränderlich im Protokoll darunter. Skala und
      -- Rohwert werden JE BEWERTUNG gespeichert, damit ein späterer
      -- Skalenwechsel alte Bewertungen nicht umdeutet.
      CREATE TABLE leadership_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leader_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES rating_categories(id),
        period_kind TEXT NOT NULL CHECK (period_kind IN ('monat', 'quartal', 'halbjahr', 'jahr')),
        period_key TEXT NOT NULL,
        scale TEXT NOT NULL CHECK (scale IN ('stars5', 'ampel', 'points10', 'schulnote')),
        score INTEGER NOT NULL CHECK (score >= 1),
        comment TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by_user_id INTEGER REFERENCES users(id),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (leader_employee_id, employee_id, category_id, period_key)
      );
      CREATE INDEX idx_leadership_ratings_employee ON leadership_ratings(employee_id, period_key);
      CREATE INDEX idx_leadership_ratings_period ON leadership_ratings(period_key, category_id);

      -- ================= Protokoll (unveränderlich) =================
      -- Jede Speicherung erzeugt eine Zeile — auch Korrekturen. Die Fachspalten
      -- sind bewusst denormalisiert, damit das Protokoll ohne Joins lesbar
      -- bleibt. Der Trigger unten verbietet jede nachträgliche Änderung.
      -- Es gibt KEINE Route, die hier löscht; die einzige Löschung ist die
      -- Kaskade beim Entfernen eines Personalprofils (DSGVO-Löschung), dann
      -- verschwindet das Protokoll über die Person mit ihr.
      CREATE TABLE leadership_rating_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rating_id INTEGER NOT NULL REFERENCES leadership_ratings(id) ON DELETE CASCADE,
        leader_employee_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        period_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        change_kind TEXT NOT NULL CHECK (change_kind IN ('erstellt', 'geaendert')),
        scale TEXT NOT NULL,
        score INTEGER NOT NULL,
        comment TEXT NOT NULL,
        previous_score INTEGER,
        previous_comment TEXT,
        changed_by_user_id INTEGER REFERENCES users(id),
        changed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_leadership_rating_history_rating
        ON leadership_rating_history(rating_id, version);
      CREATE INDEX idx_leadership_rating_history_employee
        ON leadership_rating_history(employee_id, changed_at);

      CREATE TRIGGER trg_leadership_rating_history_immutable
        BEFORE UPDATE ON leadership_rating_history
      BEGIN
        SELECT RAISE(ABORT, 'Das Bewertungsprotokoll ist unveränderlich');
      END;

      -- ================= Rechtebereich 'fuehrung' =================
      -- Bestehende Admin-Rollen bekommen die Stufe ihres Bereichs 'benutzer':
      -- Wer Konten und Rechte vergeben darf, darf auch Führungskräfte
      -- freischalten und den Report sehen (Geschäftsführung, Head of HR);
      -- die HR-Sachbearbeitung bleibt außen vor, bis jemand sie hebt. Rollen
      -- ohne 'benutzer'-Zeile bekommen nichts — fail closed wie überall.
      INSERT OR IGNORE INTO admin_role_permissions (role_id, area, level)
        SELECT role_id, 'fuehrung', level FROM admin_role_permissions WHERE area = 'benutzer';

      -- Rolle „Führungskraft“: keine HR-Bereiche, nur Dashboard und — nach
      -- Freischaltung des Profils — „Mein Team“. Nur anlegen, wenn der Name
      -- noch frei ist; bestehende Rechte einer gleichnamigen Kundenrolle
      -- bleiben durch OR IGNORE unangetastet.
      INSERT INTO admin_roles (name, description)
        SELECT 'Führungskraft',
               'Nur die Führungsfunktion („Mein Team“) — keine HR-Bereiche. Freischaltung unter Führung → Einrichtung.'
        WHERE NOT EXISTS (SELECT 1 FROM admin_roles WHERE name = 'Führungskraft');
      INSERT OR IGNORE INTO admin_role_permissions (role_id, area, level)
        SELECT r.id, a.area, 'kein'
        FROM admin_roles r
        CROSS JOIN (
          SELECT 'personal' AS area UNION ALL SELECT 'abwesenheit' UNION ALL
          SELECT 'leistung'         UNION ALL SELECT 'verguetung'  UNION ALL
          SELECT 'recruiting'       UNION ALL SELECT 'kommunikation' UNION ALL
          SELECT 'verwaltung'       UNION ALL SELECT 'einstellungen' UNION ALL
          SELECT 'benutzer'         UNION ALL SELECT 'fuehrung'
        ) a
        WHERE r.name = 'Führungskraft';
    `,
  },
];
