import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CONTRACT_TYPE_LABELS,
  EMPLOYEE_TYPE_LABELS,
  PROBATION_MONTH_OPTIONS,
  employeeTypesFor,
  probationEndFor,
  probationMonths,
  type ContractDto,
  type ContractType,
  type EmployeeType,
} from '@ohrganize/shared';
import { COUNTRY } from '../../lib/locale';
import { api, uploadFile } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { FilePicker } from '../../components/FilePicker';
import { useToast } from '../../components/Toast';
import { Select } from '../../components/Select';
import { HalfStepHint } from '../../components/HalfStepHint';
import type { EmployeeRow } from './api';
import { WorkWeekControls, workScheduleToForm, workScheduleToPayload, type WorkWeekState } from './employeeForm';

const EMPLOYEE_TYPES = employeeTypesFor(COUNTRY);

interface ContractForm extends WorkWeekState {
  contract_type: ContractType;
  /** Beschäftigungsart dieser Version; '' = ohne Angabe (alte Versionen). */
  employee_type: EmployeeType | '';
  valid_from: string;
  valid_to: string;
  probation_end: string;
  notice_period_weeks: string;
  weekly_hours: string;
  annual_leave_days: string;
  fixed_term_reason: string;
  note: string;
  document_file_id: number | null;
}

const EMPTY: ContractForm = {
  ...workScheduleToForm({ work_weekdays: null, work_days_per_week: null }),
  contract_type: 'unbefristet',
  employee_type: '',
  valid_from: '',
  valid_to: '',
  probation_end: '',
  notice_period_weeks: '',
  weekly_hours: '',
  annual_leave_days: '',
  fixed_term_reason: '',
  note: '',
  document_file_id: null,
};

const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

/**
 * `correct` gesetzt = Korrektur der offenen Version, sonst neue Version.
 * `employee`: heutige Stammdaten, Vorgabe einer neuen Version
 * (Beschäftigungsart, Stunden, Urlaub, Arbeitswoche); geändert wird meist nur
 * ein Wert.
 */
