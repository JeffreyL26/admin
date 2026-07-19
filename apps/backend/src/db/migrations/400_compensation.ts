import type { Migration } from './types.js';

// Nummernkreis 4xx: Vergütung.
//
// Geldbeträge sind überall Integer-Cent. Datumswerte ISO YYYY-MM-DD,
// Monate 'YYYY-MM'.
export const compensationMigrations: Migration[] = [
  {
    name: '400_compensation',
    sql: `
      -- Gehaltskomponenten mit lückenloser Historie: je (employee_id, kind) ist
      -- höchstens eine Zeile "offen" (valid_to IS NULL). Eine neue Komponente
      -- gleicher Art schließt die offene Vorgängerzeile (valid_to = Vortag).
      -- Bei kind='stundenlohn' ist amount_cents der Cent-Betrag JE STUNDE.
      CREATE TABLE salary_components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        valid_from TEXT NOT NULL,          -- ISO YYYY-MM-DD
        valid_to TEXT,                     -- NULL = offen
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_salary_components_employee ON salary_components(employee_id, kind, valid_from);

      -- Gehaltsänderungs-Workflow. Genehmigung wendet die Änderung transaktional
      -- auf salary_components an. reason ist Pflicht (Begründungspflicht → Audit).
      CREATE TABLE salary_change_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        new_amount_cents INTEGER NOT NULL,
        effective_date TEXT NOT NULL,      -- ISO YYYY-MM-DD
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'beantragt',  -- beantragt|genehmigt|abgelehnt
        requested_by_user_id INTEGER REFERENCES users(id),
        decided_by_user_id INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_salary_change_requests_employee ON salary_change_requests(employee_id, status);

      -- Boni. goal_id koppelt an goals(id) des Leistungs-Moduls (nur lesend,
      -- bewusst OHNE Fremdschlüssel: die Tabelle gehört einem anderen Modul und
      -- die Kopplung muss auch mit leerer/fehlender Befüllung funktionieren).
      -- Bei goal_id: Auszahlungsbetrag = target_amount_cents × progress/100
      -- (serverseitig berechnet, im Response als payout_cents ausgewiesen).
      CREATE TABLE bonuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                -- zielbonus|provision|einmalzahlung
        title TEXT NOT NULL,
        amount_cents INTEGER,              -- NULL, wenn zielgekoppelt (bis Auszahlung)
        target_amount_cents INTEGER,       -- Zielbetrag bei 100 % Zielerreichung
        goal_id INTEGER,                   -- goals.id (Leistungs-Modul), NULL = fix
        payout_month TEXT NOT NULL,        -- 'YYYY-MM'
        status TEXT NOT NULL DEFAULT 'geplant',  -- geplant|freigegeben|ausgezahlt
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_bonuses_employee ON bonuses(employee_id);
      CREATE INDEX idx_bonuses_payout_month ON bonuses(payout_month, status);

      -- Abrechnungsläufe: je Monat maximal einer (UNIQUE → 409).
      CREATE TABLE payroll_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month TEXT NOT NULL UNIQUE,        -- 'YYYY-MM'
        status TEXT NOT NULL DEFAULT 'offen',  -- offen|geprueft|exportiert
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Bewegungsdaten je Mitarbeiter:in und Lauf — Snapshot zum Zeitpunkt der
      -- Zusammenstellung (Komponenten/Boni/Flags/Warnungen als JSON), damit der
      -- Lauf auch nach späteren Gehaltsänderungen reproduzierbar bleibt.
      CREATE TABLE payroll_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        gross_cents INTEGER NOT NULL,      -- Monatsbrutto aus Komponenten
        bonus_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL,
        components_json TEXT NOT NULL,     -- [{kind, amount_cents, monthly_cents}]
        bonuses_json TEXT NOT NULL,        -- [{id, kind, title, payout_cents}]
        flags_json TEXT NOT NULL,          -- ["neueintritt", ...]
        warnings_json TEXT NOT NULL,       -- ["Fehlende IBAN", ...]
        unpaid_absence_days INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_payroll_items_run ON payroll_items(run_id);

      -- Honorarsätze für Freiberufler:innen (employee_type='freiberufler',
      -- wird serverseitig geprüft). Getrennt von der Angestelltenvergütung.
      CREATE TABLE freelancer_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        rate_cents INTEGER NOT NULL,
        unit TEXT NOT NULL,                -- stunde|tag|pauschale
        valid_from TEXT NOT NULL,          -- ISO YYYY-MM-DD
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_freelancer_rates_employee ON freelancer_rates(employee_id);

      -- Eingangsrechnungen der Freiberufler:innen. Rechnungsnummer je
      -- Mitarbeiter:in eindeutig (UNIQUE → 409).
      CREATE TABLE freelancer_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        invoice_number TEXT NOT NULL,
        invoice_date TEXT NOT NULL,        -- ISO YYYY-MM-DD
        period TEXT,                       -- Leistungszeitraum, Freitext oder 'YYYY-MM'
        amount_cents INTEGER NOT NULL,
        hours REAL,                        -- NULL bei Pauschale
        status TEXT NOT NULL DEFAULT 'offen',  -- offen|geprueft|bezahlt
        paid_date TEXT,                    -- ISO YYYY-MM-DD
        file_id INTEGER REFERENCES files(id),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (employee_id, invoice_number)
      );
      CREATE INDEX idx_freelancer_invoices_employee ON freelancer_invoices(employee_id, status);

      -- Bescheinigungen. Die Erstellung generiert eine HTML-Bescheinigung und
      -- legt sie via storeFile im Backend-Storage ab (file_id).
      CREATE TABLE certificates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                -- lohnsteuerbescheinigung|arbeitgeberbescheinigung|entgeltbescheinigung_108
        period TEXT NOT NULL,              -- Jahr 'YYYY' oder Zeitraum-Freitext
        file_id INTEGER REFERENCES files(id),
        status TEXT NOT NULL DEFAULT 'angefordert',  -- angefordert|erstellt|ausgehaendigt
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_certificates_employee ON certificates(employee_id, kind);
    `,
  },
];
