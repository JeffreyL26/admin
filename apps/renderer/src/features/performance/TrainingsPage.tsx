import React, { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, GraduationCap, Plus, Upload, Download, Users } from 'lucide-react';
import {
  formatDate,
  formatEuro,
  TRAINING_KIND_LABELS,
  TRAINING_REGISTRATION_STATUS_LABELS,
  type Training,
  type TrainingDueEntry,
  type TrainingRegistration,
  type TrainingRegistrationStatus,
} from '@hrmonic/shared';
import { api, downloadFile, uploadFile } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { REGISTRATION_STATUS_TONES } from './common';

interface TrainingRow extends Training {
  registrations_count: number;
}

interface RegistrationRow extends TrainingRegistration {
  first_name: string;
  last_name: string;
}

const EMPTY_FORM = {
  title: '',
  provider: '',
  kind: 'intern' as 'intern' | 'extern',
  cost_cents: '',
  mandatory: false,
  repeat_interval_months: '',
  description: '',
};

export function TrainingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['performance', 'trainings'] });

  const { data: trainings, isLoading } = useQuery({
    queryKey: ['performance', 'trainings', 'list'],
    queryFn: () => api.get<{ trainings: TrainingRow[] }>('/api/performance/trainings'),
    select: (d) => d.trainings,
  });
  const { data: due } = useQuery({
    queryKey: ['performance', 'trainings', 'due'],
    queryFn: () => api.get<{ due: TrainingDueEntry[] }>('/api/performance/trainings/due'),
    select: (d) => d.due,
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TrainingRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<TrainingRow | null>(null);
  const [detail, setDetail] = useState<TrainingRow | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title: form.title,
        provider: form.provider || undefined,
        kind: form.kind,
        cost_cents: form.cost_cents === '' ? undefined : Math.round(Number(form.cost_cents) * 100),
        mandatory: form.mandatory,
        repeat_interval_months:
          form.repeat_interval_months === '' ? undefined : Number(form.repeat_interval_months),
        description: form.description || undefined,
      };
      return editing
        ? api.put(`/api/performance/trainings/${editing.id}`, payload)
        : api.post('/api/performance/trainings', payload);
    },
    onSuccess: () => {
      invalidate();
      setEditorOpen(false);
      toast.success(editing ? 'Training aktualisiert' : 'Training angelegt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/trainings/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Training gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openEditor(training?: TrainingRow) {
    setEditing(training ?? null);
    setForm(
      training
        ? {
            title: training.title,
            provider: training.provider ?? '',
            kind: training.kind,
            cost_cents: training.cost_cents === null ? '' : String(training.cost_cents / 100),
            mandatory: Boolean(training.mandatory),
            repeat_interval_months:
              training.repeat_interval_months === null ? '' : String(training.repeat_interval_months),
            description: training.description ?? '',
          }
        : EMPTY_FORM,
    );
    setEditorOpen(true);
  }

  if (isLoading) return <Spinner center />;
  const overdue = (due ?? []).filter((d) => d.due_status === 'ueberfaellig');
  const soon = (due ?? []).filter((d) => d.due_status === 'bald_faellig');

  return (
    <>
      <PageHeader
        title="Trainings"
        subtitle="Interne und externe Maßnahmen, Anmeldungen und Pflichtschulungen."
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => openEditor()}>
            <Plus size={16} /> Neues Training
          </button>
        }
      />
      <div className="stack">
        {(overdue.length > 0 || soon.length > 0) && (
          <Card
            title={
              <span className="row">
                <AlertTriangle size={17} color="var(--warning)" /> Fällige Pflichtschulungen
              </span>
            }
            flush
          >
            <div className="hm-table-wrap" style={{ maxHeight: 260 }}>
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter:in</th>
                    <th>Training</th>
                    <th>Zuletzt absolviert</th>
                    <th>Fällig am</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...overdue, ...soon].map((d) => (
                    <tr key={`${d.training_id}-${d.employee_id}`}>
                      <td>
                        {d.last_name}, {d.first_name}
                      </td>
                      <td>{d.training_title}</td>
                      <td>{formatDate(d.last_completed_at)}</td>
                      <td>{d.due_date ? formatDate(d.due_date) : 'sofort'}</td>
                      <td>
                        <Badge tone={d.due_status === 'ueberfaellig' ? 'red' : 'yellow'}>
                          {d.due_status === 'ueberfaellig' ? 'Überfällig' : 'Bald fällig'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="Katalog" flush>
          {(trainings ?? []).length === 0 ? (
            <EmptyState
              icon={<GraduationCap size={40} />}
              title="Noch keine Trainings"
              hint="Legen Sie interne oder externe Maßnahmen an."
            />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Titel</th>
                    <th>Anbieter</th>
                    <th>Art</th>
                    <th>Pflicht</th>
                    <th>Intervall</th>
                    <th className="num">Kosten</th>
                    <th className="num">Anmeldungen</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(trainings ?? []).map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => setDetail(t)}>
                      <td style={{ fontWeight: 550 }}>{t.title}</td>
                      <td>{t.provider ?? '—'}</td>
                      <td>
                        <Badge tone={t.kind === 'intern' ? 'blue' : 'neutral'}>
                          {TRAINING_KIND_LABELS[t.kind]}
                        </Badge>
                      </td>
                      <td>{t.mandatory ? <Badge tone="navy">Pflicht</Badge> : '—'}</td>
                      <td>
                        {t.repeat_interval_months ? `alle ${t.repeat_interval_months} Monate` : '—'}
                      </td>
                      <td className="num">{t.cost_cents === null ? '—' : formatEuro(t.cost_cents)}</td>
                      <td className="num">{t.registrations_count}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="hm-btn hm-btn--ghost hm-btn--sm" onClick={() => openEditor(t)}>
                            Bearbeiten
                          </button>
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--sm"
                            onClick={() => setDeleteTarget(t)}
                          >
                            Löschen
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
      </div>

      <Modal
        title={editing ? 'Training bearbeiten' : 'Neues Training'}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setEditorOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={!form.title.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Speichern
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Titel" required span2>
            <input
              className="hm-input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="Anbieter">
            <input
              className="hm-input"
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            />
          </Field>
          <Field label="Art">
            <select
              className="hm-select"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as 'intern' | 'extern' })}
            >
              <option value="intern">Intern</option>
              <option value="extern">Extern</option>
            </select>
          </Field>
          <Field label="Kosten (€)">
            <input
              className="hm-input"
              type="number"
              min={0}
              step="0.01"
              value={form.cost_cents}
              onChange={(e) => setForm({ ...form, cost_cents: e.target.value })}
            />
          </Field>
          <Field label="Wiederholung (Monate)" hint="Nur für Pflichtschulungen relevant">
            <input
              className="hm-input"
              type="number"
              min={1}
              value={form.repeat_interval_months}
              onChange={(e) => setForm({ ...form, repeat_interval_months: e.target.value })}
            />
          </Field>
          <Field label="Beschreibung" span2>
            <textarea
              className="hm-textarea"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <label className="hm-checkbox">
            <input
              type="checkbox"
              checked={form.mandatory}
              onChange={(e) => setForm({ ...form, mandatory: e.target.checked })}
            />
            Pflichtschulung (mit Fälligkeitsüberwachung)
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Training löschen?"
        message={`„${deleteTarget?.title}" wird mit allen Anmeldungen gelöscht. Das kann nicht rückgängig gemacht werden.`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />

      {detail && <RegistrationsModal training={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function RegistrationsModal({ training, onClose }: { training: TrainingRow; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['performance', 'trainings', 'registrations', training.id];
  const { data: registrations, isLoading } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ registrations: RegistrationRow[] }>(
        `/api/performance/trainings/${training.id}/registrations`,
      ),
    select: (d) => d.registrations,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['performance', 'trainings'] });
  };

  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);

  const register = useMutation({
    mutationFn: () =>
      api.post('/api/performance/training-registrations', {
        training_id: training.id,
        employee_id: employeeId,
        date: date || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setEmployeeId(null);
      toast.success('Anmeldung erfasst');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      api.put(`/api/performance/training-registrations/${id}`, patch),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  async function onCertificateChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || uploadTarget === null) return;
    try {
      const res = await uploadFile(file);
      update.mutate({ id: uploadTarget, patch: { certificate_file_id: res.file.id } });
      toast.success('Zertifikat hochgeladen');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload fehlgeschlagen');
    }
  }

  const nextStatus: Record<TrainingRegistrationStatus, TrainingRegistrationStatus | null> = {
    angemeldet: 'teilgenommen',
    teilgenommen: 'abgeschlossen',
    abgeschlossen: null,
    storniert: null,
  };

  return (
    <Modal
      title={
        <span className="row">
          <Users size={18} /> Anmeldungen — {training.title}
        </span>
      }
      open
      onClose={onClose}
      wide
    >
      <div className="stack">
        <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Mitarbeiter:in">
            <div style={{ minWidth: 240 }}>
              <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
            </div>
          </Field>
          <Field label="Termin">
            <input className="hm-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <button
            className="hm-btn hm-btn--primary"
            disabled={employeeId === null || register.isPending}
            onClick={() => register.mutate()}
          >
            <Plus size={15} /> Anmelden
          </button>
        </div>

        {isLoading ? (
          <Spinner center />
        ) : (registrations ?? []).length === 0 ? (
          <EmptyState title="Noch keine Anmeldungen" />
        ) : (
          <div className="hm-table-wrap" style={{ maxHeight: 380 }}>
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Status</th>
                  <th>Termin</th>
                  <th>Abgeschlossen</th>
                  <th>Zertifikat</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(registrations ?? []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.last_name}, {r.first_name}
                    </td>
                    <td>
                      <Badge tone={REGISTRATION_STATUS_TONES[r.status]}>
                        {TRAINING_REGISTRATION_STATUS_LABELS[r.status]}
                      </Badge>
                    </td>
                    <td>{formatDate(r.date)}</td>
                    <td>{formatDate(r.completed_at)}</td>
                    <td>
                      {r.certificate_file_id ? (
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm"
                          onClick={() => downloadFile(r.certificate_file_id!)}
                        >
                          <Download size={14} /> Ansehen
                        </button>
                      ) : r.status === 'abgeschlossen' || r.status === 'teilgenommen' ? (
                        <button
                          className="hm-btn hm-btn--ghost hm-btn--sm"
                          onClick={() => {
                            setUploadTarget(r.id);
                            fileInput.current?.click();
                          }}
                        >
                          <Upload size={14} /> Hochladen
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {nextStatus[r.status] && (
                          <button
                            className="hm-btn hm-btn--secondary hm-btn--sm"
                            onClick={() => update.mutate({ id: r.id, patch: { status: nextStatus[r.status] } })}
                          >
                            → {TRAINING_REGISTRATION_STATUS_LABELS[nextStatus[r.status]!]}
                          </button>
                        )}
                        {r.status === 'angemeldet' && (
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--sm"
                            onClick={() => update.mutate({ id: r.id, patch: { status: 'storniert' } })}
                          >
                            Stornieren
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
      </div>
      <input ref={fileInput} type="file" hidden onChange={onCertificateChosen} />
    </Modal>
  );
}
