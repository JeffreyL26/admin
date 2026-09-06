import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Search, UserCheck, Users, UsersRound } from 'lucide-react';
import { RATING_PERIOD_LABELS, type TeamMember } from '@ohrganize/shared';
import { Card, EmptyState, PageHeader, Spinner, StatCard } from '../../components/ui';
import { useMyTeam } from './api';
import { PeriodSwitcher, TeamMemberCard } from './common';
import { LeaderLockedState, isForbidden } from './TeamShared';

/**
 * „Mein Team“ — Zuständigkeitsbereich der angemeldeten Führungskraft als
 * klickbare Widgets mit Bewertungsstand im gewählten Zeitraum. Suche und
 * Filter laufen clientseitig: Ein Bereich hat selten mehr als ein paar
 * Dutzend Personen, und die Antwort liegt ohnehin komplett vor.
 */
export function MyTeamPage() {
  const navigate = useNavigate();
  // null = aktueller Zeitraum laut Einstellung (folgt beim Datumswechsel mit).
  const [periodKey, setPeriodKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const { data, isLoading, error } = useMyTeam(periodKey);

  const filtered = useMemo(() => (data ? filterMembers(data.team, search, onlyOpen) : []), [data, search, onlyOpen]);

  if (isForbidden(error)) {
    return (
      <>
        <PageHeader title="Mein Team" />
        <LeaderLockedState />
      </>
    );
  }
  if (error && !data) {
    return (
      <>
        <PageHeader title="Mein Team" />
        <div className="hm-card">
          <EmptyState
            title="Mein Team konnte nicht geladen werden"
            hint={error.message}
            action={
              periodKey !== null ? (
                <button type="button" className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => setPeriodKey(null)}>
                  Aktueller Zeitraum
                </button>
              ) : undefined
            }
          />
        </div>
      </>
    );
  }
  if (isLoading || !data) return <Spinner center />;

  const total = data.team.length;
  const rated = data.team.filter((m) => m.overall !== null).length;
  const open = total - rated;
  const hasFilter = search.trim() !== '' || onlyOpen;

  const openMember = (id: number) => {
    // Nur vom aktuellen Zeitraum abweichende Auswahl wandert in die URL —
    // so bleibt der Standardlink stabil und folgt später dem Datum.
    const query =
      data.period.key !== data.current_period.key ? `?period=${encodeURIComponent(data.period.key)}` : '';
    navigate(`/fuehrung/mein-team/${id}${query}`);
  };

  return (
    <>
      <PageHeader
        title="Mein Team"
        subtitle={`Zeitraum ${data.period.label} · ${RATING_PERIOD_LABELS[data.settings.period]}`}
        actions={
          <PeriodSwitcher
            period={data.period}
            current={data.current_period}
            onChange={(key) => setPeriodKey(key === data.current_period.key ? null : key)}
          />
        }
      />

      <div className="grid-stats">
        <StatCard label="Personen im Bereich" value={total} icon={<Users size={15} />} />
        <StatCard
          label="Davon bewertet"
          value={rated}
          icon={<UserCheck size={15} />}
          sub={`Gesamtbewertung · ${data.period.label}`}
        />
        <StatCard
          label="Noch offen"
          value={open}
          icon={<ClipboardList size={15} />}
          sub={open > 0 ? (onlyOpen ? 'Filter aktiv · Klicken hebt ihn auf' : 'Klicken zeigt nur Unbewertete') : 'Alle bewertet'}
          onClick={total > 0 ? () => setOnlyOpen((v) => !v) : undefined}
        />
      </div>

      {total === 0 ? (
        <div className="hm-card">
          <EmptyState
            icon={<UsersRound size={40} />}
            title="Noch niemand in Ihrem Zuständigkeitsbereich"
            hint="Die Zuständigkeit ergibt sich aus der Organisation (direkt unterstellt, Abteilungs- oder Teamleitung) oder wird von der HR unter Führung → Einrichtung gepflegt."
          />
        </div>
      ) : (
        <div className="stack">
          <Card flush>
            <div className="lead-toolbar">
              <div className="lead-toolbar__search">
                <Search size={15} aria-hidden="true" />
                <input
                  className="hm-input"
                  type="search"
                  placeholder="Suchen (Name, Titel, Abteilung, Team)"
                  aria-label="Team durchsuchen"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <label className="hm-checkbox">
                <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
                Nur unbewertete
              </label>
              <span className="lead-toolbar__count">
                {filtered.length} von {total} {total === 1 ? 'Person' : 'Personen'}
              </span>
            </div>
          </Card>

          {filtered.length === 0 ? (
            <div className="hm-card">
              <EmptyState
                title={onlyOpen && !search.trim() ? 'Alle Personen sind bewertet' : 'Keine Treffer'}
                hint={
                  onlyOpen && !search.trim()
                    ? `Im Zeitraum ${data.period.label} liegt für jede Person eine Gesamtbewertung vor.`
                    : 'Suche oder Filter anpassen, um wieder Personen zu sehen.'
                }
                action={
                  hasFilter ? (
                    <button
                      type="button"
                      className="hm-btn hm-btn--secondary hm-btn--sm"
                      onClick={() => {
                        setSearch('');
                        setOnlyOpen(false);
                      }}
                    >
                      Filter zurücksetzen
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="lead-grid">
              {filtered.map((m) => (
                <TeamMemberCard key={m.id} member={m} onOpen={openMember} periodLabel={data.period.label} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Jeder Suchbegriff muss irgendwo in Name, Titel, Abteilung, Team oder Personalnummer vorkommen. */
function filterMembers(team: TeamMember[], search: string, onlyOpen: boolean): TeamMember[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return team.filter((m) => {
    if (onlyOpen && m.overall !== null) return false;
    if (terms.length === 0) return true;
    const haystack = [
      `${m.first_name} ${m.last_name}`,
      m.job_title,
      m.department_name,
      m.team_name,
      m.personnel_number,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
