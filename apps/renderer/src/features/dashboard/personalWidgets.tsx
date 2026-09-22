import React, { useState } from 'react';
import { BarChart3, Check, Megaphone, Paperclip } from 'lucide-react';
import { formatDate, formatDateTime, moduleEnabled, type MeAnnouncement, type MeSurvey } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { downloadSignedFile } from '../../api/client';
import { Card } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import {
  useAckAnnouncement,
  useMyAnnouncements,
  useMySurvey,
  useMySurveys,
  useSubmitSurvey,
} from '../communication/api';
import { SurveyAnswerForm, toAnswers, type AnswerDraft } from '../communication/SurveyAnswerForm';

/**
 * Persoenliche Hinweiskacheln des Dashboards: Ankuendigungen und Umfragen, die
 * sich an die angemeldete Person richten (Zielgruppe im Backend aufgeloest:
 * alle, Abteilung samt Unterabteilungen, Team, Standort, Verteiler).
 *
 * Bewusst KEINE konfigurierbaren Widgets: Sie stehen nicht in WIDGET_DEFS,
 * lassen sich nicht abwaehlen und erscheinen nur, solange es etwas gibt.
 * Ohne Eintraege (oder ohne verknuepftes Personalprofil, 403) rendert
 * PersonalNotices nichts, also auch keinen leeren Rahmen und keinen Abstand.
 * Die HR-Sicht auf alle Ankuendigungen bleibt das Widget „Aktive
 * Ankuendigungen“.
 */

