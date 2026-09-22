import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api, ApiRequestError } from '../../api/client';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { Tooltip } from '../../components/Tooltip';
import {
  balanceExceededQuestion,
  useAbsenceTypes,
  useAllowedTypeIds,
  useDaysPreview,
  type BalanceExceededDetails,
} from './api';
import { Select } from '../../components/Select';

/** Info-Zeichen neben der Beschriftung: erklaert die ausgegrauten Arten. */
function EligibilityHint() {
  return (
    <Tooltip
      content={
        <>
          <span className="hm-tooltip__title">Für diese Person nicht freigegeben</span>
          <span className="hm-tooltip__line">Ausgegraute Arten · Berechtigung unter Abwesenheitsarten</span>
        </>
      }
    >
      <span
        className="hm-info-icon"
        tabIndex={0}
        aria-label="Erklärung zu gesperrten Arten"
        // Sitzt in einem <label>: Ohne preventDefault reichte der Browser den
        // Klick als Aktivierung an das Auswahlfeld weiter und klappte es auf.
        onClick={(e) => e.preventDefault()}
      >
        <Info size={14} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

/** Dialog "Neuer Abwesenheitsantrag" (HR erfasst stellvertretend). */
export function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: types } = useAbsenceTypes();
  // Krankheit laeuft ueber die Krankmeldung (sick_notes samt AU-Frist); das
  // Backend weist die Kategorie hier ohnehin mit 400 ab.
  const activeTypes = (types ?? []).filter((t) => t.active === 1 && t.category !== 'krankheit');

  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [typeId, setTypeId] = useState<number | null>(null);
  // Freigegebene Arten der gewaehlten Person; bis zur Antwort gilt alles als
  // erlaubt, damit die Liste nicht flackert.
  const { data: allowedTypeIds } = useAllowedTypeIds(employeeId);
  const isAllowed = (id: number) => !allowedTypeIds || allowedTypeIds.has(id);
  const hasBlockedTypes = activeTypes.some((t) => !isAllowed(t.id));
  useEffect(() => {
    if (typeId !== null && allowedTypeIds && !allowedTypeIds.has(typeId)) setTypeId(null);
  }, [allowedTypeIds, typeId]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [comment, setComment] = useState('');
  const [approve, setApprove] = useState(false);
  const [balanceWarning, setBalanceWarning] = useState<BalanceExceededDetails | null>(null);
  const selectedType = activeTypes.find((t) => t.id === typeId) ?? null;
  const needsApproval = selectedType ? selectedType.requires_approval === 1 : true;

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
    setApprove(false);
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
        ...(approve && needsApproval ? { approve: true } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['absences'] });
      // Der Dialog ist auch vom Dashboard aus erreichbar (Schnelleintrag).
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(approve || !needsApproval ? 'Abwesenheit wurde erfasst und genehmigt' : 'Antrag wurde erfasst');
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
            {approve && needsApproval ? 'Erfassen und genehmigen' : 'Antrag erfassen'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field
          label="Abwesenheitsart"
          required
          span2
          labelAddon={hasBlockedTypes ? <EligibilityHint /> : undefined}
        >
          <Select
            className="hm-select"
            value={typeId ?? ''}
            onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— auswählen —</option>
            {activeTypes.map((t) => {
              const allowed = isAllowed(t.id);
              return (
                <option key={t.id} value={t.id} disabled={!allowed}>
                  {t.name}
                  {t.max_days_per_year !== null ? ` (max. ${t.max_days_per_year} Tage/Jahr)` : ''}
                  {allowed ? '' : ' · für diese Person nicht freigegeben'}
                </option>
              );
            })}
          </Select>
          {/* Der Hinweis traegt einen Link, das hint-Attribut des Feldes nur Text. */}
          <span className="hm-field__hint">
            Krankmeldungen unter{' '}
            <Link className="hm-text-link" to="/abwesenheit/krankmeldungen" onClick={onClose}>
              Krankmeldungen
            </Link>{' '}
            erfassen.
          </span>
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
        <Field
          label="Nachträgliche Erfassung"
          span2
          hint={
            needsApproval
              ? 'Für vergessene Anträge oder Personen ohne Portalzugang: Die Abwesenheit gilt sofort als genehmigt. Die eigene Abwesenheit bleibt ausgenommen (Vier-Augen-Prinzip).'
              : 'Diese Art ist nicht genehmigungspflichtig und wird ohnehin sofort genehmigt.'
          }
        >
          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={approve && needsApproval}
              disabled={!needsApproval}
              onChange={(e) => setApprove(e.target.checked)}
            />
            Direkt genehmigen
          </label>
        </Field>
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
