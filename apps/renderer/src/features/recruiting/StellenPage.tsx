import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Briefcase, Plus, Pencil, Trash2, Users, MapPin, UserCog, Layers } from 'lucide-react';
import {
  JOB_POSTING_STATUS_LABELS, JOB_POSTING_TRANSITIONS, EMPLOYEE_TYPE_LABELS,
  formatEuro, formatDate,
  type JobPostingStatus, type EmployeeType,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, StatCard } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { usePostings, usePosting, useRecruitingOrg, useInvalidate, type Posting } from './api';
import { POSTING_STATUS_TONES, StageChip, parseEuroInput, centsToInput } from './common';
import { Select } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';

interface Draft {
  title: string;
  employment_type: EmployeeType;
  department_id: number | null;
  team_id: number | null;
  location_id: number | null;
  hiring_manager_id: number | null;
  seats: number;
  employment_start: string;
  salary_min: string;
  salary_max: string;
  description: string;
  requirements: string;
}

const emptyDraft = (): Draft => ({
  title: '',
  employment_type: 'vollzeit',
  department_id: null,
  team_id: null,
  location_id: null,
  hiring_manager_id: null,
  seats: 1,
  employment_start: '',
  salary_min: '',
  salary_max: '',
  description: '',
  requirements: '',
});

