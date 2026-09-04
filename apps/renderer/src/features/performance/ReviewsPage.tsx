import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ClipboardCheck, Users } from 'lucide-react';
import { api, ApiRequestError } from '../../api/client';
import { PageHeader, Card, EmptyState, Spinner, Badge, Field, Tabs } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect, useEmployees, employeeName } from '../../components/EmployeeSelect';
import {
  REVIEW_CYCLE_KIND_LABELS,
  REVIEW_CYCLE_STATUS_LABELS,
  REVIEW_KIND_LABELS,
  REVIEW_STATUS_LABELS,
  formatDate,
  type Review,
  type ReviewAggregate,
  type ReviewCriterion,
  type ReviewCycle,
  type ReviewCycleKind,
  type ReviewCycleStatus,
  type ReviewKind,
  type ReviewScore,
  type ReviewTemplate,
} from '@ohrganize/shared';
import { CYCLE_STATUS_TONES, REVIEW_STATUS_TONES } from './common';

export function ReviewsPage() {
  const [tab, setTab] = useState('cycles');
  return (
    <>
      <PageHeader title="Beurteilungen" subtitle="Zyklen, Bögen und Durchführung von Selbst-, Vorgesetzten- und 360°-Bewertungen" />
      <Tabs
        tabs={[
          { key: 'cycles', label: 'Zyklen' },
          { key: 'templates', label: 'Bögen' },
          { key: 'conduct', label: 'Durchführen' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'cycles' && <CyclesTab />}
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'conduct' && <ConductTab />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab: Zyklen
// ---------------------------------------------------------------------------

function CyclesTab() {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'jaehrlich' as ReviewCycleKind, period_from: '', period_to: '' });
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'review-cycles'],
    queryFn: () => api.get<{ cycles: ReviewCycle[] }>('/api/performance/review-cycles'),
  });
  const cycles = data?.cycles ?? [];

  const { data: overview } = useQuery({
    queryKey: ['performance', 'cycle-overview', selectedId],
    queryFn: () =>
      api.get<{ participants: { employee_id: number; first_name: string; last_name: string; reviews_total: number; reviews_completed: number; avg_overall_score: number | null }[] }>(
        `/api/performance/review-cycles/${selectedId}/overview`,
      ),
    enabled: selectedId !== null,
  });

  const createMutation = useMutation({
    mutationFn: () => api.post('/api/performance/review-cycles', form),
    onSuccess: () => {
      toast.success('Zyklus angelegt');
      setCreateOpen(false);
      setForm({ name: '', kind: 'jaehrlich', period_from: '', period_to: '' });
      qc.invalidateQueries({ queryKey: ['performance', 'review-cycles'] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Anlegen'),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: ReviewCycleStatus }) =>
      api.put(`/api/performance/review-cycles/${id}`, { status }),
    onSuccess: () => {
      toast.success('Status aktualisiert');
      qc.invalidateQueries({ queryKey: ['performance', 'review-cycles'] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler'),
  });

  if (isLoading) return <Spinner center />;

  return (
    <>
      <Card
        title="Beurteilungszyklen"
        actions={
          <button className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Zyklus anlegen
          </button>
        }
        flush
      >
        {cycles.length === 0 ? (
          <EmptyState icon={<ClipboardCheck size={40} />} title="Noch keine Zyklen" hint="Legen Sie den ersten Beurteilungszyklus an." />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Art</th>
                  <th>Zeitraum</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cycles.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                    style={{ cursor: 'pointer', background: c.id === selectedId ? 'var(--gray-50)' : undefined }}
                  >
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td>{REVIEW_CYCLE_KIND_LABELS[c.kind]}</td>
                    <td>
                      {formatDate(c.period_from)} – {formatDate(c.period_to)}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className="hm-select"
                        value={c.status}
                        onChange={(e) => statusMutation.mutate({ id: c.id, status: e.target.value as ReviewCycleStatus })}
                        style={{ width: 160 }}
                      >
                        {(Object.keys(REVIEW_CYCLE_STATUS_LABELS) as ReviewCycleStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {REVIEW_CYCLE_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Badge tone={CYCLE_STATUS_TONES[c.status]}>{REVIEW_CYCLE_STATUS_LABELS[c.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedId !== null && (
        <Card title="Teilnehmende des Zyklus" style={{ marginTop: 16 }} flush>
          {!overview || overview.participants.length === 0 ? (
            <EmptyState
              icon={<Users size={40} />}
              title="Noch keine Beurteilungen in diesem Zyklus"
              hint="Beurteilungen werden im Tab „Durchführen“ angelegt."
            />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter:in</th>
                    <th>Fortschritt</th>
                    <th>Ø Gesamtergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.participants.map((p) => (
                    <tr key={p.employee_id}>
                      <td>
                        {p.last_name}, {p.first_name}
                      </td>
                      <td>
                        {p.reviews_completed}/{p.reviews_total} abgeschlossen
                      </td>
                      <td>{p.avg_overall_score !== null ? p.avg_overall_score.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Modal
        title="Zyklus anlegen"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setCreateOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={createMutation.isPending}
              onClick={() => {
                if (!form.name.trim() || !form.period_from || !form.period_to) {
                  toast.error('Bitte Name und Zeitraum angeben');
                  return;
                }
                createMutation.mutate();
              }}
            >
              Anlegen
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Name" required span2>
            <input
              className="hm-input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="z. B. Jahresgespräche 2026"
            />
          </Field>
          <Field label="Art" required>
            <select className="hm-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ReviewCycleKind })}>
              {(Object.keys(REVIEW_CYCLE_KIND_LABELS) as ReviewCycleKind[]).map((k) => (
                <option key={k} value={k}>
                  {REVIEW_CYCLE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <div />
          <Field label="Zeitraum von" required>
            <input type="date" className="hm-input" value={form.period_from} onChange={(e) => setForm({ ...form, period_from: e.target.value })} />
          </Field>
          <Field label="Zeitraum bis" required>
            <input type="date" className="hm-input" value={form.period_to} onChange={(e) => setForm({ ...form, period_to: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab: Bögen (Template-Editor)
// ---------------------------------------------------------------------------

function TemplatesTab() {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewTemplate | null>(null);
  const [deleting, setDeleting] = useState<ReviewTemplate | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'review-templates'],
    queryFn: () => api.get<{ templates: ReviewTemplate[] }>('/api/performance/review-templates'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/review-templates/${id}`),
    onSuccess: () => {
      toast.success('Bogen gelöscht');
      qc.invalidateQueries({ queryKey: ['performance', 'review-templates'] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Löschen'),
  });

  if (isLoading) return <Spinner center />;
  const templates = data?.templates ?? [];

  return (
    <>
      <Card
        title="Beurteilungsbögen"
        actions={
          <button
            className="hm-btn hm-btn--primary hm-btn--sm"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <Plus size={15} /> Bogen anlegen
          </button>
        }
        flush
      >
        {templates.length === 0 ? (
          <EmptyState title="Noch keine Bögen" hint="Ein Bogen definiert die Kriterien und die Bewertungsskala." />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kriterien</th>
                  <th style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td>
                      {t.criteria.map((c) => `${c.label} (1–${c.scale_max})`).join(', ')}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="hm-btn hm-btn--secondary hm-btn--sm"
                          onClick={() => {
                            setEditing(t);
                            setEditorOpen(true);
                          }}
                        >
                          Bearbeiten
                        </button>
                        <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={() => setDeleting(t)} aria-label="Löschen">
                          <Trash2 size={16} />
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

      {editorOpen && (
        <TemplateEditor
          template={editing}
          onClose={() => setEditorOpen(false)}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Bogen löschen"
        message={`„${deleting?.name}“ wird gelöscht. Bögen, die bereits verwendet werden, können nicht gelöscht werden.`}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function TemplateEditor({ template, onClose }: { template: ReviewTemplate | null; onClose: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [criteria, setCriteria] = useState<ReviewCriterion[]>(
    template?.criteria ?? [{ key: '', label: '', description: '', scale_max: 5 }],
  );
  const toast = useToast();
  const qc = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (payload: { name: string; criteria: ReviewCriterion[] }) =>
      template
        ? api.put(`/api/performance/review-templates/${template.id}`, payload)
        : api.post('/api/performance/review-templates', payload),
    onSuccess: () => {
      toast.success(template ? 'Bogen aktualisiert' : 'Bogen angelegt');
      qc.invalidateQueries({ queryKey: ['performance', 'review-templates'] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Speichern'),
  });

  const setCriterion = (i: number, patch: Partial<ReviewCriterion>) =>
    setCriteria(criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const submit = () => {
    if (!name.trim()) {
      toast.error('Bitte einen Namen angeben');
      return;
    }
    const cleaned = criteria
      .filter((c) => c.label.trim())
      .map((c) => ({
        key: c.key.trim() || slugify(c.label),
        label: c.label.trim(),
        description: c.description || undefined,
        scale_max: c.scale_max,
      }));
    if (cleaned.length === 0) {
      toast.error('Mindestens ein Kriterium ist erforderlich');
      return;
    }
    saveMutation.mutate({ name: name.trim(), criteria: cleaned });
  };

  return (
    <Modal
      title={template ? 'Bogen bearbeiten' : 'Bogen anlegen'}
      open
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="hm-btn hm-btn--primary" onClick={submit} disabled={saveMutation.isPending}>
            Speichern
          </button>
        </>
      }
    >
      <Field label="Name" required>
        <input className="hm-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Standardbogen Fachkräfte" />
      </Field>
      <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Kriterien</div>
        {criteria.map((c, i) => (
          <div key={i} className="row row--wrap" style={{ alignItems: 'flex-end', gap: 8 }}>
            <div style={{ flex: '2 1 180px' }}>
              <Field label="Kriterium" required>
                <input
                  className="hm-input"
                  value={c.label}
                  onChange={(e) => setCriterion(i, { label: e.target.value })}
                  placeholder="z. B. Arbeitsqualität"
                />
              </Field>
            </div>
            <div style={{ flex: '3 1 220px' }}>
              <Field label="Beschreibung">
                <input
                  className="hm-input"
                  value={c.description ?? ''}
                  onChange={(e) => setCriterion(i, { description: e.target.value })}
                />
              </Field>
            </div>
            <div style={{ width: 130 }}>
              <Field label="Skala">
                <select className="hm-select" value={c.scale_max} onChange={(e) => setCriterion(i, { scale_max: Number(e.target.value) })}>
                  <option value={5}>1–5</option>
                  <option value={10}>1–10</option>
                </select>
              </Field>
            </div>
            <button
              className="hm-btn hm-btn--ghost hm-btn--icon"
              onClick={() => setCriteria(criteria.filter((_, idx) => idx !== i))}
              disabled={criteria.length === 1}
              aria-label="Kriterium entfernen"
              style={{ marginBottom: 6 }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <div>
          <button
            className="hm-btn hm-btn--secondary hm-btn--sm"
            onClick={() => setCriteria([...criteria, { key: '', label: '', description: '', scale_max: 5 }])}
          >
            <Plus size={15} /> Kriterium hinzufügen
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tab: Durchführen
// ---------------------------------------------------------------------------

function ConductTab() {
  const [cycleId, setCycleId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [openReview, setOpenReview] = useState<Review | null>(null);
  const { data: employees } = useEmployees(true);

  const { data: cyclesData } = useQuery({
    queryKey: ['performance', 'review-cycles'],
    queryFn: () => api.get<{ cycles: ReviewCycle[] }>('/api/performance/review-cycles'),
  });
  const { data: templatesData } = useQuery({
    queryKey: ['performance', 'review-templates'],
    queryFn: () => api.get<{ templates: ReviewTemplate[] }>('/api/performance/review-templates'),
  });

  const params = new URLSearchParams();
  if (cycleId) params.set('cycle_id', String(cycleId));
  if (employeeId) params.set('employee_id', String(employeeId));
  const { data: reviewsData, isLoading } = useQuery({
    queryKey: ['performance', 'reviews', cycleId, employeeId],
    queryFn: () => api.get<{ reviews: Review[] }>(`/api/performance/reviews?${params.toString()}`),
  });

  const { data: aggregateData } = useQuery({
    queryKey: ['performance', 'review-aggregate', cycleId, employeeId],
    queryFn: () =>
      api.get<{ aggregate: ReviewAggregate }>(`/api/performance/reviews/aggregate/${cycleId}/${employeeId}`),
    enabled: cycleId !== null && employeeId !== null,
  });

  const nameOf = (id: number | null) => {
    if (id === null) return '—';
    const e = employees?.find((x) => x.id === id);
    return e ? employeeName(e) : `#${id}`;
  };

  const reviews = reviewsData?.reviews ?? [];
  const cycles = cyclesData?.cycles ?? [];
  const templates = templatesData?.templates ?? [];

  return (
    <>
      <Card>
        <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 220 }}>
            <Field label="Zyklus">
              <select className="hm-select" value={cycleId ?? ''} onChange={(e) => setCycleId(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Alle Zyklen</option>
                {cycles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ minWidth: 240 }}>
            <Field label="Mitarbeiter:in">
              <EmployeeSelect value={employeeId} onChange={setEmployeeId} emptyLabel="Alle Mitarbeitenden" />
            </Field>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Beurteilung anlegen
            </button>
          </div>
        </div>
      </Card>

      {cycleId !== null && employeeId !== null && aggregateData?.aggregate && aggregateData.aggregate.reviews_count > 0 && (
        <Card title={`Gesamtergebnis (${aggregateData.aggregate.reviews_count} abgeschlossene Beurteilungen, inkl. 360°)`} style={{ marginTop: 16 }}>
          <div className="row row--wrap" style={{ gap: 24 }}>
            <div>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>
                {aggregateData.aggregate.overall_score?.toFixed(2) ?? '—'}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Ø Gesamtergebnis</div>
            </div>
            <div style={{ flex: 1, minWidth: 260, display: 'grid', gap: 6 }}>
              {aggregateData.aggregate.criteria.map((c) => (
                <div key={c.key} className="row" style={{ gap: 10 }}>
                  <span style={{ flex: '0 0 200px' }}>{c.label}</span>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{c.avg_score.toFixed(2)}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>({c.count} Bewertungen)</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      <Card title="Beurteilungen" style={{ marginTop: 16 }} flush>
        {isLoading ? (
          <Spinner center />
        ) : reviews.length === 0 ? (
          <EmptyState title="Keine Beurteilungen gefunden" hint="Legen Sie eine Beurteilung für einen Zyklus an." />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Art</th>
                  <th>Reviewer:in</th>
                  <th>Status</th>
                  <th>Gesamtergebnis</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{nameOf(r.employee_id)}</td>
                    <td>
                      <Badge tone="navy">{REVIEW_KIND_LABELS[r.kind]}</Badge>
                    </td>
                    <td>{r.kind === 'selbst' ? 'Selbstbewertung' : nameOf(r.reviewer_employee_id)}</td>
                    <td>
                      <Badge tone={REVIEW_STATUS_TONES[r.status]}>{REVIEW_STATUS_LABELS[r.status]}</Badge>
                    </td>
                    <td>{r.overall_score !== null ? r.overall_score.toFixed(2) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => setOpenReview(r)}>
                        {r.status === 'abgeschlossen' ? 'Ansehen' : 'Durchführen'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {createOpen && (
        <CreateReviewModal cycles={cycles} templates={templates} onClose={() => setCreateOpen(false)} />
      )}
      {openReview && (
        <ReviewFormModal
          review={openReview}
          template={templates.find((t) => t.id === openReview.template_id) ?? null}
          onClose={() => setOpenReview(null)}
        />
      )}
    </>
  );
}

function CreateReviewModal({
  cycles,
  templates,
  onClose,
}: {
  cycles: ReviewCycle[];
  templates: ReviewTemplate[];
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    cycle_id: cycles[0]?.id ?? 0,
    employee_id: null as number | null,
    template_id: templates[0]?.id ?? 0,
    reviewer_employee_id: null as number | null,
    kind: 'vorgesetzt' as ReviewKind,
  });
  const toast = useToast();
  const qc = useQueryClient();

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/api/performance/reviews', {
        cycle_id: form.cycle_id,
        employee_id: form.employee_id,
        template_id: form.template_id,
        reviewer_employee_id: form.kind === 'selbst' ? null : form.reviewer_employee_id,
        kind: form.kind,
      }),
    onSuccess: () => {
      toast.success('Beurteilung angelegt');
      qc.invalidateQueries({ queryKey: ['performance', 'reviews'] });
      qc.invalidateQueries({ queryKey: ['performance', 'cycle-overview'] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Anlegen'),
  });

  return (
    <Modal
      title="Beurteilung anlegen"
      open
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={createMutation.isPending}
            onClick={() => {
              if (!form.cycle_id || !form.template_id || !form.employee_id) {
                toast.error('Bitte Zyklus, Bogen und Mitarbeiter:in wählen');
                return;
              }
              if (form.kind !== 'selbst' && !form.reviewer_employee_id) {
                toast.error('Bitte eine:n Reviewer:in wählen');
                return;
              }
              createMutation.mutate();
            }}
          >
            Anlegen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Zyklus" required>
          <select className="hm-select" value={form.cycle_id} onChange={(e) => setForm({ ...form, cycle_id: Number(e.target.value) })}>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bogen" required>
          <select className="hm-select" value={form.template_id} onChange={(e) => setForm({ ...form, template_id: Number(e.target.value) })}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mitarbeiter:in (bewertet)" required>
          <EmployeeSelect value={form.employee_id} onChange={(id) => setForm({ ...form, employee_id: id })} />
        </Field>
        <Field label="Art" required>
          <select className="hm-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ReviewKind })}>
            {(Object.keys(REVIEW_KIND_LABELS) as ReviewKind[]).map((k) => (
              <option key={k} value={k}>
                {REVIEW_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        {form.kind !== 'selbst' && (
          <Field
            label="Reviewer:in"
            required
            hint={form.kind === 'feedback360' ? 'Für 360°-Feedback mehrere Beurteilungen mit unterschiedlichen Reviewer:innen anlegen.' : undefined}
          >
            <EmployeeSelect value={form.reviewer_employee_id} onChange={(id) => setForm({ ...form, reviewer_employee_id: id })} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function ReviewFormModal({
  review,
  template,
  onClose,
}: {
  review: Review;
  template: ReviewTemplate | null;
  onClose: () => void;
}) {
  const [scores, setScores] = useState<Map<string, ReviewScore>>(
    new Map(review.scores.map((s) => [s.key, s])),
  );
  const [summary, setSummary] = useState(review.summary ?? '');
  const readOnly = review.status === 'abgeschlossen';
  const toast = useToast();
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['performance', 'reviews'] });
    qc.invalidateQueries({ queryKey: ['performance', 'review-aggregate'] });
    qc.invalidateQueries({ queryKey: ['performance', 'cycle-overview'] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put(`/api/performance/reviews/${review.id}`, {
        scores: [...scores.values()].filter((s) => s.score >= 1),
        summary: summary || null,
      }),
    onSuccess: () => {
      toast.success('Zwischenstand gespeichert');
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Speichern'),
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      await api.put(`/api/performance/reviews/${review.id}`, {
        scores: [...scores.values()].filter((s) => s.score >= 1),
        summary: summary || null,
      });
      return api.post<{ review: Review }>(`/api/performance/reviews/${review.id}/complete`);
    },
    onSuccess: (res) => {
      toast.success(`Beurteilung abgeschlossen — Gesamtergebnis ${res.review.overall_score?.toFixed(2)}`);
      invalidate();
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Abschließen'),
  });

  const setScore = (key: string, patch: Partial<ReviewScore>) => {
    const next = new Map(scores);
    const existing = next.get(key) ?? { key, score: 0 };
    next.set(key, { ...existing, ...patch, key });
    setScores(next);
  };

  if (!template) {
    return (
      <Modal title="Beurteilung" open onClose={onClose}>
        <p style={{ color: 'var(--text-secondary)' }}>Der zugehörige Bogen wurde nicht gefunden.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8 }}>
          Beurteilung durchführen <Badge tone="navy">{REVIEW_KIND_LABELS[review.kind]}</Badge>
        </span>
      }
      open
      onClose={onClose}
      wide
      footer={
        readOnly ? (
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Schließen
          </button>
        ) : (
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              Zwischenstand speichern
            </button>
            <button
              className="hm-btn hm-btn--primary"
              onClick={() => completeMutation.mutate()}
              disabled={completeMutation.isPending}
            >
              Abschließen
            </button>
          </>
        )
      }
    >
      {readOnly && (
        <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          Abgeschlossen am {formatDate(review.completed_at?.slice(0, 10))} — Gesamtergebnis{' '}
          <strong>{review.overall_score?.toFixed(2)}</strong>
        </p>
      )}
      <div style={{ display: 'grid', gap: 16 }}>
        {template.criteria.map((c) => {
          const current = scores.get(c.key);
          return (
            <div key={c.key} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>
              <div style={{ fontWeight: 600 }}>{c.label}</div>
              {c.description && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 6 }}>{c.description}</div>
              )}
              <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
                {Array.from({ length: c.scale_max }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={`hm-btn hm-btn--sm ${current?.score === n ? 'hm-btn--primary' : 'hm-btn--secondary'}`}
                    disabled={readOnly}
                    onClick={() => setScore(c.key, { score: n })}
                    style={{ minWidth: 38 }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <input
                className="hm-input"
                style={{ marginTop: 8 }}
                placeholder="Kommentar (optional)"
                value={current?.comment ?? ''}
                disabled={readOnly}
                onChange={(e) => setScore(c.key, { score: current?.score ?? 0, comment: e.target.value })}
              />
            </div>
          );
        })}
        <Field label="Zusammenfassung">
          <textarea className="hm-textarea" rows={3} value={summary} disabled={readOnly} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
