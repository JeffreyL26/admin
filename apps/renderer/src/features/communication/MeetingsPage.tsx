import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { AlarmClock, AlertTriangle, FileText, Info, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  MEETING_OCCASION_LABELS,
  MEETING_VISIBILITIES,
  MEETING_VISIBILITY_HINTS,
  MEETING_VISIBILITY_LABELS,
  MEETING_VISIBILITY_READERS,
  SCOPE_SOURCE_LABELS,
  formatDate,
  isFollowUpDue,
  moduleEnabled,
  todayIsoLocal,
  type MeetingOccasion,
  type MeetingVisibility,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { api } from '../../api/client';
import { Badge, EmptyState, Field, PageHeader, Spinner, type BadgeTone } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect, employeeName } from '../../components/EmployeeSelect';
import { useFollowUps, useInvalidate, useMeetingRecipients, useMeetings, type Meeting } from './api';
import { Select } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';
import { useDebounced } from '../../components/useDebounced';

interface DraftMeeting {
  employee_id: number | null;
  meeting_date: string;
  occasion: MeetingOccasion;
  participants: string;
  content: string;
  agreements: string;
  follow_up_date: string;
  visibility: MeetingVisibility;
}

const emptyDraft = (): DraftMeeting => ({
  employee_id: null,
  meeting_date: todayIsoLocal(),
  occasion: 'einzelgespraech',
  participants: '',
  content: '',
  agreements: '',
  follow_up_date: '',
  visibility: 'nur_hr',
});

/** Enthält die Variante die Führungsfunktion („Mein Team“)? Sonst erreicht keine Stufe die Führung. */
const LEADERSHIP = moduleEnabled(VARIANT, 'performance');

/** Wen die Stufe in DIESER Variante tatsächlich erreicht (Quelle: MEETING_VISIBILITY_READERS). */
function readersOf(v: MeetingVisibility) {
  const readers = MEETING_VISIBILITY_READERS[v];
  return { leaders: readers.leaders && LEADERSHIP, employee: readers.employee };
}

/** Badge der Tabelle: kurz, was die Stufe bewirkt. */
function visibilityBadge(v: MeetingVisibility): { tone: BadgeTone; label: string } {
  const r = readersOf(v);
  if (r.employee) return { tone: 'blue', label: 'Im Portal sichtbar' };
  if (r.leaders) return { tone: 'neutral', label: 'Für Führung sichtbar' };
  return { tone: 'navy', label: 'Nur HR' };
}

/** Name der Stufe in DIESER Variante: ohne Führungsfunktion keine Führung im Namen. */
function visibilityLabel(v: MeetingVisibility): string {
  if (LEADERSHIP || !MEETING_VISIBILITY_READERS[v].leaders) return MEETING_VISIBILITY_LABELS[v];
  return MEETING_VISIBILITY_READERS[v].employee ? 'HR und Mitarbeitende' : 'Nur HR (keine Führungsansicht)';
}

/** Hinweis unter der Stufe: ohne Führungsfunktion in der Variante ehrlich statt versprochen. */
function visibilityHint(v: MeetingVisibility): string {
  if (!LEADERSHIP && MEETING_VISIBILITY_READERS[v].leaders) {
    return MEETING_VISIBILITY_READERS[v].employee
      ? 'Sichtbar im Portal der Person unter „Gesprächsprotokolle“. Diese Ausgabe hat keine Führungsansicht.'
      : 'Diese Ausgabe hat keine Führungsansicht: Das Protokoll sieht nur die Personalabteilung.';
  }
  return MEETING_VISIBILITY_HINTS[v];
}

