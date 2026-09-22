import React from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Handshake } from 'lucide-react';
import {
  EMPLOYEE_TYPE_LABELS,
  SCOPE_SOURCE_LABELS,
  formatDate,
  formatDateTime,
  formatSeniority,
  scaleLevelLabel,
  scoreTone,
  shiftPeriod,
  type BreakdownCell,
  type EmployeeType,
  type RatingPeriod,
  type ReportDistributionEntry,
  type ScopeSource,
  type TeamMember,
} from '@ohrganize/shared';
import { Avatar, Badge, type BadgeTone } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { usePhotoUrl } from '../employees/api';
import { RatingValue } from './RatingInput';

/** Gemeinsame Bausteine der Seiten des Moduls Führung & Bewertung. */

// ---------------------------------------------------------------------------
// Zeitraum
// ---------------------------------------------------------------------------

/**
 * Blättert durch Bewertungszeiträume. Vorwärts endet beim aktuellen Zeitraum:
 * Zukünftige Zeiträume kann niemand bewerten, und ein leerer Report darüber
 * wäre nur verwirrend.
 */
export function PeriodSwitcher({
  period,
  current,
  onChange,
}: {
  period: RatingPeriod;
  current: RatingPeriod;
  onChange: (key: string) => void;
}) {
  const isCurrent = period.key === current.key;
  const canForward = period.from < current.from;
  return (
    <div className="lead-period" role="group" aria-label="Zeitraum wählen">
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
        aria-label="Vorheriger Zeitraum"
        onClick={() => onChange(shiftPeriod(period.key, -1))}
      >
        <ChevronLeft size={16} />
      </button>
      <span className="lead-period__label">{period.label}</span>
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
        aria-label="Nächster Zeitraum"
        disabled={!canForward}
        onClick={() => onChange(shiftPeriod(period.key, 1))}
      >
        <ChevronRight size={16} />
      </button>
      {!isCurrent && (
        <button type="button" className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => onChange(current.key)}>
          Aktueller Zeitraum
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zuständigkeit
// ---------------------------------------------------------------------------

const SOURCE_TONES: Record<ScopeSource, BadgeTone> = {
  direkt: 'blue',
  abteilung: 'navy',
  team: 'green',
  zugewiesen: 'yellow',
};

/** Woher eine Zuständigkeit stammt, plus Hinweis auf gegenseitige Verantwortung. */
export function SourceBadges({ sources, mutual }: { sources: ScopeSource[]; mutual: number }) {
  return (
    <span className="row row--wrap" style={{ gap: 6 }}>
      {sources.map((s) => (
        <Badge key={s} tone={SOURCE_TONES[s]}>
          {SCOPE_SOURCE_LABELS[s]}
        </Badge>
      ))}
      {mutual === 1 && (
        <Tooltip
          content={
            <>
              <div className="hm-tooltip__title">Gegenseitige Verantwortung</div>
              <div className="hm-tooltip__line">Diese Person ist ihrerseits für Sie zuständig</div>
            </>
          }
        >
          <span>
            <Badge tone="red">
              <Handshake size={12} /> gegenseitig
            </Badge>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

export const EMPLOYEE_TYPE_TONES: Record<EmployeeType, BadgeTone> = {
  vollzeit: 'blue',
  teilzeit: 'navy',
  minijob: 'yellow',
  werkstudent: 'green',
  praktikant: 'neutral',
  freiberufler: 'red',
  auszubildender: 'green',
};

function TeamAvatar({ member, size }: { member: TeamMember; size: number }) {
  // Signierte URL aus der Antwort direkt konsumieren (siehe usePhotoUrl):
  // Führungskräfte haben nicht zwingend das Recht, selbst zu signieren.
  const photo = usePhotoUrl(member.photo_file_id, member.photo_url);
  return <Avatar name={`${member.first_name} ${member.last_name}`} size={size} src={photo.data} />;
}

/**
 * Widget einer Person im Zuständigkeitsbereich („Mein Team“): wichtigste
 * Stammdaten, Eintrittsdatum, Herkunft der Zuständigkeit, der Bewertungsstand
 * im gewählten Zeitraum und, sofern `historyPeriods` gesetzt ist, der Verlauf
 * der letzten Zeiträume.
 *
 * Mit `onOpen` ist die ganze Karte der Knopf in die Bewertungsmaske; ohne
 * bleibt sie eine reine Anzeige.
 */
export function TeamMemberCard({
  member,
  onOpen,
  historyPeriods,
  cta,
}: {
  member: TeamMember;
  onOpen?: (employeeId: number) => void;
  /** Spalten der Verlaufsleiste (neueste zuerst, aus `MyTeamResponse`). */
  historyPeriods?: RatingPeriod[];
  /** Beschriftung des Einstiegs, z. B. „Jetzt bewerten“. Nur mit `onOpen`. */
  cta?: string;
}) {
  const name = `${member.first_name} ${member.last_name}`;
  const type = member.employee_type as EmployeeType;
  const body = (
    <>
      <div className="lead-card__head">
        <TeamAvatar member={member} size={48} />
        <div style={{ minWidth: 0 }}>
          <div className="lead-card__name">{name}</div>
          <div className="lead-card__title">{member.job_title ?? '—'}</div>
        </div>
      </div>
      <div className="lead-card__meta">
        <span>{[member.department_name, member.team_name].filter(Boolean).join(' · ') || 'Ohne Abteilung'}</span>
        <span>
          {member.personnel_number ? `Personalnr. ${member.personnel_number}` : 'Ohne Personalnummer'}
          {member.location_name ? ` · ${member.location_name}` : ''}
        </span>
        <span>
          {member.hire_date
            ? `Seit ${formatDate(member.hire_date)} · ${formatSeniority(member.hire_date)}`
            : 'Eintritt unbekannt'}
        </span>
      </div>
      <div className="row row--wrap" style={{ gap: 6 }}>
        {EMPLOYEE_TYPE_LABELS[type] && <Badge tone={EMPLOYEE_TYPE_TONES[type]}>{EMPLOYEE_TYPE_LABELS[type]}</Badge>}
        <SourceBadges sources={member.sources} mutual={member.mutual} />
      </div>
      {historyPeriods && historyPeriods.length > 0 && (
        <TeamHistoryTrack member={member} periods={historyPeriods} />
      )}
      <div className="lead-card__foot">
        <span className="lead-card__state">
          {member.overall ? (
            <RatingValue scale={member.overall.scale} score={member.overall.score} />
          ) : (
            <span className="lead-card__pending">
              {/* Kategorien erfasst, aber keine Gesamtbewertung: zählt als
                  ausstehend, ist aber etwas anderes als „gar nicht bewertet“. */}
              {member.rated_categories > 0 ? 'Kategorien begonnen' : 'Noch nicht bewertet'}
            </span>
          )}
          {member.rated_categories > 0 && (
            <span className="lead-card__cats">
              {member.rated_categories} {member.rated_categories === 1 ? 'Kategorie' : 'Kategorien'}
            </span>
          )}
        </span>
        {onOpen && cta && (
          // Kein Knopf im Knopf: Die ganze Karte ist der Auslöser, das hier
          // ist nur seine sichtbare Beschriftung.
          <span className="lead-card__cta">
            {cta}
            <ArrowRight size={14} aria-hidden="true" />
          </span>
        )}
      </div>
    </>
  );
  if (!onOpen) return <div className="hm-card lead-card">{body}</div>;
  return (
    <button
      type="button"
      className="hm-card hm-card--clickable lead-card"
      onClick={() => onOpen(member.id)}
    >
      {body}
    </button>
  );
}

/**
 * Verlaufsleiste einer Person: die letzten Zeiträume nebeneinander, neuester
 * links. Gezeigt wird die Gesamtbewertung als farbiger Punkt mit Rohwert
 * (Sterne wären in dieser Breite unleserlich); der volle Text steht im
 * Tooltip.
 *
 * Bewusst ohne eigene Bedienelemente: Die Karte selbst ist der Knopf in die
 * Bewertungsmaske, verschachtelte Knöpfe wären weder klick- noch bedienbar.
 */
function TeamHistoryTrack({ member, periods }: { member: TeamMember; periods: RatingPeriod[] }) {
  const cells = member.history ?? [];
  return (
    <div className="lead-track">
      {periods.map((p) => (
        <TrackCell key={p.key} period={p} cell={cells.find((c) => c.period_key === p.key)} />
      ))}
    </div>
  );
}

function TrackCell({ period, cell }: { period: RatingPeriod; cell?: BreakdownCell }) {
  const label = <span className="lead-track__label">{trackLabel(period)}</span>;
  if (!cell) {
    return (
      <span className="lead-track__cell lead-track__cell--empty">
        {label}
        <span className="lead-track__value lead-track__value--none">
          <span aria-hidden="true">—</span>
          <span className="lead-sr-only">Nicht bewertet</span>
        </span>
      </span>
    );
  }
  // Lokale Bindung, damit TypeScript beide Felder gemeinsam einengt: Ohne
  // Gesamtbewertung sind `score` und `scale` zusammen null (siehe BreakdownCell).
  const { score, scale } = cell;
  const count = `${cell.category_count} ${cell.category_count === 1 ? 'Kategorie' : 'Kategorien'}`;
  return (
    <Tooltip
      content={
        <>
          <div className="hm-tooltip__title">{period.label}</div>
          <div className="hm-tooltip__line">
            {score !== null && scale !== null ? scaleLevelLabel(scale, score) : 'Ohne Gesamtbewertung'} · {count}
          </div>
          <div className="hm-tooltip__line">Stand {formatDateTime(cell.updated_at)}</div>
        </>
      }
    >
      <span className="lead-track__cell">
        {label}
        {score !== null && scale !== null ? (
          <span className="lead-track__value">
            <span className={`lead-dot lead-dot--${scoreTone(scale, score)}`} aria-hidden="true" />
            {/* Sichtbar der Rohwert (schmale Spalte), vorgelesen die Stufe. */}
            <span aria-hidden="true">{score}</span>
            <span className="lead-sr-only">{scaleLevelLabel(scale, score)}</span>
          </span>
        ) : (
          <span className="lead-track__value lead-track__value--partial">
            <span aria-hidden="true">{cell.category_count} Kat.</span>
            <span className="lead-sr-only">{count} bewertet, ohne Gesamtbewertung</span>
          </span>
        )}
      </span>
    </Tooltip>
  );
}

/**
 * Kompakte Beschriftung für die schmale Spalte: Monate und Halbjahre würden
 * ausgeschrieben abgeschnitten. Der volle Text steht im Tooltip.
 */
function trackLabel(period: RatingPeriod): string {
  switch (period.kind) {
    case 'monat':
      return `${period.key.slice(5, 7)}/${period.key.slice(0, 4)}`;
    case 'halbjahr':
      return `H${period.key.slice(6, 7)} ${period.key.slice(0, 4)}`;
    default:
      return period.label;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Gestapelter Verteilungsbalken (beste Stufe links) mit Legende. */
export function DistributionBar({
  distribution,
  ratedCount,
}: {
  distribution: ReportDistributionEntry[];
  ratedCount: number;
}) {
  if (ratedCount === 0) {
    return (
      <div className="lead-dist lead-dist--empty" aria-label="Keine Bewertungen im Zeitraum">
        <span className="lead-dist__empty-label">Keine Gesamtbewertung im Zeitraum</span>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="lead-dist" role="img" aria-label="Verteilung der Gesamtbewertung">
        {distribution
          .filter((d) => d.count > 0)
          .map((d) => (
            <Tooltip
              key={d.score}
              content={
                <>
                  <div className="hm-tooltip__title">{d.label}</div>
                  <div className="hm-tooltip__line">
                    {d.count} {d.count === 1 ? 'Person' : 'Personen'} · {d.percent} %
                  </div>
                </>
              }
            >
              <span className={`lead-dist__seg lead-dist__seg--${d.tone}`} style={{ width: `${d.percent}%` }} />
            </Tooltip>
          ))}
      </div>
      <div className="lead-legend">
        {distribution.map((d) => (
          <span key={d.score} className="lead-legend__item">
            <span className={`lead-dot lead-dot--${d.tone}`} aria-hidden="true" />
            {d.label}: <strong>{d.percent} %</strong>
            <span style={{ color: 'var(--text-muted)' }}>({d.count})</span>
          </span>
        ))}
      </div>
    </div>
  );
}
