import React from 'react';
import {
  CHURCH_TAX_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_TYPE_LABELS,
  HIGHEST_DEGREES,
  HIGHEST_DEGREE_LABELS,
  NATIONALITY_CODES,
  RESIDENCE_PERMIT_LABELS,
  RESIDENCE_PERMIT_TYPES,
  DISABILITY_DEGREES,
  WEEKDAY_SHORT,
  disabilityNotes,
  entitlementDaysPerWeek,
  formatWeekdays,
  nationalityLabel,
  needsResidencePermit,
  parseWeekdays,
  statutoryLeaveDays,
  churchTaxOptionsFor,
  employeeTypeRulesFor,
  employeeTypesFor,
  taxClassesFor,
  type EmployeeRuleField,
  type EmployeeStatus,
  type EmployeeType,
} from '@ohrganize/shared';
import { COUNTRY } from '../../lib/locale';
import { uploadFile } from '../../api/client';
import { Field } from '../../components/ui';
import { PhotoPicker } from '../../components/FilePicker';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { createPhotoThumbnail } from '../../lib/photoThumbnail';
import { useDepartments, useLocations, usePhotoUrl, useTeams, type EmployeeRow } from './api';
import { avatarFileId } from './avatarPhoto';
import { Select } from '../../components/Select';
import { HalfStepHint } from '../../components/HalfStepHint';
import { useAuth } from '../../auth/AuthContext';

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
  /** Vorschaubild zum Foto, entsteht beim Hochladen (createPhotoThumbnail). */
  photo_thumb_file_id: number | null;
  nationality: string;
  residence_permit: string;
  residence_permit_until: string;
  highest_degree: string;
  degree_field: string;
  /**
   * Arbeitswoche (shared/workSchedule.ts): '' = nicht hinterlegt (Bestand,
   * gezählt wie Mo bis Fr), 'fest' = feste Wochentage, 'flexibel' = nur die
   * Zahl Tage je Woche.
   */
  work_mode: '' | 'fest' | 'flexibel';
  work_weekdays: number[];
  work_days_per_week: string;
  /** Home-Office-Tage als Muster (shared/homeOffice.ts); leer = keine. */
  home_office_weekdays: number[];
  disability_degree: string;
  disability_equal: boolean;
  disability_valid_until: string;
  disability_note: string;
  /** Leitungsebene (C-Level), core/executiveGate.ts. */
  executive: boolean;
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
  photo_thumb_file_id: null,
  nationality: '',
  residence_permit: '',
  residence_permit_until: '',
  highest_degree: '',
  degree_field: '',
  // Neue Personen: feste Woche Mo bis Fr als Vorgabe, ausdrücklich hinterlegt.
  work_mode: 'fest',
  work_weekdays: [1, 2, 3, 4, 5],
  work_days_per_week: '',
  home_office_weekdays: [],
  disability_degree: '',
  disability_equal: false,
  disability_valid_until: '',
  disability_note: '',
  executive: false,
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
    photo_thumb_file_id: e.photo_thumb_file_id ?? null,
    nationality: e.nationality ?? '',
    residence_permit: e.residence_permit ?? '',
    residence_permit_until: e.residence_permit_until ?? '',
    highest_degree: e.highest_degree ?? '',
    degree_field: e.degree_field ?? '',
    ...workScheduleToForm(e),
    home_office_weekdays: parseWeekdays(e.home_office_weekdays) ?? [],
    disability_degree: e.disability_degree != null ? String(e.disability_degree) : '',
    disability_equal: e.disability_equal === 1,
    disability_valid_until: e.disability_valid_until ?? '',
    disability_note: e.disability_note ?? '',
    executive: e.executive === 1,
  };
}

