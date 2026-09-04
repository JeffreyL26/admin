import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, MessagesSquare, Plus } from 'lucide-react';
import {
  formatDate,
  FEEDBACK_MEETING_KIND_LABELS,
  FEEDBACK_MEETING_STATUS_LABELS,
  type FeedbackAction,
  type FeedbackMeeting,
  type FeedbackMeetingKind,
  type FeedbackMeetingStatus,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, StatCard } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { MEETING_STATUS_TONES, todayIso } from './common';

interface MeetingRow extends FeedbackMeeting {
  first_name: string;
  last_name: string;
}

interface OpenActionRow extends FeedbackAction {
  employee_id: number;
  meeting_kind: FeedbackMeetingKind;
  meeting_date: string;
  first_name: string;
  last_name: string;
}

interface Reminders {
  upcoming: MeetingRow[];
  overdue: MeetingRow[];
  open_actions: OpenActionRow[];
}

export function FeedbackPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['performance', 'feedback'] });

  const [statusFilter, setStatusFilter] = useState<FeedbackMeetingStatus | ''>('');
  const [employeeFilter, setEmployeeFilter] = useState<number | null>(null);

  const { data: reminders } = useQuery({
    queryKey: ['performance', 'feedback', 'reminders'],
    queryFn: () => api.get<Reminders>('/api/performance/feedback/reminders'),
  });
  const { data: meetings, isLoading } = useQuery({
    queryKey: ['performance', 'feedback', 'meetings', statusFilter, employeeFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (employeeFilter) params.set('employee_id', String(employeeFilter));
      const qs = params.toString();
      return api.get<{ meetings: MeetingRow[] }>(
        `/api/performance/feedback-meetings${qs ? `?${qs}` : ''}`,
      );
    },
    select: (d) => d.meetings,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  if (isLoading) return <Spinner center />;
  const overdueCount = reminders?.overdue.length ?? 0;
  const detailMeeting = detailId !== null ? (meetings ?? []).find((m) => m.id === detailId) ?? null : null;

  return (
    <>
      <PageHeader
        title="Feedback-Zyklen"
        subtitle="Wiederkehrende Gespräche, Notizen und vereinbarte Maßnahmen."
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Gespräch planen
          </button>
        }
      />

      <div className="grid-stats">
        <StatCard
          label="Überfällige Gespräche"
          value={overdueCount}
          icon={<CalendarClock size={15} />}
          sub={overdueCount > 0 ? 'Bitte zeitnah nachholen' : 'Alles im Plan'}
        />
        <StatCard
          label="Anstehend (14 Tage)"
          value={reminders?.upcoming.length ?? 0}
          icon={<MessagesSquare size={15} />}
        />
        <StatCard
          label="Offene Maßnahmen"
          value={reminders?.open_actions.length ?? 0}
          icon={<CheckCircle2 size={15} />}
        />
      </div>

      <div className="stack">
        {(reminders?.overdue.length ?? 0) > 0 && (
          <Card title="Überfällige Gespräche" flush>
            <MeetingTable
              meetings={reminders!.overdue}
              onOpen={setDetailId}
              highlightOverdue
            />
          </Card>
        )}

        <Card
          title="Alle Gespräche"
          actions={
            <>
              <div style={{ width: 220 }}>
                <EmployeeSelect
                  value={employeeFilter}
                  onChange={setEmployeeFilter}
                  emptyLabel="Alle Mitarbeitenden"
                />
              </div>
              <select
                className="hm-select"
                style={{ width: 170 }}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as FeedbackMeetingStatus | '')}
              >
                <option value="">Alle Status</option>
                {Object.entries(FEEDBACK_MEETING_STATUS_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </>
          }
          flush
        >
          {(meetings ?? []).length === 0 ? (
            <EmptyState
              icon={<MessagesSquare size={40} />}
              title="Keine Gespräche gefunden"
              hint="Planen Sie 1:1-, Probezeit- oder Jahresgespräche mit Wiederholung."
            />
          ) : (
            <MeetingTable meetings={meetings ?? []} onOpen={setDetailId} />
          )}
        </Card>

        {(reminders?.open_actions.length ?? 0) > 0 && (
          <Card title="Offene Maßnahmen aus Gesprächen" flush>
            <div className="hm-table-wrap" style={{ maxHeight: 300 }}>
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Maßnahme</th>
                    <th>Mitarbeiter:in</th>
                    <th>Aus Gespräch</th>
                    <th>Fällig</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {reminders!.open_actions.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 550 }}>{a.title}</td>
                      <td>
                        {a.last_name}, {a.first_name}
                      </td>
                      <td>
                        {FEEDBACK_MEETING_KIND_LABELS[a.meeting_kind]} · {formatDate(a.meeting_date)}
                      </td>
                      <td>
                        {a.due_date ? (
                          <span style={a.due_date < todayIso() ? { color: 'var(--danger)' } : undefined}>
                            {formatDate(a.due_date)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <button
                          className="hm-btn hm-btn--secondary hm-btn--sm"
                          onClick={() => setDetailId(a.meeting_id)}
                        >
                          Zum Gespräch
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {createOpen && (
        <CreateMeetingModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            invalidate();
            setCreateOpen(false);
            toast.success('Gespräch geplant');
          }}
        />
      )}
      {detailId !== null && (
        <MeetingDetailModal
          meetingId={detailId}
          fallback={detailMeeting}
          onClose={() => setDetailId(null)}
          onChanged={invalidate}
        />
      )}
    </>
  );
}

function MeetingTable({
  meetings,
  onOpen,
  highlightOverdue,
}: {
  meetings: MeetingRow[];
  onOpen: (id: number) => void;
  highlightOverdue?: boolean;
}) {
  return (
    <div className="hm-table-wrap" style={{ maxHeight: 420 }}>
      <table className="hm-table">
        <thead>
          <tr>
            <th>Mitarbeiter:in</th>
            <th>Art</th>
            <th>Termin</th>
            <th>Wiederholung</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((m) => (
            <tr key={m.id} className="clickable" onClick={() => onOpen(m.id)}>
              <td style={{ fontWeight: 550 }}>
                {m.last_name}, {m.first_name}
              </td>
              <td>{FEEDBACK_MEETING_KIND_LABELS[m.kind]}</td>
              <td style={highlightOverdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                {formatDate(m.scheduled_date)}
              </td>
              <td>{m.recurrence_months ? `alle ${m.recurrence_months} Monate` : '—'}</td>
              <td>
                <Badge tone={MEETING_STATUS_TONES[m.status]}>
                  {FEEDBACK_MEETING_STATUS_LABELS[m.status]}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateMeetingModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [kind, setKind] = useState<FeedbackMeetingKind>('einzelgespraech');
  const [date, setDate] = useState('');
  const [recurrence, setRecurrence] = useState('');
  const [notes, setNotes] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/performance/feedback-meetings', {
        employee_id: employeeId,
        kind,
        scheduled_date: date,
        recurrence_months: recurrence === '' ? undefined : Number(recurrence),
        notes: notes || undefined,
      }),
    onSuccess: onCreated,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title="Gespräch planen"
      open
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={employeeId === null || !date || create.isPending}
            onClick={() => create.mutate()}
          >
            Planen
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
            onChange={(e) => setKind(e.target.value as FeedbackMeetingKind)}
          >
            {Object.entries(FEEDBACK_MEETING_KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Termin" required>
          <input className="hm-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Wiederholung (Monate)" hint="Leer = einmalig; Abschluss legt Folgetermin an">
          <input
            className="hm-input"
            type="number"
            min={1}
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
          />
        </Field>
        <Field label="Vorbereitungsnotizen" span2>
          <textarea className="hm-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function MeetingDetailModal({
  meetingId,
  fallback,
  onClose,
  onChanged,
}: {
  meetingId: number;
  fallback: MeetingRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['performance', 'feedback', 'meeting', meetingId];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ meeting: FeedbackMeeting; actions: FeedbackAction[] }>(
        `/api/performance/feedback-meetings/${meetingId}`,
      ),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    onChanged();
  };

  const [notes, setNotes] = useState<string | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [heldDate, setHeldDate] = useState(todayIso());
  const [actionTitle, setActionTitle] = useState('');
  const [actionDue, setActionDue] = useState('');
  const [actionOwner, setActionOwner] = useState<number | null>(null);

  const meeting = data?.meeting;
  const effectiveNotes = notes ?? meeting?.notes ?? '';

  const saveNotes = useMutation({
    mutationFn: () =>
      api.put(`/api/performance/feedback-meetings/${meetingId}`, { notes: effectiveNotes || null }),
    onSuccess: () => {
      invalidate();
      toast.success('Notizen gespeichert');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const complete = useMutation({
    mutationFn: () =>
      api.post<{ follow_up: FeedbackMeeting | null }>(
        `/api/performance/feedback-meetings/${meetingId}/complete`,
        { held_date: heldDate, notes: effectiveNotes || undefined },
      ),
    onSuccess: (res) => {
      invalidate();
      setCompleteOpen(false);
      toast.success(
        res.follow_up
          ? `Abgeschlossen — Folgetermin am ${formatDate(res.follow_up.scheduled_date)} angelegt`
          : 'Gespräch abgeschlossen',
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancel = useMutation({
    mutationFn: () => api.put(`/api/performance/feedback-meetings/${meetingId}`, { status: 'abgesagt' }),
    onSuccess: () => {
      invalidate();
      toast.success('Gespräch abgesagt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addAction = useMutation({
    mutationFn: () =>
      api.post(`/api/performance/feedback-meetings/${meetingId}/actions`, {
        title: actionTitle,
        due_date: actionDue || undefined,
        owner_employee_id: actionOwner ?? undefined,
      }),
    onSuccess: () => {
      setActionTitle('');
      setActionDue('');
      setActionOwner(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleAction = useMutation({
    mutationFn: (a: FeedbackAction) =>
      api.put(`/api/performance/feedback-actions/${a.id}`, {
        status: a.status === 'offen' ? 'erledigt' : 'offen',
      }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const title = fallback
    ? `${FEEDBACK_MEETING_KIND_LABELS[fallback.kind]} — ${fallback.first_name} ${fallback.last_name}`
    : meeting
      ? FEEDBACK_MEETING_KIND_LABELS[meeting.kind]
      : 'Gespräch';

  return (
    <Modal title={title} open onClose={onClose} wide>
      {isLoading || !meeting ? (
        <Spinner center />
      ) : (
        <div className="stack">
          <div className="row row--wrap">
            <Badge tone={MEETING_STATUS_TONES[meeting.status]}>
              {FEEDBACK_MEETING_STATUS_LABELS[meeting.status]}
            </Badge>
            <span style={{ color: 'var(--text-muted)' }}>
              Termin: {formatDate(meeting.scheduled_date)}
              {meeting.held_date ? ` · stattgefunden am ${formatDate(meeting.held_date)}` : ''}
              {meeting.recurrence_months ? ` · alle ${meeting.recurrence_months} Monate` : ''}
            </span>
          </div>

          <Field label="Gesprächsnotizen">
            <textarea
              className="hm-textarea"
              style={{ minHeight: 120 }}
              value={effectiveNotes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={meeting.status === 'abgesagt'}
            />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="hm-btn hm-btn--secondary hm-btn--sm"
              disabled={saveNotes.isPending || meeting.status === 'abgesagt'}
              onClick={() => saveNotes.mutate()}
            >
              Notizen speichern
            </button>
            {meeting.status === 'geplant' && (
              <>
                <button className="hm-btn hm-btn--ghost hm-btn--sm" onClick={() => cancel.mutate()}>
                  Absagen
                </button>
                <button
                  className="hm-btn hm-btn--primary hm-btn--sm"
                  onClick={() => setCompleteOpen(true)}
                >
                  <CheckCircle2 size={14} /> Abschließen
                </button>
              </>
            )}
          </div>

          <Card title="Vereinbarte Maßnahmen" flush>
            <div style={{ padding: 14 }} className="stack">
              {(data?.actions ?? []).length === 0 && (
                <p style={{ color: 'var(--text-muted)' }}>Noch keine Maßnahmen vereinbart.</p>
              )}
              {(data?.actions ?? []).map((a) => (
                <label key={a.id} className="hm-checkbox" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={a.status === 'erledigt'}
                    onChange={() => toggleAction.mutate(a)}
                  />
                  <span
                    style={
                      a.status === 'erledigt'
                        ? { textDecoration: 'line-through', color: 'var(--text-muted)' }
                        : undefined
                    }
                  >
                    {a.title}
                    {a.due_date && (
                      <span style={{ color: 'var(--text-muted)' }}> · fällig {formatDate(a.due_date)}</span>
                    )}
                  </span>
                </label>
              ))}
              <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
                <Field label="Neue Maßnahme">
                  <input
                    className="hm-input"
                    style={{ minWidth: 220 }}
                    value={actionTitle}
                    onChange={(e) => setActionTitle(e.target.value)}
                    placeholder="Was wurde vereinbart?"
                  />
                </Field>
                <Field label="Fällig">
                  <input
                    className="hm-input"
                    type="date"
                    value={actionDue}
                    onChange={(e) => setActionDue(e.target.value)}
                  />
                </Field>
                <Field label="Verantwortlich">
                  <div style={{ minWidth: 200 }}>
                    <EmployeeSelect value={actionOwner} onChange={setActionOwner} emptyLabel="— offen —" />
                  </div>
                </Field>
                <button
                  className="hm-btn hm-btn--secondary"
                  disabled={!actionTitle.trim() || addAction.isPending}
                  onClick={() => addAction.mutate()}
                >
                  <Plus size={15} /> Hinzufügen
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Modal
        title="Gespräch abschließen"
        open={completeOpen}
        onClose={() => setCompleteOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setCompleteOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              disabled={complete.isPending}
              onClick={() => complete.mutate()}
            >
              Abschließen
            </button>
          </>
        }
      >
        <div className="hm-form-grid">
          <Field label="Stattgefunden am" required>
            <input
              className="hm-input"
              type="date"
              value={heldDate}
              onChange={(e) => setHeldDate(e.target.value)}
            />
          </Field>
        </div>
        {meeting?.recurrence_months ? (
          <p style={{ color: 'var(--text-muted)', marginTop: 10 }}>
            Beim Abschluss wird automatisch der Folgetermin in {meeting.recurrence_months} Monaten
            angelegt.
          </p>
        ) : null}
      </Modal>
    </Modal>
  );
}
