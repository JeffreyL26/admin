import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Award, ClipboardCheck, Gauge, SlidersHorizontal, UsersRound } from 'lucide-react';
import {
  RATING_SCALES,
  scaleLevelLabel,
  scaleLevelsBestFirst,
  scoreTone,
  type RatingScaleKey,
  type ReportLeaderRow,
} from '@ohrganize/shared';
import { useAuth } from '../../auth/AuthContext';
import { Avatar, Badge, EmptyState, PageHeader, Spinner, StatCard } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { usePhotoUrl } from '../employees/api';
import { useLeadershipReport } from './api';
import { DistributionBar, PeriodSwitcher } from './common';

/**
 * Satisfaction-Report (Arbeitstitel des Kunden — genau so beschriftet):
 * Für Geschäftsführung und HR. Je freigeschalteter Führungskraft ein breites
 * Widget mit Teamgröße, Bewertungsstand und der Verteilung der
 * GESAMTBEWERTUNG über die Skalenstufen im gewählten Zeitraum. Die Zahlen
 * kommen fertig aus `GET /api/leadership/report` (Verteilung, Prozente nach
 * größtem Rest, normierter Mittelwert); hier wird nur summiert und sortiert.
 */

type SortKey = 'name' | 'best' | 'open';

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  best: 'Anteil beste Stufe (absteigend)',
  open: 'Offene Bewertungen (absteigend)',
};

function fullName(row: ReportLeaderRow): string {
  return `${row.first_name} ${row.last_name}`;
}

/** Anteil der besten Stufe an den bewerteten Personen, 0…1; -1 ohne Bewertungen (sortiert ans Ende). */
function bestShare(row: ReportLeaderRow): number {
  if (row.rated_count === 0) return -1;
  return (row.distribution[0]?.count ?? 0) / row.rated_count;
}

/** Noch nicht bewertete Personen im Bereich (nie negativ: bewertete Personen können den Bereich verlassen haben). */
function openCount(row: ReportLeaderRow): number {
  return Math.max(0, row.team_size - row.rated_count);
}

function compareName(a: ReportLeaderRow, b: ReportLeaderRow): number {
  return (
    a.last_name.localeCompare(b.last_name, 'de') ||
    a.first_name.localeCompare(b.first_name, 'de') ||
    a.employee_id - b.employee_id
  );
}

function sortRows(rows: ReportLeaderRow[], sort: SortKey): ReportLeaderRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'best':
      sorted.sort((a, b) => bestShare(b) - bestShare(a) || compareName(a, b));
      break;
    case 'open':
      sorted.sort((a, b) => openCount(b) - openCount(a) || compareName(a, b));
      break;
    default:
      sorted.sort(compareName);
  }
  return sorted;
}

function percent(part: number, total: number): number | null {
  return total === 0 ? null : Math.round((part / total) * 100);
}

