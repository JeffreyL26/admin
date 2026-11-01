import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Columns3, History, Plus, Receipt, ScrollText, Wallet, X } from 'lucide-react';
import {
  formatDate,
  formatEuro,
  todayIsoLocal,
  BONUS_KIND_LABELS,
  EMPLOYEE_TYPE_LABELS,
  SALARY_COMPONENT_KINDS,
  SALARY_COMPONENT_LABELS,
  type BonusKind,
  type EmployeeType,
  type SalaryComponentKind,
} from '@ohrganize/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useBackTo } from '../../lib/backTo';
import { tourEvent } from '../tours/events';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { parseEuroInput, STATUS_TONES } from './lib';
import { Select } from '../../components/Select';
import { Popover } from '../../components/Popover';
import { readJson, writeJson } from '../../lib/localStore';
import { LOCALE } from '../../lib/locale';
import { SortableTh } from '../../components/SortableTh';
import { TableScroller } from '../../components/TableScroller';
import { useTableSort } from '../../lib/useTableSort';

interface SalaryOverviewRow {
  employee_id: number;
  first_name: string;
  last_name: string;
  employee_type: string;
  status: string;
  job_title: string | null;
  monthly_gross_cents: number;
  component_count: number;
  last_change: string | null;
  /** Jüngster Beginn von Grundgehalt oder Stundenlohn, der schon gilt. */
  last_adjustment: string | null;
  weekly_hours: number | null;
  fte: number | null;
  hourly_rate_cents: number | null;
  /** true: aus Monatsbrutto und Vertragsstunden gerechnet, kein vereinbarter Stundenlohn. */
  hourly_derived: boolean;
  annual_gross_cents: number;
  /** Variable Vergütung des laufenden Jahres je Art (Boni & Variable). */
  extras: { kind: string; count: number }[];
}

/**
 * Spalten der Gehaltsübersicht, je Gerät wählbar wie in der Mitarbeiterliste
 * (`ohrganize.salaryList`). `sort` ist der Schlüssel aus SALARY_SORT.
 */
type SalaryColumnId =
  | 'name' | 'type' | 'job_title' | 'weekly_hours' | 'fte' | 'hourly' | 'gross' | 'annual'
  | 'extras' | 'components' | 'last_adjustment' | 'last_change';
interface SalaryColumn {
  id: SalaryColumnId;
  label: string;
  num?: boolean;
  fixed?: boolean;
  defaultVisible?: boolean;
  hint?: string;
}
const SALARY_COLUMNS: SalaryColumn[] = [
  { id: 'name', label: 'Mitarbeiter:in', fixed: true, defaultVisible: true },
  { id: 'type', label: 'Beschäftigung', defaultVisible: true },
  { id: 'job_title', label: 'Position', defaultVisible: true },
  { id: 'weekly_hours', label: 'Wochenstunden', num: true },
  { id: 'fte', label: 'FTE', num: true, hint: 'Anteil einer Vollzeitstelle (Einstellungen: Vollzeit-Wochenstunden)' },
  { id: 'hourly', label: 'Stundenlohn', num: true, hint: 'Vereinbart oder, kursiv, aus Monatsbrutto und Vertragsstunden gerechnet' },
  { id: 'gross', label: 'Monatsbrutto', num: true, defaultVisible: true },
  { id: 'annual', label: 'Jahresbrutto', num: true, defaultVisible: true, hint: '12 × Monatsbrutto, ohne Boni und Einmalzahlungen' },
  { id: 'extras', label: 'Extras', defaultVisible: true, hint: 'Boni, Provisionen und Einmalzahlungen im laufenden Jahr' },
  { id: 'components', label: 'Komponenten', num: true },
  { id: 'last_adjustment', label: 'Letzte Gehaltsanpassung', defaultVisible: true, hint: 'Jüngster Beginn von Grundgehalt oder Stundenlohn, der schon gilt' },
  { id: 'last_change', label: 'Letzte Änderung', hint: 'Jüngster Beginn irgendeiner Komponente, auch Zulagen und Abzüge' },
];
const SALARY_VIEW_KEY = 'ohrganize.salaryList';
const DEFAULT_SALARY_COLUMNS = SALARY_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);

