import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Users, Send, Stethoscope, FolderClock, Wallet, CalendarDays,
  Megaphone, BarChart3, Cake, MessagesSquare, Briefcase, CalendarClock,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  formatDate, FEEDBACK_MEETING_KIND_LABELS, INTERVIEW_KIND_LABELS,
  type FeedbackMeetingKind, type InterviewKind,
} from '@hrmonic/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Card, PageHeader, Spinner, StatCard } from '../../components/ui';

interface DashboardData {
  stats: {
    headcount: number;
    hiresYtd: number;
    pendingAbsences: number;
    missingSickNotes: number;
    expiringDocuments: number;
    openSalaryRequests: number;
    openPositions: number;
    activeApplications: number;
    upcomingInterviewsCount: number;
    absentTodayCount: number;
  };
  absentToday: { id: number; first_name: string; last_name: string; type_name: string; color: string; date_to: string }[];
  byDepartment: { department: string; count: number }[];
  absenceDaysByMonth: { month: string; days: number }[];
  upcomingMeetings: { id: number; kind: FeedbackMeetingKind; scheduled_date: string; first_name: string; last_name: string }[];
  upcomingBirthdays: { id: number; first_name: string; last_name: string; birth_date: string; next_birthday: string }[];
  activeAnnouncements: { id: number; title: string; publish_at: string; requires_ack: number }[];
  runningSurveys: { id: number; title: string; date_to: string; participations: number }[];
  upcomingInterviews: { id: number; kind: InterviewKind; scheduled_at: string; posting_title: string; first_name: string; last_name: string }[];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
  });

  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 17 ? 'Guten Tag' : 'Guten Abend';

  if (isLoading || !data) return <Spinner center />;
  const { stats } = data;

  const monthData = data.absenceDaysByMonth.map((m) => ({
    name: MONTH_NAMES[Number(m.month.slice(5)) - 1],
    Tage: m.days,
  }));

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user?.name?.split(' ')[0] ?? ''} 👋`}
        subtitle="Hier ist der Überblick über Ihre Personalarbeit."
      />

      <div className="grid-stats">
        <StatCard label="Aktive Mitarbeitende" value={stats.headcount} icon={<Users size={15} />} sub={`${stats.hiresYtd} Neueintritte dieses Jahr`} onClick={() => navigate('/personal/mitarbeitende')} />
        <StatCard label="Heute abwesend" value={stats.absentTodayCount} icon={<CalendarDays size={15} />} onClick={() => navigate('/abwesenheit/kalender')} />
        <StatCard label="Offene Anträge" value={stats.pendingAbsences} icon={<Send size={15} />} sub="Abwesenheit" onClick={() => navigate('/abwesenheit/antraege')} />
        <StatCard label="Fehlende AU" value={stats.missingSickNotes} icon={<Stethoscope size={15} />} sub={stats.missingSickNotes > 0 ? 'Frist überschritten' : 'Alles fristgerecht'} onClick={() => navigate('/abwesenheit/krankmeldungen')} />
        <StatCard label="Ablaufende Dokumente" value={stats.expiringDocuments} icon={<FolderClock size={15} />} sub="innerhalb 30 Tagen" onClick={() => navigate('/personal/dokumente')} />
        <StatCard label="Gehaltsanträge" value={stats.openSalaryRequests} icon={<Wallet size={15} />} sub="zur Entscheidung" onClick={() => navigate('/verguetung/gehaelter')} />
        <StatCard label="Offene Stellen" value={stats.openPositions} icon={<Briefcase size={15} />} sub={`${stats.activeApplications} aktive Bewerbungen`} onClick={() => navigate('/recruiting/stellen')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16, alignItems: 'start' }}>
        <div className="stack">
          <Card title="Genehmigte Abwesenheitstage je Monat">
            <div style={{ height: 220 }}>
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
          </Card>

          <Card title="Mitarbeitende je Abteilung">
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
          </Card>

          <Card
            title={
              <span className="row"><CalendarDays size={16} /> Heute abwesend</span>
            }
            flush
          >
            {data.absentToday.length === 0 ? (
              <p style={{ padding: 16, color: 'var(--text-muted)' }}>Heute sind alle an Bord.</p>
            ) : (
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
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title={<span className="row"><MessagesSquare size={16} /> Nächste Gespräche</span>}>
            <div className="stack" style={{ gap: 10 }}>
              {data.upcomingMeetings.length === 0 && (
                <p style={{ color: 'var(--text-muted)' }}>Keine Gespräche in den nächsten 3 Wochen.</p>
              )}
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
          </Card>

          <Card title={<span className="row"><CalendarClock size={16} /> Anstehende Interviews</span>}>
            <div className="stack" style={{ gap: 10 }}>
              {data.upcomingInterviews.length === 0 && (
                <p style={{ color: 'var(--text-muted)' }}>Keine geplanten Interviews.</p>
              )}
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
          </Card>

          <Card title={<span className="row"><Megaphone size={16} /> Aktive Ankündigungen</span>}>
            <div className="stack" style={{ gap: 10 }}>
              {data.activeAnnouncements.length === 0 && (
                <p style={{ color: 'var(--text-muted)' }}>Keine aktiven Ankündigungen.</p>
              )}
              {data.activeAnnouncements.map((a) => (
                <Link key={a.id} to="/kommunikation/ankuendigungen" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div className="row row--between">
                    <span style={{ fontWeight: 550 }}>{a.title}</span>
                    {a.requires_ack ? <Badge tone="blue">Bestätigung</Badge> : null}
                  </div>
                </Link>
              ))}
            </div>
          </Card>

          <Card title={<span className="row"><BarChart3 size={16} /> Laufende Umfragen</span>}>
            <div className="stack" style={{ gap: 10 }}>
              {data.runningSurveys.length === 0 && (
                <p style={{ color: 'var(--text-muted)' }}>Keine laufenden Umfragen.</p>
              )}
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
          </Card>

          <Card title={<span className="row"><Cake size={16} /> Nächste Geburtstage</span>}>
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
          </Card>
        </div>
      </div>
    </>
  );
}