function Notice({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  const Icon = tone === 'warning' ? AlertTriangle : Info;
  // role="status" statt "alert": ein Hinweis zur Auswahl, kein Fehler; er soll
  // Screenreader nicht bei jedem Personenwechsel unterbrechen.
  return (
    <div className={`hm-notice${tone === 'warning' ? ' hm-notice--warning' : ''}`} role="status" style={{ gridColumn: '1 / -1' }}>
      <Icon size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Zeigt beim Erfassen, wen ein Protokoll einer Führungsstufe erreicht: die
 * Führungskräfte, die die Person heute im Bereich haben und die Protokolle unter
 * „Mein Team“ lesen dürfen (`can_read`: Desktop-Konto und Selbstschutz beim
 * Lesen, leadership/meetingRoutes.ts). Erreicht es niemanden, warnt der Hinweis, das soll
 * die HR vor dem Speichern wissen statt hinterher. Scheitert die Abfrage, sagt
 * er das, statt still zu verschwinden. Die Quellen der Zuständigkeit liefert
 * der Server nur Konten mit Recht „Führung: lesen“.
 */
function RecipientsNote({ employeeId }: { employeeId: number | null }) {
  // Entprellt: Pfeiltasten und Tippen im Personenfeld wechseln die Auswahl
  // bei jedem Tastendruck, die Ermittlung läuft erst für die gewählte Person.
  const settled = useDebounced(employeeId === null ? '' : String(employeeId), 300);
  const queryId = settled === '' ? null : Number(settled);
  const { data, error, isLoading } = useMeetingRecipients(queryId);
  if (employeeId === null) return null;
  if (error) {
    return <Notice tone="warning">Wen das Protokoll erreicht, konnte nicht ermittelt werden: {error.message}</Notice>;
  }
  if (queryId !== employeeId || isLoading || !data) {
    return <Notice tone="info">Zuständige Führungskräfte werden ermittelt …</Notice>;
  }
  const reachable = data.filter((l) => l.can_read === 1);
  const label = (l: (typeof data)[number]) => {
    const parts = [
      ...(l.sources ?? []).map((s) => SCOPE_SOURCE_LABELS[s]),
      ...(l.has_account ? [] : ['ohne Desktop-Konto']),
      ...(l.has_account && !l.can_read ? ['ohne Leserecht Kommunikation'] : []),
    ];
    return parts.length > 0 ? `${l.name} (${parts.join(', ')})` : l.name;
  };
  if (reachable.length === 0) {
    return (
      <Notice tone="warning">
        {data.length === 0
          ? 'Für diese Person ist derzeit keine Führungskraft zuständig.'
          : `Zuständig: ${data.map(label).join(' · ')}. Keine davon kann die Protokolle unter „Mein Team“ lesen.`}{' '}
        In der Führung sieht das Protokoll niemand.
      </Notice>
    );
  }
  return <Notice tone="info">Erreicht derzeit als Führung: {data.map(label).join(' · ')}</Notice>;
}

function MeetingEditor({
  open,
  initial,
  editId,
  onClose,
}: {
  open: boolean;
  initial: DraftMeeting;
  editId: number | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<DraftMeeting>(initial);

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setForm(initial);
  }

  const reachesLeadership = readersOf(form.visibility).leaders;

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        employee_id: form.employee_id,
        meeting_date: form.meeting_date,
        occasion: form.occasion,
        participants: form.participants || null,
        content: form.content || null,
        agreements: form.agreements || null,
        follow_up_date: form.follow_up_date || null,
        visibility: form.visibility,
      };
      return editId === null
        ? api.post('/api/communication/meetings', payload)
        : api.put(`/api/communication/meetings/${editId}`, payload);
    },
    onSuccess: () => {
      toast.success(editId === null ? 'Protokoll angelegt' : 'Protokoll aktualisiert');
      invalidate('meetings');
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal
      title={editId === null ? 'Neues Gesprächsprotokoll' : 'Gesprächsprotokoll bearbeiten'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={save.isPending || form.employee_id === null}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Person" required>
          <EmployeeSelect
            value={form.employee_id}
            onChange={(id) => setForm((f) => ({ ...f, employee_id: id }))}
          />
        </Field>
        <Field label="Gesprächsdatum" required>
          <input
            type="date"
            className="hm-input"
            value={form.meeting_date}
            onChange={(e) => setForm((f) => ({ ...f, meeting_date: e.target.value }))}
          />
        </Field>
        <Field label="Anlass" required>
          <Select
            className="hm-select"
            value={form.occasion}
            onChange={(e) => setForm((f) => ({ ...f, occasion: e.target.value as MeetingOccasion }))}
          >
            {(Object.keys(MEETING_OCCASION_LABELS) as MeetingOccasion[]).map((o) => (
              <option key={o} value={o}>
                {MEETING_OCCASION_LABELS[o]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Teilnehmende" hint="Namen und Rollen, z. B. „Max Muster (Führungskraft), HR“">
          <input
            className="hm-input"
            value={form.participants}
            onChange={(e) => setForm((f) => ({ ...f, participants: e.target.value }))}
          />
        </Field>
        <Field label="Gesprächsinhalt" span2>
          <textarea
            className="hm-textarea"
            rows={5}
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
          />
        </Field>
        <Field label="Vereinbarungen" span2>
          <textarea
            className="hm-textarea"
            rows={3}
            value={form.agreements}
            onChange={(e) => setForm((f) => ({ ...f, agreements: e.target.value }))}
          />
        </Field>
        <Field label="Wiedervorlage am" hint="Leer lassen, wenn keine Wiedervorlage nötig ist">
          <input
            type="date"
            className="hm-input"
            value={form.follow_up_date}
            onChange={(e) => setForm((f) => ({ ...f, follow_up_date: e.target.value }))}
          />
        </Field>
        <Field label="Sichtbarkeit" hint={visibilityHint(form.visibility)}>
          <Select
            className="hm-select"
            value={form.visibility}
            onChange={(e) => setForm((f) => ({ ...f, visibility: e.target.value as MeetingVisibility }))}
          >
            {/* Eine Stufe, die in dieser Variante niemanden ausser der HR
                erreicht, wird nicht neu angeboten (bleibt aber wählbar, wenn
                ein Protokoll sie schon trägt). */}
            {MEETING_VISIBILITIES.filter((v) => {
              const r = readersOf(v);
              return v === 'nur_hr' || r.leaders || r.employee || v === form.visibility;
            }).map((v) => (
              <option key={v} value={v}>
                {visibilityLabel(v)}
              </option>
            ))}
          </Select>
        </Field>
        {reachesLeadership && <RecipientsNote employeeId={form.employee_id} />}
      </div>
    </Modal>
  );
}

export function MeetingsPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  // Filter in der URL (?employee=, ?occasion=), damit das Dashboard-Widget
  // „Wiedervorlagen“ direkt auf die Protokolle einer Person verlinken kann.
  const [params, setParams] = useSearchParams();
  const employeeParam = Number(params.get('employee'));
  const employeeFilter = Number.isInteger(employeeParam) && employeeParam > 0 ? employeeParam : null;
  const occasionParam = params.get('occasion');
  const occasionFilter =
    occasionParam && occasionParam in MEETING_OCCASION_LABELS ? (occasionParam as MeetingOccasion) : null;
  const setFilter = (patch: { employee?: number | null; occasion?: MeetingOccasion | null }) => {
    const next = new URLSearchParams(params);
    if (patch.employee !== undefined) {
      if (patch.employee === null) next.delete('employee');
      else next.set('employee', String(patch.employee));
    }
    if (patch.occasion !== undefined) {
      if (patch.occasion === null) next.delete('occasion');
      else next.set('occasion', patch.occasion);
    }
    setParams(next, { replace: true });
  };
  const { data: meetings, isLoading } = useMeetings({
    employee_id: employeeFilter ?? undefined,
    occasion: occasionFilter ?? undefined,
  });
  const { data: followUps } = useFollowUps();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<DraftMeeting>(emptyDraft());
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Meeting | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/communication/meetings/${id}`),
    onSuccess: () => {
      toast.success('Protokoll gelöscht');
      invalidate('meetings');
    },
    onError: (e) => toast.error(e.message),
  });

  const openEdit = (m: Meeting) => {
    setEditorInitial({
      employee_id: m.employee_id,
      meeting_date: m.meeting_date,
      occasion: m.occasion,
      participants: m.participants ?? '',
      content: m.content ?? '',
      agreements: m.agreements ?? '',
      follow_up_date: m.follow_up_date ?? '',
      visibility: m.visibility,
    });
    setEditId(m.id);
    setEditorOpen(true);
  };

  const followUpDue = (m: Meeting) => isFollowUpDue(m.follow_up_date, todayIsoLocal());

  return (
    <>
      <PageHeader
        title="Gesprächsprotokolle"
        subtitle="Protokolle von Mitarbeitergesprächen mit Wiedervorlagen"
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => {
              setEditorInitial(emptyDraft());
              setEditId(null);
              setEditorOpen(true);
            }}
          >
            <Plus size={16} /> Neues Protokoll
          </button>
        }
      />

      {(followUps?.length ?? 0) > 0 && (
        <div className="hm-card" style={{ marginBottom: 16, borderColor: 'var(--warning)' }}>
          <header className="hm-card__header">
            <div className="hm-card__title row" style={{ gap: 8 }}>
              <AlarmClock size={17} style={{ color: 'var(--warning)' }} /> Fällige Wiedervorlagen
            </div>
          </header>
          <div className="hm-card__body" style={{ padding: 12 }}>
            <div className="stack" style={{ gap: 8 }}>
              {followUps!.map((m) => (
                <div key={m.id} className="row row--between">
                  <span style={{ fontSize: 'var(--text-sm)' }}>
                    <strong>
                      {m.first_name} {m.last_name}
                    </strong>{' '}
                    · {MEETING_OCCASION_LABELS[m.occasion]} vom {formatDate(m.meeting_date)} · fällig am{' '}
                    {formatDate(m.follow_up_date)}
                  </span>
                  <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => openEdit(m)}>
                    Öffnen
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="hm-card" style={{ marginBottom: 16 }}>
        <div className="hm-card__body" style={{ padding: 14 }}>
          <div className="row row--wrap">
            <div style={{ minWidth: 240 }}>
              <EmployeeSelect
                value={employeeFilter}
                onChange={(id) => setFilter({ employee: id })}
                allowEmpty
                emptyLabel="Alle Mitarbeitenden"
                includeInactive
              />
            </div>
            <Select
              className="hm-select"
              style={{ maxWidth: 220 }}
              value={occasionFilter ?? ''}
              onChange={(e) => setFilter({ occasion: e.target.value ? (e.target.value as MeetingOccasion) : null })}
            >
              <option value="">Alle Anlässe</option>
              {(Object.keys(MEETING_OCCASION_LABELS) as MeetingOccasion[]).map((o) => (
                <option key={o} value={o}>
                  {MEETING_OCCASION_LABELS[o]}
                </option>
              ))}
            </Select>
            {(employeeFilter !== null || occasionFilter !== null) && (
              <button
                className="hm-btn hm-btn--ghost hm-btn--sm"
                onClick={() => setFilter({ employee: null, occasion: null })}
              >
                Filter zurücksetzen
              </button>
            )}
          </div>
        </div>
      </div>

      {isLoading ? (
        <Spinner center />
      ) : (meetings?.length ?? 0) === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<FileText size={40} />}
            title={
              employeeFilter !== null || occasionFilter !== null
                ? 'Keine Protokolle zu diesem Filter'
                : 'Noch keine Gesprächsprotokolle'
            }
            hint={
              employeeFilter !== null || occasionFilter !== null
                ? 'Passen Sie Person oder Anlass an.'
                : 'Dokumentieren Sie Mitarbeitergespräche strukturiert und vertraulich.'
            }
          />
        </div>
      ) : (
        <div className="hm-card">
          <div className="hm-card__body hm-card__body--flush">
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Datum</th>
                    <th>Anlass</th>
                    <th>Sichtbarkeit</th>
                    <th>Wiedervorlage</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {meetings!.map((m) => (
                    <tr key={m.id} className="clickable" onClick={() => openEdit(m)}>
                      <td style={{ fontWeight: 600 }}>{employeeName(m)}</td>
                      <td>{formatDate(m.meeting_date)}</td>
                      <td>{MEETING_OCCASION_LABELS[m.occasion]}</td>
                      <td>
                        <Tooltip content={<span className="hm-tooltip__title">{visibilityHint(m.visibility)}</span>}>
                          <Badge tone={visibilityBadge(m.visibility).tone}>{visibilityBadge(m.visibility).label}</Badge>
                        </Tooltip>
                      </td>
                      <td>
                        {m.follow_up_date === null ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : followUpDue(m) ? (
                          <Badge tone="red">fällig {formatDate(m.follow_up_date)}</Badge>
                        ) : (
                          <Badge tone="yellow">{formatDate(m.follow_up_date)}</Badge>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          <Tooltip content={<span className="hm-tooltip__title">Bearbeiten</span>}>
                            <button
                              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                              onClick={() => openEdit(m)}
                            >
                              <Pencil size={15} />
                            </button>
                          </Tooltip>
                          <Tooltip content={<span className="hm-tooltip__title">Löschen</span>}>
                            <button
                              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                              onClick={() => setDeleteTarget(m)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <MeetingEditor open={editorOpen} initial={editorInitial} editId={editId} onClose={() => setEditorOpen(false)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Protokoll löschen"
        message={`Soll das Protokoll vom ${formatDate(deleteTarget?.meeting_date)} für ${deleteTarget ? employeeName(deleteTarget) : ''} endgültig gelöscht werden?`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
