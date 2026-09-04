import { z } from 'zod';
import {
  EMPLOYEE_RULE_FIELD_LABELS,
  EMPLOYEE_TYPE_RULES,
  type EmployeeType,
} from '@ohrganize/shared';
import { badRequest } from '../../core/errors.js';
import { isoDateString } from '../../core/validation.js';

// Kalenderprüfung inklusive (core/validation.ts) — ein Regex allein ließe
// '2026-02-31' durch, was in der Vertragsanlage bis zum 500er führt.
const isoDate = isoDateString;

const employeeTypeEnum = z.enum([
  'vollzeit',
  'teilzeit',
  'minijob',
  'werkstudent',
  'praktikant',
  'freiberufler',
  'auszubildender',
]);

const nullableString = z.string().trim().max(500).nullish();

/** Alle beschreibbaren Stammdatenfelder (snake_case wie in der DB). */
export const employeeBodySchema = z.object({
  first_name: z.string().trim().min(1, 'Vorname ist Pflicht'),
  last_name: z.string().trim().min(1, 'Nachname ist Pflicht'),
  // Freiwillig und als Text: Betriebe übernehmen sie aus der Lohnbuchhaltung
  // oder pflegen ein eigenes Schema, oft mit führenden Nullen oder Präfix
  // ("P-0042"). Als Zahl gespeichert ginge diese Form verloren.
  // Eindeutigkeit erzwingt ein partieller UNIQUE-Index (Migration 104).
  personnel_number: z.string().trim().max(40).nullish(),
  email: nullableString,
  phone: nullableString,
  photo_file_id: z.number().int().positive().nullish(),
  birth_date: isoDate.nullish(),
  private_street: nullableString,
  private_zip: nullableString,
  private_city: nullableString,
  private_phone: nullableString,
  private_email: nullableString,
  iban: nullableString,
  bic: nullableString,
  tax_id: nullableString,
  tax_class: z.enum(['I', 'II', 'III', 'IV', 'V', 'VI']).nullish(),
  church_tax: z.enum(['keine', 'ev', 'rk']).nullish(),
  child_allowances: z.number().min(0).max(20).multipleOf(0.5).nullish(),
  social_security_number: nullableString,
  health_insurance: nullableString,
  employee_type: employeeTypeEnum,
  status: z.enum(['aktiv', 'ausgeschieden']).default('aktiv'),
  job_title: nullableString,
  department_id: z.number().int().positive().nullish(),
  team_id: z.number().int().positive().nullish(),
  location_id: z.number().int().positive().nullish(),
  manager_id: z.number().int().positive().nullish(),
  hire_date: isoDate.nullish(),
  exit_date: isoDate.nullish(),
  weekly_hours: z.number().min(0).max(60).nullish(),
  annual_leave_days: z.number().min(0).max(100).nullish(),
});

export const employeePatchSchema = employeeBodySchema.partial();

export type EmployeeBody = z.infer<typeof employeeBodySchema>;

/** Spalten, die per PATCH/POST geschrieben werden dürfen (Reihenfolge egal). */
export const EMPLOYEE_COLUMNS = Object.keys(employeeBodySchema.shape) as (keyof EmployeeBody)[];

/**
 * Serverseitige Prüfung der typabhängigen Pflichtfelder (Regeln:
 * EMPLOYEE_TYPE_RULES aus @ohrganize/shared — gespiegelt im Frontend).
 * Erwartet den VOLLSTÄNDIG gemergten Datensatz (bei PATCH: Bestand + Änderung).
 */
