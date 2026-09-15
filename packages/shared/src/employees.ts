// Typen des Moduls Personalverwaltung & Stammdaten.
import { type CountryCode } from './country.js';

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
export type TaxClass = (typeof TAX_CLASSES)[number];

export const CHURCH_TAX_OPTIONS = ['keine', 'ev', 'rk'] as const;
export type ChurchTax = (typeof CHURCH_TAX_OPTIONS)[number];
export const CHURCH_TAX_LABELS: Record<ChurchTax, string> = {
  keine: 'Keine',
  ev: 'Evangelisch',
  rk: 'Römisch-katholisch',
};

// ---------------------------------------------------------------------------
// Kataloge je Land
// ---------------------------------------------------------------------------
//
// Das Datenbankschema ist variantenunabhängig: Dieselben Spalten gibt es in
// jedem Land, gefüllt werden sie aus dem Katalog des Landes. Ein LEERER
// Katalog heisst "gibt es in diesem Land nicht": Das Formular blendet das
// Feld aus und die Validierung weist einen Wert ab. Steuerklasse und
// Kirchensteuer sind deutsche Begriffe; AT und CH bekommen ihre Kataloge,
// wenn der Anbieter das Land verkauft.

/** Alle Beschäftigungsarten, die das Schema kennt (CHECK in Migration 100). */
export const EMPLOYEE_TYPES = Object.keys(EMPLOYEE_TYPE_LABELS) as EmployeeType[];

/**
 * Beschäftigungsarten je Land. AT und CH tragen vorerst denselben Katalog:
 * Ohne Art liesse sich kein Profil anlegen, der Katalog darf also nicht leer
 * sein. Die landesspezifischen Arten legt der Anbieter fest.
 */
export const EMPLOYEE_TYPES_BY_COUNTRY: Record<CountryCode, readonly EmployeeType[]> = {
  DE: EMPLOYEE_TYPES,
  AT: EMPLOYEE_TYPES,
  CH: EMPLOYEE_TYPES,
};

export function employeeTypesFor(country: CountryCode): readonly EmployeeType[] {
  return EMPLOYEE_TYPES_BY_COUNTRY[country];
}

/** Steuerklassen je Land. Nur DE kennt sie. */
export const TAX_CLASSES_BY_COUNTRY: Record<CountryCode, readonly TaxClass[]> = {
  DE: TAX_CLASSES,
  AT: [],
  CH: [],
};

export function taxClassesFor(country: CountryCode): readonly TaxClass[] {
  return TAX_CLASSES_BY_COUNTRY[country];
}

/** Kirchensteuermerkmale je Land. Nur DE kennt sie in dieser Form. */
export const CHURCH_TAX_BY_COUNTRY: Record<CountryCode, readonly ChurchTax[]> = {
  DE: CHURCH_TAX_OPTIONS,
  AT: [],
  CH: [],
};

export function churchTaxOptionsFor(country: CountryCode): readonly ChurchTax[] {
  return CHURCH_TAX_BY_COUNTRY[country];
}

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

/**
 * Pflichtfeld-Regeln des Landes. Grundlage sind die deutschen Regeln oben;
 * für ein Land ohne den passenden Katalog fällt die Pflicht weg (ohne
 * Steuerklassen lässt sich `tax_class` nicht ausfüllen, die Regel wäre
 * unerfüllbar und jedes Anlegen schüge fehl). Das Ergebnis wird je Land
 * einmal gebaut und danach wiederverwendet.
 */
const rulesByCountry = new Map<CountryCode, Record<EmployeeType, EmployeeTypeRule>>();

