import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CONTRACT_TYPE_LABELS, type ContractDto, type ContractType } from '@hrmonic/shared';
import { api, uploadFile } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { FilePicker } from '../../components/FilePicker';
import { useToast } from '../../components/Toast';

interface ContractForm {
  contract_type: ContractType;
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
  contract_type: 'unbefristet',
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

/** `correct` gesetzt = Korrektur der offenen Version, sonst neue Version. */
export function ContractModal({
  open,
  onClose,
  employeeId,
  correct,
}: {
  open: boolean;
  onClose: () => void;
  employeeId: number;
  correct?: ContractDto | null;
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
        valid_from: correct.valid_from,
        valid_to: correct.valid_to ?? '',
        probation_end: correct.probation_end ?? '',
        notice_period_weeks: correct.notice_period_weeks !== null ? String(correct.notice_period_weeks) : '',
        weekly_hours: correct.weekly_hours !== null ? String(correct.weekly_hours) : '',
        annual_leave_days: correct.annual_leave_days !== null ? String(correct.annual_leave_days) : '',
        fixed_term_reason: correct.fixed_term_reason ?? '',
        note: correct.note ?? '',
        document_file_id: correct.document_file_id,
      });
    } else {
      setForm(EMPTY);
    }
  }, [open, correct]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        contract_type: form.contract_type,
        valid_from: form.valid_from,
        valid_to: form.valid_to || null,
        probation_end: form.probation_end || null,
        notice_period_weeks: form.notice_period_weeks.trim() === '' ? null : Number(form.notice_period_weeks),
        weekly_hours: num(form.weekly_hours),
        annual_leave_days: num(form.annual_leave_days),
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
            disabled={!form.valid_from || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Wird gespeichert…' : 'Speichern'}
          </button>
        </>
      }
    >
      {!correct && (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
          Eine bestehende offene Version wird automatisch zum Vortag des neuen Beginns geschlossen —
          die Historie bleibt vollständig erhalten.
        </p>
      )}
      <div className="hm-form-grid">
        <Field label="Vertragsart" required>
          <select
            className="hm-select"
            value={form.contract_type}
            onChange={(e) => set({ contract_type: e.target.value as ContractType })}
          >
            {Object.entries(CONTRACT_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Gültig ab" required>
          <input className="hm-input" type="date" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} />
        </Field>
        <Field label="Gültig bis" hint="Leer = unbefristet offen">
          <input className="hm-input" type="date" value={form.valid_to} onChange={(e) => set({ valid_to: e.target.value })} />
        </Field>
        <Field label="Probezeit bis">
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
        <Field label="Wochenstunden" hint="Wird auf die Stammdaten gespiegelt">
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
        <Field label="Jahresurlaub (Tage)" hint="Wird auf die Stammdaten gespiegelt">
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
