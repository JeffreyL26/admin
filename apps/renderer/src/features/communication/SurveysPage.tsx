import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  FlaskConical,
  Lock,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  MIN_PARTICIPANTS_NOT_REACHED,
  SURVEY_QUESTION_KIND_LABELS,
  SURVEY_STATUS_LABELS,
  formatDate,
  type SurveyQuestionKind,
  type SurveyStatus,
} from '@hrmonic/shared';
import { ApiRequestError, api } from '../../api/client';
import { Badge, EmptyState, Field, PageHeader, Spinner, type BadgeTone } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { AudienceSelect, audienceLabel, type AudienceValue } from './AudienceSelect';
import { useInvalidate, useSurvey, useSurveys, type Survey, type SurveyResults } from './api';

const STATUS_TONE: Record<SurveyStatus, BadgeTone> = {
  entwurf: 'neutral',
  laufend: 'green',
  beendet: 'blue',
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface DraftQuestion {
  kind: SurveyQuestionKind;
  text: string;
  options: string;
  scale_max: number;
}

interface DraftSurvey {
  title: string;
  description: string;
  audience: AudienceValue;
  date_from: string;
  date_to: string;
  min_participants: string;
  questions: DraftQuestion[];
}

const emptyDraft = (): DraftSurvey => ({
  title: '',
  description: '',
  audience: { audience_type: 'alle', audience_id: null },
  date_from: new Date().toISOString().slice(0, 10),
  date_to: new Date().toISOString().slice(0, 10),
  min_participants: '',
  questions: [{ kind: 'skala', text: '', options: '', scale_max: 5 }],
});

function SurveyBuilder({
  open,
  initial,
  editId,
  onClose,
}: {
  open: boolean;
  initial: DraftSurvey;
  editId: number | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<DraftSurvey>(initial);

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setForm(initial);
  }

  const setQuestion = (i: number, patch: Partial<DraftQuestion>) =>
    setForm((f) => ({
      ...f,
      questions: f.questions.map((q, idx) => (idx === i ? { ...q, ...patch } : q)),
    }));

  const moveQuestion = (i: number, delta: -1 | 1) =>
    setForm((f) => {
      const qs = [...f.questions];
      const j = i + delta;
      if (j < 0 || j >= qs.length) return f;
      [qs[i], qs[j]] = [qs[j], qs[i]];
      return { ...f, questions: qs };
    });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title: form.title,
        description: form.description || null,
        audience_type: form.audience.audience_type,
        audience_id: form.audience.audience_id,
        date_from: form.date_from,
        date_to: form.date_to,
        min_participants: form.min_participants === '' ? null : Number(form.min_participants),
        questions: form.questions.map((q) => ({
          kind: q.kind,
          text: q.text,
          options:
            q.kind === 'einfachauswahl' || q.kind === 'mehrfachauswahl'
              ? q.options
                  .split('\n')
                  .map((o) => o.trim())
                  .filter(Boolean)
              : null,
          scale_max: q.kind === 'skala' ? q.scale_max : null,
        })),
      };
      return editId === null
        ? api.post('/api/communication/surveys', payload)
        : api.put(`/api/communication/surveys/${editId}`, payload);
    },
    onSuccess: () => {
      toast.success(editId === null ? 'Umfrage angelegt' : 'Umfrage aktualisiert');
      invalidate('surveys');
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal
      title={editId === null ? 'Neue Umfrage' : 'Umfrage bearbeiten'}
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="hm-btn hm-btn--primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Speichert …' : 'Als Entwurf speichern'}
          </button>
        </>
      }
    >
      <div className="hm-form-grid" style={{ marginBottom: 16 }}>
        <Field label="Titel" required span2>
          <input
            className="hm-input"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="z. B. Mitarbeiterzufriedenheit Q3"
          />
        </Field>
        <Field label="Beschreibung" span2>
          <textarea
            className="hm-textarea"
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </Field>
        <AudienceSelect value={form.audience} onChange={(audience) => setForm((f) => ({ ...f, audience }))} />
        <Field label="Zeitraum von" required>
          <input
            type="date"
            className="hm-input"
            value={form.date_from}
            onChange={(e) => setForm((f) => ({ ...f, date_from: e.target.value }))}
          />
        </Field>
        <Field label="Zeitraum bis" required>
          <input
            type="date"
            className="hm-input"
            value={form.date_to}
            onChange={(e) => setForm((f) => ({ ...f, date_to: e.target.value }))}
          />
        </Field>
        <Field
          label="Mindestteilnehmerzahl"
          hint="Leer = Standardwert aus den Einstellungen. Ergebnisse erst ab dieser Zahl sichtbar."
        >
          <input
            type="number"
            min={1}
            className="hm-input"
            value={form.min_participants}
            onChange={(e) => setForm((f) => ({ ...f, min_participants: e.target.value }))}
          />
        </Field>
      </div>

      <div style={{ fontWeight: 650, marginBottom: 10 }}>Fragen</div>
      <div className="stack" style={{ gap: 12 }}>
        {form.questions.map((q, i) => (
          <div
            key={i}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: 14,
            }}
          >
            <div className="row row--between" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>
                Frage {i + 1}
              </span>
              <div className="row" style={{ gap: 2 }}>
                <button
                  className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                  title="Nach oben"
                  disabled={i === 0}
                  onClick={() => moveQuestion(i, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                  title="Nach unten"
                  disabled={i === form.questions.length - 1}
                  onClick={() => moveQuestion(i, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                  title="Frage entfernen"
                  disabled={form.questions.length === 1}
                  onClick={() =>
                    setForm((f) => ({ ...f, questions: f.questions.filter((_, idx) => idx !== i) }))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div className="hm-form-grid">
              <Field label="Fragetyp">
                <select
                  className="hm-select"
                  value={q.kind}
                  onChange={(e) => setQuestion(i, { kind: e.target.value as SurveyQuestionKind })}
                >
                  {(Object.keys(SURVEY_QUESTION_KIND_LABELS) as SurveyQuestionKind[]).map((k) => (
                    <option key={k} value={k}>
                      {SURVEY_QUESTION_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Fragetext" required>
                <input
                  className="hm-input"
                  value={q.text}
                  onChange={(e) => setQuestion(i, { text: e.target.value })}
                />
              </Field>
              {q.kind === 'skala' && (
                <Field label="Skala bis" hint="Bewertung von 1 bis N">
                  <select
                    className="hm-select"
                    value={q.scale_max}
                    onChange={(e) => setQuestion(i, { scale_max: Number(e.target.value) })}
                  >
                    {[3, 4, 5, 6, 7, 10].map((n) => (
                      <option key={n} value={n}>
                        1–{n}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(q.kind === 'einfachauswahl' || q.kind === 'mehrfachauswahl') && (
                <Field label="Optionen" hint="Eine Option pro Zeile (mindestens zwei)" span2>
                  <textarea
                    className="hm-textarea"
                    rows={3}
                    value={q.options}
                    onChange={(e) => setQuestion(i, { options: e.target.value })}
                  />
                </Field>
              )}
            </div>
          </div>
        ))}
        <div>
          <button
            className="hm-btn hm-btn--secondary hm-btn--sm"
            onClick={() =>
              setForm((f) => ({
                ...f,
                questions: [...f.questions, { kind: 'skala', text: '', options: '', scale_max: 5 }],
              }))
            }
          >
            <Plus size={14} /> Frage hinzufügen
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Test-Antwort-Dialog (Demo; produktiv antwortet später der Web-Client)
// ---------------------------------------------------------------------------

function TestResponseDialog({ surveyId, onClose }: { surveyId: number | null; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: survey } = useSurvey(surveyId);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<number, string | number | string[]>>({});

  const [lastId, setLastId] = useState<number | null>(null);
  if (surveyId !== lastId) {
    setLastId(surveyId);
    setEmployeeId(null);
    setAnswers({});
  }

  const submit = useMutation({
    mutationFn: () =>
      api.post(`/api/communication/surveys/${surveyId}/responses`, {
        employee_id: employeeId,
        answers: Object.entries(answers)
          .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== '' && v !== undefined))
          .map(([question_id, value]) => ({ question_id: Number(question_id), value })),
      }),
    onSuccess: () => {
      toast.success('Antwort erfasst — anonym gespeichert');
      invalidate('surveys');
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal
      title="Test-Antwort erfassen"
      open={surveyId !== null}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={submit.isPending || employeeId === null}
            onClick={() => submit.mutate()}
          >
            Antwort senden
          </button>
        </>
      }
    >
      {!survey ? (
        <Spinner center />
      ) : (
        <div className="stack">
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
            Zum Durchspielen der Umfrage. Die Teilnahme wird pro Person nur einmal gezählt; die
            Antworten werden ohne Personenbezug gespeichert.
          </p>
          <Field label="Teilnehmer:in (nur für Teilnahme-Marker)" required>
            <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
          </Field>
          {survey.questions.map((q) => (
            <Field key={q.id} label={q.text} hint={SURVEY_QUESTION_KIND_LABELS[q.kind]}>
              {q.kind === 'skala' ? (
                <select
                  className="hm-select"
                  value={(answers[q.id] as number | undefined) ?? ''}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, [q.id]: e.target.value === '' ? '' : Number(e.target.value) }))
                  }
                >
                  <option value="">— keine Angabe —</option>
                  {Array.from({ length: q.scale_max ?? 5 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : q.kind === 'einfachauswahl' ? (
                <select
                  className="hm-select"
                  value={(answers[q.id] as string | undefined) ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                >
                  <option value="">— keine Angabe —</option>
                  {(q.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : q.kind === 'mehrfachauswahl' ? (
                <div className="row row--wrap" style={{ gap: 12 }}>
                  {(q.options ?? []).map((o) => {
                    const selected = ((answers[q.id] as string[] | undefined) ?? []).includes(o);
                    return (
                      <label key={o} className="hm-checkbox">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(e) => {
                            const prev = (answers[q.id] as string[] | undefined) ?? [];
                            setAnswers((a) => ({
                              ...a,
                              [q.id]: e.target.checked ? [...prev, o] : prev.filter((x) => x !== o),
                            }));
                          }}
                        />
                        {o}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  className="hm-textarea"
                  rows={2}
                  value={(answers[q.id] as string | undefined) ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Ergebnisse
// ---------------------------------------------------------------------------

function ResultsDialog({ survey, onClose }: { survey: Survey | null; onClose: () => void }) {
  const [results, setResults] = useState<SurveyResults | null>(null);
  const [lockInfo, setLockInfo] = useState<{ required: number; current: number; missing: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const [lastId, setLastId] = useState<number | null>(null);
  if ((survey?.id ?? null) !== lastId) {
    setLastId(survey?.id ?? null);
    setResults(null);
    setLockInfo(null);
    if (survey) {
      setLoading(true);
      api
        .get<{ results: SurveyResults }>(`/api/communication/surveys/${survey.id}/results`)
        .then((d) => setResults(d.results))
        .catch((e: unknown) => {
          if (e instanceof ApiRequestError && e.code === MIN_PARTICIPANTS_NOT_REACHED) {
            setLockInfo(e.details as { required: number; current: number; missing: number });
          }
        })
        .finally(() => setLoading(false));
    }
  }

  return (
    <Modal title={`Ergebnisse: ${survey?.title ?? ''}`} open={survey !== null} onClose={onClose} wide>
      {loading ? (
        <Spinner center />
      ) : lockInfo ? (
        <EmptyState
          icon={<Lock size={40} />}
          title={`Ergebnisse werden ab ${lockInfo.required} Teilnahmen angezeigt`}
          hint={`Bisher ${lockInfo.current} ${lockInfo.current === 1 ? 'Teilnahme' : 'Teilnahmen'} — es ${lockInfo.missing === 1 ? 'fehlt noch 1 Teilnahme' : `fehlen noch ${lockInfo.missing} Teilnahmen`}. Zum Schutz der Anonymität werden vorher keine Teilergebnisse angezeigt.`}
        />
      ) : results ? (
        <div className="stack" style={{ gap: 20 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {results.response_count} Teilnahmen · anonym ausgewertet
          </div>
          {results.questions.map((q) => (
            <div key={q.id}>
              <div style={{ fontWeight: 650, marginBottom: 8 }}>{q.text}</div>
              {q.kind === 'skala' && (
                <>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Durchschnitt: <strong>{q.average ?? '—'}</strong> von {q.scale_max}
                  </div>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={q.distribution}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="value" tick={{ fontSize: 12 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="count" name="Antworten" fill="var(--brand-primary)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </>
              )}
              {(q.kind === 'einfachauswahl' || q.kind === 'mehrfachauswahl') && (
                <ResponsiveContainer width="100%" height={Math.max(120, (q.frequencies?.length ?? 0) * 44)}>
                  <BarChart data={q.frequencies} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                    <YAxis type="category" dataKey="option" width={140} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="count" name="Antworten" fill="var(--brand-primary)" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              {q.kind === 'freitext' &&
                ((q.texts?.length ?? 0) === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                    Keine Freitextantworten.
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 6 }}>
                    {q.texts!.map((t, i) => (
                      <div
                        key={i}
                        style={{
                          background: 'var(--gray-50)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '8px 12px',
                          fontSize: 'var(--text-sm)',
                        }}
                      >
                        {t}
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function SurveysPage() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { data: surveys, isLoading } = useSurveys();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderInitial, setBuilderInitial] = useState<DraftSurvey>(emptyDraft());
  const [editId, setEditId] = useState<number | null>(null);
  const [testSurveyId, setTestSurveyId] = useState<number | null>(null);
  const [resultsSurvey, setResultsSurvey] = useState<Survey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Survey | null>(null);

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'laufend' | 'beendet' }) =>
      api.post(`/api/communication/surveys/${id}/status`, { status }),
    onSuccess: (_, vars) => {
      toast.success(vars.status === 'laufend' ? 'Umfrage gestartet' : 'Umfrage beendet');
      invalidate('surveys');
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/communication/surveys/${id}`),
    onSuccess: () => {
      toast.success('Umfrage gelöscht');
      invalidate('surveys');
    },
    onError: (e) => toast.error(e.message),
  });

  const openEdit = async (s: Survey) => {
    const detail = await api.get<{
      survey: Survey & { questions: { kind: SurveyQuestionKind; text: string; options: string[] | null; scale_max: number | null }[] };
    }>(`/api/communication/surveys/${s.id}`);
    setBuilderInitial({
      title: detail.survey.title,
      description: detail.survey.description ?? '',
      audience: { audience_type: detail.survey.audience_type, audience_id: detail.survey.audience_id },
      date_from: detail.survey.date_from,
      date_to: detail.survey.date_to,
      min_participants: detail.survey.min_participants?.toString() ?? '',
      questions: detail.survey.questions.map((q) => ({
        kind: q.kind,
        text: q.text,
        options: (q.options ?? []).join('\n'),
        scale_max: q.scale_max ?? 5,
      })),
    });
    setEditId(s.id);
    setBuilderOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Umfragen"
        subtitle="Anonyme Mitarbeiterbefragungen mit Mindestteilnehmerschutz"
        actions={
          <button
            className="hm-btn hm-btn--primary"
            onClick={() => {
              setBuilderInitial(emptyDraft());
              setEditId(null);
              setBuilderOpen(true);
            }}
          >
            <Plus size={16} /> Neue Umfrage
          </button>
        }
      />

      {isLoading ? (
        <Spinner center />
      ) : (surveys?.length ?? 0) === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<BarChart3 size={40} />}
            title="Noch keine Umfragen"
            hint="Erstellen Sie die erste anonyme Mitarbeiterbefragung."
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
                    <th>Zeitraum</th>
                    <th>Teilnahme</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {surveys!.map((s) => {
                    const pct = s.recipients > 0 ? Math.round((s.participant_count / s.recipients) * 100) : 0;
                    return (
                      <tr key={s.id}>
                        <td style={{ fontWeight: 600 }}>{s.title}</td>
                        <td>
                          <Badge tone={STATUS_TONE[s.status]}>{SURVEY_STATUS_LABELS[s.status]}</Badge>
                        </td>
                        <td>{audienceLabel(s)}</td>
                        <td>
                          {formatDate(s.date_from)} – {formatDate(s.date_to)}
                        </td>
                        <td>
                          {s.participant_count}/{s.recipients} ({pct} %)
                        </td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                            {s.status === 'entwurf' && (
                              <>
                                <button
                                  className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                                  title="Bearbeiten"
                                  onClick={() => openEdit(s)}
                                >
                                  <Pencil size={15} />
                                </button>
                                <button
                                  className="hm-btn hm-btn--secondary hm-btn--sm"
                                  title="Umfrage starten"
                                  onClick={() => changeStatus.mutate({ id: s.id, status: 'laufend' })}
                                >
                                  <Play size={14} /> Starten
                                </button>
                                <button
                                  className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
                                  title="Löschen"
                                  onClick={() => setDeleteTarget(s)}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </>
                            )}
                            {s.status === 'laufend' && (
                              <>
                                <button
                                  className="hm-btn hm-btn--ghost hm-btn--sm"
                                  title="Test-Antwort erfassen"
                                  onClick={() => setTestSurveyId(s.id)}
                                >
                                  <FlaskConical size={14} /> Testen
                                </button>
                                <button
                                  className="hm-btn hm-btn--secondary hm-btn--sm"
                                  title="Umfrage beenden"
                                  onClick={() => changeStatus.mutate({ id: s.id, status: 'beendet' })}
                                >
                                  <Square size={13} /> Beenden
                                </button>
                              </>
                            )}
                            {s.status !== 'entwurf' && (
                              <button
                                className="hm-btn hm-btn--ghost hm-btn--sm"
                                title="Ergebnisse ansehen"
                                onClick={() => setResultsSurvey(s)}
                              >
                                <BarChart3 size={14} /> Ergebnisse
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <SurveyBuilder open={builderOpen} initial={builderInitial} editId={editId} onClose={() => setBuilderOpen(false)} />
      <TestResponseDialog surveyId={testSurveyId} onClose={() => setTestSurveyId(null)} />
      <ResultsDialog survey={resultsSurvey} onClose={() => setResultsSurvey(null)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Umfrage löschen"
        message={`Soll der Entwurf „${deleteTarget?.title}“ endgültig gelöscht werden?`}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