export function employeeTypeRulesFor(country: CountryCode): Record<EmployeeType, EmployeeTypeRule> {
  const cached = rulesByCountry.get(country);
  if (cached) return cached;
  const hasTaxClasses = taxClassesFor(country).length > 0;
  const built = Object.fromEntries(
    (Object.entries(EMPLOYEE_TYPE_RULES) as [EmployeeType, EmployeeTypeRule][]).map(
      ([type, rule]) => [
        type,
        hasTaxClasses ? rule : { ...rule, required: rule.required.filter((f) => f !== 'tax_class') },
      ],
    ),
  ) as Record<EmployeeType, EmployeeTypeRule>;
  rulesByCountry.set(country, built);
  return built;
}

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
 * Knoten des Abteilungsbaums (`GET /api/org/tree`, `GET /api/me/org-tree`):
 * Struktur-Tab und Abteilungsansicht der Desktop-App, Abteilungsfilter des
 * Portal-Kalenders. Teams hängen als Blätter an ihrer Abteilung.
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

/**
 * Woran eine Karte im Personen-Organigramm hängt. `manager` ist das gepflegte
 * Feld „Vorgesetzte:r"; die beiden anderen springen ersatzweise ein.
 */
export type OrgChartParentSource = 'manager' | 'team_lead' | 'department_head';

/**
 * Eine Person im Personen-Organigramm (`GET /api/org/chart`).
 *
 * `parent_id` ist die Person, unter der die Karte hängt: der hinterlegte
 * Vorgesetzte, sonst die Teamleitung, sonst die nächste Abteilungsleitung
 * aufwärts (`parent_source` nennt die Quelle). Ohne diesen Ersatz stünde jede
 * Person ohne gepflegtes Feld „Vorgesetzte:r" als eigener Baum neben der
 * Geschäftsführung. Zyklen in `manager_id` trennt der Server auf; der Baum
 * ist also immer zeichenbar. `manager_id` bleibt daneben roh erhalten, damit
 * die Oberfläche gepflegte und abgeleitete Linien unterscheiden kann.
 * `photo_url` ist kurzlebig signiert (core/files.ts): sofort konsumieren.
 */
export interface OrgChartPerson {
  id: number;
  first_name: string;
  last_name: string;
  job_title: string | null;
  employee_type: EmployeeType;
  personnel_number: string | null;
  email: string | null;
  phone: string | null;
  hire_date: string | null;
  manager_id: number | null;
  parent_id: number | null;
  parent_source: OrgChartParentSource | null;
  department_id: number | null;
  department_name: string | null;
  team_id: number | null;
  team_name: string | null;
  location_id: number | null;
  location_name: string | null;
  photo_file_id: number | null;
  photo_url: string | null;
}

