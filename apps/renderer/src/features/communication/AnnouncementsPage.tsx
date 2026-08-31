import React, { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Megaphone, Paperclip, Pencil, Plus, Trash2, Download } from 'lucide-react';
import {
  ANNOUNCEMENT_STATUS_LABELS,
  formatDate,
  todayIsoLocal,
  type AnnouncementStatus,
} from '@hrmonic/shared';
import { api, downloadFile, uploadFile } from '../../api/client';
import { Badge, EmptyState, Field, PageHeader, Spinner, type BadgeTone } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { AudienceSelect, audienceLabel, type AudienceValue } from './AudienceSelect';
import { useAnnouncement, useAnnouncements, useInvalidate, type Announcement } from './api';

const STATUS_TONE: Record<AnnouncementStatus, BadgeTone> = {
  geplant: 'yellow',
  aktiv: 'green',
  abgelaufen: 'neutral',
};

interface EditorState {
  title: string;
  body: string;
  audience: AudienceValue;
  publish_at: string;
  expires_at: string;
  requires_ack: boolean;
  attachments: { file_id: number; original_name: string }[];
}

const emptyEditor = (): EditorState => ({
  title: '',
  body: '',
  audience: { audience_type: 'alle', audience_id: null },
  publish_at: todayIsoLocal(),
  expires_at: '',
  requires_ack: false,
  attachments: [],
});

function AckBar({ ackCount, recipients }: { ackCount: number; recipients: number }) {
  const pct = recipients > 0 ? Math.round((ackCount / recipients) * 100) : 0;
  return (
    <div className="row" style={{ gap: 8, minWidth: 150 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--gray-100)',
          overflow: 'hidden',
        }}
        title={`${ackCount} von ${recipients} bestätigt`}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: 'var(--brand-primary)',
          }}
        />
      </div>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {ackCount}/{recipients}
      </span>
    </div>
  );
}

