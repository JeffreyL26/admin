import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, CalendarRange, CheckCheck, ClipboardList, Network, Search, Users, UsersRound } from 'lucide-react';
import {
  RATING_PERIOD_LABELS,
  type RatingPeriod,
  type RatingPeriodKind,
  type TeamMember,
  type TeamScopeSummary,
} from '@ohrganize/shared';
import { Card, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { useMyTeam } from './api';
import { PeriodSwitcher, TeamMemberCard } from './common';
import { LeaderLockedState, isForbidden } from './TeamShared';

/**
 * „Mein Team“: die Führungsfunktion selbst. Oben der Zuständigkeitsbereich
 * (Abteilung(en), Kopfzahl, Zeitraum und wie weit die Bewertungsrunde ist),
 * darunter die Personen in zwei Abschnitten: erst die ausstehenden
 * Bewertungen (von dort führt jede Karte in die Bewertungsmaske), dann die
 * bereits bewerteten. Jede Karte trägt Stammdaten samt Eintrittsdatum und den
 * Verlauf der letzten Zeiträume.
 *
 * Suche und Aufteilung laufen clientseitig: Ein Bereich hat selten mehr als
 * ein paar Dutzend Personen, und die Antwort liegt ohnehin komplett vor.
 */
export function MyTeamPage() {
  const navigate = useNavigate();
  // null = aktueller Zeitraum laut Einstellung (folgt beim Datumswechsel mit).
  const [periodKey, setPeriodKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useMyTeam(periodKey);

  const filtered = useMemo(() => (data ? filterMembers(data.team, search) : []), [data, search]);

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
  // „Bewertet“ heißt: In diesem Zeitraum liegt mindestens eine Kategorie vor
  // (CLAUDE.md, Führung & Bewertung). Wer nur „Leistung“ ohne Gesamtbewertung
  // erfasst hat, steht nicht mehr als ausstehend in der Liste; die Karte zeigt
  // die Lücke stattdessen an.
  const ratedMembers = filtered.filter((m) => m.rated_categories > 0);
  const openMembers = filtered.filter((m) => m.rated_categories === 0);
  const ratedTotal = data.team.filter((m) => m.rated_categories > 0).length;

  const openMember = (id: number) => {
    // Nur vom aktuellen Zeitraum abweichende Auswahl wandert in die URL:
    // So bleibt der Standardlink stabil und folgt später dem Datum.
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

      <ScopeHeader
        scope={data.scope}
        period={data.period}
        kind={data.settings.period}
        rated={ratedTotal}
        total={total}
      />

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
              <span className="lead-toolbar__count">
                {filtered.length} von {total} {total === 1 ? 'Person' : 'Personen'}
              </span>
            </div>
          </Card>

          {filtered.length === 0 ? (
            <div className="hm-card">
              <EmptyState
                title="Keine Treffer"
                hint="Suche anpassen, um wieder Personen zu sehen."
                action={
                  <button type="button" className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => setSearch('')}>
                    Suche zurücksetzen
                  </button>
                }
              />
            </div>
          ) : (
            <>
              <TeamSection
                icon={<ClipboardList size={16} aria-hidden="true" />}
                title="Ausstehende Bewertungen"
                hint={`Noch keine Bewertung für ${data.period.label} · Klick öffnet die Bewertungsmaske`}
                empty={`Für ${data.period.label} liegt zu jeder Person eine Bewertung vor.`}
                members={openMembers}
                cta="Jetzt bewerten"
                onOpen={openMember}
                historyPeriods={data.history_periods}
              />
              <TeamSection
                icon={<CheckCheck size={16} aria-hidden="true" />}
                title="Bereits bewertet"
                hint={`Bewertung für ${data.period.label} abgegeben · Klick öffnet sie zum Ändern`}
                empty={`Für ${data.period.label} wurde noch niemand bewertet.`}
                members={ratedMembers}
                cta="Bewertung öffnen"
                onOpen={openMember}
                historyPeriods={data.history_periods}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Kopf des Zuständigkeitsbereichs: Abteilung(en) und Teams mit Kopfzahl, die
 * Gesamtzahl der betreuten Personen, der Zeitraum samt Kadenz und der
 * Fortschritt der laufenden Runde.
 */
function ScopeHeader({
  scope,
  period,
  kind,
  rated,
  total,
}: {
  scope: TeamScopeSummary;
  period: RatingPeriod;
  kind: RatingPeriodKind;
  rated: number;
  total: number;
}) {
  const open = total - rated;
  const percent = total > 0 ? Math.round((rated / total) * 100) : 0;
  const departments = scope.departments.map((d) => ({ key: `d${d.id ?? 'none'}`, name: d.name, count: d.count }));
  const teams = scope.teams.map((t) => ({ key: `t${t.id}`, name: t.name, count: t.count }));

  return (
    <Card flush>
      <div className="lead-scope">
        <div className="lead-scope__facts">
          <Fact
            icon={<Building2 size={16} aria-hidden="true" />}
            label={departments.length === 1 ? 'Abteilung' : 'Abteilungen'}
            value={<ScopeList items={departments} />}
          />
          {teams.length > 0 && (
            <Fact icon={<Network size={16} aria-hidden="true" />} label="Teams" value={<ScopeList items={teams} />} />
          )}
          <Fact
            icon={<Users size={16} aria-hidden="true" />}
            label={scope.total === 1 ? 'Mitarbeiter:in' : 'Mitarbeitende'}
            value={<>{scope.total}</>}
          />
          <Fact
            icon={<CalendarRange size={16} aria-hidden="true" />}
            label="Zeitraum"
            value={
              <>
                {period.label} <span className="lead-fact__note">{RATING_PERIOD_LABELS[kind]}</span>
              </>
            }
          />
        </div>

        <div className="lead-scope__progress">
          <div className="lead-progress__text">
            <strong>{rated}</strong> von {total} bewertet
          </div>
          <div
            className="hm-progress"
            role="img"
            aria-label={`${rated} von ${total} Personen im Zeitraum ${period.label} bewertet`}
          >
            <span className="hm-progress__fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="lead-progress__hint">
            {total === 0
              ? 'Niemand zugeordnet'
              : open === 0
                ? 'Runde abgeschlossen'
                : `${open} ${open === 1 ? 'Person' : 'Personen'} ausstehend`}
          </div>
        </div>
      </div>
    </Card>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="lead-fact">
      <span className="lead-fact__icon">{icon}</span>
      <span className="lead-fact__body">
        <span className="lead-fact__label">{label}</span>
        <span className="lead-fact__value">{value}</span>
      </span>
    </div>
  );
}

/** „Technik (10) · Vertrieb (6)“: der Rest wandert in einen Tooltip. */
function ScopeList({ items, max = 3 }: { items: { key: string; name: string; count: number }[]; max?: number }) {
  if (items.length === 0) return <>Ohne Zuordnung</>;
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  return (
    <>
      {shown.map((i) => `${i.name} (${i.count})`).join(' · ')}
      {rest.length > 0 && (
        <Tooltip
          content={
            <>
              <div className="hm-tooltip__title">Weitere</div>
              {rest.map((i) => (
                <div key={i.key} className="hm-tooltip__line">
                  {i.name} · {i.count}
                </div>
              ))}
            </>
          }
        >
          {/* Fokussierbar, sonst bliebe der Rest der Liste für die Tastatur
              unerreichbar. Der Tooltip öffnet auch bei Fokus. */}
          <span className="lead-scope__more" tabIndex={0}>
            {' '}
            +{rest.length} weitere
          </span>
        </Tooltip>
      )}
    </>
  );
}

/** Ein Abschnitt der Personenliste („Ausstehend“ bzw. „Bereits bewertet“). */
function TeamSection({
  icon,
  title,
  hint,
  empty,
  members,
  cta,
  onOpen,
  historyPeriods,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  /** Text, wenn dieser Abschnitt leer ist: in beiden Abschnitten ein gutes Zeichen. */
  empty: string;
  members: TeamMember[];
  cta: string;
  onOpen: (employeeId: number) => void;
  historyPeriods: RatingPeriod[];
}) {
  return (
    <section className="lead-section">
      <div className="lead-section__head">
        <h2 className="lead-section__title">
          {icon}
          {title}
          <span className="lead-section__count">{members.length}</span>
        </h2>
        {members.length > 0 && <span className="lead-section__hint">{hint}</span>}
      </div>
      {members.length === 0 ? (
        <p className="lead-section__empty">{empty}</p>
      ) : (
        <div className="lead-grid">
          {members.map((m) => (
            <TeamMemberCard
              key={m.id}
              member={m}
              onOpen={onOpen}
              historyPeriods={historyPeriods}
              cta={cta}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Jeder Suchbegriff muss irgendwo in Name, Titel, Abteilung, Team oder Personalnummer vorkommen. */
function filterMembers(team: TeamMember[], search: string): TeamMember[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return team;
  return team.filter((m) => {
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
