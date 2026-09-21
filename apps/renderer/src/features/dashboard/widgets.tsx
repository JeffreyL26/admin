import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  formatDate, FEEDBACK_MEETING_KIND_LABELS, INTERVIEW_KIND_LABELS, ONBOARDING_KIND_LABELS,
} from '@ohrganize/shared';
import { useOnboardingProcesses } from '../admin/api';
import { useLeaderStatus, useLeadershipReport } from '../leadership/api';
import { useAuth } from '../../auth/AuthContext';
import { Badge } from '../../components/ui';
import { ChartTooltip } from '../../components/ChartTooltip';
import {
  LICENSE_PATH, LICENSE_STATE_LABELS, licenseStateTone, remainingLabel, seatsLabel,
} from '../settings/license';
import type { DashboardData } from './api';

/* Reine Widget-Inhalte des Dashboards — der Card-Rahmen (Titel, Icon,
   Bearbeitungs-Controls) kommt aus DashboardPage. Alle Listen folgen einem
   Rezept: Avatar oder Kennung in der Akzentfarbe des Widgets, Haupttext,
   rechts ein Chip mit Datum oder Zahl (Klassen hm-dash-*). */

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const ORG_ACCENTS = ['--org-1', '--org-2', '--org-3', '--org-4', '--org-5', '--org-6'];

function initials(first?: string | null, last?: string | null): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase();
}

/** Kurzdatum fuer Chips: 24.09. (Jahr nur, wenn es nicht das laufende ist). */
function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y === String(new Date().getFullYear()) ? `${d}.${m}.` : `${d}.${m}.${y}`;
}

function Empty({ text, padded }: { text: string; padded?: boolean }) {
  return <p className="hm-dash-empty" style={{ padding: padded ? 16 : 0 }}>{text}</p>;
}

/**
 * Fehlender Block in der Dashboard-Antwort = fehlendes Leserecht: Das Backend
 * lässt gesperrte Bereiche weg, statt sie mit 0/[] zu füllen. Deshalb hier
 * ausdrücklich NICHT die „alles leer“-Meldung des Widgets zeigen — „Heute sind
 * alle an Bord“ wäre eine Falschaussage, wo in Wahrheit nur die Berechtigung
 * fehlt. Regulär blendet DashboardPage solche Widgets ohnehin aus; das hier ist
 * der doppelte Boden.
 */
function Restricted({ padded }: { padded?: boolean }) {
  return <Empty text="Für diesen Bereich fehlt Ihnen die Berechtigung." padded={padded} />;
}

function Row({
  to,
  avatar,
  title,
  meta,
  chip,
  chipMuted,
}: {
  to?: string;
  avatar?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  chip?: React.ReactNode;
  chipMuted?: boolean;
}) {
  const body = (
    <>
      {avatar !== undefined && <span className="hm-dash-row__avatar" aria-hidden="true">{avatar}</span>}
      <span className="hm-dash-row__main">
        <span className="hm-dash-row__title">{title}</span>
        {meta && <span className="hm-dash-row__meta">{meta}</span>}
      </span>
      {chip !== undefined && (
        <span className={`hm-dash-row__chip${chipMuted ? ' hm-dash-row__chip--muted' : ''}`}>{chip}</span>
      )}
    </>
  );
  return to ? <Link className="hm-dash-row" to={to}>{body}</Link> : <div className="hm-dash-row">{body}</div>;
}

