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
    hint: 'Geringfügige Beschäftigung: Aktuelle Verdienstgrenze beachten (pauschale Abgaben über die Minijob-Zentrale).',
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

/** Herkunft eines Dokuments: von der HR abgelegt oder aus dem Portal hochgeladen. */
export type DocumentSource = 'hr' | 'portal';

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
  /**
   * Freiwillige Personalnummer; Text, weil führende Nullen und Präfixe üblich
   * sind. Bewusst NICHT Teil der schlanken Form (fields=lite) — die ist
   * Kontrakt für andere Module und bleibt unverändert.
   */
  personnel_number: string | null;
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
  source: DocumentSource;
  /** Hochladendes Konto — bei Bestand und HR-Uploads ohne Zuordnung null. */
  uploaded_by_user_id: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Organigramm
// ---------------------------------------------------------------------------

/**
 * Knoten des Abteilungs-Organigramms (`GET /api/org/tree`, `GET /api/me/org-tree`).
 * Liegt hier, weil Backend (`buildOrgTree`), Desktop-Renderer und Web-Portal
 * dieselbe Form brauchen — Teams hängen als Blätter an ihrer Abteilung.
 * `employee_count` zählt nur aktive Mitarbeitende der Abteilung selbst,
 * `total_employee_count` zusätzlich alle untergeordneten Abteilungen.
 */
export interface OrgTreeNode {
  id: number;
  name: string;
  parent_id: number | null;
  head_employee_id: number | null;
  head_name: string | null;
  employee_count: number;
  total_employee_count: number;
  teams: {
    id: number;
    name: string;
    department_id: number | null;
    lead_employee_id: number | null;
    lead_name: string | null;
    employee_count: number;
  }[];
  children: OrgTreeNode[];
}

// ---------------------------------------------------------------------------
// Mitarbeiterliste: Spalten, Sortierung, Seniorität
// ---------------------------------------------------------------------------

/**
 * Betriebszugehörigkeit als Anzahl voller Monate seit Eintritt.
 * Angefangene Monate zählen nicht — „2 Jahre 1 Monat“ soll am Monatstag
 * umspringen, nicht schon Tage vorher.
 */
export function seniorityMonths(hireDate: string | null, today = new Date()): number | null {
  if (!hireDate) return null;
  const [y, m, d] = hireDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  let months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m);
  if (today.getDate() < d) months -= 1; // Monatstag noch nicht erreicht
  return months < 0 ? 0 : months;
}

export type SeniorityFormat = 'monate' | 'jahre';

export const SENIORITY_FORMAT_LABELS: Record<SeniorityFormat, string> = {
  monate: 'In Monaten (z. B. 25 Monate)',
  jahre: 'In Jahren und Monaten (z. B. 2 Jahre 1 Monat)',
};

/** Betriebszugehörigkeit als deutscher Text. */
export function formatSeniority(
  hireDate: string | null,
  format: SeniorityFormat = 'jahre',
  today = new Date(),
): string {
  const months = seniorityMonths(hireDate, today);
  if (months === null) return '—';
  if (format === 'monate') return months === 1 ? '1 Monat' : `${months} Monate`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearPart = years === 1 ? '1 Jahr' : `${years} Jahre`;
  const monthPart = rest === 1 ? '1 Monat' : `${rest} Monate`;
  if (years === 0) return monthPart;
  if (rest === 0) return yearPart;
  return `${yearPart} ${monthPart}`;
}

/**
 * Wählbare Spalten der Mitarbeiterliste. `fixed` bleibt immer sichtbar —
 * ohne Name und Personalnummer wäre eine Zeile nicht mehr zuzuordnen.
 */
export interface EmployeeColumnDef {
  id: string;
  label: string;
  fixed?: boolean;
  defaultVisible?: boolean;
}

export const EMPLOYEE_LIST_COLUMNS: EmployeeColumnDef[] = [
  { id: 'name', label: 'Name', fixed: true, defaultVisible: true },
  { id: 'personnel_number', label: 'Personalnummer', fixed: true, defaultVisible: true },
  { id: 'employee_type', label: 'Typ', defaultVisible: true },
  { id: 'department', label: 'Abteilung / Team', defaultVisible: true },
  { id: 'job_title', label: 'Titel', defaultVisible: true },
  { id: 'hire_date', label: 'Eintritt', defaultVisible: true },
  { id: 'seniority', label: 'Betriebszugehörigkeit' },
  { id: 'location', label: 'Standort' },
  { id: 'status', label: 'Status' },
  { id: 'email', label: 'E-Mail' },
  { id: 'phone', label: 'Telefon' },
  { id: 'manager', label: 'Vorgesetzte:r' },
  { id: 'weekly_hours', label: 'Wochenstunden' },
  { id: 'annual_leave_days', label: 'Urlaubsanspruch' },
  { id: 'exit_date', label: 'Austritt' },
];

export type EmployeeSortField =
  | 'last_name'
  | 'first_name'
  | 'personnel_number'
  | 'hire_date'
  | 'job_title'
  | 'department';

export const EMPLOYEE_SORT_LABELS: Record<EmployeeSortField, string> = {
  last_name: 'Nachname',
  first_name: 'Vorname',
  personnel_number: 'Personalnummer',
  hire_date: 'Eintritt',
  job_title: 'Titel',
  department: 'Abteilung',
};