function workScheduleToForm(
  e: Pick<EmployeeRow, 'work_weekdays' | 'work_days_per_week'>,
): Pick<EmployeeFormState, 'work_mode' | 'work_weekdays' | 'work_days_per_week'> {
  const fixed = parseWeekdays(e.work_weekdays);
  if (fixed) return { work_mode: 'fest', work_weekdays: fixed, work_days_per_week: '' };
  if (e.work_days_per_week !== null && e.work_days_per_week !== undefined) {
    return { work_mode: 'flexibel', work_weekdays: [1, 2, 3, 4, 5], work_days_per_week: String(e.work_days_per_week) };
  }
  return { work_mode: '', work_weekdays: [1, 2, 3, 4, 5], work_days_per_week: '' };
}

const num = (s: string): number | null => (s.trim() === '' ? null : Number(s.replace(',', '.')));
const str = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/**
 * Formular → API-Payload (snake_case, '' → null, Zahlen konvertiert).
 *
 * Mit `base` (Stand, auf dem die Eingaben basieren) bleiben nur die tatsächlich
 * geänderten Felder übrig. Das verkleinert die Kollisionsfläche im
 * Mehrplatzbetrieb: Zwei Arbeitsplätze geraten nur noch aneinander, wenn sie
 * dasselbe Feld anfassen — nicht schon beim selben Datensatz.
 */
export function formToPayload(f: EmployeeFormState, base?: EmployeeFormState): Record<string, unknown> {
  if (base) {
    // Vergleich auf Payload-Ebene (nach trim/Zahl-Konvertierung), damit z. B.
    // ein angehängtes Leerzeichen nicht als Änderung zählt.
    const payload = formToPayload(f);
    const basePayload = formToPayload(base);
    return Object.fromEntries(
      Object.entries(payload).filter(([key, value]) => value !== basePayload[key]),
    );
  }
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
    photo_thumb_file_id: f.photo_thumb_file_id,
    nationality: str(f.nationality),
    // Ohne Bedarf (EU, EWR, Schweiz oder keine Angabe) bleibt nichts stehen.
    residence_permit: needsResidencePermit(f.nationality) ? str(f.residence_permit) : null,
    residence_permit_until: needsResidencePermit(f.nationality) ? str(f.residence_permit_until) : null,
    highest_degree: str(f.highest_degree),
    degree_field: str(f.degree_field),
    home_office_weekdays: f.home_office_weekdays.length > 0 ? formatWeekdays(f.home_office_weekdays) : null,
    disability_degree: num(f.disability_degree),
    disability_equal: f.disability_equal ? 1 : 0,
    disability_valid_until: str(f.disability_valid_until),
    disability_note: str(f.disability_note),
    executive: f.executive ? 1 : 0,
    work_weekdays: f.work_mode === 'fest' && f.work_weekdays.length > 0 ? formatWeekdays(f.work_weekdays) : null,
    work_days_per_week:
      f.work_mode === 'fest'
        ? f.work_weekdays.length || null
        : f.work_mode === 'flexibel'
          ? num(f.work_days_per_week)
          : null,
  };
}

/** Arbeitstage je Woche laut Formular (für den Hinweis zum Mindesturlaub). */
function formDaysPerWeek(f: EmployeeFormState): number | null {
  return entitlementDaysPerWeek({
    employee_type: f.employee_type,
    work_weekdays: f.work_mode === 'fest' ? formatWeekdays(f.work_weekdays) : null,
    work_days_per_week: f.work_mode === 'flexibel' ? num(f.work_days_per_week) : null,
  });
}

/**
 * Staatsangehörigkeiten nach deutschem Namen, das Land der Variante zuerst
 * (der häufigste Fall steht oben). Einmal je Sitzung gebaut.
 */
const NATIONALITY_OPTIONS = [
  COUNTRY,
  ...[...NATIONALITY_CODES]
    .filter((c) => c !== COUNTRY)
    .sort((a, b) => nationalityLabel(a).localeCompare(nationalityLabel(b), 'de')),
].map((code) => ({ code, label: nationalityLabel(code) }));

