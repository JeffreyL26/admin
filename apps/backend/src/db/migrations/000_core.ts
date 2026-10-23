import type { Migration } from './types.js';

export const coreMigrations: Migration[] = [
  {
    name: '000_core',
    sql: `
      -- HR-Administrator:innen (Login in die Desktop-App). Normale Mitarbeitende
      -- bekommen erst mit dem Web-Client eigene Accounts.
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Generische Key-Value-Einstellungen (JSON-Werte), z. B. Firmendaten,
      -- Verfallsfrist Resturlaub, DATEV-Berater-/Mandantennummer.
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Generischer Datei-Storage. Fachliche Metadaten (Kategorie, Mitarbeiter,
      -- Ablaufdatum, Versionierung) liegen in den Fachmodulen und referenzieren
      -- files.id. Dateien liegen ausschließlich im Backend-Storage.
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        uploaded_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Zentrales Audit-Log ("wer hat wann was warum geändert").
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
    `,
  },
  {
    name: '001_users_employee_link',
    // Mitarbeitenden-Accounts für das Web-Portal: ein users-Eintrag kann auf
    // ein Personalprofil zeigen (role 'mitarbeiter'). Die Spalte bleibt NULL-bar
    // (reine Admin-Accounts haben kein Profil); höchstens ein Account je Profil.
    // Hinweis Reihenfolge: employees entsteht erst in 100_employees — SQLite
    // löst die Referenz erst bei Schreibzugriffen mit Nicht-NULL-Wert auf.
    sql: `
      ALTER TABLE users ADD COLUMN employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX idx_users_employee ON users(employee_id) WHERE employee_id IS NOT NULL;
    `,
  },
  {
    name: '002_admin_roles',
    // Abgestufte Rechte innerhalb der HR-Administration. users.role bleibt
    // bewusst zweiwertig (admin/mitarbeiter) — sie entscheidet WELCHER Client
    // offensteht. Die Admin-Rolle entscheidet, WAS ein Admin darin sehen und
    // ändern darf. Beides zu vermischen würde Portal-Konten Systemrechte geben.
    //
    // Ein Recht je Bereich mit drei Stufen (kein/lesen/bearbeiten). Fehlt für
    // einen Bereich die Zeile, gilt 'kein' — neue Bereiche sind damit
    // automatisch gesperrt statt versehentlich offen (fail closed).
    //
    // Konten OHNE admin_role_id behalten Vollzugriff: So bleibt eine
    // bestehende Installation nach dem Update unverändert benutzbar, und ein
    // frisch angelegtes Konto sperrt sich nicht selbst aus. Die Vergabe einer
    // Rolle ist die bewusste Einschränkung.
    sql: `
      CREATE TABLE admin_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE admin_role_permissions (
        role_id INTEGER NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
        area TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('kein', 'lesen', 'bearbeiten')),
        PRIMARY KEY (role_id, area)
      );

      -- ON DELETE SET NULL: Wird eine Rolle gelöscht, fallen ihre Konten auf
      -- Vollzugriff zurück statt auszusperren. Das ist die sichere Richtung für
      -- die Erreichbarkeit; die Rechtevergabe warnt entsprechend.
      ALTER TABLE users ADD COLUMN admin_role_id INTEGER REFERENCES admin_roles(id) ON DELETE SET NULL;

      -- Startbestand: drei gängige Zuschnitte, alle frei editierbar.
      INSERT INTO admin_roles (name, description) VALUES
        ('Geschäftsführung',   'Vollzugriff inklusive Benutzer- und Rechteverwaltung'),
        ('Head of HR',         'Alle HR-Bereiche inklusive Vergütung; darf Rechte vergeben'),
        ('HR-Sachbearbeitung', 'Tagesgeschäft ohne Vergütung und ohne Rechteverwaltung');

      INSERT INTO admin_role_permissions (role_id, area, level)
      SELECT r.id, a.area, CASE r.name
        WHEN 'Geschäftsführung' THEN 'bearbeiten'
        WHEN 'Head of HR' THEN CASE a.area WHEN 'einstellungen' THEN 'lesen' ELSE 'bearbeiten' END
        ELSE CASE a.area
          WHEN 'verguetung'    THEN 'kein'
          WHEN 'benutzer'      THEN 'kein'
          WHEN 'einstellungen' THEN 'kein'
          WHEN 'verwaltung'    THEN 'lesen'
          ELSE 'bearbeiten'
        END
      END
      FROM admin_roles r
      CROSS JOIN (
        SELECT 'personal' AS area UNION ALL SELECT 'abwesenheit' UNION ALL
        SELECT 'leistung'         UNION ALL SELECT 'verguetung'  UNION ALL
        SELECT 'recruiting'       UNION ALL SELECT 'kommunikation' UNION ALL
        SELECT 'verwaltung'       UNION ALL SELECT 'einstellungen' UNION ALL
        SELECT 'benutzer'
      ) a;
    `,
  },
  {
    name: '003_hardening',
    // Schema-Grundlage für den Serverbetrieb (Backend auf einem Kundenserver,
    // erreichbar für mehrere Arbeitsplätze und das Portal). Reines Schema —
    // die Durchsetzung liegt im globalen Hook (server.ts) und in core/auth.ts.
    //
    // must_change_password: Solange 1, darf das Konto ausschließlich
    // /api/auth/me und /api/auth/password erreichen. Schützt gegen den bisher
    // dokumentierten Standard-Admin, dessen Passwort in README/CLAUDE.md und
    // im gebündelten server.cjs steht: sobald das Backend nicht mehr nur auf
    // 127.0.0.1 hört, genügt sonst ein einziger Login-POST für Vollzugriff
    // (Konten ohne admin_role_id haben Vollzugriff, siehe 002_admin_roles).
    //
    // sessions_valid_from: Unix-Sekunden. Ein Token, dessen `iat` älter ist,
    // gilt nicht mehr — damit entwerten Passwortwechsel und ein späterer
    // "Sitzungen beenden"-Knopf bereits ausgestellte JWTs. NULL = keine
    // Sperre (Normalfall). Bewusst eine Spalte statt einer Sperrliste im
    // Speicher: überlebt Neustarts und kostet keinen zusätzlichen Zustand.
    //
    // Das UPDATE trifft den Standard-Admin bestehender Installationen. Es
    // greift auch dann, wenn dort längst ein eigenes Passwort gesetzt wurde —
    // ein zusätzlicher Wechsel ist zumutbar, ein weiterlaufendes
    // Dokumentationspasswort nicht. Frische Installationen haben zu diesem
    // Zeitpunkt noch keine Zeile (ensureDefaultAdmin läuft nach migrate()).
    //
    // Die Adresse bleibt bewusst auf dem alten Markennamen: Sie beschreibt
    // Bestandsdaten, die vor der Umbenennung angelegt wurden. Frische
    // Installationen bekommen admin@ohrganize.de und brauchen dieses UPDATE
    // ohnehin nicht.
    sql: `
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN sessions_valid_from INTEGER;

      UPDATE users SET must_change_password = 1
        WHERE email = 'admin@hrmonic.de' AND role = 'admin';
    `,
  },
  {
    name: '004_license',
    // Lizenzmodell (core/license.ts). Eine Zeile je Datenbank:
    //
    //   installation_id  Zufalls-ID, an die der Anbieter eine Lizenzdatei
    //                    bindet. Von SQLite erzeugt, weil Migrationen reine
    //                    SQL-Strings sind (kein JS-Hook, siehe migrate.ts).
    //                    Wandert mit der Datei — eine kopierte Datenbank trägt
    //                    dieselbe ID; das ist bekannt und kein Schutz gegen
    //                    Kopien, sondern eine Kennung für Support und Register.
    //   created_at       Anker der 30-tägigen Testphase für Datenbanken, die
    //                    noch nie eine Lizenz gesehen haben. Für Bestands-
    //                    installationen ist das der Moment dieses Updates.
    //   licensed_at      Erstes Einspielen einer gültigen Lizenz. Danach gibt es
    //                    keine Testphase mehr — sonst wäre „Datei löschen“ ein
    //                    Weg zurück in 30 freie Tage.
    //   last_seen_date   Größter Kalendertag, den das Backend je gesehen hat
    //                    (wird nur vorwärts geschrieben). Stolperdraht gegen
    //                    zurückgestellte Uhren; ausdrücklich KEIN Riegel — ein
    //                    Administrator mit Zugriff auf die Datei kann ihn
    //                    zurücksetzen, und Windows stellt Uhren auch von selbst
    //                    um. Er wird protokolliert und angezeigt, mehr nicht.
    //
    // CHECK (id = 1) hält die Tabelle einzeilig; getInstallation() in
    // core/license.ts verlässt sich darauf.
    sql: `
      CREATE TABLE installation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        installation_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        licensed_at TEXT,
        last_seen_date TEXT
      );
      INSERT INTO installation (id, installation_id)
        VALUES (1, lower(hex(randomblob(16))));
    `,
  },
  {
    name: '005_credentials_issuer',
    // Rechte der Person, die das Passwort eines Kontos zuletzt im Klartext
    // ausgegeben hat (Anlegen, Zurücksetzen, Betreiberwerkzeug), als JSON je
    // Bereich, festgehalten im Moment der Ausgabe. Sie kennt das Passwort
    // womöglich noch; mehr Rechte bekommt das Konto deshalb nur, wenn sie sie
    // auch hatte (core/credentials.ts, core/accountRights.ts). NULL heißt
    // Vollzugriff (Konto ohne Admin-Rolle, Betreiber) und gilt auch für alle
    // bestehenden Konten: Wer sie ausgegeben hat, ist nicht mehr feststellbar.
    sql: `
      ALTER TABLE users ADD COLUMN credentials_issuer_rights TEXT;
    `,
  },
  {
    // Verweise auf Konten. Die Kontoloeschung (admin/userRoutes.ts,
    // detachUserReferences) setzt jede dieser Spalten per UPDATE ... WHERE
    // col = ? auf NULL; ohne Index las das jedes Mal das ganze Audit-Log
    // (gemessen: 12 s Stillstand bei 500 000 Zeilen). Teilindex, weil
    // Eintraege des Systems keinen Urheber haben. Der Inhalt des Audit-Logs
    // bleibt unberuehrt, ein Index ist nur ein Suchverzeichnis.
    name: '006_user_reference_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON files(uploaded_by) WHERE uploaded_by IS NOT NULL;
    `,
  },
  {
    // Bestaetigte Schritte des Einrichtungs-Assistenten, die sich nicht aus den
    // Daten ableiten lassen (heute nur "abwesenheit": die Arten sind
    // mitgeliefert, erledigt heisst angeschaut). Gilt fuer die Installation,
    // nicht je Geraet, sonst fragte jeder weitere Arbeitsplatz erneut nach.
    // Bewusst ohne Konto-Spalte: Beim Loeschen eines Kontos ist nichts
    // nachzuziehen.
    name: '007_setup_confirmations',
    sql: `
      CREATE TABLE setup_confirmations (
        step TEXT PRIMARY KEY,
        confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // Wer die Einrichtung uebernommen hat (Zeile "assistent", core/setupRoutes.ts):
    // Karte und Willkommen erscheinen dann nur noch fuer dieses Konto, auf
    // jedem Arbeitsplatz, statt fuer jede neue HR-Person. Die Kontoloeschung
    // (admin/userRoutes.ts, detachUserReferences ueber foreign_key_list) setzt
    // die Spalte auf NULL; dann gilt die Einrichtung wieder als frei. Teilindex
    // nach der Regel fuer Spalten mit REFERENCES users(id).
    name: '008_setup_owner',
    sql: `
      ALTER TABLE setup_confirmations ADD COLUMN user_id INTEGER REFERENCES users(id);
      CREATE INDEX IF NOT EXISTS idx_setup_confirmations_user
        ON setup_confirmations(user_id) WHERE user_id IS NOT NULL;
    `,
  },
  {
    // Startkonto der Installation (ensureDefaultAdmin) als Kennzeichen statt
    // am Namen: Die Adresse admin@ohrganize.de laesst sich nach dem Loeschen
    // neu vergeben, ein solches Konto ist dann ein gewoehnliches. Es haelt den
    // Einrichtungs-Assistenten nur vorlaeufig (core/setupRoutes.ts,
    // holdsProvisionally). Bestehende Installationen: ensureDefaultAdmin legt
    // das Konto als allererstes an, also zaehlt es nur mit der kleinsten ID.
    name: '009_start_account',
    sql: `
      ALTER TABLE users ADD COLUMN is_start_account INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET is_start_account = 1
       WHERE email = 'admin@ohrganize.de' AND id = (SELECT MIN(id) FROM users);
    `,
  },
];
