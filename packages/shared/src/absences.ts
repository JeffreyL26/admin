// Typen des Moduls Abwesenheitsmanagement.

export type AbsenceCategory = 'urlaub' | 'krankheit' | 'sonder';

export const ABSENCE_CATEGORY_LABELS: Record<AbsenceCategory, string> = {
  urlaub: 'Urlaub',
  krankheit: 'Krankheit',
  sonder: 'Sonderabwesenheit',
};

export type AbsenceRequestStatus = 'beantragt' | 'genehmigt' | 'abgelehnt' | 'storniert';

export const ABSENCE_STATUS_LABELS: Record<AbsenceRequestStatus, string> = {
  beantragt: 'Beantragt',
  genehmigt: 'Genehmigt',
  abgelehnt: 'Abgelehnt',
  storniert: 'Storniert',
};

/**
 * Schwelle der Kalender-Konflikterkennung: Ist an einem Tag mehr als dieser
 * Anteil eines Teams gleichzeitig abwesend (beantragt oder genehmigt), wird
 * der Tag als Konflikt markiert. Bewusst hart kodiert (keine Einstellung).
 */
export const ABSENCE_CONFLICT_THRESHOLD = 0.5;

export interface AbsenceType {
  id: number;
  name: string;
  category: AbsenceCategory;
  paid: number; // SQLite-Bool (0/1)
  affects_balance: number;
  requires_proof: number;
  requires_approval: number;
  color: string;
  max_days_per_year: number | null;
  active: number;
}

export interface AbsenceRequest {
  id: number;
  employee_id: number;
  type_id: number;
  date_from: string; // ISO YYYY-MM-DD
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  days_counted: number;
  status: AbsenceRequestStatus;
  comment: string | null;
  rejection_reason: string | null;
  decided_by_user_id: number | null;
  decided_at: string | null;
  created_by_user_id: number | null;
  created_at: string;
  // Angereichert in Listen-Antworten:
  first_name?: string;
  last_name?: string;
  type_name?: string;
  type_color?: string;
  type_category?: AbsenceCategory;
}

export interface AbsenceBalance {
  employee_id: number;
  year: number;
  entitlement: number;
  carryover: number;
  carryover_expired: boolean;
  taken: number;
  planned: number;
  remaining: number;
  first_name?: string;
  last_name?: string;
}

export interface SickNote {
  id: number;
  absence_request_id: number;
  certificate_file_id: number | null;
  certificate_due_date: string;
  received_date: string | null;
  follow_up_of_id: number | null;
  child_sick: number;
  created_at: string;
  // Angereichert:
  employee_id?: number;
  first_name?: string;
  last_name?: string;
  date_from?: string;
  date_to?: string;
  days_counted?: number;
  request_status?: AbsenceRequestStatus;
  /** Bereits angefallene Fehltage (Arbeitstage von Beginn bis heute). */
  days_absent_so_far?: number;
  /** Kalendertage seit Beginn der AU-Kette (Erst- + Folgebescheinigungen), bis heute. */
  sick_pay_days_used?: number;
  /** Entgeltfortzahlung (42 Kalendertage) überzogen. */
  sick_pay_exceeded?: boolean;
}

/** Entgeltfortzahlung im Krankheitsfall: 6 Wochen = 42 Kalendertage. */
export const SICK_PAY_LIMIT_DAYS = 42;

export interface CompanyClosure {
  id: number;
  date_from: string;
  date_to: string;
  name: string;
}

export interface CalendarAbsenceEntry {
  request_id: number;
  type_id: number;
  type_name: string;
  color: string;
  status: AbsenceRequestStatus;
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
}

export interface CalendarEmployee {
  id: number;
  first_name: string;
  last_name: string;
  department_id: number | null;
  team_id: number | null;
  bundesland: string;
  absences: CalendarAbsenceEntry[];
}

export interface CalendarConflict {
  date: string;
  team_id: number;
  absent: number;
  team_size: number;
  ratio: number;
}
