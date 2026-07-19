import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Star, MessageSquarePlus, CalendarClock, XCircle, UserCheck, FileText, ArrowRight,
  Mail, Phone, MapPin, ExternalLink, Trash2,
} from 'lucide-react';
import {
  APPLICATION_STATUS_LABELS, APPLICATION_EVENT_LABELS, CANDIDATE_SOURCE_LABELS,
  INTERVIEW_KIND_LABELS, INTERVIEW_STATUS_LABELS, INTERVIEW_RECOMMENDATION_LABELS,
  EMPLOYEE_TYPE_LABELS, formatDate, formatEuro,
  type ApplicationStatus, type InterviewKind, type InterviewRecommendation,
  type InterviewStatus, type EmployeeType, type ScorecardEntry, type InterviewDto,
} from '@hrmonic/shared';
import { api, downloadFile } from '../../api/client';
import { Badge, Avatar, Field, Spinner } from '../../components/ui';
import type { BadgeTone } from '../../components/ui';
import { Modal, ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useEmployees, employeeName } from '../../components/EmployeeSelect';
import { parseEuroInput, centsToInput } from '../compensation/lib';
import type { CandidateSource } from '@hrmonic/shared';
import {
  useApplication, useStages, useRecruitingOrg, useInvalidate, usePostings, useCandidates,
  type ApplicationDetail,
} from './api';

export const APPLICATION_STATUS_TONES: Record<ApplicationStatus, BadgeTone> = {
  aktiv: 'blue',
  eingestellt: 'green',
  abgelehnt: 'red',
  zurueckgezogen: 'neutral',
};

export const POSTING_STATUS_TONES: Record<string, BadgeTone> = {
  entwurf: 'neutral',
  veroeffentlicht: 'green',
  pausiert: 'yellow',
  besetzt: 'blue',
  geschlossen: 'neutral',
};

/** Farbige Stufen-Kennzeichnung (nutzt die in der DB hinterlegte Farbe). */
export function StageChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="hm-badge" style={{ background: `${color}22`, color }}>
      {name}
    </span>
  );
}

