import React from 'react';
import {
  CHURCH_TAX_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_TYPE_LABELS,
  EMPLOYEE_TYPE_RULES,
  TAX_CLASSES,
  type EmployeeRuleField,
  type EmployeeStatus,
  type EmployeeType,
} from '@hrmonic/shared';
import { uploadFile } from '../../api/client';
import { Field } from '../../components/ui';
import { PhotoPicker } from '../../components/FilePicker';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useDepartments, useLocations, useTeams, type EmployeeRow } from './api';

/** Formularzustand: Zahlen als String (Eingabe), Konvertierung erst beim Submit. */
export interface EmployeeFormState {
  first_name: string;
  last_name: string;
  personnel_number: string;
  email: string;
  phone: string;
  birth_date: string;
  private_street: string;
  private_zip: string;
  private_city: string;
  private_phone: string;
  private_email: string;
  iban: string;
  bic: string;
  tax_id: string;
  tax_class: string;
  church_tax: string;
  child_allowances: string;
  social_security_number: string;
  health_insurance: string;
  employee_type: EmployeeType;
  status: EmployeeStatus;
  job_title: string;
  department_id: number | null;
  team_id: number | null;
  location_id: number | null;
  manager_id: number | null;
  hire_date: string;
  exit_date: string;
  weekly_hours: string;
  annual_leave_days: string;
  photo_file_id: number | null;
}

export const EMPTY_EMPLOYEE_FORM: EmployeeFormState = {
  first_name: '',
  last_name: '',
  personnel_number: '',
  email: '',
  phone: '',
  birth_date: '',
  private_street: '',
  private_zip: '',
  private_city: '',
  private_phone: '',
  private_email: '',
  iban: '',
  bic: '',
  tax_id: '',
  tax_class: '',
  church_tax: '',
  child_allowances: '',
  social_security_number: '',
  health_insurance: '',
  employee_type: 'vollzeit',
  status: 'aktiv',
  job_title: '',
  department_id: null,
  team_id: null,
  location_id: null,
  manager_id: null,
  hire_date: '',
  exit_date: '',
  weekly_hours: '',
  annual_leave_days: '',
  photo_file_id: null,
};

export function employeeToForm(e: EmployeeRow): EmployeeFormState {
  return {
    first_name: e.first_name ?? '',
    last_name: e.last_name ?? '',
    personnel_number: e.personnel_number ?? '',
    email: e.email ?? '',
    phone: e.phone ?? '',
    birth_date: e.birth_date ?? '',
    private_street: e.private_street ?? '',
    private_zip: e.private_zip ?? '',
    private_city: e.private_city ?? '',
    private_phone: e.private_phone ?? '',
    private_email: e.private_email ?? '',
    iban: e.iban ?? '',
    bic: e.bic ?? '',
    tax_id: e.tax_id ?? '',
    tax_class: e.tax_class ?? '',
    church_tax: e.church_tax ?? '',
    child_allowances: e.child_allowances !== null && e.child_allowances !== undefined ? String(e.child_allowances) : '',
    social_security_number: e.social_security_number ?? '',
    health_insurance: e.health_insurance ?? '',
    employee_type: e.employee_type,
    status: e.status,
    job_title: e.job_title ?? '',
    department_id: e.department_id,
    team_id: e.team_id,
    location_id: e.location_id,
    manager_id: e.manager_id,
    hire_date: e.hire_date ?? '',
    exit_date: e.exit_date ?? '',
    weekly_hours: e.weekly_hours !== null && e.weekly_hours !== undefined ? String(e.weekly_hours) : '',
    annual_leave_days:
      e.annual_leave_days !== null && e.annual_leave_days !== undefined ? String(e.annual_leave_days) : '',
    photo_file_id: e.photo_file_id,
  };
}