/**
 * Kataloge des Landes der Variante (Spiegel der Server-Regeln in
 * modules/employees/validation.ts). Ein LEERER Katalog heisst "gibt es in
 * diesem Land nicht": Das Feld wird dann gar nicht erst angeboten.
 */
const TYPE_RULES = employeeTypeRulesFor(COUNTRY);
const EMPLOYEE_TYPES = employeeTypesFor(COUNTRY);
const TAX_CLASSES = taxClassesFor(COUNTRY);
const CHURCH_TAX = churchTaxOptionsFor(COUNTRY);

/** Dynamische Pflichtfelder gemäß den Regeln des Landes. */
export function requiredFor(type: EmployeeType): Set<EmployeeRuleField> {
  return new Set(TYPE_RULES[type].required);
}

type SetForm = (patch: Partial<EmployeeFormState>) => void;

export function PersonFields({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const [uploading, setUploading] = React.useState(false);
  // Hinterlegtes Foto anzeigen: gleicher Cache wie Personalakte und
  // Verzeichnis (usePhotoUrl haelt das Bild je Datei, nicht die kurzlebige URL).
  // Die Vorschau ist 64 px gross, das Vorschaubild reicht (PHOTO_THUMB_EDGE).
  const photo = usePhotoUrl(avatarFileId(form));
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
          imageOnly
          name={`${form.first_name} ${form.last_name}`.trim() || 'Neu'}
          // Solange kein Name da ist, steht ein "O" (wie oHRganize) statt des "N" von "Neu".
          placeholderInitials={`${form.first_name}${form.last_name}`.trim() ? undefined : 'O'}
          previewUrl={form.photo_file_id ? photo.data : undefined}
          busy={uploading}
          // Setzt Foto und Vorschaubild auf null; der PATCH loest beide und
          // raeumt die Dateien ab, sofern nirgends sonst verknuepft.
          onRemove={form.photo_file_id ? () => set({ photo_file_id: null, photo_thumb_file_id: null }) : undefined}
          onPick={async (file) => {
            setUploading(true);
            try {
              // Original unveraendert hochladen, daneben ein Vorschaubild fuer
              // Listen und Karten. Das Vorschaubild entsteht parallel zum
              // Upload, hochgeladen wird es erst nach dem Original (sonst
              // bliebe bei einem gescheiterten Original ein loses Vorschaubild).
              // Ohne Vorschaubild (Format nicht lesbar, Upload gescheitert)
              // zeigt die Anzeige das Original.
              const thumbnail = createPhotoThumbnail(file);
              const res = await uploadFile(file);
              const thumbFile = await thumbnail;
              const thumb = thumbFile ? await uploadFile(thumbFile).catch(() => null) : null;
              set({ photo_file_id: res.file.id, photo_thumb_file_id: thumb?.file.id ?? null });
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
      <Field label="Staatsangehörigkeit">
        <Select
          className="hm-select"
          value={form.nationality}
          onChange={(e) => set({ nationality: e.target.value })}
        >
          <option value="">— keine Angabe —</option>
          {NATIONALITY_OPTIONS.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {needsResidencePermit(form.nationality) ? (
        <>
          <Field label="Aufenthaltstitel" hint="Außerhalb von EU, EWR und Schweiz">
            <Select
              className="hm-select"
              value={form.residence_permit}
              onChange={(e) => set({ residence_permit: e.target.value })}
            >
              <option value="">— nicht erfasst —</option>
              {RESIDENCE_PERMIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RESIDENCE_PERMIT_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Aufenthaltstitel gültig bis" hint="Leer bei unbefristeten Titeln; das Dashboard erinnert 90 Tage vorher">
            <input
              className="hm-input"
              type="date"
              value={form.residence_permit_until}
              onChange={(e) => set({ residence_permit_until: e.target.value })}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

export function EmploymentFields({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const { can } = useAuth();
  const mayExecutive = can('leitung', 'bearbeiten');
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();
  const { data: locations } = useLocations();
  const required = requiredFor(form.employee_type);
  const rule = TYPE_RULES[form.employee_type];
  const teamsInDep = (teams ?? []).filter(
    (t) => form.department_id === null || t.department_id === form.department_id,
  );
  return (
    <div className="hm-form-grid">
      <Field label="Mitarbeitertyp" required hint={rule.hint}>
        <Select
          className="hm-select"
          value={form.employee_type}
          onChange={(e) => set({ employee_type: e.target.value as EmployeeType })}
        >
          {EMPLOYEE_TYPES.map((value) => (
            <option key={value} value={value}>
              {EMPLOYEE_TYPE_LABELS[value]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status">
        <Select
          className="hm-select"
          value={form.status}
          onChange={(e) => set({ status: e.target.value as EmployeeStatus })}
        >
          {Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Jobtitel" span2>
        <input className="hm-input" value={form.job_title} onChange={(e) => set({ job_title: e.target.value })} />
      </Field>
      <Field
        label="Leitungsebene"
        span2
        hint={
          mayExecutive
            ? 'Stammdaten, Verträge, Dokumente und Vergütung sehen dann nur Konten mit dem Recht „Leitungsebene“. Verzeichnis, Organigramm und Abwesenheiten bleiben für alle sichtbar.'
            : 'Setzen oder entfernen nur mit dem Recht „Leitungsebene: Bearbeiten“.'
        }
      >
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={form.executive}
            disabled={!mayExecutive}
            onChange={(e) => set({ executive: e.target.checked })}
          />
          Gehört zur Leitungsebene (C-Level)
        </label>
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
        <Select
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
        </Select>
      </Field>
      <Field label="Team">
        <Select
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
        </Select>
      </Field>
      <Field label="Standort">
        <Select
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
        </Select>
      </Field>
      <Field label="Vorgesetzte:r" hint="Ausgeschiedene bleiben sichtbar, solange sie noch eingetragen sind">
        <EmployeeSelect
          value={form.manager_id}
          onChange={(id) => set({ manager_id: id })}
          allowEmpty
          includeInactive
        />
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
        labelAddon={<HalfStepHint />}
        hint={rule.maxWeeklyHours ? `Maximal ${rule.maxWeeklyHours} Stunden` : undefined}
      >
        <input
          className="hm-input"
          type="number"
          min={0}
          max={60}
          step={1}
          value={form.weekly_hours}
          onChange={(e) => set({ weekly_hours: e.target.value })}
        />
      </Field>
      <WorkWeekField form={form} set={set} />
      <HomeOfficeField form={form} set={set} />
      <Field
        label="Jahresurlaub (Tage)"
        required={required.has('annual_leave_days')}
        labelAddon={<HalfStepHint />}
        hint={leaveHint(form)}
      >
        <input
          className="hm-input"
          type="number"
          min={0}
          max={100}
          step={1}
          value={form.annual_leave_days}
          onChange={(e) => set({ annual_leave_days: e.target.value })}
        />
      </Field>
      <Field label="Höchster Abschluss">
        <Select
          className="hm-select"
          value={form.highest_degree}
          onChange={(e) => set({ highest_degree: e.target.value })}
        >
          <option value="">— keine Angabe —</option>
          {HIGHEST_DEGREES.map((d) => (
            <option key={d} value={d}>
              {HIGHEST_DEGREE_LABELS[d]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Fachrichtung">
        <input
          className="hm-input"
          value={form.degree_field}
          onChange={(e) => set({ degree_field: e.target.value })}
          placeholder="z. B. Informatik, Industriekauffrau"
        />
      </Field>
    </div>
  );
}

/**
 * Hinweis unter dem Jahresurlaub: gesetzlicher Mindesturlaub zur
 * Arbeitswoche (§ 3 BUrlG) und, wenn der Eintrag darunter liegt, dass der
 * Saldo das Minimum nimmt. Ohne bekannte Arbeitswoche ein Verweis darauf.
 */
function leaveHint(form: EmployeeFormState): string {
  const days = formDaysPerWeek(form);
  if (form.employee_type === 'freiberufler') return 'Freie Mitarbeit hat keinen Urlaubsanspruch nach BUrlG';
  if (days === null) return 'Arbeitswoche hinterlegen, dann rechnet oHRganize den gesetzlichen Mindesturlaub';
  const minimum = statutoryLeaveDays(days);
  const entered = num(form.annual_leave_days);
  const text = `Gesetzliches Minimum bei ${String(days).replace('.', ',')} Tagen je Woche: ${String(minimum).replace('.', ',')} Tage`;
  return entered !== null && entered < minimum ? `${text}. Der Saldo rechnet mit dem Minimum.` : `${text}; der Rest ist vertraglicher Mehrurlaub.`;
}

/**
 * Home-Office-Tage als Muster: Im Kalender sind sie markiert, einzelne Tage
 * lassen sich dort als Bürotag herausnehmen. Bei fester Arbeitswoche nur deren
 * Tage, sonst Mo bis Fr.
 */
function HomeOfficeField({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const workdays = form.work_mode === 'fest' ? form.work_weekdays : [1, 2, 3, 4, 5];
  const allOn = workdays.length > 0 && workdays.every((d) => form.home_office_weekdays.includes(d));
  const toggle = (day: number) =>
    set({
      home_office_weekdays: form.home_office_weekdays.includes(day)
        ? form.home_office_weekdays.filter((d) => d !== day)
        : [...form.home_office_weekdays, day].sort((a, b) => a - b),
    });
  return (
    <Field
      label="Home Office"
      span2
      hint="Standardmäßig im Home Office an diesen Tagen; abweichende Bürotage im Abwesenheitskalender anklicken"
    >
      <div className="row row--wrap" style={{ gap: 6 }} role="group" aria-label="Home-Office-Tage">
        {WEEKDAY_SHORT.map((label, i) => {
          const day = i + 1;
          if (!workdays.includes(day)) return null;
          const on = form.home_office_weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              className={`hm-chip${on ? ' is-active' : ''}`}
              aria-pressed={on}
              onClick={(e) => {
                e.preventDefault();
                toggle(day);
              }}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          className="hm-btn hm-btn--quiet hm-btn--sm"
          onClick={(e) => {
            e.preventDefault();
            set({ home_office_weekdays: allOn ? [] : [...workdays] });
          }}
        >
          {allOn ? 'Keine' : 'Alle Arbeitstage'}
        </button>
      </div>
    </Field>
  );
}

/** Arbeitswoche: feste Wochentage zum Anklicken oder eine Zahl Tage ohne feste Tage. */
function WorkWeekField({ form, set }: { form: EmployeeFormState; set: SetForm }) {
  const toggleDay = (day: number) =>
    set({
      work_weekdays: form.work_weekdays.includes(day)
        ? form.work_weekdays.filter((d) => d !== day)
        : [...form.work_weekdays, day].sort((a, b) => a - b),
    });
  return (
    <Field
      label="Arbeitswoche"
      span2
      hint={
        form.work_mode === 'fest'
          ? 'Urlaub zählt nur an diesen Tagen; an den übrigen ist die Person im Kalender grau'
          : form.work_mode === 'flexibel'
            ? 'Ohne feste Tage: Anträge schlagen den Anteil der Werktage vor, die tatsächlichen Arbeitstage lassen sich im Antrag eintragen'
            : 'Nicht hinterlegt: gezählt wird Mo bis Fr'
      }
    >
      <div className="row row--wrap" style={{ gap: 10 }}>
        <Select
          className="hm-select"
          style={{ width: 210 }}
          value={form.work_mode}
          onChange={(e) => set({ work_mode: e.target.value as EmployeeFormState['work_mode'] })}
        >
          <option value="">— nicht hinterlegt —</option>
          <option value="fest">Feste Wochentage</option>
          <option value="flexibel">Flexibel (Tage je Woche)</option>
        </Select>
        {form.work_mode === 'fest' && (
          <div className="row" style={{ gap: 6 }} role="group" aria-label="Arbeitstage">
            {WEEKDAY_SHORT.map((label, i) => {
              const day = i + 1;
              const on = form.work_weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={`hm-chip${on ? ' is-active' : ''}`}
                  aria-pressed={on}
                  onClick={(e) => {
                    // Sitzt im <label> des Feldes: sonst reichte der Browser den Klick weiter.
                    e.preventDefault();
                    toggleDay(day);
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {form.work_mode === 'flexibel' && (
          <input
            className="hm-input"
            style={{ width: 120 }}
            type="number"
            min={0.5}
            max={7}
            step={0.5}
            value={form.work_days_per_week}
            onChange={(e) => set({ work_days_per_week: e.target.value })}
            aria-label="Arbeitstage je Woche"
            placeholder="z. B. 3"
          />
        )}
      </div>
    </Field>
  );
}

/**
 * Schwerbehinderung (nur mit dem Recht "Schwerbehinderung"): Grad,
 * Gleichstellung, Ausweis, Notiz und darunter, was der Status mit sich bringt.
 * `readOnly` bei "lesen"; das Backend sperrt das Schreiben zusätzlich.
 */
export function DisabilityFields({ form, set, readOnly }: { form: EmployeeFormState; set: SetForm; readOnly: boolean }) {
  const degree = num(form.disability_degree);
  const notes = disabilityNotes(degree, form.disability_equal);
  return (
    <div className="hm-form-grid">
      <Field label="Grad der Behinderung">
        <Select
          className="hm-select"
          value={form.disability_degree}
          disabled={readOnly}
          onChange={(e) => set({ disability_degree: e.target.value })}
        >
          <option value="">— keiner —</option>
          {DISABILITY_DEGREES.map((d) => (
            <option key={d} value={String(d)}>
              GdB {d}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Ausweis gültig bis" hint="Leer bei unbefristetem Ausweis">
        <input
          className="hm-input"
          type="date"
          value={form.disability_valid_until}
          disabled={readOnly}
          onChange={(e) => set({ disability_valid_until: e.target.value })}
        />
      </Field>
      <Field label="Gleichstellung" span2 hint="Gleichgestellt durch die Agentur für Arbeit (§ 2 Abs. 3 SGB IX), bei GdB 30 oder 40">
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={form.disability_equal}
            disabled={readOnly}
            onChange={(e) => set({ disability_equal: e.target.checked })}
          />
          Schwerbehinderten Menschen gleichgestellt
        </label>
      </Field>
      <Field label="Notiz" span2>
        <textarea
          className="hm-textarea"
          rows={2}
          value={form.disability_note}
          disabled={readOnly}
          onChange={(e) => set({ disability_note: e.target.value })}
        />
      </Field>
      {notes.length > 0 && (
        <ul className="span-2" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
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
      {TAX_CLASSES.length > 0 && (
        <Field
          label="Steuerklasse"
          required={required.has('tax_class')}
          hint={isFreelancer ? 'Entfällt bei freier Mitarbeit' : undefined}
        >
          <Select
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
          </Select>
        </Field>
      )}
      {CHURCH_TAX.length > 0 && (
        <Field label="Kirchensteuer">
          <Select
            className="hm-select"
            value={form.church_tax}
            disabled={isFreelancer}
            onChange={(e) => set({ church_tax: e.target.value })}
          >
            <option value="">— keine Angabe —</option>
            {CHURCH_TAX.map((value) => (
              <option key={value} value={value}>
                {CHURCH_TAX_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
      )}
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
