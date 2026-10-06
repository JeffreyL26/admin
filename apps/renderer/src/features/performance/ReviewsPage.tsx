import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ClipboardCheck, Users, UserCheck, UserRound, Orbit, Link2, Building2 } from 'lucide-react';
import { api, ApiRequestError } from '../../api/client';
import { PageHeader, Card, EmptyState, Spinner, Badge, Field, Tabs } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect, useEmployees, employeeName } from '../../components/EmployeeSelect';
import {
  RATING_SCALES,
  RATING_SCALE_KEYS,
  REVIEW_CREATABLE_KINDS,
  REVIEW_CYCLE_KIND_LABELS,
  REVIEW_CYCLE_STATUS_LABELS,
  REVIEW_KIND_DESCRIPTIONS,
  REVIEW_KIND_LABELS,
  REVIEW_STATUS_LABELS,
  SUPERVISOR_RATING_DESCRIPTION,
  formatDate,
  type RatingScaleKey,
  type Review,
  type ReviewAggregate,
  type ReviewCategoryOption,
  type ReviewCriterion,
  type ReviewCycle,
  type ReviewCycleKind,
  type ReviewCycleStatus,
  type ReviewKind,
  type ReviewScore,
  type ReviewTemplate,
  type ReviewerSuggestion,
} from '@ohrganize/shared';
import { CYCLE_STATUS_TONES, REVIEW_STATUS_TONES } from './common';
import { Select } from '../../components/Select';
import { SetupNote } from '../leadership/SetupShared';
import { RatingInput, RatingValue } from '../leadership/RatingInput';
import { Tooltip } from '../../components/Tooltip';
import { useLeaderStatus } from '../leadership/api';

/**
 * Beurteilungen (Bereich `leistung`). Die Vorgesetztenbewertung wird NICHT
 * hier, sondern unter Führung → „Mein Team“ abgegeben (Zuständigkeit,
 * Pflichtkommentar, Protokoll). Hier leben Selbstbewertung und
 * 360°-Feedback, beide auf den zentralen Kategorien und Skalen, und das
 * Aggregat zeigt die Vorgesetztenbewertung als Ergebnis daneben. Deep-Link aus den Gesprächen:
 * `/leistung/beurteilungen?tab=conduct&employee=<id>`.
 */
export function ReviewsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'cycles';
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'cycles') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  return (
    <>
      <PageHeader
        title="Beurteilungen"
        subtitle="Selbstbewertung und 360°-Feedback in Zyklen, auf denselben Kategorien und Skalen wie die Bewertung durch die Führungskraft"
      />
      <KindLegend />
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

const KIND_ICONS: Record<ReviewKind | 'vorgesetzt', React.ReactNode> = {
  selbst: <UserRound size={15} />,
  vorgesetzt: <UserCheck size={15} />,
  feedback360: <Orbit size={15} />,
};

/**
 * Drei Arten, drei Kästen: Wer hier landet, soll ohne Nachfrage wissen, was
 * eine Selbstbewertung von einem 360°-Feedback unterscheidet und warum die
 * Vorgesetztenbewertung woanders liegt.
 */
function KindLegend() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('ohrganize.reviews.legend') !== 'closed';
    } catch {
      return true;
    }
  });
  if (!open) {
    return (
      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--sm"
          onClick={() => {
            setOpen(true);
            try {
              localStorage.removeItem('ohrganize.reviews.legend');
            } catch {
              /* Anzeige ohne Speicher */
            }
          }}
        >
          Bewertungsarten erklären
        </button>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
      <SetupNote icon={KIND_ICONS.vorgesetzt}>
        <strong>Vorgesetztenbewertung</strong> · {SUPERVISOR_RATING_DESCRIPTION}{' '}
        <Link to="/fuehrung/mein-team">Zu „Mein Team“</Link>
      </SetupNote>
      <SetupNote icon={KIND_ICONS.selbst}>
        <strong>Selbstbewertung</strong> · {REVIEW_KIND_DESCRIPTIONS.selbst}
      </SetupNote>
      <SetupNote
        icon={KIND_ICONS.feedback360}
        onDismiss={() => {
          setOpen(false);
          try {
            localStorage.setItem('ohrganize.reviews.legend', 'closed');
          } catch {
            /* Anzeige ohne Speicher */
          }
        }}
      >
        <strong>360°-Feedback</strong> · {REVIEW_KIND_DESCRIPTIONS.feedback360}
      </SetupNote>
    </div>
  );
}

