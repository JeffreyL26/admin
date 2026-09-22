import { useState } from 'react';
import { moduleEnabled, type MeAnnouncement, type MeSurvey, type MeSurveyQuestion, type SurveyAnswer, type SurveyAnswerValue } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { downloadFile } from '../../api/client';
import {
  useAckAnnouncement,
  useMyAnnouncements,
  useMySurvey,
  useMySurveys,
  useSubmitSurvey,
} from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { Card, SkeletonRows } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDate } from '../../lib/format';

/**
 * Hinweiskarten der Uebersicht: Ankuendigungen und Umfragen, die sich an die
 * angemeldete Person richten (Zielgruppe im Backend aufgeloest: alle,
 * Abteilung samt Unterabteilungen, Team, Standort, Verteiler).
 *
 * Keine feste Kachel: NoticeSection laedt beide Listen und rendert ohne
 * Eintraege NICHTS, also auch keinen leeren Rahmen, keinen Abstand und keinen
 * Text wie „keine Ankuendigungen“. Eine Umfrage verschwindet nach der
 * Teilnahme; eine Ankuendigung bleibt, bis sie ablaeuft, und zeigt ihre
 * Lesebestaetigung.
 */

// ---------------------------------------------------------------- Ankuendigungen

function AnnouncementItem({ announcement: a }: { announcement: MeAnnouncement }) {
  const toast = useToast();
  const { readOnly } = useAuth();
  const ack = useAckAnnouncement();
  const [expanded, setExpanded] = useState(false);
  const long = a.body.length > 220 || a.body.includes('\n');
  const body = expanded || !long ? a.body : `${a.body.replace(/\s+/g, ' ').slice(0, 200).trim()}…`;

  return (
    <div style={{ padding: '16px 22px', borderTop: '1px solid var(--gray-100)' }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ fontWeight: 650 }}>{a.title}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
            {formatDate(a.publish_at)}
            {a.expires_at ? ` · gültig bis ${formatDate(a.expires_at)}` : ''}
          </p>
        </div>
        {a.requires_ack && (
          <span className={`pt-chip ${a.acked_at ? 'pt-chip--success' : 'pt-chip--warning'}`}>
            {a.acked_at ? 'Bestätigt' : 'Bestätigung offen'}
          </span>
        )}
      </div>
      <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: 10, fontSize: 'var(--text-sm)' }}>{body}</p>
      {a.attachments.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {/* Signiert erst beim Klick (wie Dokumente): Die Signatur gilt 60 Sekunden,
              die Karte liegt laenger offen, und der Link muss zur API-Basis zeigen. */}
          {a.attachments.map((f) => (
            <button
              key={f.file_id}
              type="button"
              className="pt-btn pt-btn--secondary pt-btn--sm"
              onClick={() =>
                downloadFile(`/api/me/announcements/${a.id}/attachments/${f.file_id}/sign`).catch((e: Error) =>
                  toast.error(e.message),
                )
              }
            >
              {f.original_name}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {long && (
          <button type="button" className="pt-btn pt-btn--quiet pt-btn--sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Weniger anzeigen' : 'Ganz lesen'}
          </button>
        )}
        {a.requires_ack && a.acked_at === null && (
          <button
            type="button"
            className="pt-btn pt-btn--primary pt-btn--sm"
            disabled={ack.isPending || readOnly}
            onClick={() =>
              ack.mutate(a.id, {
                onSuccess: () => toast.success('Lesebestätigung gespeichert'),
                onError: (e) => toast.error(e.message),
              })
            }
          >
            Gelesen bestätigen
          </button>
        )}
      </div>
    </div>
  );
}

function AnnouncementsCard({ items }: { items: MeAnnouncement[] }) {
  const pending = items.filter((a) => a.requires_ack && a.acked_at === null).length;
  return (
    <Card
      title="Ankündigungen für Sie"
      flush
      accent="--org-5"
      actions={pending > 0 ? <span className="pt-chip pt-chip--warning">{pending} zu bestätigen</span> : undefined}
    >
      <div style={{ marginTop: -1 }}>
        {items.map((a) => (
          <AnnouncementItem key={a.id} announcement={a} />
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------- Umfragen

type Draft = Record<number, SurveyAnswerValue | undefined>;

function toAnswers(draft: Draft): SurveyAnswer[] {
  return Object.entries(draft)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([question_id, value]) => ({ question_id: Number(question_id), value: value as SurveyAnswerValue }));
}

function Question({
  question: q,
  index,
  value,
  onChange,
  disabled,
}: {
  question: MeSurveyQuestion;
  index: number;
  value: SurveyAnswerValue | undefined;
  onChange: (v: SurveyAnswerValue | undefined) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <p style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 8 }}>
        {index + 1}. {q.text}
      </p>
      {q.kind === 'skala' ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }} role="radiogroup" aria-label={q.text}>
          {Array.from({ length: q.scale_max ?? 5 }, (_, i) => i + 1).map((n) => {
            const active = value === n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className={`pt-btn pt-btn--sm ${active ? 'pt-btn--primary' : 'pt-btn--secondary'}`}
                style={{ minWidth: 40, justifyContent: 'center' }}
                onClick={() => onChange(active ? undefined : n)}
              >
                {n}
              </button>
            );
          })}
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 6 }}>
            1 = niedrig, {q.scale_max ?? 5} = hoch
          </span>
        </div>
      ) : q.kind === 'einfachauswahl' ? (
        <div className="stack" style={{ gap: 6 }}>
          {(q.options ?? []).map((o) => (
            <label key={o} className="pt-check">
              <input type="radio" name={`q-${q.id}`} disabled={disabled} checked={value === o} onChange={() => onChange(o)} />
              {o}
            </label>
          ))}
        </div>
      ) : q.kind === 'mehrfachauswahl' ? (
        <div className="stack" style={{ gap: 6 }}>
          {(q.options ?? []).map((o) => {
            const prev = (value as string[] | undefined) ?? [];
            const selected = prev.includes(o);
            return (
              <label key={o} className="pt-check">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected}
                  onChange={(e) => onChange(e.target.checked ? [...prev, o] : prev.filter((x) => x !== o))}
                />
                {o}
              </label>
            );
          })}
        </div>
      ) : (
        <textarea
          className="pt-textarea"
          rows={3}
          disabled={disabled}
          aria-label={q.text}
          value={(value as string | undefined) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function SurveyForm({ surveyId, onDone }: { surveyId: number; onDone: () => void }) {
  const toast = useToast();
  const { readOnly } = useAuth();
  const { data: survey, isLoading } = useMySurvey(surveyId);
  const submit = useSubmitSurvey();
  const [draft, setDraft] = useState<Draft>({});
  const answers = toAnswers(draft);

  if (isLoading || !survey) return <SkeletonRows rows={3} />;

  return (
    <div className="stack" style={{ gap: 18 }}>
      {survey.description && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{survey.description}</p>
      )}
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        Läuft bis {formatDate(survey.date_to)}. Ihre Antworten werden ohne Personenbezug gespeichert; nur die
        Teilnahme selbst wird vermerkt, damit niemand doppelt zählt.
      </p>
      {survey.questions.map((q, i) => (
        <Question
          key={q.id}
          question={q}
          index={i}
          value={draft[q.id]}
          onChange={(v) => setDraft((d) => ({ ...d, [q.id]: v }))}
          disabled={submit.isPending}
        />
      ))}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="pt-btn pt-btn--primary"
          disabled={submit.isPending || answers.length === 0 || readOnly}
          onClick={() =>
            submit.mutate(
              { id: surveyId, answers },
              {
                onSuccess: () => {
                  toast.success('Vielen Dank, Ihre Antworten wurden anonym gespeichert');
                  onDone();
                },
                onError: (e) => toast.error(e.message),
              },
            )
          }
        >
          Antworten senden
        </button>
        <button type="button" className="pt-btn pt-btn--quiet" onClick={onDone}>
          Später
        </button>
      </div>
    </div>
  );
}

function SurveyItem({ survey: s }: { survey: MeSurvey }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: '16px 22px', borderTop: '1px solid var(--gray-100)' }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ fontWeight: 650 }}>{s.title}</p>
          {!open && s.description && (
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: 2 }}>{s.description}</p>
          )}
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
            Teilnahme bis {formatDate(s.date_to)}
          </p>
        </div>
        {!open && (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--sm" onClick={() => setOpen(true)}>
            Teilnehmen
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 14 }}>
          <SurveyForm surveyId={s.id} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function SurveysCard({ items }: { items: MeSurvey[] }) {
  return (
    <Card title="Ihre Meinung ist gefragt" flush accent="--org-2">
      <div style={{ marginTop: -1 }}>
        {items.map((s) => (
          <SurveyItem key={s.id} survey={s} />
        ))}
      </div>
    </Card>
  );
}

/**
 * Abschnitt der Uebersicht. Laedt beide Listen und rendert nur mit Inhalt,
 * damit der Abstand zum Raster darunter nicht als leerer Block stehen
 * bleibt. Ohne Modul Kommunikation in der Variante keine Abfragen.
 */
export function NoticeSection() {
  const enabled = moduleEnabled(VARIANT, 'communication');
  const { data: announcements } = useMyAnnouncements(enabled);
  const { data: surveys } = useMySurveys(enabled);
  const items = announcements ?? [];
  const open = (surveys ?? []).filter((s) => !s.participated);
  if (items.length === 0 && open.length === 0) return null;
  return (
    <div className="stack" style={{ marginBottom: 20 }}>
      {open.length > 0 && <SurveysCard items={open} />}
      {items.length > 0 && <AnnouncementsCard items={items} />}
    </div>
  );
}