function AnnouncementEditor({
  open,
  initial,
  editId,
  onClose,
}: {
  open: boolean;
  initial: EditorState;
  editId: number | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<EditorState>(initial);
  const fileInput = useRef<HTMLInputElement>(null);

  // Bei jedem Öffnen mit frischen Initialwerten starten.
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setForm(initial);
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title: form.title,
        body: form.body,
        audience_type: form.audience.audience_type,
        audience_id: form.audience.audience_id,
        publish_at: form.publish_at,
        expires_at: form.expires_at || null,
        requires_ack: form.requires_ack,
        attachment_file_ids: form.attachments.map((a) => a.file_id),
      };
      return editId === null
        ? api.post('/api/communication/announcements', payload)
        : api.put(`/api/communication/announcements/${editId}`, payload);
    },
    onSuccess: () => {
      toast.success(editId === null ? 'Ankündigung angelegt' : 'Ankündigung aktualisiert');
      invalidate('announcements');
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(file),
    onSuccess: (res) =>
      setForm((f) => ({
        ...f,
        attachments: [...f.attachments, { file_id: res.file.id, original_name: res.file.original_name }],
      })),
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal
      title={editId === null ? 'Neue Ankündigung' : 'Ankündigung bearbeiten'}
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
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Titel" required span2>
          <input
            className="hm-input"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="z. B. Sommerfest am 14. August"
          />
        </Field>
        <Field label="Text" required span2>
          <textarea
            className="hm-textarea"
            rows={6}
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          />
        </Field>
        <AudienceSelect
          value={form.audience}
          onChange={(audience) => setForm((f) => ({ ...f, audience }))}
        />
        <Field label="Veröffentlichung am" required>
          <input
            type="date"
            className="hm-input"
            value={form.publish_at}
            onChange={(e) => setForm((f) => ({ ...f, publish_at: e.target.value }))}
          />
        </Field>
        <Field label="Läuft ab am" hint="Leer lassen, wenn die Ankündigung nicht abläuft">
          <input
            type="date"
            className="hm-input"
            value={form.expires_at}
            onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
          />
        </Field>
        <Field label="Lesebestätigung" span2>
          <label className="hm-checkbox" style={{ height: 36 }}>
            <input
              type="checkbox"
              checked={form.requires_ack}
              onChange={(e) => setForm((f) => ({ ...f, requires_ack: e.target.checked }))}
            />
            Mitarbeitende müssen den Erhalt bestätigen
          </label>
        </Field>
        <Field label="Anhänge" span2>
          <div className="stack" style={{ gap: 8 }}>
            {form.attachments.map((a) => (
              <div key={a.file_id} className="row row--between">
                <span className="row" style={{ gap: 7, fontSize: 'var(--text-sm)' }}>
                  <Paperclip size={14} /> {a.original_name}
                </span>
                <button
                  className="hm-btn hm-btn--ghost hm-btn--sm"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      attachments: f.attachments.filter((x) => x.file_id !== a.file_id),
                    }))
                  }
                >
                  Entfernen
                </button>
              </div>
            ))}
            <div>
              <input
                ref={fileInput}
                type="file"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = '';
                }}
              />
              <button
                className="hm-btn hm-btn--secondary hm-btn--sm"
                disabled={upload.isPending}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={14} /> {upload.isPending ? 'Lädt hoch …' : 'Datei anhängen'}
              </button>
            </div>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function AnnouncementDetail({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (a: Announcement) => void }) {
  const { data: a } = useAnnouncement(id);
  return (
    <Modal
      title={a?.title ?? 'Ankündigung'}
      open={id !== null}
      onClose={onClose}
      wide
      footer={
        a && (
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => onEdit(a)}>
              <Pencil size={15} /> Bearbeiten
            </button>
            <button className="hm-btn hm-btn--primary" onClick={onClose}>
              Schließen
            </button>
          </>
        )
      }
    >
      {!a ? (
        <Spinner center />
      ) : (
        <div className="stack">
          <div className="row row--wrap" style={{ gap: 8 }}>
            <Badge tone={STATUS_TONE[a.status]}>{ANNOUNCEMENT_STATUS_LABELS[a.status]}</Badge>
            <Badge tone="navy">{audienceLabel(a)}</Badge>
            {a.requires_ack && <Badge tone="blue">Lesebestätigung</Badge>}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Veröffentlichung {formatDate(a.publish_at)}
            {a.expires_at ? ` · läuft ab ${formatDate(a.expires_at)}` : ''} · {a.recipients} Empfänger:innen
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>
          {a.requires_ack && (
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 6 }}>
                Lesequote
              </div>
              <AckBar ackCount={a.ack_count} recipients={a.recipients} />
            </div>
          )}
          {a.attachments.length > 0 && (
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 6 }}>
                Anhänge
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {a.attachments.map((att) => (
                  <div key={att.id} className="row row--between">
                    <span className="row" style={{ gap: 7, fontSize: 'var(--text-sm)' }}>
                      <Paperclip size={14} /> {att.original_name}
                    </span>
                    <button
                      className="hm-btn hm-btn--ghost hm-btn--sm"
                      onClick={() => downloadFile(att.file_id)}
                    >
                      <Download size={14} /> Herunterladen
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function AnnouncementsPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: announcements, isLoading } = useAnnouncements();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<EditorState>(emptyEditor());
  const [editId, setEditId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/communication/announcements/${id}`),
    onSuccess: () => {
      toast.success('Ankündigung gelöscht');
      invalidate('announcements');
    },
    onError: (e) => toast.error(e.message),
  });

  const openEdit = async (a: Announcement) => {
    setDetailId(null);
    const detail = await api.get<{
      announcement: Announcement & { attachments: { file_id: number; original_name: string }[] };
    }>(`/api/communication/announcements/${a.id}`);
    setEditorInitial({
      title: detail.announcement.title,
      body: detail.announcement.body,
      audience: {
        audience_type: detail.announcement.audience_type,
        audience_id: detail.announcement.audience_id,
      },
      publish_at: detail.announcement.publish_at,
      expires_at: detail.announcement.expires_at ?? '',
      requires_ack: detail.announcement.requires_ack,
      attachments: detail.announcement.attachments.map((x) => ({
        file_id: x.file_id,
        original_name: x.original_name,
      })),
    });
    setEditId(a.id);
    setEditorOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Ankündigungen"
        subtitle="Unternehmensweite und zielgruppenspezifische Mitteilungen"
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => {
              setEditorInitial(emptyEditor());
              setEditId(null);
              setEditorOpen(true);
            }}
          >
            <Plus size={16} /> Neue Ankündigung
          </button>
        }
      />

      {isLoading ? (
        <Spinner center />
      ) : (announcements?.length ?? 0) === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<Megaphone size={40} />}
            title="Noch keine Ankündigungen"
            hint="Legen Sie die erste Ankündigung für Ihre Mitarbeitenden an."
          />
        </div>
      ) : (
        <div className="hm-card">
          <div className="hm-card__body hm-card__body--flush">
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Titel</th>
                    <th>Status</th>
                    <th>Zielgruppe</th>
                    <th>Veröffentlichung</th>
                    <th>Lesequote</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {announcements!.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => setDetailId(a.id)}>
                      <td style={{ fontWeight: 600 }}>{a.title}</td>
                      <td>
                        <Badge tone={STATUS_TONE[a.status]}>
                          {ANNOUNCEMENT_STATUS_LABELS[a.status]}
                        </Badge>
                      </td>
                      <td>{audienceLabel(a)}</td>
                      <td>
                        {formatDate(a.publish_at)}
                        {a.expires_at && (
                          <span style={{ color: 'var(--text-muted)' }}> – {formatDate(a.expires_at)}</span>
                        )}
                      </td>
                      <td>
                        {a.requires_ack ? (
                          <AckBar ackCount={a.ack_count} recipients={a.recipients} />
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                            title="Bearbeiten"
                            onClick={() => openEdit(a)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                            title="Löschen"
                            onClick={() => setDeleteTarget(a)}
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

      <AnnouncementEditor
        open={editorOpen}
        initial={editorInitial}
        editId={editId}
        onClose={() => setEditorOpen(false)}
      />
      <AnnouncementDetail id={detailId} onClose={() => setDetailId(null)} onEdit={openEdit} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Ankündigung löschen"
        message={`Soll die Ankündigung „${deleteTarget?.title}“ endgültig gelöscht werden?`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
