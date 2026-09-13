import React from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  formatDate, FEEDBACK_MEETING_KIND_LABELS, INTERVIEW_KIND_LABELS, ONBOARDING_KIND_LABELS,
} from '@ohrganize/shared';
import { useOnboardingProcesses } from '../admin/api';
import { useLeaderStatus, useLeadershipReport } from '../leadership/api';
import { useAuth } from '../../auth/AuthContext';
import { Badge } from '../../components/ui';
import {
  LICENSE_PATH, LICENSE_STATE_LABELS, licenseStateTone, remainingLabel, seatsLabel,
} from '../settings/license';
import type { DashboardData } from './api';

/* Reine Widget-Inhalte des Dashboards — der Card-Rahmen (Titel, Icon,
   Bearbeitungs-Controls) kommt aus DashboardPage. */

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function Empty({ text, padded }: { text: string; padded?: boolean }) {
  return <p style={{ color: 'var(--text-muted)', margin: 0, padding: padded ? 16 : 0 }}>{text}</p>;
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

export function AbsenceChartWidget({ data }: { data: DashboardData }) {
  if (!data.absenceDaysByMonth) return <Restricted />;
  const monthData = data.absenceDaysByMonth.map((m) => ({
    name: MONTH_NAMES[Number(m.month.slice(5)) - 1],
    Tage: m.days,
  }));
  return (
    <div style={{ height: 210 }}>
      <ResponsiveContainer>
        <BarChart data={monthData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-200)" vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
          <YAxis tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
          <Tooltip cursor={{ fill: 'var(--blue-50)' }} />
          <Bar dataKey="Tage" fill="var(--brand-primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DepartmentChartWidget({ data }: { data: DashboardData }) {
  if (!data.byDepartment) return <Restricted />;
  return (
    <div style={{ height: Math.max(160, data.byDepartment.length * 34) }}>
      <ResponsiveContainer>
        <BarChart data={data.byDepartment} layout="vertical" margin={{ top: 0, right: 24, left: 30, bottom: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="department" width={110} tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
          <Tooltip cursor={{ fill: 'var(--blue-50)' }} />
          <Bar dataKey="count" name="Anzahl" fill="var(--brand-navy)" radius={[0, 4, 4, 0]} barSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Wird als flush-Card gerendert (Tabelle bis an den Rand) — Leertext deshalb selbst gepolstert. */
export function AbsentTodayWidget({ data }: { data: DashboardData }) {
  if (!data.absentToday) return <Restricted padded />;
  if (data.absentToday.length === 0) {
    return <Empty text="Heute sind alle an Bord. 🎉" padded />;
  }
  return (
    <div className="hm-table-wrap" style={{ maxHeight: 240 }}>
      <table className="hm-table">
        <tbody>
          {data.absentToday.map((a) => (
            <tr key={a.id}>
              <td style={{ fontWeight: 550 }}>{a.first_name} {a.last_name}</td>
              <td>
                <span className="hm-badge" style={{ background: `${a.color}22`, color: a.color }}>
                  {a.type_name}
                </span>
              </td>
              <td style={{ color: 'var(--text-muted)' }}>bis {formatDate(a.date_to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InterviewsWidget({ data }: { data: DashboardData }) {
  if (!data.upcomingInterviews) return <Restricted />;
  if (data.upcomingInterviews.length === 0) return <Empty text="Keine geplanten Interviews." />;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {data.upcomingInterviews.map((iv) => (
        <Link key={iv.id} to="/recruiting/interviews" style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="row row--between">
            <span style={{ fontWeight: 550 }}>{iv.first_name} {iv.last_name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {INTERVIEW_KIND_LABELS[iv.kind]} · {formatDate(iv.scheduled_at.slice(0, 10))}
            </span>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{iv.posting_title}</div>
        </Link>
      ))}
    </div>
  );
}

export function MeetingsWidget({ data }: { data: DashboardData }) {
  if (!data.upcomingMeetings) return <Restricted />;
  if (data.upcomingMeetings.length === 0) return <Empty text="Keine Gespräche in den nächsten 3 Wochen." />;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {data.upcomingMeetings.map((m) => (
        <Link key={m.id} to="/leistung/feedback" style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="row row--between">
            <span style={{ fontWeight: 550 }}>{m.first_name} {m.last_name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {FEEDBACK_MEETING_KIND_LABELS[m.kind]} · {formatDate(m.scheduled_date)}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function AnnouncementsWidget({ data }: { data: DashboardData }) {
  if (!data.activeAnnouncements) return <Restricted />;
  if (data.activeAnnouncements.length === 0) return <Empty text="Keine aktiven Ankündigungen." />;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {data.activeAnnouncements.map((a) => (
        <Link key={a.id} to="/kommunikation/ankuendigungen" style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="row row--between">
            <span style={{ fontWeight: 550 }}>{a.title}</span>
            {a.requires_ack ? <span className="hm-badge hm-badge--blue">Bestätigung</span> : null}
          </div>
        </Link>
      ))}
    </div>
  );
}

export function SurveysWidget({ data }: { data: DashboardData }) {
  if (!data.runningSurveys) return <Restricted />;
  if (data.runningSurveys.length === 0) return <Empty text="Keine laufenden Umfragen." />;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {data.runningSurveys.map((s) => (
        <Link key={s.id} to="/kommunikation/umfragen" style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="row row--between">
            <span style={{ fontWeight: 550 }}>{s.title}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {s.participations} Teilnahmen · bis {formatDate(s.date_to)}
            </span>
          </div>
        </Link>
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
    <div className="stack" style={{ gap: 10 }}>
      {processes.map((p) => (
        <Link key={p.id} to="/verwaltung/onboarding" style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="row row--between">
            <span style={{ fontWeight: 550 }}>{p.first_name} {p.last_name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              {ONBOARDING_KIND_LABELS[p.kind]} · {p.done_tasks ?? 0}/{p.total_tasks ?? 0} erledigt
            </span>
          </div>
          {p.target_date && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
              Stichtag {formatDate(p.target_date)}
            </div>
          )}
        </Link>
      ))}
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
    <Link to="/fuehrung/mein-team" style={{ color: 'inherit', textDecoration: 'none' }}>
      <div className="row row--between">
        <span style={{ fontWeight: 550 }}>{status.period?.label ?? 'Laufender Zeitraum'}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          {status.rated_count}/{status.team_size} bewertet
        </span>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
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
      <Link to="/fuehrung/report" style={{ color: 'inherit', textDecoration: 'none' }}>
        <div className="row row--between">
          <span style={{ fontWeight: 550 }}>{data.period.label}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            {done}/{data.leaders.length} vollständig
          </span>
        </div>
      </Link>
      {open.length === 0 ? (
        <Empty text="Alle Führungskräfte haben ihr Team bewertet. 🎉" />
      ) : (
        open.slice(0, 5).map((l) => (
          <Link key={l.employee_id} to="/fuehrung/report" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row row--between">
              <span>{l.first_name} {l.last_name}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{l.open_count} offen</span>
            </div>
          </Link>
        ))
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
  const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
  const runtime =
    license.state === 'entwicklung'
      ? 'keine Prüfung'
      : license.state === 'expired'
        ? 'Nur-Lese-Betrieb'
        : `${formatDate(license.valid_until)} · ${remainingLabel(license.days_left)}`;
  const body = (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row row--between">
        <Badge tone={licenseStateTone(license)}>{LICENSE_STATE_LABELS[license.state]}</Badge>
        <span style={muted}>{license.customer ?? ''}</span>
      </div>
      <div className="row row--between">
        <span>{license.state === 'grace' ? 'Kulanz bis' : 'Gültig bis'}</span>
        <span style={muted}>
          {license.state === 'grace'
            ? `${formatDate(license.grace_until)} · ${remainingLabel(license.days_left)}`
            : runtime}
        </span>
      </div>
      <div className="row row--between">
        <span>Plätze</span>
        <span style={muted}>{seatsLabel(license)}</span>
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
    <div className="stack" style={{ gap: 10 }}>
      {data.upcomingBirthdays.map((b) => (
        <div key={b.id} className="row row--between">
          <span>{b.first_name} {b.last_name}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            {formatDate(b.next_birthday)}
          </span>
        </div>
      ))}
    </div>
  );
}
