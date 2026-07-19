import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Plus, Target, Trash2 } from 'lucide-react';
import {
  BONUS_KIND_LABELS,
  BONUS_STATUS_LABELS,
  formatEuro,
  type BonusKind,
  type BonusStatus,
} from '@hrmonic/shared';
import { api, ApiRequestError } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { currentMonth, formatMonth, parseEuroInput, STATUS_TONES } from './lib';

interface GoalOption {
  id: number;
  title: string;
  progress: number;
  status: string;
}

interface BonusRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  kind: string;
  title: string;
  amount_cents: number | null;
  target_amount_cents: number | null;
  goal_id: number | null;
  payout_month: string;
  status: string;
  note: string | null;
  payout_cents: number;
  goal: GoalOption | null;
}

function CreateBonusDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [kind, setKind] = useState<string>('einmalzahlung');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [goalId, setGoalId] = useState<number | null>(null);
  const [payoutMonth, setPayoutMonth] = useState(currentMonth());
  const [note, setNote] = useState('');

  const goalCoupled = kind === 'zielbonus';

  const goalsQuery = useQuery({
    queryKey: ['compensation', 'goals', employeeId],
    queryFn: () => api.get<{ goals: GoalOption[] }>(`/api/compensation/goals?employee_id=${employeeId}`),
    enabled: goalCoupled && employeeId !== null,
    select: (d) => d.goals,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/compensation/bonuses', {
        employee_id: employeeId,
        kind,
        title,
        payout_month: payoutMonth,
        note: note.trim() || null,
        ...(goalCoupled && goalId
          ? { goal_id: goalId, target_amount_cents: parseEuroInput(targetAmount) }
          : { amount_cents: parseEuroInput(amount) }),
      }),
    onSuccess: () => {
      toast.success('Bonus wurde angelegt');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
      setTitle('');
      setAmount('');
      setTargetAmount('');
      setGoalId(null);
      setNote('');
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Anlegen fehlgeschlagen'),
  });

  const valid =
    employeeId &&
    title.trim() &&
    /^\d{4}-\d{2}$/.test(payoutMonth) &&
    (goalCoupled && goalId ? parseEuroInput(targetAmount) : parseEuroInput(amount));

  const selectedGoal = (goalsQuery.data ?? []).find((g) => g.id === goalId) ?? null;
  const previewCents =
    goalCoupled && selectedGoal && parseEuroInput(targetAmount)
      ? Math.round((parseEuroInput(targetAmount)! * Math.min(100, Math.max(0, selectedGoal.progress))) / 100)
      : null;

  return (
    <Modal
      title="Bonus anlegen"
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
            onClick={() => create.mutate()}
          >
            Anlegen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect
            value={employeeId}
            onChange={(id) => {
              setEmployeeId(id);
              setGoalId(null);
            }}
          />
        </Field>
        <Field label="Art" required>
          <select
            className="hm-select"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setGoalId(null);
            }}
          >
            {(Object.keys(BONUS_KIND_LABELS) as BonusKind[]).map((k) => (
              <option key={k} value={k}>
                {BONUS_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Titel" required>
          <input
            className="hm-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="z. B. Jahresbonus 2026"
          />
        </Field>
        {goalCoupled && (
          <Field
            label="Zielkopplung"
            span2
            hint={
              employeeId === null
                ? 'Wählen Sie zuerst eine Mitarbeiter:in'
                : (goalsQuery.data ?? []).length === 0
                  ? 'Keine Ziele vorhanden — ohne Kopplung wird ein fester Betrag verwendet'
                  : 'Auszahlung = Zielbetrag × Zielerreichung'
            }
          >
            <select
              className="hm-select"
              value={goalId ?? ''}
              disabled={employeeId === null}
              onChange={(e) => setGoalId(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">— ohne Zielkopplung (fester Betrag) —</option>
              {(goalsQuery.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({g.progress} %)
                </option>
              ))}
            </select>
          </Field>
        )}
        {goalCoupled && goalId ? (
          <Field label="Zielbetrag bei 100 % (€)" required>
            <input
              className="hm-input"
              value={targetAmount}
              onChange={(e) => setTargetAmount(e.target.value)}
              placeholder="z. B. 5.000,00"
            />
          </Field>
        ) : (
          <Field label="Betrag (€)" required>
            <input
              className="hm-input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="z. B. 1.500,00"
            />
          </Field>
        )}
        <Field label="Auszahlungsmonat" required>
          <input
            type="month"
            className="hm-input"
            value={payoutMonth}
            onChange={(e) => setPayoutMonth(e.target.value)}
          />
        </Field>
        <Field label="Notiz" span2>
          <input className="hm-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {previewCents !== null && selectedGoal && (
        <p style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          <Target size={14} style={{ verticalAlign: -2 }} /> Aktuelle Zielerreichung{' '}
          <strong>{selectedGoal.progress} %</strong> → voraussichtliche Auszahlung{' '}
          <strong>{formatEuro(previewCents)}</strong>
        </p>
      )}
    </Modal>
  );
}

export function BonusesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('alle');
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['compensation', 'bonuses', statusFilter],
    queryFn: () =>
      api.get<{ bonuses: BonusRow[] }>(
        `/api/compensation/bonuses${statusFilter === 'alle' ? '' : `?status=${statusFilter}`}`,
      ),
    select: (d) => d.bonuses,
  });

  const setStatus = useMutation({
    mutationFn: (p: { id: number; status: string }) =>
      api.post(`/api/compensation/bonuses/${p.id}/status`, { status: p.status }),
    onSuccess: (_d, p) => {
      toast.success(p.status === 'freigegeben' ? 'Bonus freigegeben' : 'Bonus als ausgezahlt markiert');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Statuswechsel fehlgeschlagen'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/compensation/bonuses/${id}`),
    onSuccess: () => {
      toast.success('Bonus wurde gelöscht');
      queryClient.invalidateQueries({ queryKey: ['compensation'] });
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Löschen fehlgeschlagen'),
  });

  return (
    <>
      <PageHeader
        title="Boni & Variable Vergütung"
        subtitle="Zielboni, Provisionen und Einmalzahlungen mit Freigabe-Workflow"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Bonus anlegen
          </button>
        }
      />
      <Card
        flush
        title={
          <Tabs
            tabs={[
              { key: 'alle', label: 'Alle' },
              { key: 'geplant', label: 'Geplant' },
              { key: 'freigegeben', label: 'Freigegeben' },
              { key: 'ausgezahlt', label: 'Ausgezahlt' },
            ]}
            active={statusFilter}
            onChange={setStatusFilter}
          />
        }
      >
        {isLoading ? (
          <Spinner center />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            icon={<Gift size={40} />}
            title="Keine Boni vorhanden"
            hint="Legen Sie einen Zielbonus, eine Provision oder eine Einmalzahlung an."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Titel</th>
                  <th>Art</th>
                  <th>Zielkopplung</th>
                  <th className="num">Auszahlung</th>
                  <th>Monat</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((b) => (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 600 }}>
                      {b.last_name}, {b.first_name}
                    </td>
                    <td>{b.title}</td>
                    <td>
                      <Badge tone="blue">{BONUS_KIND_LABELS[b.kind as BonusKind] ?? b.kind}</Badge>
                    </td>
                    <td>
                      {b.goal_id ? (
                        b.goal ? (
                          <span className="row" style={{ gap: 6 }}>
                            <Target size={14} />
                            <span>
                              {b.goal.title}{' '}
                              <Badge tone={b.goal.progress >= 100 ? 'green' : 'yellow'}>
                                {b.goal.progress} %
                              </Badge>
                            </span>
                          </span>
                        ) : (
                          <Badge tone="red">Ziel nicht gefunden</Badge>
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {formatEuro(b.payout_cents)}
                      {b.goal_id && b.target_amount_cents !== null && b.status !== 'ausgezahlt' && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 400 }}>
                          von {formatEuro(b.target_amount_cents)} Zielbetrag
                        </div>
                      )}
                    </td>
                    <td>{formatMonth(b.payout_month)}</td>
                    <td>
                      <Badge tone={STATUS_TONES[b.status] ?? 'neutral'}>
                        {BONUS_STATUS_LABELS[b.status as BonusStatus] ?? b.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {b.status === 'geplant' && (
                          <>
                            <button
                              className="hm-btn hm-btn--primary hm-btn--sm"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: b.id, status: 'freigegeben' })}
                            >
                              Freigeben
                            </button>
                            <button
                              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                              aria-label="Löschen"
                              onClick={() => setDeleteId(b.id)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </>
                        )}
                        {b.status === 'freigegeben' && (
                          <button
                            className="hm-btn hm-btn--secondary hm-btn--sm"
                            disabled={setStatus.isPending}
                            onClick={() => setStatus.mutate({ id: b.id, status: 'ausgezahlt' })}
                          >
                            Als ausgezahlt markieren
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <CreateBonusDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConfirmDialog
        open={deleteId !== null}
        title="Bonus löschen"
        message="Soll dieser geplante Bonus wirklich gelöscht werden?"
        onConfirm={() => deleteId !== null && remove.mutate(deleteId)}
        onClose={() => setDeleteId(null)}
      />
    </>
  );
}
