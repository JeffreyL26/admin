import { z } from 'zod';
import {
  EMPLOYEE_RULE_FIELD_LABELS,
  EMPLOYEE_TYPE_RULES,
  type EmployeeType,
} from '@hrmonic/shared';
import { badRequest } from '../../core/errors.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT erwartet');

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
 * EMPLOYEE_TYPE_RULES aus @hrmonic/shared — gespiegelt im Frontend).
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