function PostingEditor({
  open,
  initial,
  editId,
  onClose,
}: {
  open: boolean;
  initial: Draft;
  editId: number | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: org } = useRecruitingOrg();
  const [form, setForm] = useState<Draft>(initial);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setForm(initial);
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title: form.title,
        employment_type: form.employment_type,
        department_id: form.department_id,
        team_id: form.team_id,
        location_id: form.location_id,
        hiring_manager_id: form.hiring_manager_id,
        seats: form.seats,
        employment_start: form.employment_start || null,
        salary_min_cents: parseEuroInput(form.salary_min),
        salary_max_cents: parseEuroInput(form.salary_max),
        description: form.description || null,
        requirements: form.requirements || null,
      };
      return editId === null
        ? api.post('/api/recruiting/postings', payload)
        : api.put(`/api/recruiting/postings/${editId}`, payload);
    },
    onSuccess: () => {
      toast.success(editId === null ? 'Stelle angelegt' : 'Stelle aktualisiert');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const teams = (org?.teams ?? []).filter((t) => !form.department_id || t.department_id === form.department_id);

  return (
    <Modal
      title={editId === null ? 'Neue Stelle' : 'Stelle bearbeiten'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>Abbrechen</button>
          <button className="hm-btn hm-btn--primary" disabled={save.isPending || !form.title.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Stellentitel" required span2>
          <input className="hm-input" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="z. B. Senior Backend Entwickler:in" />
        </Field>
        <Field label="Beschäftigungsart" required>
          <Select className="hm-select" value={form.employment_type} onChange={(e) => setForm((f) => ({ ...f, employment_type: e.target.value as EmployeeType }))}>
            {(Object.keys(EMPLOYEE_TYPE_LABELS) as EmployeeType[]).map((t) => (
              <option key={t} value={t}>{EMPLOYEE_TYPE_LABELS[t]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Anzahl Stellen" required>
          <input className="hm-input" type="number" min={1} value={form.seats} onChange={(e) => setForm((f) => ({ ...f, seats: Math.max(1, Number(e.target.value)) }))} />
        </Field>
        <Field label="Abteilung">
          <Select className="hm-select" value={form.department_id ?? ''} onChange={(e) => setForm((f) => ({ ...f, department_id: e.target.value ? Number(e.target.value) : null, team_id: null }))}>
            <option value="">— keine —</option>
            {(org?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Team">
          <Select className="hm-select" value={form.team_id ?? ''} onChange={(e) => setForm((f) => ({ ...f, team_id: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">— keins —</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Standort">
          <Select className="hm-select" value={form.location_id ?? ''} onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">— keiner —</option>
            {(org?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Verantwortliche Führungskraft">
          <EmployeeSelect value={form.hiring_manager_id} onChange={(id) => setForm((f) => ({ ...f, hiring_manager_id: id }))} allowEmpty emptyLabel="— keiner —" />
        </Field>
        <Field label="Gewünschter Eintritt">
          <input className="hm-input" type="date" value={form.employment_start} onChange={(e) => setForm((f) => ({ ...f, employment_start: e.target.value }))} />
        </Field>
        <Field label="Gehalt von (€/Monat)" hint="Bruttomonatsgehalt">
          <input className="hm-input" value={form.salary_min} onChange={(e) => setForm((f) => ({ ...f, salary_min: e.target.value }))} placeholder="z. B. 5.500" />
        </Field>
        <Field label="Gehalt bis (€/Monat)">
          <input className="hm-input" value={form.salary_max} onChange={(e) => setForm((f) => ({ ...f, salary_max: e.target.value }))} placeholder="z. B. 7.000" />
        </Field>
        <Field label="Stellenbeschreibung" span2>
          <textarea className="hm-textarea" rows={4} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
        <Field label="Anforderungen" span2>
          <textarea className="hm-textarea" rows={3} value={form.requirements} onChange={(e) => setForm((f) => ({ ...f, requirements: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

/** Stellendetail: Stammdaten und Verteilung der aktiven Bewerbungen ueber die Stufen. */
function PostingDetailDialog({ postingId, onClose }: { postingId: number | null; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: p, isLoading } = usePosting(postingId);
  const counts = p?.stage_counts ?? [];
  const max = Math.max(1, ...counts.map((c) => c.count));
  return (
    <Modal
      title={p?.title ?? 'Stelle'}
      open={postingId !== null}
      onClose={onClose}
      wide
      footer={
        p && (
          <button className="hm-btn hm-btn--secondary" onClick={() => { onClose(); navigate('/recruiting/pipeline'); }}>
            <Layers size={15} /> Zur Pipeline
          </button>
        )
      }
    >
      {isLoading || !p ? (
        <Spinner center />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={POSTING_STATUS_TONES[p.status]}>{JOB_POSTING_STATUS_LABELS[p.status]}</Badge>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{EMPLOYEE_TYPE_LABELS[p.employment_type]} · {p.seats} {p.seats === 1 ? 'Stelle' : 'Stellen'}</span>
          </div>
          <dl className="hm-form-grid" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            <div><dt style={{ color: 'var(--text-muted)' }}>Abteilung</dt><dd style={{ margin: 0 }}>{p.department_name ?? 'keine Angabe'}</dd></div>
            <div><dt style={{ color: 'var(--text-muted)' }}>Team</dt><dd style={{ margin: 0 }}>{p.team_name ?? 'keine Angabe'}</dd></div>
            <div><dt style={{ color: 'var(--text-muted)' }}>Standort</dt><dd style={{ margin: 0 }}>{p.location_name ?? 'keine Angabe'}</dd></div>
            <div><dt style={{ color: 'var(--text-muted)' }}>Verantwortliche Führungskraft</dt><dd style={{ margin: 0 }}>{p.hiring_manager_name ?? 'keine Angabe'}</dd></div>
            <div><dt style={{ color: 'var(--text-muted)' }}>Gewünschter Eintritt</dt><dd style={{ margin: 0 }}>{p.employment_start ? formatDate(p.employment_start) : 'keine Angabe'}</dd></div>
            <div>
              <dt style={{ color: 'var(--text-muted)' }}>Gehaltsspanne (€/Monat)</dt>
              <dd style={{ margin: 0 }}>
                {p.salary_min_cents || p.salary_max_cents
                  ? `${p.salary_min_cents ? formatEuro(p.salary_min_cents) : '?'} bis ${p.salary_max_cents ? formatEuro(p.salary_max_cents) : '?'}`
                  : 'keine Angabe'}
              </dd>
            </div>
          </dl>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              Bewerbungen je Stufe
              <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 'var(--text-sm)' }}>
                {' '}· {p.active_count ?? 0} aktiv, {p.hired_count ?? 0} eingestellt, {p.application_count ?? 0} gesamt
              </span>
            </div>
            {counts.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>Keine aktiven Stufen konfiguriert.</p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {counts.map((c) => (
                  <div key={c.stage_id} className="row" style={{ gap: 10 }}>
                    <span style={{ width: 150, flexShrink: 0 }}><StageChip name={c.name} color={c.color} /></span>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--gray-100)', overflow: 'hidden' }}>
                      <div style={{ width: `${(c.count / max) * 100}%`, height: '100%', background: c.color, borderRadius: 4 }} />
                    </div>
                    <span style={{ width: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-numeric)', fontSize: 'var(--text-sm)' }}>{c.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {p.description && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Stellenbeschreibung</div>
              <div style={{ fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{p.description}</div>
            </div>
          )}
          {p.requirements && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Anforderungen</div>
              <div style={{ fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{p.requirements}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function StellenPage() {
  const navigate = useNavigate();
  const [detailId, setDetailId] = useState<number | null>(null);
  const toast = useToast();
  const invalidate = useInvalidate();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data: postings, isLoading } = usePostings({ status: statusFilter || undefined });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<Draft>(emptyDraft());
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Posting | null>(null);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: JobPostingStatus }) =>
      api.post(`/api/recruiting/postings/${id}/status`, { status }),
    onSuccess: () => {
      toast.success('Status aktualisiert');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/recruiting/postings/${id}`),
    onSuccess: () => {
      toast.success('Stelle gelöscht');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const openEdit = (p: Posting) => {
    setEditorInitial({
      title: p.title,
      employment_type: p.employment_type,
      department_id: p.department_id,
      team_id: p.team_id,
      location_id: p.location_id,
      hiring_manager_id: p.hiring_manager_id,
      seats: p.seats,
      employment_start: p.employment_start ?? '',
      salary_min: centsToInput(p.salary_min_cents),
      salary_max: centsToInput(p.salary_max_cents),
      description: p.description ?? '',
      requirements: p.requirements ?? '',
    });
    setEditId(p.id);
    setEditorOpen(true);
  };

  const all = postings ?? [];
  const openCount = all.filter((p) => p.status === 'veroeffentlicht' || p.status === 'pausiert').length;
  const totalSeats = all.filter((p) => p.status === 'veroeffentlicht' || p.status === 'pausiert').reduce((s, p) => s + p.seats, 0);
  const totalApplications = all.reduce((s, p) => s + (p.active_count ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Stellen"
        subtitle="Stellenausschreibungen und deren Besetzungsstatus verwalten"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => { setEditorInitial(emptyDraft()); setEditId(null); setEditorOpen(true); }}>
            <Plus size={16} /> Neue Stelle
          </button>
        }
      />

      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <StatCard label="Offene Stellen" value={openCount} icon={<Briefcase size={15} />} />
        <StatCard label="Zu besetzende Plätze" value={totalSeats} icon={<Users size={15} />} />
        <StatCard label="Aktive Bewerbungen" value={totalApplications} icon={<Users size={15} />} onClick={() => navigate('/recruiting/bewerber?tab=bewerbungen&status=aktiv')} />
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <Select className="hm-select" style={{ maxWidth: 220 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Alle Status</option>
          {(Object.keys(JOB_POSTING_STATUS_LABELS) as JobPostingStatus[]).map((s) => (
            <option key={s} value={s}>{JOB_POSTING_STATUS_LABELS[s]}</option>
          ))}
        </Select>
      </div>

      {isLoading ? (
        <Spinner center />
      ) : all.length === 0 ? (
        <Card>
          <EmptyState icon={<Briefcase size={40} />} title="Noch keine Stellen" hint="Legen Sie Ihre erste Stellenausschreibung an." />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {all.map((p) => (
            <div key={p.id} className="hm-card hm-card--clickable" onClick={() => setDetailId(p.id)}>
              <div className="hm-card__body">
                <div className="row row--between" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 'var(--text-md)' }}>{p.title}</strong>
                      <Badge tone={POSTING_STATUS_TONES[p.status]}>{JOB_POSTING_STATUS_LABELS[p.status]}</Badge>
                    </div>
                    <div className="row" style={{ gap: 12, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
                      <span>{EMPLOYEE_TYPE_LABELS[p.employment_type]}</span>
                      {p.department_name && <span>· {p.department_name}</span>}
                      {p.team_name && <span>· Team {p.team_name}</span>}
                      {p.location_name && <span className="row" style={{ gap: 3 }}>· <MapPin size={12} /> {p.location_name}</span>}
                      {p.hiring_manager_name && <span className="row" style={{ gap: 3 }}>· <UserCog size={12} /> {p.hiring_manager_name}</span>}
                      <span>· {p.seats} {p.seats === 1 ? 'Stelle' : 'Stellen'}</span>
                      {(p.salary_min_cents || p.salary_max_cents) && (
                        <span>· {p.salary_min_cents ? formatEuro(p.salary_min_cents) : '?'}–{p.salary_max_cents ? formatEuro(p.salary_max_cents) : '?'}</span>
                      )}
                      {p.published_at && <span>· veröffentlicht {formatDate(p.published_at)}</span>}
                    </div>
                    <div className="row" style={{ gap: 12, marginTop: 6, fontSize: 'var(--text-sm)' }}>
                      <span><strong>{p.active_count ?? 0}</strong> aktiv</span>
                      <span style={{ color: 'var(--text-muted)' }}><strong>{p.application_count ?? 0}</strong> gesamt</span>
                      <span style={{ color: 'var(--success)' }}><strong>{p.hired_count ?? 0}</strong> eingestellt</span>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <Select
                      className="hm-select"
                      style={{ maxWidth: 160 }}
                      value=""
                      onChange={(e) => e.target.value && setStatus.mutate({ id: p.id, status: e.target.value as JobPostingStatus })}
                    >
                      <option value="">Status ändern …</option>
                      {(JOB_POSTING_TRANSITIONS[p.status] ?? []).map((s) => (
                        <option key={s} value={s}>{JOB_POSTING_STATUS_LABELS[s]}</option>
                      ))}
                    </Select>
                    <Tooltip content={<span className="hm-tooltip__title">Bearbeiten</span>}>
                      <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" onClick={() => openEdit(p)}>
                        <Pencil size={15} />
                      </button>
                    </Tooltip>
                    <Tooltip content={<span className="hm-tooltip__title">Löschen</span>}>
                      <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" onClick={() => setDeleteTarget(p)}>
                        <Trash2 size={15} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <PostingEditor open={editorOpen} initial={editorInitial} editId={editId} onClose={() => setEditorOpen(false)} />
      <PostingDetailDialog postingId={detailId} onClose={() => setDetailId(null)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Stelle löschen"
        message={`Soll die Stelle „${deleteTarget?.title}“ gelöscht werden? Das ist nur möglich, solange keine Bewerbungen erfasst sind.`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
