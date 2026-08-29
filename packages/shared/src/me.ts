// Typen des Mitarbeitenden-Self-Service (Web-Portal, /api/me/*).

import type {
  BonusKind,
  BonusStatus,
  FreelancerInvoiceStatus,
  FreelancerRateUnit,
  SalaryComponentKind,
} from './compensation.js';
import type { DocumentCategory, DocumentSource } from './employees.js';

/** Rollen von Benutzerkonten: HR-Administration (Desktop) bzw. Web-Portal. */
export type UserRole = 'admin' | 'mitarbeiter';

/** Angemeldeter Benutzer (JWT-Payload und /api/auth/me). */
export interface AuthUserDto {
  id: number;
  email: string;
  name: string;
  role: string;
  /** Verknüpftes Personalprofil (nur Mitarbeitenden-Accounts, sonst null). */
  employee_id: number | null;
  /**
   * 0/1 (SQLite kennt kein Boolean). Solange 1, lässt das Backend nur
   * `/api/auth/me` und `/api/auth/password` durch und beantwortet alles
   * andere mit 403 `PASSWORD_CHANGE_REQUIRED`. Beide Clients müssen darauf
   * mit dem Passwort-setzen-Schirm reagieren, sonst läuft der Erstlogin
   * eines neu angelegten oder zurückgesetzten Kontos ins Leere.
   */
  must_change_password?: number;
}

/** Eigene Stammdaten (GET /api/me/profile) — bewusst ohne Bank-/Steuerdaten. */
export interface MeProfile {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  birth_date: string | null;
  private_street: string | null;
  private_zip: string | null;
  private_city: string | null;
  private_phone: string | null;
  private_email: string | null;
  employee_type: string;
  job_title: string | null;
  hire_date: string | null;
  weekly_hours: number | null;
  annual_leave_days: number | null;
  health_insurance: string | null;
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
  manager_name: string | null;
}

// ---------------------------------------------------------------------------
// Vergütung (GET /api/me/salary, /salary/history, /bonuses, /freelancer)
// ---------------------------------------------------------------------------

/**
 * Eine eigene Gehaltskomponente. Bewusst OHNE `note`: die Notiz einer
 * Komponente enthält HR-interne Begründungen (Verhandlungsstand, Vermerke)
 * und wird im Self-Service nie ausgeliefert.
 */
export interface MeSalaryComponent {
  id: number;
  kind: SalaryComponentKind;
  /** Bei `stundenlohn` Cent je Stunde, sonst Monatsbetrag in Cent. */
  amount_cents: number;
  /** Auf den Monat gerechneter Wert; Abzugsarten gehen negativ ein. */
  monthly_cents: number;
  valid_from: string; // ISO YYYY-MM-DD
  valid_to: string | null;
}

export interface MeSalary {
  weekly_hours: number | null;
  monthly_gross_cents: number;
  /** Nur die heute gültigen Komponenten; die Historie liegt unter /salary/history. */
  components: MeSalaryComponent[];
}

/** Eigener Bonus — ohne `note` (HR-intern), aber mit Status und Auszahlungsbetrag. */
export interface MeBonus {
  id: number;
  kind: BonusKind;
  title: string;
  /** Fixbetrag; bei zielgekoppelten Boni bis zur Auszahlung null. */
  amount_cents: number | null;
  target_amount_cents: number | null;
  /** Errechneter Auszahlungsbetrag (bei Zielboni aus der Zielerreichung). */
  payout_cents: number;
  /** true bei zielgekoppelten Boni — der Betrag ist nur voraussichtlich. */
  is_projected: boolean;
  payout_month: string; // 'YYYY-MM'
  status: BonusStatus;
  created_at: string;
}

/**
 * Honorare der Freiberufler:innen. Für alle anderen Beschäftigungsarten
 * liefert die Route beide Listen leer. Rechnungsnotizen bleiben HR-intern.
 */
export interface MeFreelancer {
  rates: {
    id: number;
    description: string;
    rate_cents: number;
    unit: FreelancerRateUnit;
    valid_from: string;
  }[];
  invoices: {
    id: number;
    invoice_number: string;
    invoice_date: string;
    period: string | null;
    amount_cents: number;
    hours: number | null;
    status: FreelancerInvoiceStatus;
    paid_date: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Firmenkalender (GET /api/me/calendar)
// ---------------------------------------------------------------------------

/**
 * Abwesenheit im Firmenkalender. Ein Status-Feld gibt es bewusst nicht:
 * das Portal zeigt ausschließlich genehmigte Abwesenheiten. Ist die Art auf
 * `portal_visibility = 'neutral'` gestellt, liefert das Backend `type_id: null`
 * und den maskierten Namen „Abwesend“.
 */
export interface MeCalendarEntry {
  request_id: number;
  type_id: number | null;
  type_name: string;
  color: string;
  date_from: string; // ISO YYYY-MM-DD
  date_to: string;
  half_day_start: number; // SQLite-Bool (0/1)
  half_day_end: number;
}

export interface MeCalendarEmployee {
  id: number;
  first_name: string;
  last_name: string;
  department_id: number | null;
  team_id: number | null;
  /** Für die Feiertagsauflösung des Kalenders. */
  bundesland: string;
  absences: MeCalendarEntry[];
}

// ---------------------------------------------------------------------------
// Dokumente (GET/POST /api/me/documents)
// ---------------------------------------------------------------------------

/**
 * Eigenes Dokument — inklusive der von der HR abgelegten. Ohne
 * `download_url`: die signierte URL holt der Client einzeln über
 * POST /api/me/documents/:id/download.
 */
export interface MeDocument {
  id: number;
  category: DocumentCategory;
  title: string;
  note: string | null;
  expiry_date: string | null;
  version: number;
  /** `hr` = von der Personalabteilung abgelegt, `portal` = selbst hochgeladen. */
  source: DocumentSource;
  created_at: string;
  // Angereichert aus files:
  original_name: string;
  mime_type: string;
  size_bytes: number;
}
