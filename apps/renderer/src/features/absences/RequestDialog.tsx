import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '../../api/client';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { balanceExceededQuestion, useAbsenceTypes, useDaysPreview, type BalanceExceededDetails } from './api';

/** Dialog "Neuer Abwesenheitsantrag" (HR erfasst stellvertretend). */
export function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: types } = useAbsenceTypes();
  const activeTypes = (types ?? []).filter((t) => t.active === 1);

  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [comment, setComment] = useState('');
  const [balanceWarning, setBalanceWarning] = useState<BalanceExceededDetails | null>(null);

  const sameDay = dateFrom !== '' && dateFrom === dateTo;
  // Bei einem eintägigen Zeitraum sind "erster" und "letzter" Tag derselbe —
  // das Backend lehnt beide Häkchen ab. Wie im Portal zählt dann nur der halbe
  // Start; sonst bliebe nach einer Datumsänderung die ungültige Kombination
  // stehen, obwohl die Checkbox-Handler sie beim Anhaken ausschließen.
  const effectiveHalfEnd = halfEnd && !sameDay;

  const preview = useDaysPreview(employeeId, dateFrom, dateTo, halfStart, effectiveHalfEnd);

  const reset = () => {
    setEmployeeId(null);
    setTypeId(null);
    setDateFrom('');
    setDateTo('');
    setHalfStart(false);
    setHalfEnd(false);
    setComment('');
    setBalanceWarning(null);
  };

  const create = useMutation({
    mutationFn: (overrideBalance: boolean) =>
      api.post('/api/absences/requests', {
        employee_id: employeeId,
        type_id: typeId,
        date_from: dateFrom,
        date_to: dateTo,
        half_day_start: halfStart,
        half_day_end: effectiveHalfEnd,
        comment: comment.trim() || undefined,
        ...(overrideBalance ? { override_balance: true } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      // Der Dialog ist auch vom Dashboard aus erreichbar (Schnelleintrag).
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Antrag wurde erfasst');
      reset();
      onClose();
    },
    // BALANCE_EXCEEDED ist kein Fehler, sondern eine Rückfrage: erst die
    // ausdrückliche Bestätigung schickt den Request mit override_balance erneut.
    onError: (e: Error) => {
      if (e instanceof ApiRequestError && e.code === 'BALANCE_EXCEEDED') {
        setBalanceWarning(e.details as BalanceExceededDetails);
        return;
      }
      toast.error(e.message);
    },
  });

  const valid = !!employeeId && !!typeId && !!dateFrom && !!dateTo && dateFrom <= dateTo;

  return (
    <>
    <Modal
      title="Neuer Abwesenheitsantrag"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!valid || create.isPending}
            onClick={() => create.mutate(false)}
          >
            Antrag erfassen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field label="Abwesenheitsart" required span2>
          <select
            className="hm-select"
            value={typeId ?? ''}
            onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— auswählen —</option>
            {activeTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.max_days_per_year !== null ? ` (max. ${t.max_days_per_year} Tage/Jahr)` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Von" required>
          <input className="hm-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Field>
        <Field label="Bis" required error={dateFrom && dateTo && dateTo < dateFrom ? 'Enddatum liegt vor dem Startdatum' : undefined}>
          <input className="hm-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Field>
        <label className="hm-checkbox">
          <input
            type="checkbox"
            checked={halfStart}
            onChange={(e) => setHalfStart(e.target.checked)}
          />
          Erster Tag nur halb
        </label>
        <label className="hm-checkbox">
          <input
            type="checkbox"
            checked={effectiveHalfEnd}
            disabled={sameDay}
            onChange={(e) => setHalfEnd(e.target.checked)}
          />
          Letzter Tag nur halb
        </label>
        <Field label="Kommentar" span2>
          <textarea className="hm-textarea" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
        </Field>
      </div>
      <div
        style={{
          marginTop: 14,
          padding: '10px 14px',
          background: 'var(--gray-100)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        {valid
          ? preview.data
            ? (
              <>
                Gezählte Abwesenheitstage:{' '}
                <strong style={{ color: 'var(--text-primary)' }}>
                  {preview.data.days_counted.toLocaleString('de-DE')}
                </strong>{' '}
                (Bundesland {preview.data.bundesland}; Wochenenden, Feiertage und Betriebsruhe zählen nicht)
              </>
            )
            : 'Berechne gezählte Tage …'
          : 'Wählen Sie Mitarbeiter:in und Zeitraum für die Tage-Vorschau.'}
      </div>
    </Modal>
    <ConfirmDialog
      open={balanceWarning !== null}
      title="Urlaubssaldo wird überzogen"
      message={balanceWarning ? balanceExceededQuestion(balanceWarning, 'erfassen') : ''}
      confirmLabel="Trotzdem erfassen"
      danger={false}
      onConfirm={() => create.mutate(true)}
      onClose={() => setBalanceWarning(null)}
    />
    </>
  );
}