const num = (s: string): number | null => (s.trim() === '' ? null : Number(s.replace(',', '.')));
const str = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** Formular → API-Payload (snake_case, '' → null, Zahlen konvertiert). */
export function formToPayload(f: EmployeeFormState): Record<string, unknown> {
  return {
    first_name: f.first_name.trim(),
    last_name: f.last_name.trim(),
    personnel_number: str(f.personnel_number),
    email: str(f.email),
    phone: str(f.phone),
    birth_date: str(f.birth_date),
    private_street: str(f.private_street),
    private_zip: str(f.private_zip),
    private_city: str(f.private_city),
    private_phone: str(f.private_phone),
    private_email: str(f.private_email),
    iban: str(f.iban),
    bic: str(f.bic),
    tax_id: str(f.tax_id),
    tax_class: str(f.tax_class),
    church_tax: str(f.church_tax),
    child_allowances: num(f.child_allowances),
    social_security_number: str(f.social_security_number),
    health_insurance: str(f.health_insurance),
    employee_type: f.employee_type,
    status: f.status,
    job_title: str(f.job_title),
    department_id: f.department_id,
    team_id: f.team_id,
    location_id: f.location_id,
    manager_id: f.manager_id,
    hire_date: str(f.hire_date),
    exit_date: str(f.exit_date),
    weekly_hours: num(f.weekly_hours),
    annual_leave_days: num(f.annual_leave_days),
    photo_file_id: f.photo_file_id,
  };
}

/** Dynamische Pflichtfelder gemäß EMPLOYEE_TYPE_RULES (Spiegel der Server-Regeln). */
export function requiredFor(type: EmployeeType): Set<EmployeeRuleField> {
  return new Set(EMPLOYEE_TYPE_RULES[type].required);
}

type SetForm = (patch: Partial<EmployeeFormState>) => void;