export function ContractModal({
  open,
  onClose,
  employeeId,
  correct,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employeeId: number;
  correct?: ContractDto | null;
  employee?: Pick<EmployeeRow, 'employee_type' | 'weekly_hours' | 'annual_leave_days' | 'work_weekdays' | 'work_days_per_week'>;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<ContractForm>(EMPTY);
  const [uploading, setUploading] = useState(false);
  const [docFile, setDocFile] = useState<File | null>(null);
  const set = (patch: Partial<ContractForm>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!open) return;
    setDocFile(null);
    if (correct) {
      setForm({
        contract_type: correct.contract_type,
        employee_type: correct.employee_type ?? '',
        valid_from: correct.valid_from,
        valid_to: correct.valid_to ?? '',
        probation_end: correct.probation_end ?? '',
        notice_period_weeks: correct.notice_period_weeks !== null ? String(correct.notice_period_weeks) : '',
        weekly_hours: correct.weekly_hours !== null ? String(correct.weekly_hours) : '',
        annual_leave_days: correct.annual_leave_days !== null ? String(correct.annual_leave_days) : '',
        fixed_term_reason: correct.fixed_term_reason ?? '',
        note: correct.note ?? '',
        document_file_id: correct.document_file_id,
        ...workScheduleToForm(correct),
      });
    } else {
      setForm({
        ...EMPTY,
        employee_type: employee?.employee_type ?? '',
        weekly_hours: employee?.weekly_hours != null ? String(employee.weekly_hours) : '',
        annual_leave_days: employee?.annual_leave_days != null ? String(employee.annual_leave_days) : '',
        ...(employee ? workScheduleToForm(employee) : {}),
      });
    }
  }, [open, correct, employee]);

  // Probezeit als Länge: aus Beginn und Ende abgeleitet, nicht gespeichert.
  // Verschiebt sich der Beginn, wandert ein in Monaten gewähltes Ende mit.
  const months =
    form.valid_from && form.probation_end ? probationMonths(form.valid_from, form.probation_end) : null;
  const setValidFrom = (validFrom: string) =>
    set({
      valid_from: validFrom,
      ...(months !== null && validFrom ? { probation_end: probationEndFor(validFrom, months) } : {}),
    });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        contract_type: form.contract_type,
        employee_type: form.employee_type || null,
        valid_from: form.valid_from,
        valid_to: form.valid_to || null,
        probation_end: form.probation_end || null,
        notice_period_weeks: form.notice_period_weeks.trim() === '' ? null : Number(form.notice_period_weeks),
        weekly_hours: num(form.weekly_hours),
        annual_leave_days: num(form.annual_leave_days),
        ...workScheduleToPayload(form),
        fixed_term_reason: form.fixed_term_reason.trim() || null,
        document_file_id: form.document_file_id,
        note: form.note.trim() || null,
      };
      return correct
        ? api.patch(`/api/contracts/${correct.id}`, payload)
        : api.post(`/api/employees/${employeeId}/contracts`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contracts', employeeId] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast.success(correct ? 'Offene Vertragsversion korrigiert' : 'Neue Vertragsversion angelegt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={correct ? 'Offene Vertragsversion korrigieren' : 'Neue Vertragsversion'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            // Auch während des Dokument-Uploads sperren: Ein Klick in dieser
            // Lücke speicherte den Vertrag sonst still ohne document_file_id.
            disabled={!form.valid_from || save.isPending || uploading}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Wird gespeichert…' : uploading ? 'Dokument wird hochgeladen…' : 'Speichern'}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
        {correct
          ? 'Eine Korrektur ändert diese Version für ihren ganzen Zeitraum. Ändern sich Wochenstunden, Arbeitswoche oder Jahresurlaub erst ab einem Datum, bitte eine neue Version anlegen.'
          : 'Eine bestehende offene Version wird automatisch zum Vortag des neuen Beginns geschlossen. Die Historie bleibt vollständig erhalten.'}{' '}
        Ändern sich Arbeitswoche oder Jahresurlaub im Lauf eines Jahres, rechnet der Urlaubsanspruch für jeden Zeitraum
        mit den Werten der jeweils geltenden Version.
      </p>
      <div className="hm-form-grid">
        <Field label="Vertragsart" required>
          <Select
            className="hm-select"
            value={form.contract_type}
            onChange={(e) => set({ contract_type: e.target.value as ContractType })}
          >
            {Object.entries(CONTRACT_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Beschäftigungsart" hint="Seit wann jemand Vollzeit, Werkstudent usw. ist, zeigt die Vertragshistorie">
          <Select
            className="hm-select"
            value={form.employee_type}
            onChange={(e) => set({ employee_type: e.target.value as EmployeeType | '' })}
          >
            <option value="">— ohne Angabe —</option>
            {EMPLOYEE_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMPLOYEE_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Gültig ab" required>
          <input className="hm-input" type="date" value={form.valid_from} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Gültig bis" hint="Leer = unbefristet offen">
          <input className="hm-input" type="date" value={form.valid_to} onChange={(e) => set({ valid_to: e.target.value })} />
        </Field>
        <Field label="Probezeit" hint={form.valid_from ? undefined : 'Erst den Beginn setzen'}>
          <Select
            className="hm-select"
            value={months !== null ? String(months) : form.probation_end ? 'datum' : ''}
            disabled={!form.valid_from}
            onChange={(e) =>
              set({
                probation_end:
                  e.target.value === ''
                    ? ''
                    : e.target.value === 'datum'
                      ? form.probation_end
                      : probationEndFor(form.valid_from, Number(e.target.value)),
              })
            }
          >
            <option value="">Keine Probezeit</option>
            {PROBATION_MONTH_OPTIONS.map((m) => (
              <option key={m} value={String(m)}>
                {m} {m === 1 ? 'Monat' : 'Monate'}
              </option>
            ))}
            {months === null && form.probation_end && <option value="datum">Eigenes Enddatum</option>}
          </Select>
        </Field>
        <Field label="Probezeit bis" hint="Ergibt sich aus der Länge, lässt sich aber auch frei setzen">
          <input className="hm-input" type="date" value={form.probation_end} onChange={(e) => set({ probation_end: e.target.value })} />
        </Field>
        <Field label="Kündigungsfrist (Wochen)">
          <input
            className="hm-input"
            type="number"
            min={0}
            max={104}
            value={form.notice_period_weeks}
            onChange={(e) => set({ notice_period_weeks: e.target.value })}
          />
        </Field>
        <Field label="Wochenstunden" hint="Wird ab Beginn auf die Stammdaten gespiegelt" labelAddon={<HalfStepHint />}>
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
        <Field label="Jahresurlaub (Tage)" hint="Wird ab Beginn auf die Stammdaten gespiegelt" labelAddon={<HalfStepHint />}>
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
        <Field
          label="Arbeitswoche"
          span2
          hint="Gilt ab Beginn dieser Version und wird dann auf die Stammdaten gespiegelt; kommende Anträge zählen danach neu"
        >
          <WorkWeekControls value={form} onChange={set} />
        </Field>
        {form.contract_type === 'befristet' && (
          <Field label="Befristungsgrund" span2 hint="Sachgrund nach TzBfG oder sachgrundlos">
            <input
              className="hm-input"
              value={form.fixed_term_reason}
              onChange={(e) => set({ fixed_term_reason: e.target.value })}
            />
          </Field>
        )}
        <Field label="Vertragsdokument (optional)" span2>
          <FilePicker
            file={docFile}
            busy={uploading}
            accept=".pdf,.doc,.docx"
            hint="PDF oder Word-Dokument"
            existingLabel={form.document_file_id && !docFile ? 'Dokument hinterlegt' : undefined}
            onFile={async (file) => {
              setDocFile(file);
              if (!file) {
                set({ document_file_id: null });
                return;
              }
              setUploading(true);
              try {
                const res = await uploadFile(file);
                set({ document_file_id: res.file.id });
              } catch (err) {
                // Die gewählte Datei ist nie im Backend angekommen — bliebe
                // sie im Picker stehen, sähe der Dialog nach hinterlegtem
                // Dokument aus. document_file_id bleibt unangetastet (bei
                // einer Korrektur zeigt es weiter auf das bestehende Dokument).
                setDocFile(null);
                toast.error(err instanceof Error ? err.message : 'Upload fehlgeschlagen');
              } finally {
                setUploading(false);
              }
            }}
          />
        </Field>
        <Field label="Notiz" span2>
          <textarea className="hm-textarea" value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
