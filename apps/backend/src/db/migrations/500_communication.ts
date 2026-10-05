import type { Migration } from './types.js';
import { rebuildTableInKeyOrder } from '../rebuildTable.js';

// Nummernkreis 5xx: Kommunikation & Engagement.
//
// Zielgruppen-Muster (Kontrakt, überall identisch): audience_type
// ('alle'|'abteilung'|'team'|'standort') + audience_id (NULL bei 'alle',
// sonst id der Abteilung/des Teams/des Standorts).
/** Zustand des Neuaufbaus der Umfrageantworten (Migration 504, surveyService.ts). */
export const REBUILD_STATE_TABLE = '_survey_rebuild_state';

export const communicationMigrations: Migration[] = [
  {
    name: '500_communication',
    sql: `
      -- Konfigurierbare Feld-Sichtbarkeit des Mitarbeiterverzeichnisses.
      -- Unsichtbare Felder werden SERVERSEITIG aus der Antwort entfernt.
      CREATE TABLE directory_field_visibility (
        field_key TEXT PRIMARY KEY,
        visible INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO directory_field_visibility (field_key, visible) VALUES
        ('email', 1), ('phone', 1), ('photo', 1), ('job_title', 1),
        ('department', 1), ('team', 1), ('location', 1), ('skills', 1);

      -- Ankündigungen. Status (geplant/aktiv/abgelaufen) wird zur Laufzeit aus
      -- publish_at/expires_at abgeleitet, nicht persistiert.
      CREATE TABLE announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        audience_type TEXT NOT NULL DEFAULT 'alle',
        audience_id INTEGER,                        -- NULL bei audience_type 'alle'
        publish_at TEXT NOT NULL,                   -- ISO YYYY-MM-DD
        expires_at TEXT,                            -- NULL = läuft nicht ab
        requires_ack INTEGER NOT NULL DEFAULT 0,    -- Lesebestätigung erforderlich
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_announcements_publish ON announcements(publish_at);

      CREATE TABLE announcement_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id)
      );

      -- Lesebestätigungen: Datenmodell für den späteren Mitarbeitenden-
      -- Web-Client (POST /api/me/announcements/:id/ack). Der Desktop-Client
      -- zeigt nur die Quote (acks / Empfänger).
      CREATE TABLE announcement_acks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        acked_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (announcement_id, employee_id)
      );

      -- Umfragen mit anonymer Auswertung.
      CREATE TABLE surveys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        audience_type TEXT NOT NULL DEFAULT 'alle',
        audience_id INTEGER,                        -- NULL bei audience_type 'alle'
        date_from TEXT NOT NULL,                    -- ISO YYYY-MM-DD
        date_to TEXT NOT NULL,
        min_participants INTEGER,                   -- NULL -> getSetting('surveyMinParticipants')
        status TEXT NOT NULL DEFAULT 'entwurf',     -- 'entwurf' | 'laufend' | 'beendet'
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE survey_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                         -- 'skala' | 'einfachauswahl' | 'mehrfachauswahl' | 'freitext'
        text TEXT NOT NULL,
        options TEXT,                               -- JSON-Array der Auswahloptionen (nur Auswahl-Fragen)
        scale_max INTEGER,                          -- nur 'skala' (Skala 1..scale_max)
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      -- ANONYMITÄT BY DESIGN: Antworten werden OHNE employee_id gespeichert;
      -- es gibt bewusst keinen Fremdschlüssel auf employees. Die Teilnahme
      -- selbst wird GETRENNT davon in survey_participations markiert (Dedup +
      -- Teilnahmequote), sodass Antworten niemals einer Person zuordenbar sind.
      -- (Zeitstempel und fortlaufende ID entfernt 502_survey_anonymity.)
      CREATE TABLE survey_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
        answers TEXT NOT NULL                       -- JSON [{question_id, value}]
      );

      -- Teilnahme-Marker (wer hat teilgenommen, NICHT was wurde geantwortet).
      CREATE TABLE survey_participations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        participated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (survey_id, employee_id)
      );

      -- Gesprächsprotokolle (1:1, Probezeit, Jahresgespräch, ...).
      CREATE TABLE meeting_protocols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        meeting_date TEXT NOT NULL,                 -- ISO YYYY-MM-DD
        occasion TEXT NOT NULL,                     -- MeetingOccasion aus @ohrganize/shared
        participants TEXT,                          -- Freitext (Namen/Rollen)
        content TEXT,                               -- Gesprächsinhalt
        agreements TEXT,                            -- Vereinbarungen
        follow_up_date TEXT,                        -- Wiedervorlage (NULL = keine)
        visibility TEXT NOT NULL DEFAULT 'nur_hr',  -- MeetingVisibility aus @ohrganize/shared
        created_by_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_meeting_protocols_employee ON meeting_protocols(employee_id);
      CREATE INDEX idx_meeting_protocols_follow_up ON meeting_protocols(follow_up_date);
    `,
  },
  {
    // Kanaele entfernt (Sender ohne Empfaenger, Ueberschneidung mit den
    // Ankuendigungen). Die Tabellen fallen auf bestehenden Installationen
    // hier; Frischinstallationen kennen sie nicht mehr (IF EXISTS deckt beides).
    //
    // Verteiler: von der HR gepflegte Zielgruppe, die Abteilungen (samt
    // Unterabteilungen), Teams, Standorte und einzelne Personen aufnimmt.
    // audience_type 'verteiler' + audience_id zeigt darauf. Ein Verteiler
    // mit Verwendung (Ankuendigung, Umfrage) ist nicht loeschbar (Route).
    name: '501_distribution_lists',
    sql: `
      DROP TABLE IF EXISTS channel_messages;
      DROP TABLE IF EXISTS channels;

      CREATE TABLE distribution_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- member_type 'abteilung' | 'team' | 'standort' | 'mitarbeiter';
      -- member_id die id der jeweiligen Einheit. Kein Fremdschluessel, weil
      -- die Zieltabelle je Zeile wechselt; verwaiste Eintraege ignoriert die
      -- Aufloesung und die Detailansicht zeigt sie ohne Namen.
      CREATE TABLE distribution_list_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL REFERENCES distribution_lists(id) ON DELETE CASCADE,
        member_type TEXT NOT NULL,
        member_id INTEGER NOT NULL,
        UNIQUE (list_id, member_type, member_id)
      );
      CREATE INDEX idx_dlm_member ON distribution_list_members(member_type, member_id);
    `,
  },
  {
    // Anonymitaet der Umfragen auch gegenueber der Datenbank. Teilnahme und
    // Antwort entstehen in derselben Transaktion; mit fortlaufenden IDs und
    // sekundengleichen Zeitstempeln war die n-te Teilnahme die n-te Antwort.
    // Deshalb: keine Zeitstempel mehr, Antworten unter zufaelliger ID (die
    // Zeilen liegen im B-Baum nach ID, die Einfuegereihenfolge ist damit
    // weg), und der Bestand wird hier durchmischt. Geschrieben wird die ID
    // in surveyService.recordParticipation.
    name: '502_survey_anonymity',
    // Die eigenen Daten raeumen secure_delete und der Neuaufbau unten (run)
    // aus der Datei; das VACUUM danach erfasst nur noch aeltere Reste aus der
    // Zeit vor secure_delete (frueher geloeschte Umfragen).
    vacuumAfter: true,
    sql: `
      CREATE TABLE survey_responses_new (
        id INTEGER PRIMARY KEY,
        survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        answers TEXT NOT NULL                       -- JSON [{question_id, value}]
      );
      -- Nur Zeilen, deren Umfrage existiert (hier und unten): Das Umkopieren
      -- prueft die Fremdschluessel (in diesem SQLite-Build und im Dienst an),
      -- und eine verwaiste Zeile, entstanden ohne Fremdschluessel ausserhalb
      -- der Anwendung, braeche sonst den ganzen Migrationslauf ab. Die
      -- Kaskade haette sie ohnehin geloescht; defer_foreign_keys hilft nicht
      -- (das Loeschen einer verwaisten Zeile zaehlt nicht gegen, gemessen).
      INSERT INTO survey_responses_new (id, survey_id, answers)
        SELECT (random() & 9007199254740991) + 1, survey_id, answers FROM survey_responses
        WHERE survey_id IN (SELECT id FROM surveys);
      DROP TABLE survey_responses;
      ALTER TABLE survey_responses_new RENAME TO survey_responses;
      CREATE INDEX idx_survey_responses_survey ON survey_responses(survey_id);

      -- Teilnahmen ohne Zeitstempel. Verwaiste Zeilen zuerst weg (Grund oben
      -- bei survey_responses_new; der Neuaufbau in run fuegt wieder ein und
      -- prueft dabei die Fremdschluessel).
      DELETE FROM survey_participations
        WHERE survey_id NOT IN (SELECT id FROM surveys) OR employee_id NOT IN (SELECT id FROM employees);
      ALTER TABLE survey_participations DROP COLUMN participated_at;
    `,
    // DROP COLUMN schreibt jede Zeile an Ort und Stelle um; dabei verschiebt
    // SQLite Zellen zwischen Seiten und laesst Kopien mit den alten
    // Zeitstempeln in Seitenluecken stehen, die secure_delete nicht erfasst
    // (nachgestellt, encryptionSmoke.ts Abschnitt 7). Der Neuaufbau entfernt
    // die Tabelle mit DROP TABLE (unter secure_delete: jede Seite genullt,
    // auch die Wurzel) und legt sie in Schluesselreihenfolge neu an, samt
    // AUTOINCREMENT-Zaehler. Das VACUUM danach ist dafuer nicht noetig und
    // entfaellt bei grossen Datenbanken.
    run: (db) => rebuildTableInKeyOrder(db, 'survey_participations'),
  },
  {
    // Nachbesserung zu 502, drei Dinge:
    // - Antwort-IDs im selben Bereich wie neue Antworten (1 bis 2^48 - 1,
    //   surveyService.RESPONSE_ID_LIMIT). 502 vergab bis 2^53, und an der
    //   Groesse der ID liessen sich Antworten von vor und nach dem Update
    //   trennen, aus einem einzigen Stand der Datei.
    // - Einfuegen in Schluesselreihenfolge: Ohne ORDER BY landeten die Zeilen
    //   in der alten Reihenfolge der Teilnahmen auf den Seiten, und die
    //   Anonymitaet des Bestands hing allein am VACUUM danach.
    // - Kein Index auf survey_id mehr: Er war die teuerste Stelle beim
    //   Neuschreiben jeder Teilnahme (storeAnonymousResponse), und seine
    //   Seiten verrieten die Reihenfolge eigenstaendig. Die Auswertung liest
    //   die Tabelle ganz; bei Umfragen dieser Groesse sind das Millisekunden.
    name: '503_survey_response_ids',
    vacuumAfter: true,
    sql: `
      CREATE TABLE survey_responses_new (
        id INTEGER PRIMARY KEY,
        survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        answers TEXT NOT NULL                       -- JSON [{question_id, value}]
      );
      INSERT INTO survey_responses_new (id, survey_id, answers)
        SELECT id, survey_id, answers FROM (
          SELECT ((random() & 281474976710655) % 281474976710655) + 1 AS id, survey_id, answers
          FROM survey_responses
        ) ORDER BY id;
      DROP TABLE survey_responses;
      ALTER TABLE survey_responses_new RENAME TO survey_responses;
    `,
  },
  {
    // Zustand des Neuaufbaus von survey_responses (surveyService.ts): eine
    // Zeile je Vermerk statt einer Tabelle je Vermerk, damit keine Teilnahme
    // das Schema aendert. Ohne Zeitstempel.
    name: '504_survey_rebuild_state',
    sql: `
      CREATE TABLE ${REBUILD_STATE_TABLE} (key TEXT PRIMARY KEY) WITHOUT ROWID;
    `,
  },
  {
    // Anhaenge je Ankuendigung (Portal und Dashboard fragen sie bei jedem
    // Abruf ab; ohne Index las das alle Anhaenge) und der Dateiverweis
    // (FILE_REFERENCES in core/files.ts). survey_responses bekommt bewusst
    // KEINEN Index (seit 503, siehe CLAUDE.md "Zielgruppen der
    // Kommunikation").
    name: '505_announcement_attachment_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_announcement_attachments_announcement ON announcement_attachments(announcement_id);
      CREATE INDEX IF NOT EXISTS idx_announcement_attachments_file ON announcement_attachments(file_id);
    `,
  },
];
