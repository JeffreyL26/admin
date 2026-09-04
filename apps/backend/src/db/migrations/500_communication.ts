import type { Migration } from './types.js';

// Nummernkreis 5xx: Kommunikation & Engagement.
//
// Zielgruppen-Muster (Kontrakt, überall identisch): audience_type
// ('alle'|'abteilung'|'team'|'standort') + audience_id (NULL bei 'alle',
// sonst id der Abteilung/des Teams/des Standorts).
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

      -- Kommunikationskanäle: HR verwaltet und sendet; Konsum kommt später im
      -- Mitarbeitenden-Web-Client.
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        topic TEXT,
        audience_type TEXT NOT NULL DEFAULT 'alle',
        audience_id INTEGER,                        -- NULL bei audience_type 'alle'
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        sent_by_user_id INTEGER REFERENCES users(id),
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_channel_messages_channel ON channel_messages(channel_id, sent_at);
    `,
  },
];
