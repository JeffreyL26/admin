import React from 'react';
import { History, MessageSquare } from 'lucide-react';
import {
  formatDateTime,
  type Rating,
  type RatingHistoryEntry,
  type RatingPeriodKind,
} from '@ohrganize/shared';
import { Badge, EmptyState, Spinner } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useRatingDetail } from './api';
import { RatingValue, ScoreBadge } from './RatingInput';
import { PeriodText, TeamNotice } from './TeamShared';

/**
 * Detail-Pop-up des Satisfaction-Reports: Klick auf ein bereits bewertetes
 * Quartal in der aufgeklappten Tabelle schlüsselt die Bewertung auf —
 * Gesamtbewertung zuerst, darunter jede weitere bewertete Kategorie
 * (Leistung, Verhalten …) mit ihrem Kommentar.
 *
 * Bewusst ein Dialog im Fenster (components/Modal, Portal an <body>) und kein
 * neues Fenster: Der Report bleibt im Hintergrund stehen, Escape schließt.
 * Die Daten kommen erst beim Öffnen
 * (`GET /api/leadership/leaders/:employeeId/employees/:memberId/ratings`) —
 * die Tabelle darüber trägt bewusst keine Kommentartexte.
 */
export function ReportRatingDialog({
  leaderId,
  memberId,
  periodKey,
  kind,
  onClose,
}: {
  leaderId: number;
  memberId: number;
  periodKey: string;
  /** Eingestellte Kadenz — beschriftet Zeiträume aus dem Protokoll korrekt. */
  kind: RatingPeriodKind;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useRatingDetail(leaderId, memberId, periodKey);
  const employeeName = data ? `${data.employee.first_name} ${data.employee.last_name}` : 'Bewertung';
  const leaderName = data?.leader ? `${data.leader.first_name} ${data.leader.last_name}` : '(gelöschte Führungskraft)';
  // Nur Korrekturen sind erzählenswert: Bei genau einer Version je Kategorie
  // wiederholte das Protokoll bloß, was oben schon steht.
  const corrections = (data?.history ?? []).filter((h) => h.change_kind === 'geaendert');

  return (
    <Modal
      title={
        <span className="lead-detail__title">
          {employeeName}
          {data && <span className="lead-detail__period">{data.period.label}</span>}
        </span>
      }
      open
      onClose={onClose}
      wide
      footer={
        <button type="button" className="hm-btn hm-btn--secondary" onClick={onClose}>
          Schließen
        </button>
      }
    >
      {isLoading ? (
        <Spinner center />
      ) : error || !data ? (
        <EmptyState
          title="Bewertung konnte nicht geladen werden"
          hint={error instanceof Error ? error.message : 'Bitte versuchen Sie es später erneut.'}
        />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="lead-detail__meta">
            <span>
              Bewertet von <strong>{leaderName}</strong>
            </span>
            <span>
              {data.employee.personnel_number ? `Personalnr. ${data.employee.personnel_number}` : 'Ohne Personalnummer'}
            </span>
            {data.employee.job_title && <span>{data.employee.job_title}</span>}
            {data.employee.department_name && <span>{data.employee.department_name}</span>}
          </div>

          {data.ratings.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={40} />}
              title={`Für ${data.period.label} liegt keine Bewertung vor`}
              hint="Möglicherweise wurde sie inzwischen entfernt oder gehört zu einer anderen Führungskraft."
            />
          ) : (
            <ul className="lead-detail__list">
              {data.ratings.map((r) => (
                <RatingBlock key={r.id} rating={r} />
              ))}
            </ul>
          )}

          {corrections.length > 0 && (
            <details className="lead-detail__history">
              <summary>
                <History size={14} aria-hidden="true" /> Korrekturen in diesem Zeitraum ({corrections.length})
              </summary>
              <ul className="lead-history">
                {corrections.map((h) => (
                  <CorrectionItem key={h.id} entry={h} kind={kind} />
                ))}
              </ul>
            </details>
          )}

          <TeamNotice>
            Bewertungen sind änderbar; jede Änderung erzeugt eine neue Version im unveränderlichen Protokoll.
            Angezeigt ist der aktuelle Stand.
          </TeamNotice>
        </div>
      )}
    </Modal>
  );
}

/** Eine Kategorie: Name, Wert auf ihrer Skala, Kommentar, Stand und Version. */
function RatingBlock({ rating }: { rating: Rating }) {
  return (
    <li className="lead-detail__item">
      <div className="lead-detail__head">
        <span className="lead-detail__category">{rating.category_name}</span>
        <RatingValue scale={rating.scale} score={rating.score} />
        {rating.version > 1 && <Badge tone="blue">Version {rating.version}</Badge>}
      </div>
      <p className="lead-detail__comment">{rating.comment}</p>
      <div className="lead-detail__stand">
        Stand {formatDateTime(rating.updated_at)}
        {rating.updated_by_name ? ` · ${rating.updated_by_name}` : ''}
      </div>
    </li>
  );
}

function CorrectionItem({ entry, kind }: { entry: RatingHistoryEntry; kind: RatingPeriodKind }) {
  return (
    <li className="lead-history__item">
      <div className="lead-history__when">
        {formatDateTime(entry.changed_at)}
        <span className="lead-history__who">{entry.changed_by_name ?? '—'}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="lead-history__line">
          <strong>{entry.category_name}</strong>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span>
            <PeriodText periodKey={entry.period_key} kind={kind} />
          </span>
          <ScoreBadge scale={entry.scale} score={entry.score} />
          {entry.previous_score !== null && (
            <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              vorher: <ScoreBadge scale={entry.previous_scale ?? entry.scale} score={entry.previous_score} />
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: 'var(--text-xs)' }}>
            Version {entry.version}
          </span>
        </div>
        <div className="lead-history__comment">{entry.comment}</div>
      </div>
    </li>
  );
}
