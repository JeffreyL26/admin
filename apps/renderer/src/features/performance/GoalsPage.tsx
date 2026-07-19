import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Target, Trash2, TrendingUp } from 'lucide-react';
import { api, ApiRequestError } from '../../api/client';
import { PageHeader, Card, EmptyState, Spinner, Badge, StatCard, Field } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import {
  GOAL_KIND_LABELS,
  GOAL_STATUS_LABELS,
  formatDate,
  type Goal,
  type GoalKind,
  type GoalStatus,
} from '@hrmonic/shared';
import { ProgressBar, GOAL_STATUS_TONES } from './common';

const emptyForm = {
  title: '',
  description: '',
  kind: 'objective' as GoalKind,
  parent_goal_id: null as number | null,
  metric: '',
  target_value: '',
  current_value: '',
  period_from: '',
  period_to: '',
};

export function GoalsPage() {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [deleteGoal, setDeleteGoal] = useState<Goal | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'goals', employeeId],
    queryFn: () => api.get<{ goals: Goal[] }>(`/api/performance/goals?employee_id=${employeeId}`),
    enabled: employeeId !== null,
  });
  const goals = data?.goals ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['performance', 'goals'] });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post('/api/performance/goals', payload),
    onSuccess: () => {
      toast.success('Ziel angelegt');
      setCreateOpen(false);
      setForm(emptyForm);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Anlegen'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/goals/${id}`),
    onSuccess: () => {
      toast.success('Ziel gelöscht');
      invalidate();
    },
    onError: () => toast.error('Fehler beim Löschen'),
  });

  const objectives = useMemo(() => goals.filter((g) => g.kind === 'objective'), [goals]);
  const keyResultsByParent = useMemo(() => {
    const map = new Map<number, Goal[]>();
    for (const g of goals) {
      if (g.kind === 'key_result' && g.parent_goal_id) {
        map.set(g.parent_goal_id, [...(map.get(g.parent_goal_id) ?? []), g]);
      }
    }
    return map;
  }, [goals]);
  const kpis = useMemo(() => goals.filter((g) => g.kind === 'kpi'), [goals]);

  const avgProgress = goals.length
    ? Math.round(goals.reduce((s, g) => s + g.progress, 0) / goals.length)
    : 0;
  const statusCounts = useMemo(() => {
    const counts: Record<GoalStatus, number> = { aktiv: 0, erreicht: 0, verfehlt: 0, abgebrochen: 0 };
    for (const g of goals) counts[g.status] += 1;
    return counts;
  }, [goals]);

  const submitCreate = () => {
    if (!employeeId) return;
    if (!form.title.trim()) {
      toast.error('Bitte einen Titel angeben');
      return;
    }
    if (form.kind === 'key_result' && !form.parent_goal_id) {
      toast.error('Bitte ein übergeordnetes Objective wählen');
      return;
    }
    createMutation.mutate({
      employee_id: employeeId,
      title: form.title.trim(),
      description: form.description || null,
      kind: form.kind,
      parent_goal_id: form.kind === 'key_result' ? form.parent_goal_id : null,
      metric: form.metric || null,
      target_value: form.target_value || null,
      current_value: form.current_value || null,
      period_from: form.period_from || null,
      period_to: form.period_to || null,
    });
  };

  return (
    <>
      <PageHeader
        title="Ziele & OKR"
        subtitle="Objectives mit Key Results und KPIs je Mitarbeiter:in"
        actions={
          <button
            className="hm-btn hm-btn--primary"
            disabled={!employeeId}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} /> Neues Ziel
          </button>
        }
      />

      <Card>
        <div className="row row--wrap">
          <div style={{ minWidth: 280 }}>
            <Field label="Mitarbeiter:in">
              <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
            </Field>
          </div>
        </div>
      </Card>

      {employeeId === null ? (
        <Card style={{ marginTop: 16 }}>
          <EmptyState
            icon={<Target size={40} />}
            title="Bitte eine:n Mitarbeiter:in auswählen"
            hint="Die Ziele werden pro Person verwaltet."
          />
        </Card>
      ) : isLoading ? (
        <Spinner center />
      ) : (
        <>
          <div className="grid-stats" style={{ marginTop: 16 }}>
            <StatCard label="Ø Zielerreichung" value={`${avgProgress} %`} icon={<TrendingUp size={15} />} />
            <StatCard label="Aktiv" value={statusCounts.aktiv} />
            <StatCard label="Erreicht" value={statusCounts.erreicht} />
            <StatCard label="Verfehlt / Abgebrochen" value={statusCounts.verfehlt + statusCounts.abgebrochen} />
          </div>

          <Card title="OKR-Baum" style={{ marginBottom: 16 }}>
            {objectives.length === 0 ? (
              <EmptyState
                title="Noch keine Objectives"
                hint="Legen Sie ein Objective an und ordnen Sie ihm Key Results zu."
              />
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {objectives.map((obj) => (
                  <div key={obj.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14 }}>
                    <GoalRow
                      goal={obj}
                      onDelete={() => setDeleteGoal(obj)}
                      lockedProgress={(keyResultsByParent.get(obj.id) ?? []).length > 0}
                    />
                    {(keyResultsByParent.get(obj.id) ?? []).map((kr) => (
                      <div key={kr.id} style={{ marginLeft: 28, marginTop: 10 }}>
                        <GoalRow goal={kr} onDelete={() => setDeleteGoal(kr)} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="KPIs">
            {kpis.length === 0 ? (
              <EmptyState title="Keine KPIs hinterlegt" />
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {kpis.map((kpi) => (
                  <GoalRow key={kpi.id} goal={kpi} onDelete={() => setDeleteGoal(kpi)} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <Modal
        title="Neues Ziel"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setCreateOpen(false)}>
              Abbrechen
            </button>
            <button className="hm-btn hm-btn--primary" onClick={submitCreate} disabled={createMutation.isPending}>
              Anlegen
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Art" required>
            <select
              className="hm-select"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as GoalKind })}
            >
              {(Object.keys(GOAL_KIND_LABELS) as GoalKind[]).map((k) => (
                <option key={k} value={k}>
                  {GOAL_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          {form.kind === 'key_result' && (
            <Field label="Objective" required>
              <select
                className="hm-select"
                value={form.parent_goal_id ?? ''}
                onChange={(e) =>
                  setForm({ ...form, parent_goal_id: e.target.value === '' ? null : Number(e.target.value) })
                }
              >
                <option value="">— auswählen —</option>
                {objectives.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Titel" required span2>
            <input
              className="hm-input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="z. B. Kundenzufriedenheit steigern"
            />
          </Field>
          <Field label="Beschreibung" span2>
            <textarea
              className="hm-textarea"
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <Field label="Metrik" hint="z. B. NPS, Umsatz, Tickets">
            <input className="hm-input" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} />
          </Field>
          <Field label="Zielwert">
            <input
              className="hm-input"
              value={form.target_value}
              onChange={(e) => setForm({ ...form, target_value: e.target.value })}
            />
          </Field>
          <Field label="Zeitraum von">
            <input
              type="date"
              className="hm-input"
              value={form.period_from}
              onChange={(e) => setForm({ ...form, period_from: e.target.value })}
            />
          </Field>
          <Field label="Zeitraum bis">
            <input
              type="date"
              className="hm-input"
              value={form.period_to}
              onChange={(e) => setForm({ ...form, period_to: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteGoal !== null}
        title="Ziel löschen"
        message={
          deleteGoal?.kind === 'objective'
            ? `„${deleteGoal?.title}“ und alle zugehörigen Key Results werden gelöscht.`
            : `„${deleteGoal?.title}“ wird gelöscht.`
        }
        onConfirm={() => deleteGoal && deleteMutation.mutate(deleteGoal.id)}
        onClose={() => setDeleteGoal(null)}
      />
    </>
  );
}

/** Zeile mit Fortschrittsbalken, Inline-Progress-Update und Statuswechsel. */
function GoalRow({
  goal,
  onDelete,
  lockedProgress = false,
}: {
  goal: Goal;
  onDelete: () => void;
  lockedProgress?: boolean;
}) {
  const [progress, setProgress] = useState<number>(goal.progress);
  const toast = useToast();
  const qc = useQueryClient();

  const update = useMutation({
    mutationFn: (payload: { progress: number }) =>
      api.post(`/api/performance/goals/${goal.id}/progress`, payload),
    onSuccess: () => {
      toast.success('Fortschritt aktualisiert');
      qc.invalidateQueries({ queryKey: ['performance', 'goals'] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Aktualisieren'),
  });

  // Statuswechsel läuft über PUT — funktioniert auch für Objectives mit
  // automatisch berechnetem Fortschritt.
  const updateStatus = useMutation({
    mutationFn: (status: GoalStatus) => api.put(`/api/performance/goals/${goal.id}`, { status }),
    onSuccess: () => {
      toast.success('Status aktualisiert');
      qc.invalidateQueries({ queryKey: ['performance', 'goals'] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Aktualisieren'),
  });

  // Bei Refetch aktualisierte Server-Werte übernehmen.
  React.useEffect(() => setProgress(goal.progress), [goal.progress]);

  return (
    <div className="row row--wrap" style={{ alignItems: 'center', gap: 12 }}>
      <div style={{ flex: '1 1 220px', minWidth: 200 }}>
        <div className="row" style={{ gap: 8 }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>{goal.title}</strong>
          <Badge tone="navy">{GOAL_KIND_LABELS[goal.kind]}</Badge>
          <Badge tone={GOAL_STATUS_TONES[goal.status]}>{GOAL_STATUS_LABELS[goal.status]}</Badge>
        </div>
        {(goal.metric || goal.period_from) && (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
            {goal.metric && (
              <>
                {goal.metric}
                {goal.target_value ? `: Ziel ${goal.target_value}` : ''}
                {goal.current_value ? ` · aktuell ${goal.current_value}` : ''}
              </>
            )}
            {goal.metric && goal.period_from ? ' · ' : ''}
            {goal.period_from && `${formatDate(goal.period_from)} – ${formatDate(goal.period_to)}`}
          </div>
        )}
      </div>
      <div style={{ flex: '2 1 240px', minWidth: 180 }}>
        <ProgressBar value={goal.progress} />
      </div>
      <div className="row" style={{ gap: 6 }}>
        {lockedProgress ? (
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 48, textAlign: 'right' }}>
            {goal.progress} %
          </span>
        ) : (
          <>
            <input
              type="number"
              className="hm-input"
              min={0}
              max={100}
              value={progress}
              onChange={(e) => setProgress(Math.max(0, Math.min(100, Number(e.target.value))))}
              style={{ width: 76 }}
              aria-label="Fortschritt in Prozent"
            />
            <button
              className="hm-btn hm-btn--secondary hm-btn--sm"
              disabled={update.isPending || progress === goal.progress}
              onClick={() => update.mutate({ progress })}
            >
              OK
            </button>
          </>
        )}
        <select
          className="hm-select"
          value={goal.status}
          onChange={(e) => updateStatus.mutate(e.target.value as GoalStatus)}
          style={{ width: 140 }}
          aria-label="Status"
        >
          {(Object.keys(GOAL_STATUS_LABELS) as GoalStatus[]).map((s) => (
            <option key={s} value={s}>
              {GOAL_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={onDelete} aria-label="Löschen">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
