import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Plus, Trash2, UserPlus } from 'lucide-react';
import {
  ONBOARDING_KIND_LABELS,
  formatDate,
  type OnboardingKind,
  type OnboardingProcess,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useToast } from '../../components/Toast';
import { useOnboardingProcess, useOnboardingProcesses } from './api';

function kindBadge(kind: OnboardingKind) {
  return kind === 'onboarding' ? (
    <Badge tone="green">Onboarding</Badge>
  ) : (
    <Badge tone="navy">Offboarding</Badge>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="row" style={{ gap: 8 }}>
      <div
        style={{
          flex: '0 0 90px',
          height: 6,
          borderRadius: 3,
          background: 'var(--gray-200)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: pct === 100 ? 'var(--success)' : 'var(--brand-primary)',
          }}
        />
      </div>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        {done}/{total}
      </span>
    </div>
  );
}

/** Überblick: Wer befindet sich gerade im On- bzw. Offboarding? Checkliste zum Abhaken je Prozess. */
export function OnboardingPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [statusTab, setStatusTab] = useState<'laufend' | 'abgeschlossen'>('laufend');
  const [kindFilter, setKindFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<OnboardingProcess | null>(null);

  const { data: processes, isLoading } = useOnboardingProcesses(statusTab, kindFilter);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/onboarding/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] });
      toast.success('Prozess gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="On- & Offboarding"
        subtitle="Wer kommt an Bord, wer verlässt uns? Mit abhakbarer Checkliste je Prozess."
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Prozess starten
          </button>
        }
      />

      <div className="row row--between" style={{ marginBottom: 12 }}>
        <Tabs
          tabs={[
            { key: 'laufend', label: 'Laufend' },
            { key: 'abgeschlossen', label: 'Abgeschlossen' },
          ]}
          active={statusTab}
          onChange={(k) => setStatusTab(k as typeof statusTab)}
        />
        <select
          className="hm-select"
          style={{ width: 170 }}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="">On- & Offboarding</option>
          {Object.entries(ONBOARDING_KIND_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : (processes?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<UserPlus size={40} />}
            title={statusTab === 'laufend' ? 'Aktuell keine laufenden Prozesse' : 'Keine abgeschlossenen Prozesse'}
            hint="Starten Sie ein On- oder Offboarding über den Button oben rechts — die Checkliste wird automatisch angelegt."
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Art</th>
                  <th>Stichtag</th>
                  <th>Checkliste</th>
                  <th style={{ width: 130 }} />
                </tr>
              </thead>
              <tbody>
                {processes!.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {p.last_name}, {p.first_name}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {[p.job_title, p.department_name].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td>{kindBadge(p.kind)}</td>
                    <td>
                      {p.target_date ? formatDate(p.target_date) : '—'}
                      {p.status === 'abgeschlossen' && p.completed_at && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                          abgeschlossen {formatDate(p.completed_at.slice(0, 10))}
                        </div>
                      )}
                    </td>
                    <td>
                      <ProgressBar done={p.done_tasks ?? 0} total={p.total_tasks ?? 0} />
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="hm-btn hm-btn--sm hm-btn--secondary"
                          onClick={() => setDetailId(p.id)}
                        >
                          <ClipboardList size={14} /> Checkliste
                        </button>
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                          title="Prozess löschen"
                          onClick={() => setConfirmDelete(p)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateProcessDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ChecklistDialog processId={detailId} onClose={() => setDetailId(null)} />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Prozess löschen?"
        message={`Das ${confirmDelete ? ONBOARDING_KIND_LABELS[confirmDelete.kind] : ''} von ${confirmDelete?.first_name} ${confirmDelete?.last_name} wird samt Checkliste entfernt.`}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}

function CreateProcessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [kind, setKind] = useState<OnboardingKind>('onboarding');
  const [targetDate, setTargetDate] = useState('');
  const [note, setNote] = useState('');

  React.useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setKind('onboarding');
      setTargetDate('');
      setNote('');
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/admin/onboarding', {
        employee_id: employeeId,
        kind,
        target_date: targetDate || null,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] });
      toast.success('Prozess gestartet — Checkliste wurde angelegt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title="On-/Offboarding starten"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!employeeId || create.isPending}
            onClick={() => create.mutate()}
          >
            Prozess starten
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Mitarbeiter:in" required span2>
          <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
        </Field>
        <Field label="Art" required>
          <select
            className="hm-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as OnboardingKind)}
          >
            {Object.entries(ONBOARDING_KIND_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Stichtag"
          hint={kind === 'onboarding' ? 'z. B. erster Arbeitstag' : 'z. B. Austrittsdatum'}
        >
          <input
            className="hm-input"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </Field>
        <Field label="Notiz" span2>
          <textarea className="hm-textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <p style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        Die Checkliste wird aus der Standard-Vorlage des Prozesstyps angelegt und kann danach frei
        ergänzt werden.
      </p>
    </Modal>
  );
}

/** Checkliste eines Prozesses: Aufgaben abhaken, ergänzen, Prozess abschließen. */
function ChecklistDialog({ processId, onClose }: { processId: number | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useOnboardingProcess(processId);
  const [newTask, setNewTask] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] });

  const toggle = useMutation({
    mutationFn: ({ taskId, done }: { taskId: number; done: boolean }) =>
      api.patch(`/api/admin/onboarding/tasks/${taskId}`, { done }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const addTask = useMutation({
    mutationFn: () => api.post(`/api/admin/onboarding/${processId}/tasks`, { title: newTask.trim() }),
    onSuccess: () => {
      invalidate();
      setNewTask('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeTask = useMutation({
    mutationFn: (taskId: number) => api.delete(`/api/admin/onboarding/tasks/${taskId}`),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const complete = useMutation({
    mutationFn: () => api.post(`/api/admin/onboarding/${processId}/complete`),
    onSuccess: () => {
      invalidate();
      toast.success('Prozess abgeschlossen');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const process = data?.process;
  const tasks = data?.tasks ?? [];
  const allDone = tasks.length > 0 && tasks.every((t) => t.done === 1);
  const running = process?.status === 'laufend';

  return (
    <Modal
      title={
        process
          ? `${ONBOARDING_KIND_LABELS[process.kind]}: ${process.first_name} ${process.last_name}`
          : 'Checkliste'
      }
      open={processId !== null}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Schließen
          </button>
          {running && (
            <button
              className="hm-btn hm-btn--primary"
              disabled={!allDone || complete.isPending}
              title={allDone ? undefined : 'Erst alle Aufgaben abhaken'}
              onClick={() => complete.mutate()}
            >
              <CheckCircle2 size={15} /> Prozess abschließen
            </button>
          )}
        </>
      }
    >
      {!process ? (
        <Spinner center />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {process.target_date && <>Stichtag {formatDate(process.target_date)} · </>}
            {tasks.filter((t) => t.done === 1).length} von {tasks.length} Aufgaben erledigt
            {process.note && (
              <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>{process.note}</div>
            )}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            {tasks.map((t) => (
              <div key={t.id} className="row row--between" style={{ gap: 10 }}>
                <label className="hm-checkbox" style={{ flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={t.done === 1}
                    disabled={!running || toggle.isPending}
                    onChange={(e) => toggle.mutate({ taskId: t.id, done: e.target.checked })}
                  />
                  <span
                    style={
                      t.done === 1
                        ? { textDecoration: 'line-through', color: 'var(--text-muted)' }
                        : undefined
                    }
                  >
                    {t.title}
                  </span>
                </label>
                <span className="row" style={{ gap: 8, flexShrink: 0 }}>
                  {t.done === 1 && t.done_at && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      {t.done_by_name ? `${t.done_by_name} · ` : ''}
                      {formatDate(t.done_at.slice(0, 10))}
                    </span>
                  )}
                  {running && (
                    <button
                      className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                      title="Aufgabe entfernen"
                      onClick={() => removeTask.mutate(t.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>

          {running && (
            <div className="row" style={{ gap: 8 }}>
              <input
                className="hm-input"
                style={{ flex: 1 }}
                placeholder="Weitere Aufgabe ergänzen …"
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTask.trim()) addTask.mutate();
                }}
              />
              <button
                className="hm-btn hm-btn--secondary"
                disabled={!newTask.trim() || addTask.isPending}
                onClick={() => addTask.mutate()}
              >
                <Plus size={15} /> Hinzufügen
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
