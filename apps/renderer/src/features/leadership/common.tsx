import React from 'react';
import { ChevronLeft, ChevronRight, Handshake } from 'lucide-react';
import {
  EMPLOYEE_TYPE_LABELS,
  SCOPE_SOURCE_LABELS,
  formatDate,
  formatSeniority,
  shiftPeriod,
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

/** Woher eine Zuständigkeit stammt — plus Hinweis auf gegenseitige Verantwortung. */
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
 * Widget einer Person im Zuständigkeitsbereich: wichtigste Stammdaten,
 * Herkunft der Zuständigkeit und der Bewertungsstand im Zeitraum. Klickbar,
 * wenn `onOpen` gesetzt ist (Führungsfunktion); in der Einrichtung dient
 * dieselbe Karte als reine Vorschau.
 */
export function TeamMemberCard({
  member,
  onOpen,
  periodLabel,
}: {
  member: TeamMember;
  onOpen?: (employeeId: number) => void;
  periodLabel?: string;
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
      <div className="lead-card__foot">
        {member.overall ? (
          <RatingValue scale={member.overall.scale} score={member.overall.score} />
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            {periodLabel ? `Noch nicht bewertet · ${periodLabel}` : 'Noch nicht bewertet'}
          </span>
        )}
        {member.rated_categories > 0 && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
            {member.rated_categories} {member.rated_categories === 1 ? 'Kategorie' : 'Kategorien'}
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
      aria-label={`${name} bewerten`}
    >
      {body}
    </button>
  );
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
