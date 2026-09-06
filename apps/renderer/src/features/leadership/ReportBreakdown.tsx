import React, { useEffect, useState } from 'react';
import { UserMinus, UsersRound } from 'lucide-react';
import { formatDateTime, type BreakdownCell, type BreakdownRow, type RatingPeriodKind } from '@ohrganize/shared';
import { Badge, EmptyState, Spinner } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { useLeaderBreakdown } from './api';
import { ScoreBadge } from './RatingInput';
import { ReportRatingDialog } from './ReportRatingDialog';
import { SourceBadges } from './common';

/**
 * Aufgeklappter Teil eines Report-Widgets: alle von dieser Führungskraft
 * verantworteten Personen mit Name, Personalnummer und ihrer
 * GESAMTBEWERTUNG je Zeitraum (Spalten in der eingestellten Kadenz, neueste
 * links). Ein Klick auf eine bereits bewertete Zelle öffnet das Detail-Pop-up
 * mit allen Kategorien und Kommentaren.
 *
 * Geladen wird erst beim Aufklappen (`useLeaderBreakdown` bleibt mit
 * `employeeId: null` still) — der Report zeigt bis zu einem Dutzend Widgets,
 * und niemand klappt alle auf.
 */
export function ReportBreakdown({
  leaderId,
  periodKey,
  kind,
  labelledBy,
}: {
  leaderId: number;
  /** Jüngste Spalte; null = aktueller Zeitraum laut Einstellung. */
  periodKey: string | null;
  kind: RatingPeriodKind;
  /** Kopfzeile des Widgets — verknüpft die Tabelle mit ihrer Überschrift. */
  labelledBy: string;
}) {
  const { data, isLoading, error } = useLeaderBreakdown(leaderId, periodKey);
  const [open, setOpen] = useState<{ memberId: number; periodKey: string } | null>(null);

  // Wechselt der Report den Zeitraum, während ein Detail offen ist, passt das
  // Pop-up nicht mehr zur Tabelle darunter — dann lieber schließen.
  useEffect(() => setOpen(null), [periodKey]);

  if (isLoading) return <Spinner center />;
  if (error || !data) {
    return (
      <EmptyState
        title="Aufschlüsselung konnte nicht geladen werden"
        hint={error instanceof Error ? error.message : 'Bitte versuchen Sie es später erneut.'}
      />
    );
  }
  if (data.rows.length === 0) {
    return (
      <EmptyState
        icon={<UsersRound size={40} />}
        title="Niemand zugeordnet"
        hint="Dieser Führungskraft ist derzeit keine Person zugeordnet, und in den angezeigten Zeiträumen liegen keine Bewertungen vor."
      />
    );
  }

  const cellFor = (row: BreakdownRow, key: string): BreakdownCell | undefined =>
    row.cells.find((c) => c.period_key === key);
  const hasFormer = data.rows.some((r) => r.former === 1);

  return (
    <>
      <div className="hm-table-wrap lead-breakdown">
        <table className="hm-table" aria-labelledby={labelledBy}>
          <thead>
            <tr>
              <th>Mitarbeiter:in</th>
              <th style={{ width: 140 }}>Personalnummer</th>
              {data.periods.map((p) => (
                <th key={p.key} className="lead-breakdown__period">
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.employee_id}>
                <td>
                  <div className="lead-breakdown__name">
                    {row.last_name}, {row.first_name}
                    {row.former === 1 && (
                      <Tooltip
                        content={
                          <>
                            <div className="hm-tooltip__title">Nicht mehr zuständig</div>
                            <div className="hm-tooltip__line">
                              Frühere Bewertungen bleiben sichtbar · aktuelle Zuordnung entfallen
                            </div>
                          </>
                        }
                      >
                        <span>
                          <Badge tone="neutral">
                            <UserMinus size={12} /> ehemals
                          </Badge>
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  <div className="lead-breakdown__sub">
                    {[row.job_title, row.department_name].filter(Boolean).join(' · ') || '—'}
                  </div>
                  {/* Quellen nur zeigen, wo sie etwas erklären: Dass fast alle
                      einer Abteilungsleitung unterstehen, weiß man; eine
                      manuelle Zuweisung dagegen ist begründungsbedürftig. */}
                  {row.sources.includes('zugewiesen') && (
                    <div style={{ marginTop: 4 }}>
                      <SourceBadges sources={row.sources} mutual={0} />
                    </div>
                  )}
                </td>
                <td className="lead-breakdown__number">{row.personnel_number ?? '—'}</td>
                {data.periods.map((p) => {
                  const cell = cellFor(row, p.key);
                  return (
                    <td key={p.key} className="lead-breakdown__cell">
                      {cell ? (
                        <Tooltip
                          content={
                            <>
                              <div className="hm-tooltip__title">Bewertung ansehen</div>
                              <div className="hm-tooltip__line">
                                {cell.category_count}{' '}
                                {cell.category_count === 1 ? 'Kategorie' : 'Kategorien'} ·{' '}
                                {formatDateTime(cell.updated_at)}
                              </div>
                            </>
                          }
                        >
                          <button
                            type="button"
                            className="lead-breakdown__score"
                            aria-label={`Bewertung von ${row.first_name} ${row.last_name} für ${p.label} ansehen`}
                            onClick={() => setOpen({ memberId: row.employee_id, periodKey: p.key })}
                          >
                            <ScoreBadge scale={cell.scale} score={cell.score} />
                          </button>
                        </Tooltip>
                      ) : (
                        <span className="lead-breakdown__empty" aria-label="Nicht bewertet">
                          —
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="lead-breakdown__foot">
        Gesamtbewertung je {kindLabel(kind)} · Klick auf einen Wert zeigt alle Kategorien und Kommentare.
        {hasFormer && ' Mit „ehemals“ markierte Personen gehören nicht mehr zum Bereich; ihre Bewertungen bleiben erhalten.'}
      </div>

      {open && (
        <ReportRatingDialog
          leaderId={leaderId}
          memberId={open.memberId}
          periodKey={open.periodKey}
          kind={kind}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** „Quartal“, „Monat“ … — für den Fußtext der Tabelle. */
function kindLabel(kind: RatingPeriodKind): string {
  switch (kind) {
    case 'monat':
      return 'Monat';
    case 'quartal':
      return 'Quartal';
    case 'halbjahr':
      return 'Halbjahr';
    case 'jahr':
      return 'Jahr';
  }
}