function loadSalaryColumns(): SalaryColumnId[] {
  const stored = readJson<unknown>(SALARY_VIEW_KEY);
  if (!Array.isArray(stored)) return DEFAULT_SALARY_COLUMNS;
  const known = new Set(SALARY_COLUMNS.map((c) => c.id));
  const chosen = stored.filter((c): c is SalaryColumnId => typeof c === 'string' && known.has(c as SalaryColumnId));
  return chosen.length ? chosen : DEFAULT_SALARY_COLUMNS;
}

function salaryCell(r: SalaryOverviewRow, id: SalaryColumnId): React.ReactNode {
  switch (id) {
    case 'name':
      return (
        <span style={{ fontWeight: 600 }}>
          {r.last_name}, {r.first_name} {r.status !== 'aktiv' && <Badge tone="neutral">ausgeschieden</Badge>}
        </span>
      );
    case 'type':
      return <Badge tone="blue">{EMPLOYEE_TYPE_LABELS[r.employee_type as EmployeeType] ?? r.employee_type}</Badge>;
    case 'job_title':
      return r.job_title ?? '—';
    case 'weekly_hours':
      return r.weekly_hours !== null ? `${r.weekly_hours.toLocaleString(LOCALE)} h` : '—';
    case 'fte':
      return r.fte !== null ? r.fte.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
    case 'hourly':
      return r.hourly_rate_cents !== null ? (
        <span style={r.hourly_derived ? { fontStyle: 'italic', color: 'var(--text-secondary)' } : undefined}>
          {formatEuro(r.hourly_rate_cents)}
        </span>
      ) : (
        '—'
      );
    case 'gross':
      return <span style={{ fontWeight: 600 }}>{formatEuro(r.monthly_gross_cents)}</span>;
    case 'annual':
      return formatEuro(r.annual_gross_cents);
    case 'extras':
      return r.extras.length === 0 ? (
        '—'
      ) : (
        <span className="row row--wrap" style={{ gap: 4 }}>
          {r.extras.map((x) => (
            <Link
              key={x.kind}
              className="hm-badge hm-badge--navy"
              to={`/verguetung/boni?person=${r.employee_id}&jahr=${todayIsoLocal().slice(0, 4)}`}
              onClick={(e) => e.stopPropagation()}
            >
              {BONUS_KIND_LABELS[x.kind as BonusKind] ?? x.kind}
              {x.count > 1 ? ` × ${x.count}` : ''}
            </Link>
          ))}
        </span>
      );
    case 'components':
      return r.component_count;
    case 'last_adjustment':
      return r.last_adjustment ? formatDate(r.last_adjustment) : '—';
    case 'last_change':
      return r.last_change ? formatDate(r.last_change) : '—';
    default:
      return null;
  }
}

/** Sortierbare Spalten der Übersicht (lib/useTableSort.ts). */
const SALARY_SORT: Record<SalaryColumnId, (r: SalaryOverviewRow) => string | number | null> = {
  name: (r) => `${r.last_name} ${r.first_name}`,
  type: (r) => EMPLOYEE_TYPE_LABELS[r.employee_type as EmployeeType] ?? r.employee_type,
  job_title: (r) => r.job_title,
  weekly_hours: (r) => r.weekly_hours,
  fte: (r) => r.fte,
  hourly: (r) => r.hourly_rate_cents,
  gross: (r) => r.monthly_gross_cents,
  annual: (r) => r.annual_gross_cents,
  extras: (r) => r.extras.reduce((n, x) => n + x.count, 0) || null,
  components: (r) => r.component_count,
  last_adjustment: (r) => r.last_adjustment,
  last_change: (r) => r.last_change,
};
const SALARY_SORT_DEFAULT = { key: 'name', dir: 'asc' } as const;
const salaryTieBreak = (r: SalaryOverviewRow) => `${r.last_name} ${r.first_name}`;

