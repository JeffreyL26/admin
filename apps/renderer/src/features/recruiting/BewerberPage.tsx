import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { UserSearch, Plus, Pencil, Trash2, Search, FileText } from 'lucide-react';
import {
  CANDIDATE_SOURCE_LABELS, APPLICATION_STATUS_LABELS, formatDate,
  type CandidateSource,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { Avatar, Badge, Card, EmptyState, Field, PageHeader, Spinner } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useCandidates, useCandidate, useInvalidate, type Candidate } from './api';
import {
  ApplicationDrawer, NewApplicationModal, CandidateMeta, StageChip,
  APPLICATION_STATUS_TONES,
} from './common';

interface Draft {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  city: string;
  source: CandidateSource;
  headline: string;
  linkedin_url: string;
  consent_until: string;
  note: string;
}

const emptyDraft = (): Draft => ({
  first_name: '', last_name: '', email: '', phone: '', city: '',
  source: 'website', headline: '', linkedin_url: '', consent_until: '', note: '',
});

function CandidateEditor({
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
  const [form, setForm] = useState<Draft>(initial);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setForm(initial);
  }
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email || null,
        phone: form.phone || null,
        city: form.city || null,
        source: form.source,
        headline: form.headline || null,
        linkedin_url: form.linkedin_url || null,
        consent_until: form.consent_until || null,
        note: form.note || null,
      };
      return editId === null
        ? api.post('/api/recruiting/candidates', payload)
        : api.put(`/api/recruiting/candidates/${editId}`, payload);
    },
    onSuccess: () => {
      toast.success(editId === null ? 'Bewerber:in angelegt' : 'Bewerber:in aktualisiert');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal
      title={editId === null ? 'Neue:r Bewerber:in' : 'Bewerber:in bearbeiten'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>Abbrechen</button>
          <button className="hm-btn hm-btn--primary" disabled={save.isPending || !form.first_name.trim() || !form.last_name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Vorname" required>
          <input className="hm-input" value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} />
        </Field>
        <Field label="Nachname" required>
          <input className="hm-input" value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} />
        </Field>
        <Field label="E-Mail">
          <input className="hm-input" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </Field>
        <Field label="Telefon">
          <input className="hm-input" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        </Field>
        <Field label="Ort">
          <input className="hm-input" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
        </Field>
        <Field label="Herkunftskanal">
          <select className="hm-select" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as CandidateSource }))}>
            {(Object.keys(CANDIDATE_SOURCE_LABELS) as CandidateSource[]).map((s) => (
              <option key={s} value={s}>{CANDIDATE_SOURCE_LABELS[s]}</option>
            ))}
          </select>
        </Field>
        <Field label="Kurzprofil / aktuelle Position" span2>
          <input className="hm-input" value={form.headline} onChange={(e) => setForm((f) => ({ ...f, headline: e.target.value }))} />
        </Field>
        <Field label="Profil-Link (LinkedIn/Xing)">
          <input className="hm-input" value={form.linkedin_url} onChange={(e) => setForm((f) => ({ ...f, linkedin_url: e.target.value }))} />
        </Field>
        <Field label="DSGVO-Einwilligung bis" hint="Speicherung der Bewerberdaten bis zu diesem Datum">
          <input className="hm-input" type="date" value={form.consent_until} onChange={(e) => setForm((f) => ({ ...f, consent_until: e.target.value }))} />
        </Field>
        <Field label="Interne Notiz" span2>
          <textarea className="hm-textarea" rows={3} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

