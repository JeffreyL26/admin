import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, History, Plus, ScrollText, Wallet, X } from 'lucide-react';
import {
  formatDate,
  formatEuro,
  EMPLOYEE_TYPE_LABELS,
  SALARY_COMPONENT_KINDS,
  SALARY_COMPONENT_LABELS,
  type EmployeeType,
  type SalaryComponentKind,
} from '@ohrganize/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { parseEuroInput } from './lib';

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
}

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
  requested_by_name: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
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
      title="Gehaltsänderung beantragen"
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
          <select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SALARY_COMPONENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
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
      <div className="hm-form-grid">
        <Field label="Art" required>
          <select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SALARY_COMPONENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
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
        <Field label="Gültig ab" required hint="Eine offene Vorgängerzeile gleicher Art wird automatisch geschlossen">
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

function PendingRequests() {
  const toast = useToast();
  const queryClient = useQueryClient();
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
                    <button
                      className="hm-btn hm-btn--primary hm-btn--sm"
                      onClick={() => setDecideFor({ request: r, decision: 'genehmigt' })}
                    >
                      <Check size={14} /> Genehmigen
                    </button>
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

function EmployeeDetail({ employeeId, onBack }: { employeeId: number; onBack: () => void }) {
  const [componentDialog, setComponentDialog] = useState(false);
  const [requestDialog, setRequestDialog] = useState(false);

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

  return (
    <>
      <PageHeader
        title={`${salary.first_name} ${salary.last_name}`}
        subtitle={`${EMPLOYEE_TYPE_LABELS[salary.employee_type as EmployeeType] ?? salary.employee_type} · Monatsbrutto ${formatEuro(salary.monthly_gross_cents)}`}
        actions={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={16} /> Zurück zur Übersicht
            </button>
            <button className="hm-btn hm-btn--secondary" onClick={() => setComponentDialog(true)}>
              <Plus size={16} /> Komponente
            </button>
            <button className="hm-btn hm-btn--primary" onClick={() => setRequestDialog(true)}>
              Änderung beantragen
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
                        {a.details?.reason ?? a.details?.decision_note ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <ComponentDialog open={componentDialog} onClose={() => setComponentDialog(false)} employeeId={employeeId} />
      <ChangeRequestDialog open={requestDialog} onClose={() => setRequestDialog(false)} presetEmployeeId={employeeId} />
    </>
  );
}

export function SalariesPage() {
  const [selected, setSelected] = useState<number | null>(null);
  const [requestDialog, setRequestDialog] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'salaries'],
    queryFn: () => api.get<{ salaries: SalaryOverviewRow[] }>('/api/compensation/salaries'),
    select: (d) => d.salaries,
  });

  if (selected !== null) {
    return <EmployeeDetail employeeId={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <>
      <PageHeader
        title="Gehälter"
        subtitle="Aktuelle Vergütung aller Mitarbeitenden mit Änderungs-Workflow"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setRequestDialog(true)}>
            <Plus size={16} /> Änderung beantragen
          </button>
        }
      />
      <div className="stack">
        <PendingRequests />
        <Card title="Übersicht" flush>
          {isLoading ? (
            <Spinner center />
          ) : (data ?? []).length === 0 ? (
            <EmptyState
              icon={<Wallet size={40} />}
              title="Keine Mitarbeitenden vorhanden"
              hint="Legen Sie zunächst Mitarbeitende im Personal-Modul an."
            />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter:in</th>
                    <th>Beschäftigung</th>
                    <th>Position</th>
                    <th className="num">Monatsbrutto</th>
                    <th className="num">Komponenten</th>
                    <th>Letzte Änderung</th>
                  </tr>
                </thead>
                <tbody>
                  {(data ?? []).map((r) => (
                    <tr key={r.employee_id} className="clickable" onClick={() => setSelected(r.employee_id)}>
                      <td style={{ fontWeight: 600 }}>
                        {r.last_name}, {r.first_name}{' '}
                        {r.status !== 'aktiv' && <Badge tone="neutral">ausgeschieden</Badge>}
                      </td>
                      <td>
                        <Badge tone="blue">
                          {EMPLOYEE_TYPE_LABELS[r.employee_type as EmployeeType] ?? r.employee_type}
                        </Badge>
                      </td>
                      <td>{r.job_title ?? '—'}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {formatEuro(r.monthly_gross_cents)}
                      </td>
                      <td className="num">{r.component_count}</td>
                      <td>{r.last_change ? formatDate(r.last_change) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <ChangeRequestDialog open={requestDialog} onClose={() => setRequestDialog(false)} />
    </>
  );
}