interface ComponentRow {
  id: number;
  kind: string;
  amount_cents: number;
  monthly_cents?: number;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
}

interface ChangeRequestRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  kind: string;
  new_amount_cents: number;
  effective_date: string;
  reason: string;
  status: string;
  requested_by_user_id: number | null;
  requested_by_name: string | null;
  decided_by_user_id: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

interface AuditEntry {
  id: number;
  action: string;
  created_at: string;
  user_name: string | null;
  details: {
    kind?: string;
    old_amount_cents?: number | null;
    new_amount_cents?: number;
    effective_date?: string;
    valid_from?: string;
    reason?: string | null;
    decision_note?: string | null;
  } | null;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  'salary_component.create': 'Komponente angelegt',
  'salary_change_request.create': 'Änderung beantragt',
  'salary_change_request.approve': 'Änderung genehmigt',
  'salary_change_request.reject': 'Änderung abgelehnt',
};

function kindLabel(kind: string): string {
  return SALARY_COMPONENT_LABELS[kind as SalaryComponentKind] ?? kind;
}

function ChangeRequestDialog({
  open,
  onClose,
  presetEmployeeId,
}: {
  open: boolean;
  onClose: () => void;
  presetEmployeeId?: number | null;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(presetEmployeeId ?? null);
  const [kind, setKind] = useState<string>('grundgehalt');
  const [amount, setAmount] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reason, setReason] = useState('');

  React.useEffect(() => {
    if (open) setEmployeeId(presetEmployeeId ?? null);
  }, [open, presetEmployeeId]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/compensation/change-requests', {
        employee_id: employeeId,
        kind,
        new_amount_cents: parseEuroInput(amount),
        effective_date: effectiveDate,
        reason,
      }),
    onSuccess: () => {
      toast.success('Änderungsantrag wurde angelegt');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setAmount('');
      setReason('');
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Antrag fehlgeschlagen'),
  });

  const valid = employeeId && parseEuroInput(amount) && effectiveDate && reason.trim().length >= 3;

  return (
    <Modal
      title="Gehaltsänderungsanfrage dokumentieren"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!valid || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Antrag stellen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field label="Art" required>
          <Select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SALARY_COMPONENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Neuer Betrag (€)"
          required
          hint={kind === 'stundenlohn' ? 'Betrag je Stunde' : 'Monatsbetrag'}
        >
          <input
            className="hm-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="z. B. 4.200,00"
          />
        </Field>
        <Field label="Wirksam ab" required>
          <input
            type="date"
            className="hm-input"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </Field>
        <Field label="Begründung" required span2 hint="Pflichtfeld (wird im Audit-Log dokumentiert)">
          <textarea
            className="hm-textarea"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="z. B. Beförderung, Tarifanpassung, Marktanpassung …"
          />
        </Field>
      </div>
    </Modal>
  );
}

