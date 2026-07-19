// Typen des Moduls Personalverwaltung & Stammdaten.

export type EmployeeType =
  | 'vollzeit'
  | 'teilzeit'
  | 'minijob'
  | 'werkstudent'
  | 'praktikant'
  | 'freiberufler'
  | 'auszubildender';

export const EMPLOYEE_TYPE_LABELS: Record<EmployeeType, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob: 'Minijob',
  werkstudent: 'Werkstudent',
  praktikant: 'Praktikant',
  freiberufler: 'Freiberufler',
  auszubildender: 'Auszubildender',
};

export type EmployeeStatus = 'aktiv' | 'ausgeschieden';

export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = {
  aktiv: 'Aktiv',
  ausgeschieden: 'Ausgeschieden',
};

export const TAX_CLASSES = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const;

export const CHURCH_TAX_OPTIONS = ['keine', 'ev', 'rk'] as const;
export const CHURCH_TAX_LABELS: Record<(typeof CHURCH_TAX_OPTIONS)[number], string> = {
  keine: 'Keine',
  ev: 'Evangelisch',
  rk: 'Römisch-katholisch',
};

/**
 * Typabhängige Pflichtfeld-Regeln (EINE Quelle für Backend-Validierung und
 * dynamische Pflichtfeld-Markierung im Frontend):
 * - vollzeit/teilzeit/auszubildender: weekly_hours, annual_leave_days, iban,
 *   tax_class, social_security_number sind Pflicht.
 * - minijob: weekly_hours Pflicht; Hinweis auf geringfügige Beschäftigung.
 * - werkstudent: weekly_hours Pflicht und maximal 20 Stunden/Woche.
 * - praktikant: hire_date und exit_date Pflicht (befristeter Zeitraum).
 * - freiberufler: keine Steuer-/SV-Pflichtangaben; weekly_hours und
 *   annual_leave_days bleiben optional bzw. leer.
 */
export interface EmployeeTypeRule {
  /** Feldnamen (snake_case wie in DB/API), die für diesen Typ Pflicht sind. */
  required: EmployeeRuleField[];
  /** Obergrenze für weekly_hours (z. B. Werkstudentenprivileg). */
  maxWeeklyHours?: number;
  /** Hinweistext für die Erfassung. */
  hint?: string;
}

export type EmployeeRuleField =
  | 'weekly_hours'
  | 'annual_leave_days'
  | 'iban'
  | 'tax_class'
  | 'social_security_number'
  | 'hire_date'
  | 'exit_date';

export const EMPLOYEE_TYPE_RULES: Record<EmployeeType, EmployeeTypeRule> = {
  vollzeit: {
    required: ['weekly_hours', 'annual_leave_days', 'iban', 'tax_class', 'social_security_number'],
  },
  teilzeit: {
    required: ['weekly_hours', 'annual_leave_days', 'iban', 'tax_class', 'social_security_number'],
  },
  auszubildender: {
    required: ['weekly_hours', 'annual_leave_days', 'iban', 'tax_class', 'social_security_number'],
  },
  minijob: {
    required: ['weekly_hours'],
    hint: 'Geringfügige Beschäftigung — aktuelle Verdienstgrenze beachten (pauschale Abgaben über die Minijob-Zentrale).',
  },
  werkstudent: {
    required: ['weekly_hours'],
    maxWeeklyHours: 20,
    hint: 'Werkstudentenprivileg: maximal 20 Wochenstunden während der Vorlesungszeit.',
  },
  praktikant: {
    required: ['hire_date', 'exit_date'],
    hint: 'Praktika werden mit festem Zeitraum (Eintritt und Austritt) erfasst.',
  },
  freiberufler: {
    required: [],
    hint: 'Freie Mitarbeit: keine Steuerklasse/SV-Nummer, Abrechnung über Honorare.',
  },
};

export const EMPLOYEE_RULE_FIELD_LABELS: Record<EmployeeRuleField, string> = {
  weekly_hours: 'Wochenstunden',
  annual_leave_days: 'Jahresurlaub (Tage)',
  iban: 'IBAN',
  tax_class: 'Steuerklasse',
  social_security_number: 'SV-Nummer',
  hire_date: 'Eintrittsdatum',
  exit_date: 'Austrittsdatum',
};

// ---------------------------------------------------------------------------
// Verträge
// ---------------------------------------------------------------------------

export type ContractType = 'unbefristet' | 'befristet' | 'ausbildung' | 'werkvertrag' | 'praktikum';

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  unbefristet: 'Unbefristet',
  befristet: 'Befristet',
  ausbildung: 'Ausbildung',
  werkvertrag: 'Werkvertrag',
  praktikum: 'Praktikum',
};

// ---------------------------------------------------------------------------
// Dokumente
// ---------------------------------------------------------------------------

export type DocumentCategory = 'vertrag' | 'zeugnis' | 'zertifikat' | 'bescheinigung' | 'sonstiges';

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  vertrag: 'Vertrag',
  zeugnis: 'Zeugnis',
  zertifikat: 'Zertifikat',
  bescheinigung: 'Bescheinigung',
  sonstiges: 'Sonstiges',
};

// ---------------------------------------------------------------------------
// API-Formen (snake_case wie in der DB)
// ---------------------------------------------------------------------------

export interface EmployeeLiteDto {
  id: number;
  first_name: string;
  last_name: string;
  employee_type: EmployeeType;
  status: EmployeeStatus;
  job_title: string | null;
  department_id: number | null;
  team_id: number | null;
  location_id: number | null;
}

export interface EmployeeDto extends EmployeeLiteDto {
  email: string | null;
  phone: string | null;
  photo_file_id: number | null;
  birth_date: string | null;
  private_street: string | null;
  private_zip: string | null;
  private_city: string | null;
  private_phone: string | null;
  private_email: string | null;
  iban: string | null;
  bic: string | null;
  tax_id: string | null;
  tax_class: string | null;
  church_tax: string | null;
  child_allowances: number | null;
  social_security_number: string | null;
  health_insurance: string | null;
  manager_id: number | null;
  hire_date: string | null;
  exit_date: string | null;
  weekly_hours: number | null;
  annual_leave_days: number | null;
  created_at: string;
  updated_at: string;
}

export interface ContractDto {
  id: number;
  employee_id: number;
  contract_type: ContractType;
  valid_from: string;
  valid_to: string | null;
  probation_end: string | null;
  notice_period_weeks: number | null;
  weekly_hours: number | null;
  annual_leave_days: number | null;
  fixed_term_reason: string | null;
  document_file_id: number | null;
  note: string | null;
  created_at: string;
}

export interface DocumentDto {
  id: number;
  employee_id: number | null;
  file_id: number;
  category: DocumentCategory;
  title: string;
  note: string | null;
  expiry_date: string | null;
  reminder_days: number;
  version: number;
  supersedes_id: number | null;
  created_at: string;
}