export function assertTypeRules(employee: Record<string, unknown>): void {
  const type = employee.employee_type as EmployeeType;
  const rule = EMPLOYEE_TYPE_RULES[type];
  if (!rule) throw badRequest(`Unbekannter Mitarbeitertyp: ${String(type)}`);

  const missing = rule.required.filter((field) => {
    const value = employee[field];
    return value === null || value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw badRequest(
      `Für den Typ „${type}“ sind Pflichtangaben unvollständig: ${missing
        .map((f) => EMPLOYEE_RULE_FIELD_LABELS[f])
        .join(', ')}`,
      { missing_fields: missing },
    );
  }

  const hours = employee.weekly_hours;
  if (
    rule.maxWeeklyHours !== undefined &&
    typeof hours === 'number' &&
    hours > rule.maxWeeklyHours
  ) {
    throw badRequest(
      `Für den Typ „${type}“ sind maximal ${rule.maxWeeklyHours} Wochenstunden zulässig`,
      { field: 'weekly_hours', max: rule.maxWeeklyHours },
    );
  }
}

/**
 * Reihenfolge-Prüfung Eintritt/Austritt — bewusst NICHT Teil von
 * assertTypeRules: Die läuft auf dem gemergten Datensatz auch bei Änderungen,
 * die die Datumsfelder gar nicht anfassen (z. B. ein Telefonnummer-Patch),
 * und würde Bestandszeilen mit Altlast (exit < hire) für jede unbeteiligte
 * Änderung sperren — in der Massenbearbeitung bräche eine einzige
 * Altlast-Zeile den ganzen Batch. Deshalb nur aufrufen, wenn der
 * Schreibvorgang hire_date oder exit_date tatsächlich setzt; erwartet dann
 * den vollständig gemergten Datensatz (bei PATCH: Bestand + Änderung), damit
 * die Regel auch greift, wenn nur eines der beiden Daten geändert wird.
 * Ein Datensatz mit Austritt vor Eintritt fällt sonst still aus jeder
 * Anspruchs- und Abrechnungslogik.
 */
export function assertExitNotBeforeHire(employee: Record<string, unknown>): void {
  const hire = employee.hire_date;
  const exit = employee.exit_date;
  if (typeof hire === 'string' && typeof exit === 'string' && hire && exit && exit < hire) {
    throw badRequest('Das Austrittsdatum darf nicht vor dem Eintrittsdatum liegen', {
      field: 'exit_date',
    });
  }
}

// ---------------------------------------------------------------------------
// Verträge
// ---------------------------------------------------------------------------

export const contractBodySchema = z.object({
  contract_type: z.enum(['unbefristet', 'befristet', 'ausbildung', 'werkvertrag', 'praktikum']),
  valid_from: isoDate,
  valid_to: isoDate.nullish(),
  probation_end: isoDate.nullish(),
  notice_period_weeks: z.number().int().min(0).max(104).nullish(),
  weekly_hours: z.number().min(0).max(60).nullish(),
  annual_leave_days: z.number().min(0).max(100).nullish(),
  fixed_term_reason: nullableString,
  document_file_id: z.number().int().positive().nullish(),
  note: nullableString,
});

export const contractPatchSchema = contractBodySchema.partial();

export type ContractBody = z.infer<typeof contractBodySchema>;

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export const departmentBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist Pflicht'),
  parent_id: z.number().int().positive().nullish(),
  head_employee_id: z.number().int().positive().nullish(),
});

export const teamBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist Pflicht'),
  department_id: z.number().int().positive().nullish(),
  lead_employee_id: z.number().int().positive().nullish(),
});

export const locationBodySchema = z.object({
  name: z.string().trim().min(1, 'Name ist Pflicht'),
  street: nullableString,
  zip: nullableString,
  city: nullableString,
  bundesland: z.enum([
    'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
    'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
  ]),
});

// ---------------------------------------------------------------------------
// Dokumente
// ---------------------------------------------------------------------------

export const documentBodySchema = z.object({
  employee_id: z.number().int().positive().nullish(),
  file_id: z.number().int().positive(),
  category: z.enum(['vertrag', 'zeugnis', 'zertifikat', 'bescheinigung', 'sonstiges']),
  title: z.string().trim().min(1, 'Titel ist Pflicht').max(300),
  note: nullableString,
  expiry_date: isoDate.nullish(),
  reminder_days: z.number().int().min(0).max(730).default(30),
  supersedes_id: z.number().int().positive().nullish(),
});

export const documentPatchSchema = documentBodySchema.omit({ supersedes_id: true }).partial();

// ---------------------------------------------------------------------------
// Massenbearbeitung
// ---------------------------------------------------------------------------

export const bulkBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'Mindestens eine ID erforderlich'),
  set: z
    .object({
      department_id: z.number().int().positive().nullable().optional(),
      team_id: z.number().int().positive().nullable().optional(),
      location_id: z.number().int().positive().nullable().optional(),
      manager_id: z.number().int().positive().nullable().optional(),
      status: z.enum(['aktiv', 'ausgeschieden']).optional(),
      weekly_hours: z.number().min(0).max(60).nullable().optional(),
      annual_leave_days: z.number().min(0).max(100).nullable().optional(),
    })
    .strict(),
});