/** Sterne-Bewertung 1–5, optional editierbar. */
export function RatingStars({
  value,
  onChange,
  size = 16,
}: {
  value: number | null;
  onChange?: (v: number | null) => void;
  size?: number;
}) {
  const editable = !!onChange;
  return (
    <span className="row" style={{ gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value !== null && n <= value;
        return (
          <Star
            key={n}
            size={size}
            role={editable ? 'button' : undefined}
            onClick={editable ? () => onChange!(value === n ? null : n) : undefined}
            style={{
              cursor: editable ? 'pointer' : 'default',
              fill: filled ? 'var(--warning)' : 'none',
              color: filled ? 'var(--warning)' : 'var(--gray-300)',
            }}
          />
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Interviewer-Auswahl (Chips)
// ---------------------------------------------------------------------------

function InterviewerPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data: employees } = useEmployees();
  const byId = new Map((employees ?? []).map((e) => [e.id, e]));
  const available = (employees ?? []).filter((e) => !value.includes(e.id));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <select
        className="hm-select"
        value=""
        onChange={(e) => e.target.value && onChange([...value, Number(e.target.value)])}
      >
        <option value="">— Interviewer:in hinzufügen —</option>
        {available.map((e) => (
          <option key={e.id} value={e.id}>
            {e.last_name}, {e.first_name}
          </option>
        ))}
      </select>
      {value.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {value.map((id) => {
            const e = byId.get(id);
            return (
              <span key={id} className="hm-badge hm-badge--blue" style={{ gap: 4 }}>
                {e ? employeeName(e) : `#${id}`}
                <button
                  className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                  style={{ width: 18, height: 18 }}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  title="Entfernen"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interview-Editor (Planung + Feedback/Scorecard) — auch von InterviewsPage genutzt
// ---------------------------------------------------------------------------

const SCORECARD_CRITERIA = ['Fachkompetenz', 'Kommunikation', 'Kultur-Fit', 'Motivation'];

export function InterviewEditor({
  open,
  applicationId,
  interview,
  onClose,
}: {
  open: boolean;
  applicationId: number;
  interview: InterviewDto | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const isEdit = interview !== null;

  const [kind, setKind] = useState<InterviewKind>('telefon');
  const [scheduledAt, setScheduledAt] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState('60');
  const [location, setLocation] = useState('');
  const [interviewers, setInterviewers] = useState<number[]>([]);
  const [status, setStatus] = useState<InterviewStatus>('geplant');
  const [recommendation, setRecommendation] = useState<InterviewRecommendation | ''>('');
  const [scores, setScores] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState('');

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      if (interview) {
        setKind(interview.kind);
        setScheduledAt(interview.scheduled_at.slice(0, 10));
        setTime(interview.scheduled_at.length > 10 ? interview.scheduled_at.slice(11, 16) : '');
        setDuration(interview.duration_minutes ? String(interview.duration_minutes) : '');
        setLocation(interview.location ?? '');
        setInterviewers(interview.interviewer_ids);
        setStatus(interview.status);
        setRecommendation(interview.recommendation ?? '');
        setScores(Object.fromEntries(interview.scorecard.map((s) => [s.criterion, s.score])));
        setFeedback(interview.feedback ?? '');
      } else {
        setKind('telefon');
        setScheduledAt(new Date().toISOString().slice(0, 10));
        setTime('10:00');
        setDuration('60');
        setLocation('');
        setInterviewers([]);
        setStatus('geplant');
        setRecommendation('');
        setScores({});
        setFeedback('');
      }
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const scheduled = time ? `${scheduledAt} ${time}` : scheduledAt;
      const base = {
        kind,
        scheduled_at: scheduled,
        duration_minutes: duration ? Number(duration) : null,
        location: location || null,
        interviewer_ids: interviewers,
      };
      if (!isEdit) {
        return api.post(`/api/recruiting/applications/${applicationId}/interviews`, base);
      }
      const scorecard: ScorecardEntry[] = Object.entries(scores).map(([criterion, score]) => ({
        criterion,
        score,
      }));
      return api.put(`/api/recruiting/interviews/${interview!.id}`, {
        ...base,
        status,
        recommendation: recommendation || null,
        scorecard,
        feedback: feedback || null,
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Interview aktualisiert' : 'Interview geplant');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal
      title={isEdit ? 'Interview & Feedback' : 'Interview planen'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>Abbrechen</button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={save.isPending || !scheduledAt}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Art" required>
          <select className="hm-select" value={kind} onChange={(e) => setKind(e.target.value as InterviewKind)}>
            {(Object.keys(INTERVIEW_KIND_LABELS) as InterviewKind[]).map((k) => (
              <option key={k} value={k}>{INTERVIEW_KIND_LABELS[k]}</option>
            ))}
          </select>
        </Field>
        <Field label="Dauer (Min.)">
          <input className="hm-input" type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
        <Field label="Datum" required>
          <input className="hm-input" type="date" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
        <Field label="Uhrzeit">
          <input className="hm-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <Field label="Ort / Videolink" span2>
          <input className="hm-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Raum, Adresse oder Meeting-Link" />
        </Field>
        <Field label="Interviewer:innen" span2>
          <InterviewerPicker value={interviewers} onChange={setInterviewers} />
        </Field>

        {isEdit && (
          <>
            <Field label="Status" span2>
              <select className="hm-select" value={status} onChange={(e) => setStatus(e.target.value as InterviewStatus)}>
                {(Object.keys(INTERVIEW_STATUS_LABELS) as InterviewStatus[]).map((s) => (
                  <option key={s} value={s}>{INTERVIEW_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </Field>
            <div className="span-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Scorecard</div>
              <div className="stack" style={{ gap: 8 }}>
                {SCORECARD_CRITERIA.map((crit) => (
                  <div key={crit} className="row row--between">
                    <span style={{ fontSize: 'var(--text-sm)' }}>{crit}</span>
                    <RatingStars
                      value={scores[crit] ?? null}
                      onChange={(v) =>
                        setScores((s) => {
                          const next = { ...s };
                          if (v === null) delete next[crit];
                          else next[crit] = v;
                          return next;
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
            <Field label="Empfehlung" span2>
              <select
                className="hm-select"
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value as InterviewRecommendation | '')}
              >
                <option value="">— keine —</option>
                {(Object.keys(INTERVIEW_RECOMMENDATION_LABELS) as InterviewRecommendation[]).map((r) => (
                  <option key={r} value={r}>{INTERVIEW_RECOMMENDATION_LABELS[r]}</option>
                ))}
              </select>
            </Field>
            <Field label="Notizen zum Gespräch" span2>
              <textarea className="hm-textarea" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Absage-Dialog
// ---------------------------------------------------------------------------

function RejectDialog({
  open,
  applicationId,
  onClose,
}: {
  open: boolean;
  applicationId: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [reason, setReason] = useState('');
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setReason('');
  }
  const reject = useMutation({
    mutationFn: () => api.post(`/api/recruiting/applications/${applicationId}/reject`, { reason }),
    onSuccess: () => {
      toast.success('Bewerbung abgelehnt');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal
      title="Bewerbung ablehnen"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>Abbrechen</button>
          <button className="hm-btn hm-btn--danger" disabled={reject.isPending || !reason.trim()} onClick={() => reject.mutate()}>
            Absage senden
          </button>
        </>
      }
    >
      <Field label="Absagegrund" required hint="Wird in der Bewerbungshistorie protokolliert.">
        <textarea className="hm-textarea" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Einstellungs-Dialog (Lebenszyklus-Brücke zum Personal-Modul)
// ---------------------------------------------------------------------------

function HireDialog({
  open,
  application,
  onClose,
}: {
  open: boolean;
  application: ApplicationDetail;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: org } = useRecruitingOrg();
  const [hireDate, setHireDate] = useState('');
  const [type, setType] = useState<EmployeeType>('vollzeit');
  const [weeklyHours, setWeeklyHours] = useState('40');
  const [leave, setLeave] = useState('30');
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setHireDate(application.available_from ?? new Date().toISOString().slice(0, 10));
      setType('vollzeit');
      setWeeklyHours('40');
      setLeave('30');
    }
  }
  const hire = useMutation({
    mutationFn: () =>
      api.post<{ employee_id: number }>(`/api/recruiting/applications/${application.id}/hire`, {
        hire_date: hireDate,
        employee_type: type,
        weekly_hours: weeklyHours ? Number(weeklyHours) : null,
        annual_leave_days: leave ? Number(leave) : null,
      }),
    onSuccess: () => {
      toast.success('Eingestellt — Mitarbeitenden-Datensatz angelegt');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal
      title={`${application.candidate_first_name} ${application.candidate_last_name} einstellen`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>Abbrechen</button>
          <button className="hm-btn hm-btn--primary" disabled={hire.isPending || !hireDate} onClick={() => hire.mutate()}>
            {hire.isPending ? 'Stellt ein …' : 'Einstellen'}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-secondary)', marginBottom: 12, fontSize: 'var(--text-sm)' }}>
        Es wird ein Mitarbeitenden-Grunddatensatz angelegt (Name, Kontakt, Orga, Eintritt).
        Steuer-, SV- und Bankdaten ergänzen Sie anschließend im Personal-Modul.
      </p>
      <div className="hm-form-grid">
        <Field label="Eintrittsdatum" required>
          <input className="hm-input" type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} />
        </Field>
        <Field label="Beschäftigungsart" required>
          <select className="hm-select" value={type} onChange={(e) => setType(e.target.value as EmployeeType)}>
            {(Object.keys(EMPLOYEE_TYPE_LABELS) as EmployeeType[]).map((t) => (
              <option key={t} value={t}>{EMPLOYEE_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="Wochenstunden">
          <input className="hm-input" type="number" min={0} value={weeklyHours} onChange={(e) => setWeeklyHours(e.target.value)} />
        </Field>
        <Field label="Jahresurlaub (Tage)">
          <input className="hm-input" type="number" min={0} value={leave} onChange={(e) => setLeave(e.target.value)} />
        </Field>
      </div>
      {org && (
        <p style={{ color: 'var(--text-muted)', marginTop: 10, fontSize: 'var(--text-xs)' }}>
          Abteilung/Team/Standort werden aus der Stelle „{application.posting_title}“ übernommen.
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bewerbungs-Detail (Drawer/Modal) — Timeline, Bewertung, Stufen, Interviews
// ---------------------------------------------------------------------------

export function ApplicationDrawer({
  applicationId,
  onClose,
}: {
  applicationId: number | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: app, isLoading } = useApplication(applicationId);
  const { data: stages } = useStages();
  const [note, setNote] = useState('');
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [interviewEdit, setInterviewEdit] = useState<InterviewDto | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [hireOpen, setHireOpen] = useState(false);
  const [deleteInterview, setDeleteInterview] = useState<InterviewDto | null>(null);

  const activeStages = (stages ?? []).filter((s) => s.category === 'aktiv');

  const setRating = useMutation({
    mutationFn: (rating: number | null) =>
      api.patch(`/api/recruiting/applications/${applicationId}`, { rating }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const moveStage = useMutation({
    mutationFn: (stageId: number) =>
      api.post(`/api/recruiting/applications/${applicationId}/stage`, { stage_id: stageId }),
    onSuccess: () => {
      invalidate();
      toast.success('Stufe aktualisiert');
    },
    onError: (e) => toast.error(e.message),
  });
  const addNote = useMutation({
    mutationFn: () => api.post(`/api/recruiting/applications/${applicationId}/notes`, { body: note }),
    onSuccess: () => {
      setNote('');
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const removeInterview = useMutation({
    mutationFn: (id: number) => api.delete(`/api/recruiting/interviews/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success('Interview gelöscht');
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Modal
        title={app ? `${app.candidate_first_name} ${app.candidate_last_name}` : 'Bewerbung'}
        open={applicationId !== null}
        onClose={onClose}
        wide
      >
        {isLoading || !app ? (
          <Spinner center />
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {/* Kopf */}
            <div className="row row--between" style={{ alignItems: 'flex-start' }}>
              <div className="row" style={{ gap: 12 }}>
                <Avatar name={`${app.candidate_first_name} ${app.candidate_last_name}`} size={44} />
                <div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <strong>{app.posting_title}</strong>
                    <Badge tone={APPLICATION_STATUS_TONES[app.status]}>{APPLICATION_STATUS_LABELS[app.status]}</Badge>
                    {app.stage_name && app.stage_color && <StageChip name={app.stage_name} color={app.stage_color} />}
                  </div>
                  <div className="row" style={{ gap: 12, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
                    {app.candidate_email && <span className="row" style={{ gap: 4 }}><Mail size={13} /> {app.candidate_email}</span>}
                    <span>Eingang {formatDate(app.applied_at)}</span>
                    {app.source && <span>· {CANDIDATE_SOURCE_LABELS[app.source]}</span>}
                  </div>
                </div>
              </div>
              <RatingStars value={app.rating} onChange={(v) => setRating.mutate(v)} size={20} />
            </div>

            {/* Metadaten */}
            <div className="row" style={{ gap: 16, flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
              {app.salary_expectation_cents != null && (
                <span>Gehaltsvorstellung: <strong>{formatEuro(app.salary_expectation_cents)}</strong></span>
              )}
              {app.available_from && <span>Verfügbar ab: <strong>{formatDate(app.available_from)}</strong></span>}
              {app.cv_url && (
                <button className="hm-btn hm-btn--ghost hm-btn--sm" onClick={() => app.cv_file_id && downloadFile(app.cv_file_id)}>
                  <FileText size={14} /> Lebenslauf
                </button>
              )}
            </div>

            {app.cover_letter && (
              <div style={{ background: 'var(--bg-tint-1)', borderRadius: 8, padding: 12, fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap' }}>
                {app.cover_letter}
              </div>
            )}

            {/* Aktionen */}
            {app.status === 'aktiv' && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <select
                  className="hm-select"
                  style={{ maxWidth: 220 }}
                  value={app.stage_id}
                  onChange={(e) => moveStage.mutate(Number(e.target.value))}
                >
                  {activeStages.map((s) => (
                    <option key={s.id} value={s.id}>Stufe: {s.name}</option>
                  ))}
                </select>
                <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => { setInterviewEdit(null); setInterviewOpen(true); }}>
                  <CalendarClock size={15} /> Interview planen
                </button>
                <button className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setHireOpen(true)}>
                  <UserCheck size={15} /> Einstellen
                </button>
                <button className="hm-btn hm-btn--ghost hm-btn--sm" onClick={() => setRejectOpen(true)} style={{ color: 'var(--danger)' }}>
                  <XCircle size={15} /> Ablehnen
                </button>
              </div>
            )}
            {app.status === 'abgelehnt' && app.rejection_reason && (
              <div style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>Abgelehnt: {app.rejection_reason}</div>
            )}

            {/* Interviews */}
            {app.interviews.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Interviews</div>
                <div className="stack" style={{ gap: 8 }}>
                  {app.interviews.map((iv) => (
                    <div key={iv.id} className="row row--between" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                      <div>
                        <div className="row" style={{ gap: 8 }}>
                          <strong style={{ fontSize: 'var(--text-sm)' }}>{INTERVIEW_KIND_LABELS[iv.kind]}</strong>
                          <Badge tone={iv.status === 'stattgefunden' ? 'green' : iv.status === 'abgesagt' ? 'neutral' : 'blue'}>
                            {INTERVIEW_STATUS_LABELS[iv.status]}
                          </Badge>
                          {iv.recommendation && (
                            <Badge tone={iv.recommendation === 'ja' ? 'green' : iv.recommendation === 'nein' ? 'red' : 'yellow'}>
                              {INTERVIEW_RECOMMENDATION_LABELS[iv.recommendation]}
                            </Badge>
                          )}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                          {formatDate(iv.scheduled_at.slice(0, 10))}
                          {iv.scheduled_at.length > 10 ? ` ${iv.scheduled_at.slice(11, 16)}` : ''}
                          {iv.interviewer_names && iv.interviewer_names.length > 0 ? ` · ${iv.interviewer_names.join(', ')}` : ''}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="hm-btn hm-btn--ghost hm-btn--sm" onClick={() => { setInterviewEdit(iv); setInterviewOpen(true); }}>
                          Feedback
                        </button>
                        <button className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm" title="Löschen" onClick={() => setDeleteInterview(iv)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notiz + Timeline */}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Verlauf & Notizen</div>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                <input
                  className="hm-input"
                  placeholder="Notiz hinzufügen …"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && note.trim() && addNote.mutate()}
                />
                <button className="hm-btn hm-btn--secondary" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                  <MessageSquarePlus size={15} /> Notiz
                </button>
              </div>
              <div className="stack" style={{ gap: 10 }}>
                {app.events.map((ev) => (
                  <div key={ev.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ marginTop: 4, width: 8, height: 8, borderRadius: '50%', background: 'var(--brand-primary)', flexShrink: 0 }} />
                    <div style={{ fontSize: 'var(--text-sm)' }}>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <strong>{APPLICATION_EVENT_LABELS[ev.kind] ?? ev.kind}</strong>
                        {ev.kind === 'stufenwechsel' && ev.from_stage_name && ev.to_stage_name && (
                          <span className="row" style={{ gap: 4, color: 'var(--text-muted)' }}>
                            {ev.from_stage_name} <ArrowRight size={12} /> {ev.to_stage_name}
                          </span>
                        )}
                      </div>
                      {ev.body && <div style={{ color: 'var(--text-secondary)' }}>{ev.body}</div>}
                      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                        {formatDate(ev.created_at.slice(0, 10))}{ev.user_name ? ` · ${ev.user_name}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {app && (
        <>
          <InterviewEditor open={interviewOpen} applicationId={app.id} interview={interviewEdit} onClose={() => setInterviewOpen(false)} />
          <RejectDialog open={rejectOpen} applicationId={app.id} onClose={() => setRejectOpen(false)} />
          <HireDialog open={hireOpen} application={app} onClose={() => setHireOpen(false)} />
          <ConfirmDialog
            open={deleteInterview !== null}
            title="Interview löschen"
            message="Soll dieses Interview endgültig gelöscht werden?"
            onConfirm={() => deleteInterview && removeInterview.mutate(deleteInterview.id)}
            onClose={() => setDeleteInterview(null)}
          />
        </>
      )}
    </>
  );
}

/** Kompakter Helfer: Bewerber:in-Herkunft und Ort in einer Zeile. */
export function CandidateMeta({ candidate }: { candidate: { city?: string | null; phone?: string | null; linkedin_url?: string | null } }) {
  return (
    <div className="row" style={{ gap: 12, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
      {candidate.city && <span className="row" style={{ gap: 4 }}><MapPin size={13} /> {candidate.city}</span>}
      {candidate.phone && <span className="row" style={{ gap: 4 }}><Phone size={13} /> {candidate.phone}</span>}
      {candidate.linkedin_url && (
        <a href={candidate.linkedin_url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4, color: 'var(--brand-primary)' }}>
          <ExternalLink size={13} /> Profil
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Neue Bewerbung (bestehende:r oder neue:r Bewerber:in)
// ---------------------------------------------------------------------------

const SOURCES = Object.keys(CANDIDATE_SOURCE_LABELS) as CandidateSource[];

export function NewApplicationModal({
  open,
  onClose,
  presetPostingId,
  presetCandidateId,
}: {
  open: boolean;
  onClose: () => void;
  presetPostingId?: number | null;
  presetCandidateId?: number | null;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: postings } = usePostings();
  const { data: candidates } = useCandidates();

  const [postingId, setPostingId] = useState<number | ''>('');
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [candidateId, setCandidateId] = useState<number | ''>('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [headline, setHeadline] = useState('');
  const [source, setSource] = useState<CandidateSource>('website');
  const [appliedAt, setAppliedAt] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [coverLetter, setCoverLetter] = useState('');

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setPostingId(presetPostingId ?? '');
      setMode(presetCandidateId ? 'existing' : 'new');
      setCandidateId(presetCandidateId ?? '');
      setFirstName(''); setLastName(''); setEmail(''); setPhone(''); setHeadline('');
      setSource('website');
      setAppliedAt(new Date().toISOString().slice(0, 10));
      setRating(null);
      setCoverLetter('');
    }
  }

  const create = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        posting_id: Number(postingId),
        applied_at: appliedAt,
        source,
        rating,
        cover_letter: coverLetter || null,
      };
      if (mode === 'existing') payload.candidate_id = Number(candidateId);
      else payload.candidate = { first_name: firstName, last_name: lastName, email: email || null, phone: phone || null, headline: headline || null, source };
      return api.post('/api/recruiting/applications', payload);
    },
    onSuccess: () => {
      toast.success('Bewerbung erfasst');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const valid =
    postingId !== '' &&
    (mode === 'existing' ? candidateId !== '' : firstName.trim() !== '' && lastName.trim() !== '');
  const openPostings = (postings ?? []).filter((p) => p.status !== 'geschlossen');

  return (
    <Modal
      title="Neue Bewerbung"
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>Abbrechen</button>
          <button className="hm-btn hm-btn--primary" disabled={create.isPending || !valid} onClick={() => create.mutate()}>
            {create.isPending ? 'Speichert …' : 'Bewerbung erfassen'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Stelle" required span2>
          <select className="hm-select" value={postingId} onChange={(e) => setPostingId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— Stelle wählen —</option>
            {openPostings.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </Field>

        <div className="span-2">
          <div className="hm-tabs" role="tablist">
            <button className={`hm-tab${mode === 'new' ? ' hm-tab--active' : ''}`} onClick={() => setMode('new')}>Neue:r Bewerber:in</button>
            <button className={`hm-tab${mode === 'existing' ? ' hm-tab--active' : ''}`} onClick={() => setMode('existing')}>Bestehende:r</button>
          </div>
        </div>

        {mode === 'existing' ? (
          <Field label="Bewerber:in" required span2>
            <select className="hm-select" value={candidateId} onChange={(e) => setCandidateId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">— auswählen —</option>
              {(candidates ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.last_name}, {c.first_name}{c.email ? ` · ${c.email}` : ''}</option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Vorname" required>
              <input className="hm-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
            <Field label="Nachname" required>
              <input className="hm-input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
            <Field label="E-Mail">
              <input className="hm-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Telefon">
              <input className="hm-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Kurzprofil / aktuelle Position" span2>
              <input className="hm-input" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="z. B. Backend-Entwickler bei ACME" />
            </Field>
          </>
        )}

        <Field label="Eingang am" required>
          <input className="hm-input" type="date" value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} />
        </Field>
        <Field label="Herkunftskanal">
          <select className="hm-select" value={source} onChange={(e) => setSource(e.target.value as CandidateSource)}>
            {SOURCES.map((s) => <option key={s} value={s}>{CANDIDATE_SOURCE_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field label="Erste Bewertung" span2>
          <RatingStars value={rating} onChange={setRating} size={20} />
        </Field>
        <Field label="Anschreiben / Notiz" span2>
          <textarea className="hm-textarea" rows={3} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export { parseEuroInput, centsToInput };
