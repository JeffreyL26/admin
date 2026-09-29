import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { UserSearch, Plus, Pencil, Trash2, Search, FileText, ShieldAlert } from 'lucide-react';
import {
  CANDIDATE_SOURCE_LABELS, APPLICATION_STATUS_LABELS, formatDate, todayIsoLocal,
  type CandidateSource, type ApplicationStatus,
} from '@ohrganize/shared';
import { api, uploadFile } from '../../api/client';
import { Avatar, Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { PhotoPicker } from '../../components/FilePicker';
import { useToast } from '../../components/Toast';
import { useCandidates, useCandidate, useApplications, useInvalidate, type Candidate } from './api';
import {
  ApplicationDrawer, NewApplicationModal, CandidateMeta, StageChip, RatingStars,
  APPLICATION_STATUS_TONES,
} from './common';
import { Select } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';

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
  /** undefined = unveraendert lassen (Server behaelt das Foto), Zahl = neues Foto. */
  photo_file_id?: number;
  photo_url?: string | null;
}

const emptyDraft = (): Draft => ({
  first_name: '', last_name: '', email: '', phone: '', city: '',
  source: 'website', headline: '', linkedin_url: '', consent_until: '', note: '',
});

/** Einwilligung zur Datenspeicherung liegt in der Vergangenheit. */
function consentExpired(consentUntil: string | null): boolean {
  return !!consentUntil && consentUntil < todayIsoLocal();
}