function shortBody(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ------------------------------------------------------------- Ankuendigungen

function AnnouncementDialog({ announcement, onClose }: { announcement: MeAnnouncement | null; onClose: () => void }) {
  const toast = useToast();
  const ack = useAckAnnouncement();
  const a = announcement;
  return (
    <Modal
      title={a?.title ?? ''}
      open={a !== null}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Schließen
          </button>
          {a?.requires_ack && a.acked_at === null && (
            <button
              className="hm-btn hm-btn--primary"
              disabled={ack.isPending}
              onClick={() =>
                ack.mutate(a.id, {
                  onSuccess: () => {
                    toast.success('Lesebestätigung gespeichert');
                    onClose();
                  },
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              <Check size={15} /> Gelesen bestätigen
            </button>
          )}
        </>
      }
    >
      {a && (
        <div className="stack" style={{ gap: 14 }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Veröffentlicht am {formatDate(a.publish_at)}
            {a.expires_at ? ` · gültig bis ${formatDate(a.expires_at)}` : ''}
            {a.requires_ack && a.acked_at ? ` · bestätigt am ${formatDateTime(a.acked_at)}` : ''}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{a.body}</div>
          {a.attachments.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="hm-field__label">Anhänge</div>
              {/* Signiert erst beim Klick ueber die Self-Service-Route (prueft die
                  Zielgruppe, nicht den Bereich personal): eine vorab signierte URL
                  waere nach 60 Sekunden tot und unter file:// ohnehin nicht erreichbar. */}
              {a.attachments.map((f) => (
                <button
                  key={f.file_id}
                  type="button"
                  className="hm-btn hm-btn--secondary hm-btn--sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() =>
                    downloadSignedFile(`/api/me/announcements/${a.id}/attachments/${f.file_id}/sign`).catch(
                      (e: Error) => toast.error(e.message),
                    )
                  }
                >
                  <Paperclip size={13} /> {f.original_name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function MyAnnouncementsCard({ items }: { items: MeAnnouncement[] }) {
  const [open, setOpen] = useState<MeAnnouncement | null>(null);
  const pending = items.filter((a) => a.requires_ack && a.acked_at === null).length;
  return (
    <div className="hm-widget" style={{ '--hm-accent': 'var(--org-5)' } as React.CSSProperties}>
      <Card
        title={
          <span className="row" style={{ gap: 10 }}>
            <span className="hm-widget__icon"><Megaphone size={15} /></span>
            Ankündigungen für Sie
          </span>
        }
        actions={pending > 0 ? <span className="hm-dash-row__chip">{pending} zu bestätigen</span> : undefined}
      >
        <div className="hm-dash-list">
          {items.map((a) => (
            <button key={a.id} type="button" className="hm-dash-row hm-dash-row--button" onClick={() => setOpen(a)}>
              <span className="hm-dash-row__avatar" aria-hidden="true"><Megaphone size={14} /></span>
              <span className="hm-dash-row__main">
                <span className="hm-dash-row__title">{a.title}</span>
                <span className="hm-dash-row__meta">{shortBody(a.body)}</span>
              </span>
              {a.requires_ack && (
                <span className={`hm-dash-row__chip${a.acked_at ? ' hm-dash-row__chip--muted' : ''}`}>
                  {a.acked_at ? 'Bestätigt' : 'Bestätigung offen'}
                </span>
              )}
            </button>
          ))}
        </div>
      </Card>
      <AnnouncementDialog announcement={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ------------------------------------------------------------------- Umfragen

function SurveyDialog({ surveyId, onClose }: { surveyId: number | null; onClose: () => void }) {
  const toast = useToast();
  const { data: survey } = useMySurvey(surveyId);
  const submit = useSubmitSurvey();
  const [draft, setDraft] = useState<AnswerDraft>({});
  const [draftFor, setDraftFor] = useState<number | null>(null);
  if (surveyId !== draftFor) {
    setDraft({});
    setDraftFor(surveyId);
  }
  const answers = toAnswers(draft);
  return (
    <Modal
      title={survey?.title ?? 'Umfrage'}
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
            disabled={submit.isPending || answers.length === 0 || surveyId === null}
            onClick={() =>
              surveyId !== null &&
              submit.mutate(
                { id: surveyId, answers },
                {
                  onSuccess: () => {
                    toast.success('Vielen Dank, Ihre Antworten wurden anonym gespeichert');
                    onClose();
                  },
                  onError: (e) => toast.error(e.message),
                },
              )
            }
          >
            Antworten senden
          </button>
        </>
      }
    >
      {survey && (
        <div className="stack" style={{ gap: 16 }}>
          {survey.description && (
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{survey.description}</p>
          )}
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Läuft bis {formatDate(survey.date_to)}. Die Antworten werden ohne Personenbezug gespeichert; nur die
            Teilnahme selbst wird vermerkt, damit niemand doppelt zählt.
          </p>
          <SurveyAnswerForm questions={survey.questions} draft={draft} onChange={setDraft} disabled={submit.isPending} />
        </div>
      )}
    </Modal>
  );
}

function MySurveysCard({ items }: { items: MeSurvey[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <div className="hm-widget" style={{ '--hm-accent': 'var(--org-2)' } as React.CSSProperties}>
      <Card
        title={
          <span className="row" style={{ gap: 10 }}>
            <span className="hm-widget__icon"><BarChart3 size={15} /></span>
            Ihre Meinung ist gefragt
          </span>
        }
      >
        <div className="hm-dash-list">
          {items.map((s) => (
            <button key={s.id} type="button" className="hm-dash-row hm-dash-row--button" onClick={() => setOpenId(s.id)}>
              <span className="hm-dash-row__avatar" aria-hidden="true"><BarChart3 size={14} /></span>
              <span className="hm-dash-row__main">
                <span className="hm-dash-row__title">{s.title}</span>
                {s.description && <span className="hm-dash-row__meta">{shortBody(s.description)}</span>}
              </span>
              <span className="hm-dash-row__chip">bis {formatDate(s.date_to)}</span>
            </button>
          ))}
        </div>
      </Card>
      <SurveyDialog surveyId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

/**
 * Beide Kacheln in einem eigenen Raster oberhalb der Widgets. Die Daten
 * werden HIER geladen, damit ohne Inhalt gar nichts gerendert wird, auch
 * kein leeres Raster und kein Abstand. Ohne Modul Kommunikation in der
 * Variante bleiben die Abfragen aus (die Routen gibt es dann nicht).
 */
export function PersonalNotices() {
  const enabled = moduleEnabled(VARIANT, 'communication');
  const { data: announcements } = useMyAnnouncements(enabled);
  const { data: surveys } = useMySurveys(enabled);
  const items = announcements ?? [];
  const open = (surveys ?? []).filter((s) => !s.participated);
  if (items.length === 0 && open.length === 0) return null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 16,
        alignItems: 'start',
        marginBottom: 16,
      }}
    >
      {open.length > 0 && <MySurveysCard items={open} />}
      {items.length > 0 && <MyAnnouncementsCard items={items} />}
    </div>
  );
}
