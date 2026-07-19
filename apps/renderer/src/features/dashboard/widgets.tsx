import React from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  formatDate, FEEDBACK_MEETING_KIND_LABELS, INTERVIEW_KIND_LABELS,
} from '@hrmonic/shared';
import type { DashboardData } from './api';

/* Reine Widget-Inhalte des Dashboards — der Card-Rahmen (Titel, Icon,
   Bearbeitungs-Controls) kommt aus DashboardPage. */

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function Empty({ text }: { text: string }) {
  return <p style={{ color: 'var(--text-muted)', margin: 0 }}>{text}</p>;
}

export function AbsenceChartWidget({ data }: { data: DashboardData }) {
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
  if (data.absentToday.length === 0) {
    return <p style={{ color: 'var(--text-muted)', margin: 0, padding: 16 }}>Heute sind alle an Bord. 🎉</p>;
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

export function BirthdaysWidget({ data }: { data: DashboardData }) {
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
