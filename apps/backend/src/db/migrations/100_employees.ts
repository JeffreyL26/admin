import { todayIsoLocal } from '@ohrganize/shared';
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
  {
    // Änderungsanträge zu den eigenen Stammdaten: Mitarbeitende stellen sie im
    // Portal, die Personalabteilung entscheidet. Bewusst NICHT als direktes
    // Schreibrecht auf `employees` gebaut — die Personalakte ist die Grundlage
    // für Abrechnung und Meldungen, jede Änderung braucht eine zweite Person
    // und eine Spur.
    //
    // Zwei Tabellen statt einer: Ein Antrag ist eine Einreichung (eine
    // Begründung, eine Entscheidung), enthält aber mehrere Felder. Mit einer
    // Zeile je Feld ließe sich weder die Einreichung als Ganzes ablehnen noch
    // die Begründung EINMAL speichern.
    //
    // old_value hält den Stand BEI ANTRAGSTELLUNG fest. Es dient der
    // Gegenüberstellung in der Personalabteilung und dem Protokoll — nicht
    // dem Vergleich beim Genehmigen: Hat sich der Wert zwischenzeitlich
    // geändert, wird der beantragte Wert trotzdem gesetzt (die Entscheidung
    // gilt dem gewünschten Zustand), der Unterschied steht im audit_log.
    name: '106_employee_change_requests',
    sql: `
      CREATE TABLE employee_change_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'beantragt'
          CHECK (status IN ('beantragt', 'genehmigt', 'abgelehnt', 'zurueckgezogen')),
        note TEXT,
        requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_employee_change_requests_employee
        ON employee_change_requests(employee_id, status);
      -- Die Personalabteilung filtert die Liste fast immer auf "beantragt";
      -- partiell, damit der Index nicht mit dem Archiv mitwächst.
      CREATE INDEX idx_employee_change_requests_offen
        ON employee_change_requests(created_at) WHERE status = 'beantragt';

      -- field ist ein Spaltenname aus EMPLOYEE_SELF_EDITABLE_FIELDS
      -- (packages/shared/src/employees.ts). Er landet beim Genehmigen in der
      -- SET-Klausel; geprüft wird er ausschließlich gegen diese Liste.
      CREATE TABLE employee_change_request_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL
          REFERENCES employee_change_requests(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        UNIQUE (request_id, field)
      );
    `,
  },
  {
    // Laender-Dimension (Phase 5): Der Standort traegt sein Land, die
    // Privatanschrift ihres. Additiv und variantenunabhaengig, wie jedes
    // Schema: Editionen und Laender entfernen Routen und Seiten, nie
    // Tabellen. Bestandszeilen sind deutsch, deshalb die Vorgabe 'DE';
    // neue Standorte bekommen die Vorgabe aus dem Land der Variante
    // (modules/employees/validation.ts). `bundesland` bleibt und traegt
    // weiterhin den Regionscode des jeweiligen Landes.
    name: '107_locations_country',
    sql: `
      ALTER TABLE locations ADD COLUMN country TEXT NOT NULL DEFAULT 'DE';
      ALTER TABLE employees ADD COLUMN private_country TEXT;
    `,
  },
  {
    // Sichtbarkeit je Dokument: 'portal' zeigt es der zugeordneten Person im
    // Portal, 'hr' hält es HR-intern (Ablage und Protokoll, etwa eine
    // Abmahnung). Bestand bleibt sichtbar, so wie er bisher ausgeliefert wurde.
    name: '108_documents_visibility',
    sql: `
      ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'portal'
        CHECK (visibility IN ('portal','hr'));
    `,
  },
  {
    // Fachrolle entscheidet, ob ihre Mitglieder den firmenweiten
    // Abwesenheitskalender im Portal sehen (Vorgabe: ja). Durchsetzung in
    // core/portalAccess.ts: sichtbar, solange mindestens eine zugewiesene
    // Rolle es erlaubt oder die Person gar keine Rolle hat.
    name: '109_roles_calendar',
    sql: `
      ALTER TABLE roles ADD COLUMN can_view_calendar INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // Dateiverweise (FILE_REFERENCES in core/files.ts): Jede Signatur und
    // jede Aufraeumpruefung fragt alle Verweisspalten nach einer Datei-ID ab,
    // und das DELETE FROM files prueft die Fremdschluessel noch einmal. Ohne
    // Index las jede dieser Abfragen ihre ganze Tabelle (gemessen: Loeschen
    // einer Person 4,2 s bei 39 000 Dokumenten). Teilindex, weil die meisten
    // Zeilen keine Datei tragen; SQLite nutzt ihn fuer col = ?.
    name: '110_file_reference_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_employees_photo_file ON employees(photo_file_id) WHERE photo_file_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_contracts_document_file ON contracts(document_file_id) WHERE document_file_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_documents_file ON documents(file_id) WHERE file_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by_user_id) WHERE uploaded_by_user_id IS NOT NULL;
    `,
  },
  {
    // Vorschaubild des Mitarbeiterfotos: quadratisch, beim Hochladen im
    // Client erzeugt (Kantenlaenge PHOTO_THUMB_EDGE in packages/shared). Listen,
    // Karten und Avatare zeigen es, das Original bleibt unveraendert in
    // photo_file_id. NULL heisst: kein Vorschaubild, die Anzeige nimmt das
    // Original (Bestand von vorher). Verweisspalte wie photo_file_id, also
    // Eintrag in FILE_REFERENCES (core/files.ts) und Teilindex wie in 110.
    name: '111_employee_photo_thumbnails',
    sql: `
      ALTER TABLE employees ADD COLUMN photo_thumb_file_id INTEGER REFERENCES files(id);
      CREATE INDEX IF NOT EXISTS idx_employees_photo_thumb_file
        ON employees(photo_thumb_file_id) WHERE photo_thumb_file_id IS NOT NULL;
    `,
  },
  {
    // Rueckmeldungen aus dem ersten Kundentest: Staatsangehoerigkeit (ISO-2)
    // samt Aufenthaltstitel ausserhalb von EU, EWR und Schweiz, hoechster
    // Abschluss, und je Vertragsversion die Beschaeftigungsart, damit die
    // Historie zeigt, seit wann jemand Vollzeit, Werkstudent usw. ist. Die
    // jeweils neueste Version jeder Person uebernimmt die heutige Art der
    // Stammdaten; aeltere Versionen bleiben ohne Angabe (unbekannt).
    name: '112_employee_master_data',
    sql: `
      ALTER TABLE employees ADD COLUMN nationality TEXT;
      ALTER TABLE employees ADD COLUMN residence_permit TEXT;
      ALTER TABLE employees ADD COLUMN residence_permit_until TEXT;
      ALTER TABLE employees ADD COLUMN highest_degree TEXT;
      ALTER TABLE employees ADD COLUMN degree_field TEXT;
      ALTER TABLE contracts ADD COLUMN employee_type TEXT;
      UPDATE contracts SET employee_type = (
        SELECT e.employee_type FROM employees e WHERE e.id = contracts.employee_id
      )
      WHERE id IN (
        SELECT c.id FROM contracts c
        WHERE NOT EXISTS (
          SELECT 1 FROM contracts n
          WHERE n.employee_id = c.employee_id
            AND (n.valid_from > c.valid_from OR (n.valid_from = c.valid_from AND n.id > c.id))
        )
      );
    `,
  },
  {
    // Arbeitswoche einer Person (shared/workSchedule.ts): feste Wochentage
    // als "1,2,4" (Mo = 1) oder nur die Zahl Tage je Woche (flexibel). Davon
    // haengen der gesetzliche Mindesturlaub (shared/leaveEntitlement.ts) und
    // die Zaehlung von Antraegen ab. Beides NULL heisst "nicht hinterlegt":
    // gezaehlt wird wie bisher Mo bis Fr, und Bestandssalden aendern sich
    // erst, wenn die HR die Woche eintraegt (Vollzeit gilt als fuenf Tage).
    name: '113_work_schedule',
    sql: `
      ALTER TABLE employees ADD COLUMN work_days_per_week REAL;
      ALTER TABLE employees ADD COLUMN work_weekdays TEXT;
    `,
  },
  {
    // Schwerbehinderung (shared/disability.ts): Grad der Behinderung, Gleichstellung
    // (§ 2 Abs. 3 SGB IX), Gueltigkeit des Ausweises, Notiz. Lesen und Schreiben
    // nur mit dem Rechtebereich 'schwerbehinderung' (modules/employees/disability.ts).
    name: '114_employee_disability',
    sql: `
      ALTER TABLE employees ADD COLUMN disability_degree INTEGER;
      ALTER TABLE employees ADD COLUMN disability_equal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE employees ADD COLUMN disability_valid_until TEXT;
      ALTER TABLE employees ADD COLUMN disability_note TEXT;
    `,
  },
  {
    // Leitungsebene (C-Level, core/executiveGate.ts): Konten ohne das Recht
    // 'leitung' sehen die Person nur mit Verzeichnisdaten.
    name: '115_employee_executive',
    sql: `
      ALTER TABLE employees ADD COLUMN executive INTEGER NOT NULL DEFAULT 0 CHECK (executive IN (0, 1));
      CREATE INDEX IF NOT EXISTS idx_employees_executive ON employees(executive) WHERE executive = 1;
    `,
  },
  {
    // Geplante Vertragsversion (Beginn kuenftig): Stunden, Urlaub und Art
    // gehen erst zum Beginn auf employees (contractRoutes.ts#mirrorDueContracts),
    // nicht schon beim Anlegen, sonst rechneten Lohnlauf, FTE und Typregeln
    // vorzeitig damit. 1 = steht noch aus. Bestehende Versionen gelten als
    // gespiegelt (sie wurden es beim Anlegen).
    name: '116_contract_mirror_pending',
    sql: `
      ALTER TABLE contracts ADD COLUMN mirror_pending INTEGER NOT NULL DEFAULT 0 CHECK (mirror_pending IN (0, 1));
      CREATE INDEX IF NOT EXISTS idx_contracts_mirror_pending ON contracts(valid_from) WHERE mirror_pending = 1;
    `,
  },
  {
    // Grund, warum eine faellige geplante Version nicht gespiegelt werden
    // konnte (Typregeln); sie bleibt offen und wird erneut versucht, die Akte
    // zeigt den Grund. Dazu der Altbestand (run): Geplante Versionen, die vor
    // 116 angelegt wurden, waren schon beim Anlegen gespiegelt. Sie gelten
    // jetzt als offen, und die Personalakte bekommt die Werte der heute
    // geltenden Version zurueck, mit updated_at (die optimistische Sperre der
    // Clients sieht die Aenderung) und je Person einem Protokolleintrag ohne
    // Konto mit altem und neuem Wert. Ohne Typregelpruefung: Die Werte waren
    // vor der geplanten Version schon in der Akte, das stellt diesen Stand
    // wieder her. Datum lokal wie todayIso.
    name: '117_contract_mirror_backfill',
    sql: `
      ALTER TABLE contracts ADD COLUMN mirror_error TEXT;
    `,
    run: (db) => {
      const today = todayIsoLocal();
      const planned = db
        .prepare(
          `SELECT id, employee_id FROM contracts
           WHERE valid_from > ? AND (valid_to IS NULL OR valid_to >= ?)`,
        )
        .all([today, today]) as { id: number; employee_id: number }[];
      if (planned.length === 0) return;
      db.prepare('UPDATE contracts SET mirror_pending = 1 WHERE id IN (SELECT value FROM json_each(?))').run(
        JSON.stringify(planned.map((p) => p.id)),
      );
      const inEffect = db.prepare(
        `SELECT weekly_hours, annual_leave_days, employee_type FROM contracts
         WHERE employee_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
         ORDER BY valid_from DESC, id DESC LIMIT 1`,
      );
      const current = db.prepare('SELECT weekly_hours, annual_leave_days, employee_type FROM employees WHERE id = ?');
      const columns = ['weekly_hours', 'annual_leave_days', 'employee_type'] as const;
      for (const employeeId of new Set(planned.map((p) => p.employee_id))) {
        const version = inEffect.get([employeeId, today, today]) as Record<string, unknown> | undefined;
        const person = current.get([employeeId]) as Record<string, unknown> | undefined;
        if (!version || !person) continue;
        const changed = columns.filter((c) => version[c] !== null && version[c] !== person[c]);
        if (changed.length === 0) continue;
        db.prepare(
          `UPDATE employees SET ${changed.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ).run([...changed.map((c) => version[c]), employeeId]);
        db.prepare(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, details)
           VALUES (NULL, 'contract.mirror_backfill', 'employee', ?, ?)`,
        ).run([
          employeeId,
          JSON.stringify({ changed: Object.fromEntries(changed.map((c) => [c, { from: person[c], to: version[c] }])) }),
        ]);
      }
    },
  },
  {
    // Arbeitswoche je Vertragsversion: Der Urlaubsanspruch eines Jahres
    // rechnet je Zeitabschnitt mit Arbeitswoche und Jahresurlaub der jeweils
    // geltenden Version (absences/service.ts, shared leaveEntitlementForPeriods),
    // sonst aenderte ein Wechsel in Teilzeit rueckwirkend den Anspruch frueherer
    // Jahre. Die heute geltende Version uebernimmt Arbeitswoche (und fehlenden
    // Jahresurlaub) aus der Personalakte; aeltere bleiben leer und rechnen wie
    // bisher mit den Werten der Akte.
    name: '118_contract_work_schedule',
    sql: `
      ALTER TABLE contracts ADD COLUMN work_weekdays TEXT;
      ALTER TABLE contracts ADD COLUMN work_days_per_week REAL;
    `,
    run: (db) => {
      const today = todayIsoLocal();
      const versions = db
        .prepare(
          `SELECT c.id, e.work_weekdays, e.work_days_per_week, e.annual_leave_days
           FROM contracts c
           JOIN employees e ON e.id = c.employee_id
           WHERE c.id = (
             SELECT c2.id FROM contracts c2
              WHERE c2.employee_id = c.employee_id AND c2.valid_from <= ?
                AND (c2.valid_to IS NULL OR c2.valid_to >= ?)
              ORDER BY c2.valid_from DESC, c2.id DESC LIMIT 1
           )`,
        )
        .all([today, today]) as {
        id: number;
        work_weekdays: string | null;
        work_days_per_week: number | null;
        annual_leave_days: number | null;
      }[];
      const update = db.prepare(
        `UPDATE contracts SET work_weekdays = ?, work_days_per_week = ?,
           annual_leave_days = COALESCE(annual_leave_days, ?) WHERE id = ?`,
      );
      for (const v of versions) update.run([v.work_weekdays, v.work_days_per_week, v.annual_leave_days, v.id]);
    },
  },
  {
    // Vergangene Zeitraeume ohne Vertragsversion (vor der ersten, zwischen
    // zwei, nach der letzten) mit den Werten, mit denen sie bisher rechneten:
    // freezeEntitlementInputs (absences/service.ts) legt sie an, bevor sich
    // Beschaeftigungsart, Jahresurlaub oder Arbeitswoche der Akte aendern.
    // Ohne sie rechnete diese Zeit mit den HEUTIGEN Werten der Akte, und ein
    // Wechsel in Teilzeit aenderte frueheren Anspruch. Leer angelegt: Bis zur
    // ersten Aenderung rechnet die Zeit ohnehin mit der Akte.
    name: '119_contract_gap_values',
    sql: `
      CREATE TABLE contract_gap_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        valid_from TEXT NOT NULL,
        valid_to TEXT NOT NULL,
        employee_type TEXT,
        annual_leave_days REAL,
        work_weekdays TEXT,
        work_days_per_week REAL
      );
      CREATE INDEX idx_contract_gap_values_employee ON contract_gap_values(employee_id, valid_from);
    `,
  },
];