function KindBadge({ kind }: { kind: ReviewKind }) {
  return (
    <Badge tone={kind === 'selbst' ? 'blue' : 'navy'}>
      <span className="row" style={{ gap: 5 }}>
        {KIND_ICONS[kind]}
        {REVIEW_KIND_LABELS[kind]}
      </span>
    </Badge>
  );
}

/**
 * Selbstbewertung und 360°-Feedback werden in diesem Schritt von der
 * Personalabteilung stellvertretend erfasst (kein Ausfüllen im Portal).
 * Das steht sichtbar an jeder Beurteilung, damit niemand die Zeilen für
 * eigenhändige Eingaben der Person hält.
 */
const PROXY_NOTE = 'Von der Personalabteilung stellvertretend erfasst; die Person bzw. das Umfeld füllt den Bogen nicht selbst im Portal aus.';

function ProxyBadge() {
  return (
    <Tooltip content={<span className="hm-tooltip__line">{PROXY_NOTE}</span>}>
      <span tabIndex={0} style={{ display: 'inline-flex' }}>
        <Badge tone="neutral">
          <span className="row" style={{ gap: 4 }}>
            <Building2 size={12} /> stellvertretend erfasst
          </span>
        </Badge>
      </span>
    </Tooltip>
  );
}

function percentText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value} %`;
}

function useRatingCategories() {
  return useQuery({
    queryKey: ['performance', 'rating-categories'],
    queryFn: () => api.get<{ categories: ReviewCategoryOption[] }>('/api/performance/rating-categories'),
    select: (d) => d.categories,
  });
}

// ---------------------------------------------------------------------------
// Tab: Zyklen
// ---------------------------------------------------------------------------

function CyclesTab() {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'jaehrlich' as ReviewCycleKind, period_from: '', period_to: '' });
  const [editing, setEditing] = useState<ReviewCycle | null>(null);
  const [deleting, setDeleting] = useState<ReviewCycle | null>(null);
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
      api.get<{
        participants: {
          employee_id: number;
          first_name: string;
          last_name: string;
          reviews_total: number;
          reviews_completed: number;
          avg_overall_percent: number | null;
        }[];
      }>(`/api/performance/review-cycles/${selectedId}/overview`),
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

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/review-cycles/${id}`),
    onSuccess: (_res, id) => {
      toast.success('Zyklus gelöscht');
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['performance', 'review-cycles'] });
      qc.invalidateQueries({ queryKey: ['performance', 'reviews'] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Löschen'),
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
                      <Select
                        className="hm-select"
                        value={c.status}
                        menuOnly
                        onChange={(e) => statusMutation.mutate({ id: c.id, status: e.target.value as ReviewCycleStatus })}
                        style={{ width: 160 }}
                      >
                        {(Object.keys(REVIEW_CYCLE_STATUS_LABELS) as ReviewCycleStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {REVIEW_CYCLE_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <Badge tone={CYCLE_STATUS_TONES[c.status]}>{REVIEW_CYCLE_STATUS_LABELS[c.status]}</Badge>
                        <Tooltip content={<span className="hm-tooltip__title">Bearbeiten</span>}>
                          <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={() => setEditing(c)} aria-label="Zyklus bearbeiten">
                            <Pencil size={16} />
                          </button>
                        </Tooltip>
                        <Tooltip content={<span className="hm-tooltip__title">Löschen</span>}>
                          <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={() => setDeleting(c)} aria-label="Zyklus löschen">
                            <Trash2 size={16} />
                          </button>
                        </Tooltip>
                      </div>
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
                    <th>Ø Ergebnis</th>
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
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{percentText(p.avg_overall_percent)}</td>
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
            <Select className="hm-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ReviewCycleKind })}>
              {(Object.keys(REVIEW_CYCLE_KIND_LABELS) as ReviewCycleKind[]).map((k) => (
                <option key={k} value={k}>
                  {REVIEW_CYCLE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
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

      {editing && <EditCycleModal cycle={editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={deleting !== null}
        title="Zyklus löschen"
        message={`„${deleting?.name}“ wird mit allen darin angelegten Beurteilungen gelöscht. Das kann nicht rückgängig gemacht werden.`}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

/** Name, Art und Zeitraum eines Zyklus; der Status wird in der Liste geschaltet. */
function EditCycleModal({ cycle, onClose }: { cycle: ReviewCycle; onClose: () => void }) {
  const [form, setForm] = useState({
    name: cycle.name,
    kind: cycle.kind,
    period_from: cycle.period_from,
    period_to: cycle.period_to,
  });
  const toast = useToast();
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: () => api.put(`/api/performance/review-cycles/${cycle.id}`, { ...form, name: form.name.trim() }),
    onSuccess: () => {
      toast.success('Zyklus gespeichert');
      qc.invalidateQueries({ queryKey: ['performance', 'review-cycles'] });
      qc.invalidateQueries({ queryKey: ['performance', 'review-aggregate'] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Speichern'),
  });

  const periodInvalid = Boolean(form.period_from && form.period_to && form.period_to < form.period_from);

  return (
    <Modal
      title="Zyklus bearbeiten"
      open
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!form.name.trim() || !form.period_from || !form.period_to || periodInvalid || save.isPending}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2>
          <input className="hm-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Art" required>
          <Select className="hm-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ReviewCycleKind })}>
            {(Object.keys(REVIEW_CYCLE_KIND_LABELS) as ReviewCycleKind[]).map((k) => (
              <option key={k} value={k}>
                {REVIEW_CYCLE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <div />
        <Field label="Zeitraum von" required>
          <input type="date" className="hm-input" value={form.period_from} onChange={(e) => setForm({ ...form, period_from: e.target.value })} />
        </Field>
        <Field label="Zeitraum bis" required hint={periodInvalid ? 'Ende liegt vor dem Beginn' : undefined}>
          <input type="date" className="hm-input" value={form.period_to} onChange={(e) => setForm({ ...form, period_to: e.target.value })} />
        </Field>
      </div>
    </Modal>
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
      <SetupNote>
        Ein Bogen stellt Kriterien zusammen. Kriterien aus den <strong>zentralen Kategorien</strong> (Führung → Einrichtung)
        übernehmen Name und Skala von dort, damit Selbst- und Vorgesetztenbewertung vergleichbar bleiben; freie Kriterien
        eignen sich für 360°-Fragen, die nur das Umfeld beantworten kann.
      </SetupNote>
      <Card
        title="Beurteilungsbögen"
        style={{ marginTop: 12 }}
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
          <EmptyState title="Noch keine Bögen" hint="Ein Bogen definiert die Kriterien und je Kriterium die Skala." />
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
                      <div className="row row--wrap" style={{ gap: 6 }}>
                        {t.criteria.map((c) => (
                          <Badge key={c.key} tone={c.category_id ? 'blue' : 'neutral'}>
                            <span className="row" style={{ gap: 4 }}>
                              {c.category_id ? <Link2 size={12} /> : null}
                              {c.label} · {RATING_SCALES[c.scale].label}
                            </span>
                          </Badge>
                        ))}
                      </div>
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

      {editorOpen && <TemplateEditor template={editing} onClose={() => setEditorOpen(false)} />}

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

type EditableCriterion = ReviewCriterion & { description: string };

const emptyCriterion = (): EditableCriterion => ({ key: '', label: '', description: '', scale: 'stars5', category_id: null });

function TemplateEditor({ template, onClose }: { template: ReviewTemplate | null; onClose: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [criteria, setCriteria] = useState<EditableCriterion[]>(
    template?.criteria.map((c) => ({ ...c, description: c.description ?? '', category_id: c.category_id ?? null })) ?? [
      emptyCriterion(),
    ],
  );
  const { data: categories } = useRatingCategories();
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

  const setCriterion = (i: number, patch: Partial<EditableCriterion>) =>
    setCriteria(criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  /** Kategorie wählen: Name, Beschreibung und Skala kommen von dort und sind gesperrt. */
  const bindCategory = (i: number, id: number | null) => {
    if (id === null) {
      setCriterion(i, { category_id: null });
      return;
    }
    const cat = categories?.find((c) => c.id === id);
    if (!cat) return;
    setCriterion(i, {
      category_id: cat.id,
      label: cat.name,
      description: cat.description ?? '',
      scale: cat.scale,
      key: `kat_${cat.id}`,
    });
  };

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
        scale: c.scale,
        category_id: c.category_id ?? null,
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
        {criteria.map((c, i) => {
          const bound = !!c.category_id;
          return (
            <div key={i} className="row row--wrap" style={{ alignItems: 'flex-end', gap: 8 }}>
              <div style={{ flex: '2 1 200px' }}>
                <Field label="Quelle">
                  <Select
                    className="hm-select"
                    value={c.category_id ?? ''}
                    onChange={(e) => bindCategory(i, e.target.value === '' ? null : Number(e.target.value))}
                  >
                    <option value="">Freies Kriterium</option>
                    {(categories ?? []).map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        Kategorie: {cat.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div style={{ flex: '2 1 180px' }}>
                <Field label="Kriterium" required>
                  <input
                    className="hm-input"
                    value={c.label}
                    disabled={bound}
                    onChange={(e) => setCriterion(i, { label: e.target.value })}
                    placeholder="z. B. Arbeitsqualität"
                  />
                </Field>
              </div>
              <div style={{ flex: '3 1 220px' }}>
                <Field label="Beschreibung">
                  <input
                    className="hm-input"
                    value={c.description}
                    disabled={bound}
                    onChange={(e) => setCriterion(i, { description: e.target.value })}
                  />
                </Field>
              </div>
              <div style={{ width: 200 }}>
                <Field label="Skala">
                  <Select
                    className="hm-select"
                    value={c.scale}
                    disabled={bound}
                    onChange={(e) => setCriterion(i, { scale: e.target.value as RatingScaleKey })}
                  >
                    {RATING_SCALE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {RATING_SCALES[k].label}
                      </option>
                    ))}
                  </Select>
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
          );
        })}
        <div>
          <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => setCriteria([...criteria, emptyCriterion()])}>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const employeeParam = searchParams.get('employee');
  const [cycleId, setCycleId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(employeeParam ? Number(employeeParam) : null);
  const [createOpen, setCreateOpen] = useState(false);
  const [openReview, setOpenReview] = useState<Review | null>(null);
  const [deleting, setDeleting] = useState<Review | null>(null);
  const { data: employees } = useEmployees(true);
  const { data: leaderStatus } = useLeaderStatus();
  const toast = useToast();
  const qc = useQueryClient();
  // „Mein Team“ öffnet sich nur für Führungskräfte; alle anderen sehen die
  // Bewertung im Report (Bereich fuehrung).
  const leadershipLink = leaderStatus?.is_leader
    ? { to: `/fuehrung/mein-team/${employeeId}`, label: 'Mein Team' }
    : { to: '/fuehrung/report', label: 'Satisfaction-Report' };

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/api/performance/reviews/${id}`),
    onSuccess: () => {
      toast.success('Beurteilung gelöscht');
      qc.invalidateQueries({ queryKey: ['performance', 'reviews'] });
      qc.invalidateQueries({ queryKey: ['performance', 'review-aggregate'] });
      qc.invalidateQueries({ queryKey: ['performance', 'cycle-overview'] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Löschen'),
  });

  // Der Deep-Link aus den Gesprächen setzt die Person; die Auswahl selbst
  // hält die URL nach, damit Zurück-Navigation den Filter behält.
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (employeeId) params.set('employee', String(employeeId));
    else params.delete('employee');
    if (params.toString() !== searchParams.toString()) setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

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
  const aggregate = aggregateData?.aggregate;
  const showAggregate = cycleId !== null && employeeId !== null && aggregate && (aggregate.reviews_count > 0 || aggregate.supervisor.length > 0);

  return (
    <>
      <Card>
        <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 220 }}>
            <Field label="Zyklus">
              <Select className="hm-select" value={cycleId ?? ''} onChange={(e) => setCycleId(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Alle Zyklen</option>
                {cycles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
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
        {cycleId === null && employeeId !== null && (
          <div style={{ marginTop: 10, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Wählen Sie einen Zyklus, um das Gesamtbild dieser Person (Selbstbild, Umfeld, Führungskraft) zu sehen.
          </div>
        )}
      </Card>

      {showAggregate && aggregate && (
        <Card title="Gesamtbild im Zyklus" style={{ marginTop: 16 }}>
          <div className="row row--wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 300px' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }} className="row">
                {KIND_ICONS.selbst} Selbstbild &amp; Umfeld
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                  {aggregate.reviews_count} abgeschlossene Bögen
                </span>
              </div>
              {aggregate.reviews_count === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Noch keine abgeschlossene Beurteilung.</div>
              ) : (
                <>
                  <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>{percentText(aggregate.overall_percent)}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 10 }}>
                    Ø Anteil der Bestnote über alle Kriterien
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {aggregate.criteria.map((c) => (
                      <div key={c.key} className="row" style={{ gap: 10 }}>
                        <span style={{ flex: '0 0 200px' }}>{c.label}</span>
                        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{c.avg_percent} %</strong>
                        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                          Ø {c.avg_score.toFixed(2)} auf {RATING_SCALES[c.scale].label} · {c.count} Bewertungen
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div style={{ flex: '1 1 300px' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }} className="row">
                {KIND_ICONS.vorgesetzt} Bewertung durch die Führungskraft
              </div>
              {aggregate.supervisor.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                  Im Zeitraum des Zyklus liegt keine Bewertung aus dem Bereich Führung vor. Sie entsteht unter „Mein Team“
                  durch die zuständige Führungskraft.{' '}
                  <Link to={leadershipLink.to}>{leadershipLink.label}</Link>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {aggregate.supervisor.map((s) => (
                    <div key={s.period_key} style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <strong>{s.period_label}</strong>
                        {s.leader_name && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>von {s.leader_name}</span>
                        )}
                        {s.overall && <RatingValue scale={s.overall.scale} score={s.overall.score} />}
                      </div>
                      <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                        {s.categories.map((c) => (
                          <div key={c.name} className="row" style={{ gap: 10 }}>
                            <span style={{ flex: '0 0 200px' }}>{c.name}</span>
                            <RatingValue scale={c.scale} score={c.score} size={14} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                    Kommentare und Protokoll: <Link to={leadershipLink.to}>{leadershipLink.label}</Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card title="Beurteilungen" style={{ marginTop: 16 }} flush>
        {isLoading ? (
          <Spinner center />
        ) : reviews.length === 0 ? (
          <EmptyState title="Keine Beurteilungen gefunden" hint="Legen Sie eine Selbstbewertung oder ein 360°-Feedback für einen Zyklus an." />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Mitarbeiter:in</th>
                  <th>Art</th>
                  <th>Reviewer:in</th>
                  <th>Status</th>
                  <th>Ergebnis</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{nameOf(r.employee_id)}</td>
                    <td>
                      <div className="row row--wrap" style={{ gap: 6 }}>
                        <KindBadge kind={r.kind} />
                        <ProxyBadge />
                      </div>
                    </td>
                    <td>{r.kind === 'selbst' ? 'die Person selbst' : nameOf(r.reviewer_employee_id)}</td>
                    <td>
                      <Badge tone={REVIEW_STATUS_TONES[r.status]}>{REVIEW_STATUS_LABELS[r.status]}</Badge>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{percentText(r.overall_percent)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => setOpenReview(r)}>
                          {r.status === 'abgeschlossen' ? 'Ansehen' : 'Durchführen'}
                        </button>
                        <Tooltip content={<span className="hm-tooltip__title">Löschen</span>}>
                          <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={() => setDeleting(r)} aria-label="Beurteilung löschen">
                            <Trash2 size={16} />
                          </button>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {createOpen && (
        <CreateReviewModal
          cycles={cycles}
          templates={templates}
          initialEmployeeId={employeeId}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {openReview && (
        <ReviewFormModal
          review={openReview}
          template={templates.find((t) => t.id === openReview.template_id) ?? null}
          onClose={() => setOpenReview(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Beurteilung löschen"
        message={
          deleting
            ? `${REVIEW_KIND_LABELS[deleting.kind]} für ${nameOf(deleting.employee_id)} wird samt aller Bewertungen und Kommentare gelöscht.`
            : ''
        }
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

const RELATION_LABELS: Record<ReviewerSuggestion['relation'], string> = {
  vorgesetzt: 'Berichtslinie',
  team: 'Team',
  kollegium: 'Kollegium',
};

function CreateReviewModal({
  cycles,
  templates,
  initialEmployeeId,
  onClose,
}: {
  cycles: ReviewCycle[];
  templates: ReviewTemplate[];
  initialEmployeeId: number | null;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    cycle_id: cycles[0]?.id ?? 0,
    employee_id: initialEmployeeId,
    template_id: templates[0]?.id ?? 0,
    reviewer_employee_id: null as number | null,
    kind: 'selbst' as ReviewKind,
  });
  const toast = useToast();
  const qc = useQueryClient();

  const { data: suggestions } = useQuery({
    queryKey: ['performance', 'reviewer-suggestions', form.employee_id],
    queryFn: () =>
      api.get<{ suggestions: ReviewerSuggestion[] }>(`/api/performance/reviews/suggestions/${form.employee_id}`),
    select: (d) => d.suggestions,
    enabled: form.kind === 'feedback360' && form.employee_id !== null,
  });

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
        <Field label="Art" required span2>
          <div className="row row--wrap" style={{ gap: 8 }}>
            {REVIEW_CREATABLE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`hm-btn hm-btn--sm ${form.kind === k ? 'hm-btn--primary' : 'hm-btn--secondary'}`}
                onClick={() => setForm({ ...form, kind: k, reviewer_employee_id: null })}
              >
                {KIND_ICONS[k]} {REVIEW_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 6 }}>
            {REVIEW_KIND_DESCRIPTIONS[form.kind]}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            <Building2 size={14} /> {PROXY_NOTE}
          </div>
        </Field>
        <Field label="Zyklus" required>
          <Select className="hm-select" value={form.cycle_id} onChange={(e) => setForm({ ...form, cycle_id: Number(e.target.value) })}>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bogen" required>
          <Select className="hm-select" value={form.template_id} onChange={(e) => setForm({ ...form, template_id: Number(e.target.value) })}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mitarbeiter:in (bewertet)" required span2>
          <EmployeeSelect value={form.employee_id} onChange={(id) => setForm({ ...form, employee_id: id, reviewer_employee_id: null })} />
        </Field>
        {form.kind === 'feedback360' && (
          <Field
            label="Reviewer:in"
            required
            span2
            hint="Je Reviewer:in ein eigener Bogen; die Bögen werden im Gesamtbild gemittelt."
          >
            <EmployeeSelect value={form.reviewer_employee_id} onChange={(id) => setForm({ ...form, reviewer_employee_id: id })} />
            {suggestions && suggestions.length > 0 && (
              <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Aus dem Organigramm:</span>
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`hm-chip${form.reviewer_employee_id === s.id ? ' is-active' : ''}`}
                    onClick={() => setForm({ ...form, reviewer_employee_id: s.id })}
                  >
                    {s.name}
                    <span style={{ opacity: 0.7 }}> · {RELATION_LABELS[s.relation]}</span>
                  </button>
                ))}
              </div>
            )}
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
  const [scores, setScores] = useState<Map<string, ReviewScore>>(new Map(review.scores.map((s) => [s.key, s])));
  const [summary, setSummary] = useState(review.summary ?? '');
  const readOnly = review.status === 'abgeschlossen';
  const toast = useToast();
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['performance', 'reviews'] });
    qc.invalidateQueries({ queryKey: ['performance', 'review-aggregate'] });
    qc.invalidateQueries({ queryKey: ['performance', 'cycle-overview'] });
  };

  // Zwischenstand: auch Kommentare ohne Bewertung (score 0) mitschicken, damit
  // sie nicht verloren gehen; der Abschluss verlangt weiterhin jedes Kriterium.
  const payload = () => ({
    scores: [...scores.values()]
      .filter((s) => s.score >= 1 || (s.comment ?? '').trim() !== '')
      .map((s) => ({ ...s, comment: (s.comment ?? '').trim() || undefined })),
    summary: summary || null,
  });

  const saveMutation = useMutation({
    mutationFn: () => api.put(`/api/performance/reviews/${review.id}`, payload()),
    onSuccess: () => {
      toast.success('Zwischenstand gespeichert');
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiRequestError ? e.message : 'Fehler beim Speichern'),
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      await api.put(`/api/performance/reviews/${review.id}`, payload());
      return api.post<{ review: Review }>(`/api/performance/reviews/${review.id}/complete`);
    },
    onSuccess: (res) => {
      toast.success(`Beurteilung abgeschlossen — Ergebnis ${percentText(res.review.overall_percent)}`);
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

  const answered = useMemo(
    () => (template ? template.criteria.filter((c) => (scores.get(c.key)?.score ?? 0) >= 1).length : 0),
    [scores, template],
  );

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
          {readOnly ? 'Beurteilung' : 'Beurteilung durchführen'} <KindBadge kind={review.kind} />
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
            <span style={{ marginRight: 'auto', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {answered}/{template.criteria.length} Kriterien bewertet
            </span>
            <button className="hm-btn hm-btn--secondary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              Zwischenstand speichern
            </button>
            <button
              className="hm-btn hm-btn--primary"
              onClick={() => completeMutation.mutate()}
              disabled={completeMutation.isPending || answered < template.criteria.length}
            >
              Abschließen
            </button>
          </>
        )
      }
    >
      <SetupNote icon={KIND_ICONS[review.kind]}>
        {REVIEW_KIND_DESCRIPTIONS[review.kind]} <strong>{PROXY_NOTE}</strong>
      </SetupNote>
      {readOnly && (
        <p style={{ color: 'var(--text-secondary)', margin: '12px 0' }}>
          Abgeschlossen am {formatDate(review.completed_at?.slice(0, 10))} — Ergebnis{' '}
          <strong>{percentText(review.overall_percent)}</strong>
        </p>
      )}
      <div style={{ display: 'grid', gap: 16, marginTop: 12 }}>
        {template.criteria.map((c) => {
          const current = scores.get(c.key);
          return (
            <div key={c.key} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{c.label}</span>
                {c.category_id ? <Badge tone="blue">zentrale Kategorie</Badge> : null}
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{RATING_SCALES[c.scale].label}</span>
              </div>
              {c.description && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 6 }}>{c.description}</div>
              )}
              <div style={{ marginTop: 8 }}>
                <RatingInput
                  scale={c.scale}
                  value={current && current.score >= 1 ? current.score : null}
                  disabled={readOnly}
                  onChange={(n) => setScore(c.key, { score: n })}
                />
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