export function PersonFields({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const [uploading, setUploading] = React.useState(false);
  return (
    <div className="hm-form-grid">
      <Field label="Vorname" required>
        <input className="hm-input" value={form.first_name} onChange={(e) => set({ first_name: e.target.value })} />
      </Field>
      <Field label="Nachname" required>
        <input className="hm-input" value={form.last_name} onChange={(e) => set({ last_name: e.target.value })} />
      </Field>
      <Field label="Geburtsdatum">
        <input className="hm-input" type="date" value={form.birth_date} onChange={(e) => set({ birth_date: e.target.value })} />
      </Field>
      <Field label="Foto" span2>
        <PhotoPicker
          name={`${form.first_name} ${form.last_name}`.trim() || 'Neu'}
          busy={uploading}
          onPick={async (file) => {
            setUploading(true);
            try {
              const res = await uploadFile(file);
              set({ photo_file_id: res.file.id });
            } finally {
              setUploading(false);
            }
          }}
        />
      </Field>
      <Field label="E-Mail (dienstlich)">
        <input className="hm-input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field label="Telefon (dienstlich)">
        <input className="hm-input" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
      </Field>
      <Field label="E-Mail (privat)">
        <input className="hm-input" type="email" value={form.private_email} onChange={(e) => set({ private_email: e.target.value })} />
      </Field>
      <Field label="Telefon (privat)">
        <input className="hm-input" value={form.private_phone} onChange={(e) => set({ private_phone: e.target.value })} />
      </Field>
      <Field label="Straße und Hausnummer" span2>
        <input className="hm-input" value={form.private_street} onChange={(e) => set({ private_street: e.target.value })} />
      </Field>
      <Field label="PLZ">
        <input className="hm-input" value={form.private_zip} onChange={(e) => set({ private_zip: e.target.value })} />
      </Field>
      <Field label="Ort">
        <input className="hm-input" value={form.private_city} onChange={(e) => set({ private_city: e.target.value })} />
      </Field>
    </div>
  );
}

export function EmploymentFields({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();
  const { data: locations } = useLocations();
  const required = requiredFor(form.employee_type);
  const rule = EMPLOYEE_TYPE_RULES[form.employee_type];
  const teamsInDep = (teams ?? []).filter(
    (t) => form.department_id === null || t.department_id === form.department_id,
  );
  return (
    <div className="hm-form-grid">
      <Field label="Mitarbeitertyp" required hint={rule.hint}>
        <select
          className="hm-select"
          value={form.employee_type}
          onChange={(e) => set({ employee_type: e.target.value as EmployeeType })}
        >
          {Object.entries(EMPLOYEE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Status">
        <select
          className="hm-select"
          value={form.status}
          onChange={(e) => set({ status: e.target.value as EmployeeStatus })}
        >
          {Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Jobtitel" span2>
        <input className="hm-input" value={form.job_title} onChange={(e) => set({ job_title: e.target.value })} />
      </Field>
      <Field
        label="Personalnummer"
        hint="Optional. Buchstaben und führende Nullen bleiben erhalten (z. B. P-0042); jede Nummer darf nur einmal vergeben werden."
      >
        <input
          className="hm-input"
          value={form.personnel_number}
          onChange={(e) => set({ personnel_number: e.target.value })}
          placeholder="—"
        />
      </Field>
      <Field label="Abteilung">
        <select
          className="hm-select"
          value={form.department_id ?? ''}
          onChange={(e) =>
            set({ department_id: e.target.value === '' ? null : Number(e.target.value), team_id: null })
          }
        >
          <option value="">— keine —</option>
          {(departments ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Team">
        <select
          className="hm-select"
          value={form.team_id ?? ''}
          onChange={(e) => set({ team_id: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">— keines —</option>
          {teamsInDep.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Standort">
        <select
          className="hm-select"
          value={form.location_id ?? ''}
          onChange={(e) => set({ location_id: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">— keiner —</option>
          {(locations ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Vorgesetzte:r">
        <EmployeeSelect value={form.manager_id} onChange={(id) => set({ manager_id: id })} allowEmpty />
      </Field>
      <Field label="Eintrittsdatum" required={required.has('hire_date')}>
        <input className="hm-input" type="date" value={form.hire_date} onChange={(e) => set({ hire_date: e.target.value })} />
      </Field>
      <Field label="Austrittsdatum" required={required.has('exit_date')}>
        <input className="hm-input" type="date" value={form.exit_date} onChange={(e) => set({ exit_date: e.target.value })} />
      </Field>
      <Field
        label="Wochenstunden"
        required={required.has('weekly_hours')}
        hint={rule.maxWeeklyHours ? `Maximal ${rule.maxWeeklyHours} Stunden` : undefined}
      >
        <input
          className="hm-input"
          type="number"
          min={0}
          max={60}
          step={0.5}
          value={form.weekly_hours}
          onChange={(e) => set({ weekly_hours: e.target.value })}
        />
      </Field>
      <Field label="Jahresurlaub (Tage)" required={required.has('annual_leave_days')}>
        <input
          className="hm-input"
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={form.annual_leave_days}
          onChange={(e) => set({ annual_leave_days: e.target.value })}
        />
      </Field>
    </div>
  );
}

export function FinanceFields({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const required = requiredFor(form.employee_type);
  const isFreelancer = form.employee_type === 'freiberufler';
  return (
    <div className="hm-form-grid">
      <Field label="IBAN" required={required.has('iban')} span2>
        <input className="hm-input" value={form.iban} onChange={(e) => set({ iban: e.target.value })} placeholder="DE.." />
      </Field>
      <Field label="BIC">
        <input className="hm-input" value={form.bic} onChange={(e) => set({ bic: e.target.value })} />
      </Field>
      <Field label="Steuer-ID">
        <input className="hm-input" value={form.tax_id} onChange={(e) => set({ tax_id: e.target.value })} disabled={isFreelancer} />
      </Field>
      <Field
        label="Steuerklasse"
        required={required.has('tax_class')}
        hint={isFreelancer ? 'Entfällt bei freier Mitarbeit' : undefined}
      >
        <select
          className="hm-select"
          value={form.tax_class}
          disabled={isFreelancer}
          onChange={(e) => set({ tax_class: e.target.value })}
        >
          <option value="">— keine —</option>
          {TAX_CLASSES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Kirchensteuer">
        <select
          className="hm-select"
          value={form.church_tax}
          disabled={isFreelancer}
          onChange={(e) => set({ church_tax: e.target.value })}
        >
          <option value="">— keine Angabe —</option>
          {Object.entries(CHURCH_TAX_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Kinderfreibeträge" hint="In 0,5-Schritten">
        <input
          className="hm-input"
          type="number"
          min={0}
          max={20}
          step={0.5}
          value={form.child_allowances}
          disabled={isFreelancer}
          onChange={(e) => set({ child_allowances: e.target.value })}
        />
      </Field>
      <Field label="SV-Nummer" required={required.has('social_security_number')}>
        <input
          className="hm-input"
          value={form.social_security_number}
          disabled={isFreelancer}
          onChange={(e) => set({ social_security_number: e.target.value })}
        />
      </Field>
      <Field label="Krankenkasse">
        <input
          className="hm-input"
          value={form.health_insurance}
          disabled={isFreelancer}
          onChange={(e) => set({ health_insurance: e.target.value })}
        />
      </Field>
    </div>
  );
}
