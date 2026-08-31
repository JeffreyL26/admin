import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlarmClock, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  MEETING_OCCASION_LABELS,
  MEETING_VISIBILITY_LABELS,
  formatDate,
  todayIsoLocal,
  type MeetingOccasion,
  type MeetingVisibility,
} from '@hrmonic/shared';
import { api } from '../../api/client';
import { Badge, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect, employeeName } from '../../components/EmployeeSelect';
import { useFollowUps, useInvalidate, useMeetings, type Meeting } from './api';

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
        <Field label="Mitarbeiter:in" required>
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
          <select
            className="hm-select"
            value={form.occasion}
            onChange={(e) => setForm((f) => ({ ...f, occasion: e.target.value as MeetingOccasion }))}
          >
            {(Object.keys(MEETING_OCCASION_LABELS) as MeetingOccasion[]).map((o) => (
              <option key={o} value={o}>
                {MEETING_OCCASION_LABELS[o]}
              </option>
            ))}
          </select>
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
        <Field
          label="Sichtbarkeit"
          hint="Gilt für den späteren Mitarbeitenden-Web-Client; im Desktop informativ"
        >
          <select
            className="hm-select"
            value={form.visibility}
            onChange={(e) => setForm((f) => ({ ...f, visibility: e.target.value as MeetingVisibility }))}
          >
            {(Object.keys(MEETING_VISIBILITY_LABELS) as MeetingVisibility[]).map((v) => (
              <option key={v} value={v}>
                {MEETING_VISIBILITY_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export function MeetingsPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: meetings, isLoading } = useMeetings();
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

  const followUpDue = (m: Meeting) => m.follow_up_date !== null && m.follow_up_date <= todayIsoLocal();

  return (
    <>
      <PageHeader
        title="Gespräche"
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
                    · {MEETING_OCCASION_LABELS[m.occasion]} vom {formatDate(m.meeting_date)} — fällig am{' '}
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

      {isLoading ? (
        <Spinner center />
      ) : (meetings?.length ?? 0) === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<FileText size={40} />}
            title="Noch keine Gesprächsprotokolle"
            hint="Dokumentieren Sie Mitarbeitergespräche strukturiert und vertraulich."
          />
        </div>
      ) : (
        <div className="hm-card">
          <div className="hm-card__body hm-card__body--flush">
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter:in</th>
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
                        <Badge tone={m.visibility === 'nur_hr' ? 'navy' : 'blue'}>
                          {MEETING_VISIBILITY_LABELS[m.visibility]}
                        </Badge>
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
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                            title="Bearbeiten"
                            onClick={() => openEdit(m)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                            title="Löschen"
                            onClick={() => setDeleteTarget(m)}
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