function ComponentDialog({
  open,
  onClose,
  employeeId,
}: {
  open: boolean;
  onClose: () => void;
  employeeId: number;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<string>('grundgehalt');
  const [amount, setAmount] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/api/compensation/employees/${employeeId}/components`, {
        kind,
        amount_cents: parseEuroInput(amount),
        valid_from: validFrom,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Gehaltskomponente wurde angelegt');
      tourEvent('gehaelter.component-saved');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setAmount('');
      setNote('');
      onClose();
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Anlegen fehlgeschlagen'),
  });

  return (
    <Modal
      title="Gehaltskomponente hinzufügen"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!parseEuroInput(amount) || !validFrom || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Anlegen
          </button>
        </>
      }
    >
      <div className="hm-form-grid" data-tour="gehaelter-component-form">
        <Field label="Art" required>
          <Select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SALARY_COMPONENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Betrag (€)"
          required
          hint={kind === 'stundenlohn' ? 'Betrag je Stunde' : 'Monatsbetrag'}
        >
          <input
            className="hm-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="z. B. 350,00"
          />
        </Field>
        <Field label="Gültig ab" required hint="Ein gültiger Vorgängereintrag gleicher Art wird automatisch geschlossen">
          <input
            type="date"
            className="hm-input"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
        </Field>
        <Field label="Notiz">
          <input className="hm-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Vier-Augen-Prinzip (Vorbild absences/RequestsPage.tsx): Das Backend weist die
 * Genehmigung des eigenen Antrags mit 403 ab. Die Schaltflaeche ist deshalb
 * schon hier gesperrt, damit niemand vergeblich klickt; Ablehnen bleibt
 * moeglich (Rueckzug, kein Entscheid).
 */
function useIsOwnRequest() {
  const { user } = useAuth();
  const ownUserId = user?.id ?? null;
  return (r: ChangeRequestRow) => ownUserId !== null && r.requested_by_user_id === ownUserId;
}

function PendingRequests() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const isOwnRequest = useIsOwnRequest();
  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'change-requests', 'beantragt'],
    queryFn: () =>
      api.get<{ requests: ChangeRequestRow[] }>('/api/compensation/change-requests?status=beantragt'),
    select: (d) => d.requests,
  });
  const [decideFor, setDecideFor] = useState<{ request: ChangeRequestRow; decision: 'genehmigt' | 'abgelehnt' } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');

  const decide = useMutation({
    mutationFn: (p: { id: number; decision: string; decision_note: string | null }) =>
      api.post(`/api/compensation/change-requests/${p.id}/decide`, {
        decision: p.decision,
        decision_note: p.decision_note,
      }),
    onSuccess: (_d, p) => {
      toast.success(p.decision === 'genehmigt' ? 'Antrag genehmigt und angewendet' : 'Antrag abgelehnt');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setDecideFor(null);
      setDecisionNote('');
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Entscheidung fehlgeschlagen'),
  });

  if (isLoading || !data || data.length === 0) return null;

  return (
    <Card title={`Offene Änderungsanträge (${data.length})`} flush>
      <div className="hm-table-wrap">
        <table className="hm-table">
          <thead>
            <tr>
              <th>Mitarbeiter:in</th>
              <th>Art</th>
              <th className="num">Neuer Betrag</th>
              <th>Wirksam ab</th>
              <th>Begründung</th>
              <th>Beantragt von</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.last_name}, {r.first_name}
                </td>
                <td>{kindLabel(r.kind)}</td>
                <td className="num">{formatEuro(r.new_amount_cents)}</td>
                <td>{formatDate(r.effective_date)}</td>
                <td style={{ maxWidth: 260 }}>{r.reason}</td>
                <td>{r.requested_by_name ?? '—'}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <Tooltip
                      content={
                        isOwnRequest(r) ? (
                          <>
                            <span className="hm-tooltip__title">Vier-Augen-Prinzip</span>
                            <span className="hm-tooltip__line">
                              Muss von einer anderen berechtigten Person genehmigt werden.
                            </span>
                          </>
                        ) : null
                      }
                    >
                      {/* Ein gesperrter Knopf nimmt keine Mausereignisse an: Der Tooltip
                          haengt deshalb an der Huelle, der Knopf selbst ist dann "durchlaessig". */}
                      <span style={{ display: 'inline-flex' }}>
                        <button
                          className="hm-btn hm-btn--primary hm-btn--sm"
                          disabled={isOwnRequest(r)}
                          style={isOwnRequest(r) ? { pointerEvents: 'none' } : undefined}
                          onClick={() => setDecideFor({ request: r, decision: 'genehmigt' })}
                        >
                          <Check size={14} /> Genehmigen
                        </button>
                      </span>
                    </Tooltip>
                    <button
                      className="hm-btn hm-btn--danger hm-btn--sm"
                      onClick={() => setDecideFor({ request: r, decision: 'abgelehnt' })}
                    >
                      <X size={14} /> Ablehnen
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        title={decideFor?.decision === 'genehmigt' ? 'Antrag genehmigen' : 'Antrag ablehnen'}
        open={!!decideFor}
        onClose={() => setDecideFor(null)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setDecideFor(null)}>
              Abbrechen
            </button>
            <button
              className={`hm-btn ${decideFor?.decision === 'genehmigt' ? 'hm-btn--primary' : 'hm-btn--danger'}`}
              disabled={decide.isPending}
              onClick={() =>
                decideFor &&
                decide.mutate({
                  id: decideFor.request.id,
                  decision: decideFor.decision,
                  decision_note: decisionNote.trim() || null,
                })
              }
            >
              {decideFor?.decision === 'genehmigt' ? 'Genehmigen & anwenden' : 'Ablehnen'}
            </button>
          </>
        }
      >
        {decideFor && (
          <div className="stack" style={{ gap: 12 }}>
            <p style={{ color: 'var(--text-secondary)' }}>
              {decideFor.request.last_name}, {decideFor.request.first_name} —{' '}
              {kindLabel(decideFor.request.kind)} auf{' '}
              <strong>{formatEuro(decideFor.request.new_amount_cents)}</strong> zum{' '}
              {formatDate(decideFor.request.effective_date)}.
            </p>
            <Field label="Anmerkung zur Entscheidung">
              <textarea
                className="hm-textarea"
                rows={2}
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
              />
            </Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

/** Entschiedene Antraege (genehmigt oder abgelehnt) mit Entscheider, Datum und Anmerkung. */
function DecidedRequests() {
  const [status, setStatus] = useState<'genehmigt' | 'abgelehnt'>('genehmigt');
  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'change-requests', status],
    queryFn: () =>
      api.get<{ requests: ChangeRequestRow[] }>(`/api/compensation/change-requests?status=${status}`),
    select: (d) => d.requests,
  });

  return (
    <div data-tour="gehaelter-decided">
      <Card
        flush
        title={
          <Tabs
            size="sm"
            ariaLabel="Entschiedene Anträge"
            tabs={[
              { key: 'genehmigt', label: 'Genehmigte Anträge' },
              { key: 'abgelehnt', label: 'Abgelehnte Anträge' },
            ]}
            active={status}
            onChange={(k) => {
              setStatus(k as 'genehmigt' | 'abgelehnt');
              tourEvent('gehaelter.decided-viewed');
            }}
          />
        }
      >
        {isLoading ? (
          <Spinner center />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title={status === 'genehmigt' ? 'Keine genehmigten Anträge' : 'Keine abgelehnten Anträge'}
            hint="Entschiedene Änderungsanträge bleiben hier nachvollziehbar."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Art</th>
                  <th className="num">Betrag</th>
                  <th>Wirksam ab</th>
                  <th>Begründung</th>
                  <th>Beantragt von</th>
                  <th>Entschieden</th>
                  <th>Anmerkung</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      {r.last_name}, {r.first_name}
                    </td>
                    <td>{kindLabel(r.kind)}</td>
                    <td className="num">{formatEuro(r.new_amount_cents)}</td>
                    <td>{formatDate(r.effective_date)}</td>
                    <td style={{ maxWidth: 240, color: 'var(--text-muted)' }}>{r.reason}</td>
                    <td>{r.requested_by_name ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Badge tone={STATUS_TONES[r.status] ?? 'neutral'}>
                        {r.status === 'genehmigt' ? 'Genehmigt' : 'Abgelehnt'}
                      </Badge>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                        {r.decided_by_name ?? '—'}
                        {r.decided_at ? ` · ${formatDate(r.decided_at.slice(0, 10))}` : ''}
                      </div>
                    </td>
                    <td style={{ maxWidth: 240, color: 'var(--text-muted)' }}>{r.decision_note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function EmployeeDetail({
  employeeId,
  onBack,
  backLabel,
}: {
  employeeId: number;
  onBack: () => void;
  backLabel: string;
}) {
  const [componentDialog, setComponentDialog] = useState(false);
  const [requestDialog, setRequestDialog] = useState(false);

  // Einfuehrung: Eine Person zu oeffnen ist der erste Schritt.
  useEffect(() => {
    tourEvent('gehaelter.person-opened');
  }, []);

  const salaryQuery = useQuery({
    queryKey: ['compensation', 'salary', employeeId],
    queryFn: () =>
      api.get<{
        salary: {
          first_name: string;
          last_name: string;
          employee_type: string;
          weekly_hours: number | null;
          monthly_gross_cents: number;
          components: ComponentRow[];
        };
      }>(`/api/compensation/employees/${employeeId}/salary`),
    select: (d) => d.salary,
  });
  const historyQuery = useQuery({
    queryKey: ['compensation', 'salary-history', employeeId],
    queryFn: () =>
      api.get<{ components: ComponentRow[] }>(
        `/api/compensation/employees/${employeeId}/salary/history`,
      ),
    select: (d) => d.components,
  });
  const auditQuery = useQuery({
    queryKey: ['compensation', 'audit', employeeId],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/api/compensation/employees/${employeeId}/audit`),
    select: (d) => d.entries,
  });

  if (salaryQuery.isLoading) return <Spinner center />;
  const salary = salaryQuery.data;
  if (!salary) return <EmptyState title="Vergütung konnte nicht geladen werden" />;
  const typeLabel = EMPLOYEE_TYPE_LABELS[salary.employee_type as EmployeeType] ?? salary.employee_type;

  // Freiberufler:innen werden ueber Honorare verguetet; Komponenten und
  // Aenderungsantraege weist das Backend fuer sie mit 400 ab. Statt einer
  // leeren Gehaltsseite fuehrt der Weg zu den Honoraren.
  if (salary.employee_type === 'freiberufler') {
    return (
      <>
        <PageHeader
          title={`${salary.first_name} ${salary.last_name}`}
          subtitle={typeLabel}
          actions={
            <button className="hm-btn hm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={16} /> {backLabel}
            </button>
          }
        />
        <Card>
          <EmptyState
            icon={<Receipt size={40} />}
            title="Vergütung über Honorare"
            hint="Freiberufliche Mitarbeiter haben keine Gehaltskomponenten. Honorarsätze und Rechnungen stehen unter Freiberufler & Honorare."
            action={
              <Link className="hm-btn hm-btn--primary" to="/verguetung/honorare">
                <Receipt size={16} /> Zu den Honoraren
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${salary.first_name} ${salary.last_name}`}
        subtitle={`${typeLabel} · Monatsbrutto ${formatEuro(salary.monthly_gross_cents)}`}
        actions={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={onBack} data-tour="gehaelter-back">
              <ArrowLeft size={16} /> {backLabel}
            </button>
            <button
              className="hm-btn hm-btn--secondary"
              data-tour="gehaelter-component-btn"
              onClick={() => {
                setComponentDialog(true);
                tourEvent('gehaelter.component-dialog');
              }}
            >
              <Plus size={16} /> Komponente
            </button>
            <button
              className="hm-btn hm-btn--primary"
              data-tour="gehaelter-request-btn"
              onClick={() => {
                setRequestDialog(true);
                tourEvent('gehaelter.request-dialog');
              }}
            >
              Änderungsanfrage dokumentieren
            </button>
          </>
        }
      />
      <div className="stack">
        <Card title="Aktuelle Vergütungskomponenten">
          {salary.components.length === 0 ? (
            <EmptyState
              icon={<Wallet size={40} />}
              title="Keine Gehaltskomponenten hinterlegt"
              hint="Legen Sie eine Komponente an oder stellen Sie einen Änderungsantrag."
            />
          ) : (
            <div className="grid-stats" style={{ marginBottom: 0 }}>
              {salary.components.map((c) => (
                <div key={c.id} className="hm-card hm-stat">
                  <span className="hm-stat__label">{kindLabel(c.kind)}</span>
                  <span className="hm-stat__value">
                    {formatEuro(c.amount_cents)}
                    {c.kind === 'stundenlohn' && (
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                        {' '}
                        / Std.
                      </span>
                    )}
                  </span>
                  <span className="hm-stat__sub">
                    seit {formatDate(c.valid_from)}
                    {c.kind === 'stundenlohn' && c.monthly_cents !== undefined
                      ? ` · Monatswert ${formatEuro(c.monthly_cents)}`
                      : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={<span className="row"><History size={16} /> Historie</span>} flush>
          {historyQuery.isLoading ? (
            <Spinner center />
          ) : (historyQuery.data ?? []).length === 0 ? (
            <EmptyState title="Noch keine Historie" />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Art</th>
                    <th className="num">Betrag</th>
                    <th>Gültig von</th>
                    <th>Gültig bis</th>
                    <th>Notiz</th>
                  </tr>
                </thead>
                <tbody>
                  {(historyQuery.data ?? []).map((c) => (
                    <tr key={c.id}>
                      <td>{kindLabel(c.kind)}</td>
                      <td className="num">
                        {formatEuro(c.amount_cents)}
                        {c.kind === 'stundenlohn' ? ' / Std.' : ''}
                      </td>
                      <td>{formatDate(c.valid_from)}</td>
                      <td>{c.valid_to ? formatDate(c.valid_to) : <Badge tone="green">offen</Badge>}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{c.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={<span className="row"><ScrollText size={16} /> Audit-Trail — wer/wann/was/warum</span>} flush>
          {auditQuery.isLoading ? (
            <Spinner center />
          ) : (auditQuery.data ?? []).length === 0 ? (
            <EmptyState title="Noch keine Audit-Einträge" />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Wann</th>
                    <th>Wer</th>
                    <th>Was</th>
                    <th className="num">Alt → Neu</th>
                    <th>Warum</th>
                    <th>Anmerkung zur Entscheidung</th>
                  </tr>
                </thead>
                <tbody>
                  {(auditQuery.data ?? []).map((a) => (
                    <tr key={a.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(a.created_at?.slice(0, 10))}</td>
                      <td>{a.user_name ?? '—'}</td>
                      <td>
                        {AUDIT_ACTION_LABELS[a.action] ?? a.action}
                        {a.details?.kind ? ` (${kindLabel(a.details.kind)})` : ''}
                      </td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {a.details?.new_amount_cents !== undefined
                          ? `${
                              a.details?.old_amount_cents != null
                                ? formatEuro(a.details.old_amount_cents)
                                : '—'
                            } → ${formatEuro(a.details.new_amount_cents)}`
                          : '—'}
                      </td>
                      <td style={{ maxWidth: 300, color: 'var(--text-muted)' }}>
                        {a.details?.reason ?? '—'}
                      </td>
                      <td style={{ maxWidth: 300, color: 'var(--text-muted)' }}>
                        {a.details?.decision_note ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <div className="page__foot">
        <button className="hm-btn hm-btn--secondary" onClick={onBack}>
          <ArrowLeft size={16} /> {backLabel}
        </button>
      </div>
      <ComponentDialog open={componentDialog} onClose={() => setComponentDialog(false)} employeeId={employeeId} />
      <ChangeRequestDialog open={requestDialog} onClose={() => setRequestDialog(false)} presetEmployeeId={employeeId} />
    </>
  );
}

export function SalariesPage() {
  // Die gewählte Person steht in der URL (?person=<id>): So springt die
  // Personalakte direkt auf ihre Vergütung, und der Browser-Zurück-Knopf
  // landet wieder in der Übersicht.
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const backTo = useBackTo();
  const personParam = Number(params.get('person'));
  const selected = Number.isInteger(personParam) && personParam > 0 ? personParam : null;
  const setSelected = (id: number | null) => setParams(id === null ? {} : { person: String(id) });
  const [requestDialog, setRequestDialog] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'salaries'],
    queryFn: () => api.get<{ salaries: SalaryOverviewRow[] }>('/api/compensation/salaries'),
    select: (d) => d.salaries,
  });

  const { sort, toggle: sortBy, sorted } = useTableSort('salaries', data, SALARY_SORT, SALARY_SORT_DEFAULT, salaryTieBreak);
  const [columns, setColumns] = useState<SalaryColumnId[]>(loadSalaryColumns);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const visibleColumns = SALARY_COLUMNS.filter((c) => c.fixed || columns.includes(c.id));
  const toggleColumn = (id: SalaryColumnId) => {
    const next = columns.includes(id) ? columns.filter((c) => c !== id) : [...columns, id];
    setColumns(next);
    writeJson(SALARY_VIEW_KEY, next);
  };

  if (selected !== null) {
    return (
      <EmployeeDetail
        employeeId={selected}
        onBack={() => (backTo ? navigate(backTo.path) : setSelected(null))}
        backLabel={backTo?.label ?? 'Zurück zur Übersicht'}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Gehälter"
        subtitle="Aktuelle Vergütung aller Mitarbeitenden mit Änderungs-Workflow"
        actions={
          <button
            className="hm-btn hm-btn--primary"
            data-tour="gehaelter-request-btn"
            onClick={() => {
              setRequestDialog(true);
              tourEvent('gehaelter.request-dialog');
            }}
          >
            <Plus size={16} /> Änderungsanfrage dokumentieren
          </button>
        }
      />
      <div className="stack">
        <PendingRequests />
        <div data-tour="gehaelter-overview">
          <Card
            title="Übersicht"
            flush
            actions={
              <div className="hm-multi" style={{ width: 150 }}>
                <button
                  ref={columnsButtonRef}
                  type="button"
                  className="hm-multi__button"
                  onClick={() => setColumnsOpen((o) => !o)}
                  aria-expanded={columnsOpen}
                >
                  <Columns3 size={14} />
                  <span className="hm-multi__label">Spalten</span>
                </button>
                <Popover
                  open={columnsOpen}
                  onClose={() => setColumnsOpen(false)}
                  anchorRef={columnsButtonRef}
                  align="right"
                  minWidth={280}
                >
                  <div>
                    <div className="hm-multi__list">
                      {SALARY_COLUMNS.map((c) => {
                        const on = c.fixed || columns.includes(c.id);
                        return (
                          <label
                            key={c.id}
                            className={`hm-multi__option${on ? ' hm-multi__option--on' : ''}`}
                            style={c.fixed ? { opacity: 0.65, cursor: 'default' } : undefined}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={c.fixed}
                              onChange={() => toggleColumn(c.id)}
                            />
                            <span className="hm-multi__text">{c.label}</span>
                            {c.fixed && <span className="hm-multi__hint">immer</span>}
                          </label>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="hm-multi__reset"
                      onClick={() => {
                        setColumns(DEFAULT_SALARY_COLUMNS);
                        writeJson(SALARY_VIEW_KEY, DEFAULT_SALARY_COLUMNS);
                      }}
                    >
                      Auf Standard zurücksetzen
                    </button>
                  </div>
                </Popover>
              </div>
            }
          >
            {isLoading ? (
              <Spinner center />
            ) : (data ?? []).length === 0 ? (
              <EmptyState
                icon={<Wallet size={40} />}
                title="Keine Mitarbeitenden vorhanden"
                hint="Legen Sie zunächst Mitarbeitende im Personal-Modul an."
              />
            ) : (
              <TableScroller>
                <table className="hm-table">
                  <thead>
                    <tr>
                      {visibleColumns.map((c) => (
                        <SortableTh
                          key={c.id}
                          className={c.num ? 'num' : undefined}
                          label={
                            c.hint ? (
                              <Tooltip content={<span className="hm-tooltip__line">{c.hint}</span>}>
                                <span>{c.label}</span>
                              </Tooltip>
                            ) : (
                              c.label
                            )
                          }
                          sortKey={c.id}
                          sort={sort}
                          onSort={sortBy}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(sorted ?? []).map((r) => (
                      <tr key={r.employee_id} className="clickable" onClick={() => setSelected(r.employee_id)}>
                        {visibleColumns.map((c) => (
                          <td key={c.id} className={c.num ? 'num' : undefined}>
                            {salaryCell(r, c.id)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </Card>
        </div>
        <DecidedRequests />
      </div>
      <ChangeRequestDialog open={requestDialog} onClose={() => setRequestDialog(false)} />
    </>
  );
}