function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className="hm-dash-progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function AbsenceChartWidget({ data }: { data: DashboardData }) {
  if (!data.absenceDaysByMonth) return <Restricted />;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthData = data.absenceDaysByMonth.map((m) => ({
    name: MONTH_NAMES[Number(m.month.slice(5)) - 1],
    Tage: m.days,
    current: m.month === currentMonth,
  }));
  return (
    <Link
      to="/abwesenheit/kalender?tab=jahr"
      aria-label="Zur Jahresansicht des Abwesenheitskalenders"
      style={{ display: 'block', height: 210, color: 'inherit', textDecoration: 'none' }}
    >
      <ResponsiveContainer>
        <BarChart data={monthData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-200)" vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
          <YAxis tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--blue-50)' }} />
          <Bar dataKey="Tage" radius={[5, 5, 0, 0]}>
            {monthData.map((m) => (
              <Cell
                key={m.name}
                fill={m.current ? 'var(--hm-accent)' : 'color-mix(in srgb, var(--hm-accent) 45%, var(--bg-surface))'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Link>
  );
}

type DepartmentRow = NonNullable<DashboardData['byDepartment']>[number];

/** Balken wie Beschriftung führen ins Organigramm mit dieser Abteilung als Filter (wie in Organisation → Struktur). */
export function DepartmentChartWidget({ data }: { data: DashboardData }) {
  const navigate = useNavigate();
  if (!data.byDepartment) return <Restricted />;
  const rows = data.byDepartment;
  const open = (row: DepartmentRow | undefined) => {
    if (row?.department_id != null) navigate(`/personal/organisation?tab=organigramm&abteilung=${row.department_id}`);
  };
  const tick = ({ x, y, payload }: { x: number; y: number; payload: { value: string; index: number } }) => {
    const row = rows[payload.index];
    const clickable = row?.department_id != null;
    return (
      <text
        x={x}
        y={y}
        dy={4}
        textAnchor="end"
        fontSize={12}
        fill="currentColor"
        style={{ cursor: clickable ? 'pointer' : undefined }}
        onClick={() => open(row)}
      >
        {payload.value}
      </text>
    );
  };
  return (
    <div style={{ height: Math.max(160, rows.length * 34) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 24, left: 30, bottom: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="department" width={110} tickLine={false} axisLine={false} tick={tick} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--blue-50)' }} />
          <Bar
            dataKey="count"
            name="Anzahl"
            radius={[0, 5, 5, 0]}
            barSize={16}
            style={{ cursor: 'pointer' }}
            onClick={(entry: unknown) => open((entry as { payload?: DepartmentRow }).payload)}
          >
            {rows.map((r, i) => (
              <Cell key={r.department} fill={`var(${ORG_ACCENTS[i % ORG_ACCENTS.length]})`} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AbsentTodayWidget({ data }: { data: DashboardData }) {
  if (!data.absentToday) return <Restricted />;
  if (data.absentToday.length === 0) return <Empty text="Heute sind alle an Bord. 🎉" />;
  return (
    <div className="hm-dash-list" style={{ maxHeight: 240, overflow: 'auto' }}>
      {data.absentToday.map((a) => (
        <Row
          key={`${a.id}-${a.date_to}`}
          to={`/abwesenheit/kalender?person=${a.id}`}
          avatar={initials(a.first_name, a.last_name)}
          title={`${a.first_name} ${a.last_name}`}
          meta={
            <span style={{ color: a.color, fontWeight: 560 }}>{a.type_name}</span>
          }
          chip={`bis ${shortDate(a.date_to)}`}
          chipMuted
        />
      ))}
    </div>
  );
}

export function InterviewsWidget({ data }: { data: DashboardData }) {
  if (!data.upcomingInterviews) return <Restricted />;
  if (data.upcomingInterviews.length === 0) return <Empty text="Keine geplanten Interviews." />;
  return (
    <div className="hm-dash-list">
      {data.upcomingInterviews.map((iv) => (
        <Row
          key={iv.id}
          to="/recruiting/interviews"
          avatar={initials(iv.first_name, iv.last_name)}
          title={`${iv.first_name} ${iv.last_name}`}
          meta={`${INTERVIEW_KIND_LABELS[iv.kind]} · ${iv.posting_title}`}
          chip={shortDate(iv.scheduled_at)}
        />
      ))}
    </div>
  );
}

export function MeetingsWidget({ data }: { data: DashboardData }) {
  if (!data.upcomingMeetings) return <Restricted />;
  if (data.upcomingMeetings.length === 0) return <Empty text="Keine Gespräche in den nächsten 3 Wochen." />;
  return (
    <div className="hm-dash-list">
      {data.upcomingMeetings.map((m) => (
        <Row
          key={m.id}
          to="/leistung/feedback"
          avatar={initials(m.first_name, m.last_name)}
          title={`${m.first_name} ${m.last_name}`}
          meta={FEEDBACK_MEETING_KIND_LABELS[m.kind]}
          chip={shortDate(m.scheduled_date)}
        />
      ))}
    </div>
  );
}

export function AnnouncementsWidget({ data }: { data: DashboardData }) {
  if (!data.activeAnnouncements) return <Restricted />;
  if (data.activeAnnouncements.length === 0) return <Empty text="Keine aktiven Ankündigungen." />;
  return (
    <div className="hm-dash-list">
      {data.activeAnnouncements.map((a) => (
        <Row
          key={a.id}
          to="/kommunikation/ankuendigungen"
          avatar={shortDate(a.publish_at).slice(0, 3)}
          title={a.title}
          meta={`veröffentlicht ${formatDate(a.publish_at.slice(0, 10))}`}
          chip={a.requires_ack ? 'Bestätigung' : undefined}
        />
      ))}
    </div>
  );
}

export function SurveysWidget({ data }: { data: DashboardData }) {
  if (!data.runningSurveys) return <Restricted />;
  if (data.runningSurveys.length === 0) return <Empty text="Keine laufenden Umfragen." />;
  return (
    <div className="hm-dash-list">
      {data.runningSurveys.map((s) => (
        <Row
          key={s.id}
          to="/kommunikation/umfragen"
          avatar={s.participations}
          title={s.title}
          meta={`${s.participations} Teilnahmen`}
          chip={`bis ${shortDate(s.date_to)}`}
          chipMuted
        />
      ))}
    </div>
  );
}

/** Lädt seine Daten selbst (Modul Verwaltung), statt /api/dashboard zu erweitern. */
export function OnboardingWidget() {
  const { data: processes } = useOnboardingProcesses('laufend', '');
  if (!processes || processes.length === 0) {
    return <Empty text="Aktuell ist niemand im On- oder Offboarding." />;
  }
  return (
    <div className="hm-dash-list">
      {processes.map((p) => {
        const done = p.done_tasks ?? 0;
        const total = p.total_tasks ?? 0;
        return (
          <Row
            key={p.id}
            to="/verwaltung/onboarding"
            avatar={initials(p.first_name, p.last_name)}
            title={`${p.first_name} ${p.last_name}`}
            meta={
              <span className="row" style={{ gap: 8 }}>
                <span style={{ flexShrink: 0 }}>
                  {ONBOARDING_KIND_LABELS[p.kind]}
                  {p.target_date ? ` · Stichtag ${shortDate(p.target_date)}` : ''}
                </span>
                <span style={{ flex: 1, minWidth: 40 }}><Progress value={done} max={total} /></span>
              </span>
            }
            chip={`${done}/${total}`}
          />
        );
      })}
    </div>
  );
}

/**
 * Lädt seine Daten selbst (Führungsfunktion, personengebunden statt an einen
 * Rechtebereich). Wer keine Führungskraft ist, sieht einen Hinweis statt
 * Zahlen, die für das Konto gar nicht gelten.
 */
export function LeadershipTeamWidget() {
  const { data: status } = useLeaderStatus();
  if (!status) return null;
  if (!status.is_leader) {
    return <Empty text="Sie sind derzeit keiner Führungsrolle zugewiesen." />;
  }
  const open = status.team_size - status.rated_count;
  return (
    <Link to="/fuehrung/mein-team" className="stack" style={{ gap: 10, color: 'inherit', textDecoration: 'none' }}>
      <div className="row row--between">
        <span style={{ fontWeight: 560 }}>{status.period?.label ?? 'Laufender Zeitraum'}</span>
        <span className="hm-dash-row__chip">{status.rated_count}/{status.team_size} bewertet</span>
      </div>
      <Progress value={status.rated_count} max={status.team_size} />
      <div className="hm-dash-row__meta">
        {open > 0 ? `${open} Person${open === 1 ? '' : 'en'} noch offen` : 'Alle bewertet für diesen Zeitraum.'}
      </div>
    </Link>
  );
}

/** Bis zu fünf Führungskräfte mit offenen Bewertungen, absteigend sortiert. */
export function LeadershipReportWidget() {
  const { data } = useLeadershipReport(null);
  if (!data) return null;
  if (data.leaders.length === 0) return <Empty text="Noch keine Führungskräfte eingerichtet." />;
  const open = data.leaders.filter((l) => l.open_count > 0).sort((a, b) => b.open_count - a.open_count);
  const done = data.leaders.length - open.length;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <Link to="/fuehrung/report" className="stack" style={{ gap: 8, color: 'inherit', textDecoration: 'none' }}>
        <div className="row row--between">
          <span style={{ fontWeight: 560 }}>{data.period.label}</span>
          <span className="hm-dash-row__chip">{done}/{data.leaders.length} vollständig</span>
        </div>
        <Progress value={done} max={data.leaders.length} />
      </Link>
      {open.length === 0 ? (
        <Empty text="Alle Führungskräfte haben ihr Team bewertet. 🎉" />
      ) : (
        <div className="hm-dash-list">
          {open.slice(0, 5).map((l) => (
            <Row
              key={l.employee_id}
              to="/fuehrung/report"
              avatar={initials(l.first_name, l.last_name)}
              title={`${l.first_name} ${l.last_name}`}
              chip={`${l.open_count} offen`}
              chipMuted
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Lizenzzustand aus dem Auth-Kontext (Login, /api/auth/me) — keine eigene
 * Abfrage. Der Sprung zur Lizenzseite hängt am Bereich `einstellungen`; ohne
 * ihn bleibt die Kachel reine Anzeige.
 */
export function LicenseWidget() {
  const { license, can } = useAuth();
  if (!license) return <Empty text="Lizenzzustand nicht verfügbar." />;
  const runtime =
    license.state === 'entwicklung'
      ? 'keine Prüfung'
      : license.state === 'expired'
        ? 'Nur-Lese-Betrieb'
        : license.perpetual
          ? 'unbefristet'
          : `${formatDate(license.valid_until)} · ${remainingLabel(license.days_left)}`;
  const body = (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row row--between">
        <Badge tone={licenseStateTone(license)}>{LICENSE_STATE_LABELS[license.state]}</Badge>
        <span className="hm-dash-row__meta">{license.customer ?? ''}</span>
      </div>
      <div className="row row--between">
        <span>{license.state === 'grace' ? 'Kulanz bis' : 'Gültig bis'}</span>
        <span className="hm-dash-row__chip hm-dash-row__chip--muted">
          {license.state === 'grace'
            ? `${formatDate(license.grace_until)} · ${remainingLabel(license.days_left)}`
            : runtime}
        </span>
      </div>
      <div className="row row--between">
        <span>Plätze</span>
        <span className="hm-dash-row__chip">{seatsLabel(license)}</span>
      </div>
    </div>
  );
  if (!can('einstellungen')) return body;
  return (
    <Link to={LICENSE_PATH} style={{ color: 'inherit', textDecoration: 'none' }}>
      {body}
    </Link>
  );
}

export function BirthdaysWidget({ data }: { data: DashboardData }) {
  if (!data.upcomingBirthdays) return <Restricted />;
  if (data.upcomingBirthdays.length === 0) return <Empty text="Keine Geburtstage hinterlegt." />;
  return (
    <div className="hm-dash-list">
      {data.upcomingBirthdays.map((b) => (
        <Row
          key={b.id}
          to={`/personal/mitarbeitende/${b.id}`}
          avatar={initials(b.first_name, b.last_name)}
          title={`${b.first_name} ${b.last_name}`}
          chip={shortDate(b.next_birthday)}
        />
      ))}
    </div>
  );
}