function CandidateDetail({
  candidateId,
  onClose,
  onOpenApplication,
  onNewApplication,
}: {
  candidateId: number | null;
  onClose: () => void;
  onOpenApplication: (id: number) => void;
  onNewApplication: (candidateId: number) => void;
}) {
  const { data: candidate, isLoading } = useCandidate(candidateId);
  return (
    <Modal
      title={candidate ? `${candidate.first_name} ${candidate.last_name}` : 'Bewerber:in'}
      open={candidateId !== null}
      onClose={onClose}
      wide
      footer={
        candidate && (
          <button className="hm-btn hm-btn--primary" onClick={() => onNewApplication(candidate.id)}>
            <Plus size={15} /> Auf Stelle bewerben
          </button>
        )
      }
    >
      {isLoading || !candidate ? (
        <Spinner center />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 12 }}>
            <Avatar name={`${candidate.first_name} ${candidate.last_name}`} size={44} src={candidate.photo_url ?? undefined} />
            <div>
              {candidate.headline && <div style={{ fontWeight: 600 }}>{candidate.headline}</div>}
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {candidate.email ?? 'keine E-Mail'} · {CANDIDATE_SOURCE_LABELS[candidate.source]}
              </div>
              <CandidateMeta candidate={candidate} />
            </div>
          </div>
          {candidate.consent_until && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              DSGVO-Einwilligung bis {formatDate(candidate.consent_until)}
            </div>
          )}
          {candidate.note && (
            <div style={{ background: 'var(--bg-tint-1)', borderRadius: 8, padding: 12, fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap' }}>
              {candidate.note}
            </div>
          )}
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Bewerbungen ({candidate.applications.length})</div>
            {candidate.applications.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Noch keine Bewerbung erfasst.</p>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {candidate.applications.map((a) => (
                  <div key={a.id} className="hm-card hm-card--clickable" style={{ padding: 10 }} onClick={() => onOpenApplication(a.id)}>
                    <div className="row row--between">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <FileText size={15} style={{ color: 'var(--text-muted)' }} />
                        <strong style={{ fontSize: 'var(--text-sm)' }}>{a.posting_title}</strong>
                        {a.stage_name && a.stage_color && <StageChip name={a.stage_name} color={a.stage_color} />}
                      </div>
                      <Badge tone={APPLICATION_STATUS_TONES[a.status]}>{APPLICATION_STATUS_LABELS[a.status]}</Badge>
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 4 }}>
                      Eingang {formatDate(a.applied_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function BewerberPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [search, setSearch] = useState('');
  const { data: candidates, isLoading } = useCandidates(search || undefined);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<Draft>(emptyDraft());
  const [editId, setEditId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [appId, setAppId] = useState<number | null>(null);
  const [newAppFor, setNewAppFor] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Candidate | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/recruiting/candidates/${id}`),
    onSuccess: () => {
      toast.success('Bewerber:in gelöscht');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const openEdit = (c: Candidate) => {
    setEditorInitial({
      first_name: c.first_name, last_name: c.last_name, email: c.email ?? '', phone: c.phone ?? '',
      city: c.city ?? '', source: c.source, headline: c.headline ?? '', linkedin_url: c.linkedin_url ?? '',
      consent_until: c.consent_until ?? '', note: c.note ?? '',
    });
    setEditId(c.id);
    setEditorOpen(true);
  };

  const all = candidates ?? [];

  return (
    <>
      <PageHeader
        title="Bewerber:innen"
        subtitle="Talentpool aller erfassten Bewerber:innen"
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => { setEditorInitial(emptyDraft()); setEditId(null); setEditorOpen(true); }}>
            <Plus size={16} /> Neue:r Bewerber:in
          </button>
        }
      />

      <div className="row" style={{ gap: 8, marginBottom: 16, maxWidth: 380 }}>
        <div className="hm-input" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input
            style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, color: 'inherit' }}
            placeholder="Name, E-Mail oder Profil …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <Spinner center />
      ) : all.length === 0 ? (
        <Card>
          <EmptyState icon={<UserSearch size={40} />} title="Keine Bewerber:innen" hint="Legen Sie Bewerber:innen an oder erfassen Sie eine Bewerbung in der Pipeline." />
        </Card>
      ) : (
        <Card flush>
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Profil</th>
                  <th>Kanal</th>
                  <th>Ort</th>
                  <th>Bewerbungen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {all.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setDetailId(c.id)}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <Avatar name={`${c.first_name} ${c.last_name}`} size={28} src={c.photo_url ?? undefined} />
                        <span style={{ fontWeight: 600 }}>{c.last_name}, {c.first_name}</span>
                      </div>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{c.headline ?? '—'}</td>
                    <td>{CANDIDATE_SOURCE_LABELS[c.source]}</td>
                    <td>{c.city ?? '—'}</td>
                    <td>{c.application_count ?? 0}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" title="Bearbeiten" onClick={() => openEdit(c)}>
                          <Pencil size={15} />
                        </button>
                        <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" title="Löschen" onClick={() => setDeleteTarget(c)}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <CandidateEditor open={editorOpen} initial={editorInitial} editId={editId} onClose={() => setEditorOpen(false)} />
      <CandidateDetail
        candidateId={detailId}
        onClose={() => setDetailId(null)}
        onOpenApplication={(id) => setAppId(id)}
        onNewApplication={(cid) => { setDetailId(null); setNewAppFor(cid); }}
      />
      <ApplicationDrawer applicationId={appId} onClose={() => setAppId(null)} />
      <NewApplicationModal open={newAppFor !== null} presetCandidateId={newAppFor} onClose={() => setNewAppFor(null)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Bewerber:in löschen"
        message={`Soll ${deleteTarget ? `${deleteTarget.first_name} ${deleteTarget.last_name}` : ''} inkl. aller Bewerbungen gelöscht werden?`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