export interface OrgChartResponse {
  /** Nur aktive Mitarbeitende, nach Nachname sortiert. */
  people: OrgChartPerson[];
  /** Alle Abteilungen, nach Name sortiert (stabile Farbzuordnung, auch ohne Personen). */
  departments: { id: number; name: string; parent_id: number | null; head_employee_id: number | null }[];
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

// ===========================================================================
// Änderungsanträge zu den eigenen Stammdaten (Portal → Personalabteilung)
// ===========================================================================

/**
 * Ein Feld der Personalakte, das Mitarbeitende im Portal selbst zur Änderung
 * BEANTRAGEN dürfen — geändert wird es erst durch die Personalabteilung.
 *
 * Die Liste ist der einzige Ort, an dem diese Auswahl steht: Das Backend baut
 * daraus seine Zod-Prüfung UND die SET-Klausel des UPDATE, das Portal sein
 * Formular, die Personalabteilung ihre Gegenüberstellung. Ein Feld, das hier
 * nicht steht, ist damit weder beantragbar noch schreibbar — die Feldnamen
 * landen im SQL, eine zweite Liste wäre eine Einladung zum Auseinanderlaufen.
 */
export interface EmployeeSelfEditableField {
  /** Spaltenname in `employees`. Geht direkt ins SQL — nur aus dieser Liste. */
  field: string;
  label: string;
  group: 'adresse' | 'kontakt' | 'versicherung' | 'bank';
  input: 'text' | 'email' | 'tel' | 'zip' | 'iban' | 'bic';
  maxLength: number;
  /**
   * Der Klartext geht NIE ins Portal zurück (nur an die Personalabteilung).
   * Betrifft die Bankverbindung: Sie steht bewusst nicht in der
   * Profil-Projektion von `GET /api/me/profile`, und ein Antrag darf diese
   * Grenze nicht durch die Hintertür aufweichen.
   */
  confidential?: boolean;
  hint?: string;
}

export const EMPLOYEE_SELF_EDITABLE_FIELDS: readonly EmployeeSelfEditableField[] = [
  { field: 'private_street', label: 'Straße und Hausnummer', group: 'adresse', input: 'text', maxLength: 120 },
  { field: 'private_zip', label: 'Postleitzahl', group: 'adresse', input: 'zip', maxLength: 10 },
  { field: 'private_city', label: 'Ort', group: 'adresse', input: 'text', maxLength: 80 },
  { field: 'private_phone', label: 'Telefon (privat)', group: 'kontakt', input: 'tel', maxLength: 40 },
  { field: 'private_email', label: 'E-Mail (privat)', group: 'kontakt', input: 'email', maxLength: 120 },
  { field: 'health_insurance', label: 'Krankenkasse', group: 'versicherung', input: 'text', maxLength: 120 },
  {
    field: 'iban',
    label: 'IBAN',
    group: 'bank',
    input: 'iban',
    maxLength: 34,
    confidential: true,
    hint: 'Die hinterlegte Bankverbindung wird im Portal nicht angezeigt. Eine Änderung wirkt erst nach der Freigabe durch die Personalabteilung.',
  },
  { field: 'bic', label: 'BIC', group: 'bank', input: 'bic', maxLength: 11, confidential: true },
];

export const EMPLOYEE_SELF_EDITABLE_FIELD_NAMES: readonly string[] =
  EMPLOYEE_SELF_EDITABLE_FIELDS.map((f) => f.field);

export const EMPLOYEE_SELF_EDITABLE_GROUP_LABELS: Record<EmployeeSelfEditableField['group'], string> = {
  adresse: 'Privatanschrift',
  kontakt: 'Private Erreichbarkeit',
  versicherung: 'Versicherung',
  bank: 'Bankverbindung',
};

export function selfEditableField(field: string): EmployeeSelfEditableField | undefined {
  return EMPLOYEE_SELF_EDITABLE_FIELDS.find((f) => f.field === field);
}

/**
 * Vertraulichen Wert für die Anzeige kürzen: nur die letzten vier Zeichen
 * bleiben stehen. Für die IBAN reicht das, um einen Zahlendreher zu erkennen,
 * ohne die vollständige Kontonummer erneut über den Bildschirm zu schicken.
 */
export function maskConfidential(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const clean = value.replace(/\s+/g, '');
  if (clean.length <= 4) return '•'.repeat(clean.length);
  return `${'•'.repeat(Math.min(clean.length - 4, 12))}${clean.slice(-4)}`;
}

export type EmployeeChangeRequestStatus = 'beantragt' | 'genehmigt' | 'abgelehnt' | 'zurueckgezogen';

export const EMPLOYEE_CHANGE_REQUEST_STATUS_LABELS: Record<EmployeeChangeRequestStatus, string> = {
  beantragt: 'Beantragt',
  genehmigt: 'Genehmigt',
  abgelehnt: 'Abgelehnt',
  zurueckgezogen: 'Zurückgezogen',
};

/** Eine beantragte Feldänderung. `old_value` ist der Stand bei Antragstellung. */
export interface EmployeeChangeRequestField {
  field: string;
  label: string;
  old_value: string | null;
  new_value: string | null;
  /** true, wenn old_value/new_value gekürzt sind (Bankverbindung im Portal). */
  masked?: boolean;
}

export interface EmployeeChangeRequest {
  id: number;
  employee_id: number;
  status: EmployeeChangeRequestStatus;
  /** Begründung der antragstellenden Person. */
  note: string | null;
  decided_at: string | null;
  /** Begründung der Entscheidung (bei Ablehnung Pflicht). */
  decision_note: string | null;
  created_at: string;
  fields: EmployeeChangeRequestField[];
}

/** Zusätzliche Felder für die Liste in der Personalabteilung. */
export interface EmployeeChangeRequestForHr extends EmployeeChangeRequest {
  first_name: string;
  last_name: string;
  personnel_number: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
}