const APPLICATION_STATUS_FILTERS: ApplicationStatus[] = ['aktiv', 'abgelehnt', 'zurueckgezogen', 'eingestellt'];

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
  const [uploading, setUploading] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setForm(initial);
  }
  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
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
      // Nur senden, wenn ein neues Foto gewaehlt wurde; sonst behaelt der
      // Server das bestehende (PUT /candidates/:id).
      if (form.photo_file_id !== undefined) payload.photo_file_id = form.photo_file_id;
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
          <button className="hm-btn hm-btn--primary" disabled={save.isPending || uploading || !form.first_name.trim() || !form.last_name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Foto" span2>
          <PhotoPicker
            name={`${form.first_name} ${form.last_name}`.trim() || 'Neu'}
            previewUrl={form.photo_url ?? undefined}
            busy={uploading}
            onPick={async (file) => {
              setUploading(true);
              try {
                const res = await uploadFile(file);
                setForm((f) => ({ ...f, photo_file_id: res.file.id }));
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setUploading(false);
              }
            }}
          />
        </Field>
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
          <Select className="hm-select" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as CandidateSource }))}>
            {(Object.keys(CANDIDATE_SOURCE_LABELS) as CandidateSource[]).map((s) => (
              <option key={s} value={s}>{CANDIDATE_SOURCE_LABELS[s]}</option>
            ))}
          </Select>
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
            <div className="row" style={{ gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              DSGVO-Einwilligung bis {formatDate(candidate.consent_until)}
              {consentExpired(candidate.consent_until) && <Badge tone="red">Einwilligung abgelaufen</Badge>}
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

/** Tab „Bewerbungen“: alle Bewerbungen ueber alle Stellen, gefiltert nach Status. */
function ApplicationsTab({
  status,
  onStatus,
  onOpen,
}: {
  status: ApplicationStatus;
  onStatus: (s: ApplicationStatus) => void;
  onOpen: (id: number) => void;
}) {
  const [search, setSearch] = useState('');
  const { data: applications, isLoading } = useApplications({ status, search: search || undefined });
  const all = applications ?? [];
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Select className="hm-select" style={{ maxWidth: 200 }} value={status} onChange={(e) => onStatus(e.target.value as ApplicationStatus)}>
          {APPLICATION_STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{APPLICATION_STATUS_LABELS[s]}</option>
          ))}
        </Select>
        <div className="hm-input" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 380 }}>
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input
            style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, color: 'inherit' }}
            placeholder="Name, E-Mail oder Stelle …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {isLoading ? (
        <Spinner center />
      ) : all.length === 0 ? (
        <Card>
          <EmptyState icon={<FileText size={40} />} title="Keine Bewerbungen" hint={`Mit Status „${APPLICATION_STATUS_LABELS[status]}“ ist keine Bewerbung erfasst.`} />
        </Card>
      ) : (
        <Card flush>
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Bewerber</th>
                  <th>Stelle</th>
                  <th>Stufe</th>
                  <th>Eingang</th>
                  <th>Bewertung</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {all.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => onOpen(a.id)}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{a.candidate_last_name}, {a.candidate_first_name}</div>
                      {a.candidate_email && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{a.candidate_email}</div>}
                    </td>
                    <td>{a.posting_title}</td>
                    <td>{a.stage_name && a.stage_color ? <StageChip name={a.stage_name} color={a.stage_color} /> : ''}</td>
                    <td>{formatDate(a.applied_at)}</td>
                    <td><RatingStars value={a.rating} size={14} /></td>
                    <td><Badge tone={APPLICATION_STATUS_TONES[a.status]}>{APPLICATION_STATUS_LABELS[a.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function isApplicationStatus(v: string | null): v is ApplicationStatus {
  return APPLICATION_STATUS_FILTERS.includes(v as ApplicationStatus);
}

export function BewerberPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  // Deep-Link: ?tab=bewerbungen&status=aktiv (Kacheln auf Stellen- und Analyseseite).
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'bewerbungen' ? 'bewerbungen' : 'talentpool';
  const statusParam = params.get('status');
  const appStatus: ApplicationStatus = isApplicationStatus(statusParam) ? statusParam : 'aktiv';
  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'bewerbungen') p.set('tab', 'bewerbungen');
    else { p.delete('tab'); p.delete('status'); }
    setParams(p, { replace: true });
  };
  const setAppStatus = (s: ApplicationStatus) => {
    const p = new URLSearchParams(params);
    p.set('tab', 'bewerbungen');
    p.set('status', s);
    setParams(p, { replace: true });
  };
  const [search, setSearch] = useState('');
  const [onlyExpired, setOnlyExpired] = useState(false);
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
      consent_until: c.consent_until ?? '', note: c.note ?? '', photo_url: c.photo_url ?? null,
    });
    setEditId(c.id);
    setEditorOpen(true);
  };

  const all = (candidates ?? []).filter((c) => !onlyExpired || consentExpired(c.consent_until));
  const expiredCount = (candidates ?? []).filter((c) => consentExpired(c.consent_until)).length;

  return (
    <>
      <PageHeader
        title="Bewerbungen"
        subtitle="Alle Bewerbungen und der erfasste Talentpool."
        actions={
          <button className="hm-btn hm-btn--primary" onClick={() => { setEditorInitial(emptyDraft()); setEditId(null); setEditorOpen(true); }}>
            <Plus size={16} /> Neue:r Bewerber:in
          </button>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <Tabs
          tabs={[
            { key: 'talentpool', label: 'Talentpool' },
            { key: 'bewerbungen', label: 'Eingegangen' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'bewerbungen' ? (
        <ApplicationsTab status={appStatus} onStatus={setAppStatus} onOpen={(id) => setAppId(id)} />
      ) : (
      <>
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="hm-input" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 380 }}>
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input
            style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1, color: 'inherit' }}
            placeholder="Name, E-Mail oder Profil …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="hm-checkbox">
          <input type="checkbox" checked={onlyExpired} onChange={(e) => setOnlyExpired(e.target.checked)} />
          <span>Nur abgelaufene Einwilligungen{expiredCount > 0 ? ` (${expiredCount})` : ''}</span>
        </label>
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
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <Avatar name={`${c.first_name} ${c.last_name}`} size={28} src={c.photo_url ?? undefined} />
                        <span style={{ fontWeight: 600 }}>{c.last_name}, {c.first_name}</span>
                        {consentExpired(c.consent_until) && (
                          <Tooltip content={<><span className="hm-tooltip__title">Einwilligung abgelaufen</span><span className="hm-tooltip__line">bis {formatDate(c.consent_until!)}</span></>}>
                            <span className="hm-badge hm-badge--red row" style={{ gap: 4 }}><ShieldAlert size={12} /> Einwilligung abgelaufen</span>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{c.headline ?? '—'}</td>
                    <td>{CANDIDATE_SOURCE_LABELS[c.source]}</td>
                    <td>{c.city ?? '—'}</td>
                    <td>{c.application_count ?? 0}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <Tooltip content={<span className="hm-tooltip__title">Bearbeiten</span>}>
                          <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" onClick={() => openEdit(c)}>
                            <Pencil size={15} />
                          </button>
                        </Tooltip>
                        <Tooltip content={<span className="hm-tooltip__title">Löschen</span>}>
                          <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" onClick={() => setDeleteTarget(c)}>
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
        </Card>
      )}
      </>
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
        message={`Soll ${deleteTarget ? `${deleteTarget.first_name} ${deleteTarget.last_name}` : ''} inkl. aller Bewerbungen gelöscht werden? Wurde die Person über eine Bewerbung eingestellt, bleibt der Eintrag als Nachweis erhalten und lässt sich nicht löschen.`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