export function ReportPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  // null = aktueller Zeitraum laut Einstellung (folgt beim Datumswechsel mit).
  const [periodKey, setPeriodKey] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('name');
  // keepPreviousData im Hook: Beim Zeitraumwechsel bleibt die alte Liste
  // stehen, bis die neue da ist — kein Spinner, kein Springen der Seite.
  const { data, isLoading, isPlaceholderData, error } = useLeadershipReport(periodKey);

  const rows = useMemo(() => (data ? sortRows(data.leaders, sort) : []), [data, sort]);

  if (isLoading) {
    return (
      <>
        <PageHeader title="Satisfaction-Report" />
        <Spinner center />
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Satisfaction-Report" />
        <div className="hm-card">
          <EmptyState
            icon={<AlertTriangle size={40} />}
            title="Der Report konnte nicht geladen werden"
            hint={error instanceof Error ? error.message : 'Bitte versuchen Sie es später erneut.'}
          />
        </div>
      </>
    );
  }

  const { scale, period } = data;
  const leaderCount = data.leaders.length;
  const teamTotal = data.leaders.reduce((sum, r) => sum + r.team_size, 0);
  const ratedTotal = data.leaders.reduce((sum, r) => sum + r.rated_count, 0);
  // Erste Stufe der Verteilung ist die beste (Backend liefert beste zuerst).
  const bestTotal = data.leaders.reduce((sum, r) => sum + (r.distribution[0]?.count ?? 0), 0);
  const bestPercent = percent(bestTotal, ratedTotal);
  const bestLevel = scaleLevelsBestFirst(scale)[0];
  const openTotal = Math.max(0, teamTotal - ratedTotal);

  return (
    <>
      <PageHeader
        title="Satisfaction-Report"
        subtitle={`Wie Führungskräfte ihr Team in der Gesamtbewertung einschätzen · ${period.label} · Skala ${RATING_SCALES[scale].label}`}
        actions={<PeriodSwitcher period={period} current={data.current_period} onChange={setPeriodKey} />}
      />

      <div className="grid-stats">
        <StatCard label="Führungskräfte" value={leaderCount} icon={<Gauge size={15} />} sub="freigeschaltet und aktiv" />
        <StatCard
          label="Personen im Bereich"
          value={teamTotal}
          icon={<UsersRound size={15} />}
          sub="über alle Führungskräfte"
        />
        <StatCard
          label="Bewertet"
          value={ratedTotal}
          icon={<ClipboardCheck size={15} />}
          sub={openTotal > 0 ? `${openTotal} noch offen` : teamTotal > 0 ? 'vollständig' : 'niemand zugeordnet'}
        />
        <StatCard
          label="Anteil beste Stufe"
          value={bestPercent === null ? '—' : `${bestPercent} %`}
          icon={<Award size={15} />}
          sub={
            bestPercent === null
              ? 'Noch keine Gesamtbewertung'
              : `„${scaleLevelLabel(scale, bestLevel)}“ · ${bestTotal} von ${ratedTotal}`
          }
        />
      </div>

      {leaderCount === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<Gauge size={40} />}
            title="Noch keine Führungskräfte freigeschaltet"
            hint="Der Report zeigt je Führungskraft, wie sie ihr Team in der Gesamtbewertung einschätzt. Führungskräfte schaltet die HR unter Führung → Einrichtung frei."
            action={
              can('fuehrung') ? (
                <button
                  type="button"
                  className="hm-btn hm-btn--primary"
                  onClick={() => navigate('/fuehrung/einrichtung')}
                >
                  <SlidersHorizontal size={16} /> Zur Einrichtung
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="stack">
          <div className="lead-report-toolbar">
            <ScaleLegend scale={scale} />
            <label className="lead-report-sort">
              <span>Sortieren nach</span>
              <select className="hm-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            className={`lead-report-list${isPlaceholderData ? ' lead-report-list--stale' : ''}`}
            aria-busy={isPlaceholderData}
          >
            {rows.map((row) => (
              <LeaderReportRow key={row.employee_id} row={row} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Legende der Skala: alle Stufen, beste zuerst, in der Ampelfarbe des Balkens. */
function ScaleLegend({ scale }: { scale: RatingScaleKey }) {
  return (
    <div className="lead-legend" aria-label="Skalenstufen">
      <span className="lead-report-toolbar__label">Skala</span>
      {scaleLevelsBestFirst(scale).map((score) => (
        <span key={score} className="lead-legend__item">
          <span className={`lead-dot lead-dot--${scoreTone(scale, score)}`} aria-hidden="true" />
          {scaleLevelLabel(scale, score)}
        </span>
      ))}
    </div>
  );
}

function LeaderAvatar({ row, size }: { row: ReportLeaderRow; size: number }) {
  // Signierte URL aus der Antwort direkt konsumieren (siehe usePhotoUrl).
  const photo = usePhotoUrl(row.photo_file_id, row.photo_url);
  return <Avatar name={fullName(row)} size={size} src={photo.data} />;
}

/**
 * Breites Widget einer Führungskraft. Bewusst NICHT klickbar: Was ein Klick
 * öffnen soll (Teamliste? Einzelbewertungen? Verlauf?), definiert der Kunde
 * erst noch — bis dahin bleibt das Widget eine reine Anzeige. Wenn das
 * Verhalten feststeht, hier `hm-card--clickable` + Handler ergänzen.
 */
function LeaderReportRow({ row }: { row: ReportLeaderRow }) {
  const open = openCount(row);
  const subtitle = [row.job_title, row.department_name].filter(Boolean).join(' · ');
  return (
    <div className="hm-card">
      <div className="lead-report-row">
        <div className="lead-report-row__person">
          <LeaderAvatar row={row} size={48} />
          <div className="lead-report-row__text">
            <div className="lead-report-row__name">{fullName(row)}</div>
            <div className="lead-report-row__title">{subtitle || '—'}</div>
            <div className="lead-report-row__status">
              <span>
                {row.rated_count} von {row.team_size} bewertet
              </span>
              {row.team_size === 0 ? (
                <Badge tone="neutral">niemand zugeordnet</Badge>
              ) : open > 0 ? (
                <Badge tone="yellow">{open} offen</Badge>
              ) : (
                <Badge tone="green">vollständig</Badge>
              )}
              {row.other_scale_count > 0 && (
                <Tooltip
                  content={
                    <>
                      <div className="hm-tooltip__title">Andere Skala</div>
                      <div className="hm-tooltip__line">
                        {row.other_scale_count} {row.other_scale_count === 1 ? 'Bewertung' : 'Bewertungen'} vor der
                        Umstellung der Skala · nicht in der Verteilung enthalten
                      </div>
                    </>
                  }
                >
                  <span>
                    <Badge tone="neutral">{row.other_scale_count} auf anderer Skala</Badge>
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        <div className="lead-report-row__chart">
          <DistributionBar distribution={row.distribution} ratedCount={row.rated_count} />
          {row.average_normalized !== null && (
            <div className="lead-report-row__avg">Ø {Math.round(row.average_normalized * 100)} % der Bestnote</div>
          )}
        </div>
      </div>
    </div>
  );
}
