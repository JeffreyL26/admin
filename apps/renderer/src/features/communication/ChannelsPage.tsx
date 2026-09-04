import React, { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Plus, Radio, Send, Trash2, Users } from 'lucide-react';
import { api } from '../../api/client';
import { Badge, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { AudienceSelect, audienceLabel, type AudienceValue } from './AudienceSelect';
import { useChannelMessages, useChannels, useInvalidate, type Channel } from './api';

function formatTimestamp(sqlite: string): string {
  // sent_at kommt als "YYYY-MM-DD HH:MM:SS" (UTC) aus SQLite.
  const date = new Date(`${sqlite.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return sqlite;
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ChannelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState<AudienceValue>({ audience_type: 'alle', audience_id: null });

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName('');
      setTopic('');
      setAudience({ audience_type: 'alle', audience_id: null });
    }
  }

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/communication/channels', {
        name,
        topic: topic || null,
        audience_type: audience.audience_type,
        audience_id: audience.audience_id,
      }),
    onSuccess: () => {
      toast.success('Kanal angelegt');
      invalidate('channels');
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal
      title="Neuer Kanal"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="hm-btn hm-btn--primary" disabled={create.isPending} onClick={() => create.mutate()}>
            Anlegen
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2>
          <input
            className="hm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z. B. Allgemein, Standort München"
          />
        </Field>
        <Field label="Thema" span2>
          <input className="hm-input" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <AudienceSelect value={audience} onChange={setAudience} />
      </div>
    </Modal>
  );
}

function MessagePane({ channel }: { channel: Channel }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: messages, isLoading } = useChannelMessages(channel.id);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = useMutation({
    mutationFn: () => api.post(`/api/communication/channels/${channel.id}/messages`, { body: draft }),
    onSuccess: () => {
      setDraft('');
      invalidate('channels');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        {isLoading ? (
          <Spinner center />
        ) : (messages?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Radio size={40} />}
            title="Noch keine Nachrichten"
            hint="Senden Sie die erste Nachricht in diesen Kanal."
          />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {messages!.map((m) => (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div
                  style={{
                    maxWidth: '78%',
                    background: 'var(--blue-100)',
                    color: 'var(--text-primary)',
                    borderRadius: '12px 12px 2px 12px',
                    padding: '9px 13px',
                  }}
                >
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--text-base)' }}>{m.body}</div>
                  <div
                    style={{
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-muted)',
                      marginTop: 4,
                      textAlign: 'right',
                    }}
                  >
                    {m.sent_by_name ?? 'HR'} · {formatTimestamp(m.sent_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
        {channel.archived ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', textAlign: 'center' }}>
            Dieser Kanal ist archiviert. Es können keine Nachrichten mehr gesendet werden.
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <textarea
              className="hm-textarea"
              rows={2}
              style={{ minHeight: 44 }}
              placeholder={`Nachricht an „${channel.name}“ …`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) {
                  e.preventDefault();
                  send.mutate();
                }
              }}
            />
            <button
              className="hm-btn hm-btn--primary"
              disabled={send.isPending || draft.trim() === ''}
              onClick={() => send.mutate()}
              title="Senden (Strg+Enter)"
            >
              <Send size={15} /> Senden
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChannelsPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: channels, isLoading } = useChannels();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);

  const selected = channels?.find((c) => c.id === selectedId) ?? channels?.[0] ?? null;

  const toggleArchive = useMutation({
    mutationFn: (c: Channel) =>
      api.put(`/api/communication/channels/${c.id}`, {
        name: c.name,
        topic: c.topic,
        audience_type: c.audience_type,
        audience_id: c.audience_id,
        archived: !c.archived,
      }),
    onSuccess: (_, c) => {
      toast.success(c.archived ? 'Kanal reaktiviert' : 'Kanal archiviert');
      invalidate('channels');
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/communication/channels/${id}`),
    onSuccess: () => {
      toast.success('Kanal gelöscht');
      invalidate('channels');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Kanäle"
        subtitle="Themen- und zielgruppenbezogene Kommunikationskanäle"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => setDialogOpen(true)}>
            <Plus size={16} /> Neuer Kanal
          </button>
        }
      />

      {isLoading ? (
        <Spinner center />
      ) : (channels?.length ?? 0) === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<Radio size={40} />}
            title="Noch keine Kanäle"
            hint="Legen Sie den ersten Kommunikationskanal an, z. B. „Allgemein“."
            action={
              <button className="hm-btn hm-btn--primary" onClick={() => setDialogOpen(true)}>
                <Plus size={16} /> Kanal anlegen
              </button>
            }
          />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 340px) 1fr',
            gap: 16,
            alignItems: 'stretch',
            height: 'calc(100vh - 170px)',
            minHeight: 380,
          }}
        >
          <div className="hm-card" style={{ overflowY: 'auto' }}>
            <div className="hm-card__body hm-card__body--flush">
              {channels!.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--gray-100)',
                    cursor: 'pointer',
                    background: selected?.id === c.id ? 'var(--blue-50)' : undefined,
                    opacity: c.archived ? 0.65 : 1,
                  }}
                >
                  <div className="row row--between">
                    <span style={{ fontWeight: 650 }}>{c.name}</span>
                    <div className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                        title={c.archived ? 'Reaktivieren' : 'Archivieren'}
                        onClick={() => toggleArchive.mutate(c)}
                      >
                        {c.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                      </button>
                      <button
                        className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                        title="Löschen"
                        onClick={() => setDeleteTarget(c)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {c.topic && (
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
                      {c.topic}
                    </div>
                  )}
                  <div className="row row--wrap" style={{ gap: 6, marginTop: 6 }}>
                    <Badge tone="blue">
                      <Users size={11} /> {c.recipients}
                    </Badge>
                    <Badge tone="neutral">{audienceLabel(c)}</Badge>
                    {c.archived && <Badge tone="yellow">Archiviert</Badge>}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                    {c.message_count} {c.message_count === 1 ? 'Nachricht' : 'Nachrichten'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="hm-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {selected ? (
              <>
                <header className="hm-card__header">
                  <div>
                    <div className="hm-card__title">{selected.name}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      {audienceLabel(selected)} · {selected.recipients} Empfänger:innen
                    </div>
                  </div>
                </header>
                <MessagePane channel={selected} />
              </>
            ) : (
              <EmptyState icon={<Radio size={40} />} title="Kein Kanal ausgewählt" />
            )}
          </div>
        </div>
      )}

      <ChannelDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Kanal löschen"
        message={`Soll der Kanal „${deleteTarget?.name}“ mitsamt Verlauf endgültig gelöscht werden?`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
