import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { Briefcase, Users, UserCheck, CalendarClock, Timer, Layers } from 'lucide-react';
import { CANDIDATE_SOURCE_LABELS, type CandidateSource } from '@ohrganize/shared';
import { Card, PageHeader, Spinner, StatCard, EmptyState } from '../../components/ui';
import { useAnalytics } from './api';

function sourceLabel(key: string): string {
  return CANDIDATE_SOURCE_LABELS[key as CandidateSource] ?? key;
}

export function AnalysePage() {
  const { data, isLoading } = useAnalytics();

  if (isLoading || !data) return <Spinner center />;
  const { stats, funnel, bySource } = data;

  const funnelData = funnel.map((f) => ({ name: f.name, Anzahl: f.count, color: f.color }));
  const totalApplications = bySource.reduce((s, r) => s + r.count, 0);

  return (
    <>
      <PageHeader title="Analyse" subtitle="Kennzahlen zur Recruiting-Performance" />

      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <StatCard label="Offene Stellen" value={stats.openPostings} icon={<Briefcase size={15} />} sub={`${stats.openSeats} zu besetzende Plätze`} />
        <StatCard label="Aktive Bewerbungen" value={stats.activeApplications} icon={<Users size={15} />} />
        <StatCard label="Einstellungen (Jahr)" value={stats.hiresYtd} icon={<UserCheck size={15} />} />
        <StatCard label="Anstehende Interviews" value={stats.upcomingInterviews} icon={<CalendarClock size={15} />} />
        <StatCard label="Ø Time-to-Hire" value={stats.avgTimeToHire !== null ? `${stats.avgTimeToHire} T` : '—'} icon={<Timer size={15} />} sub="Eingang → Einstellung" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, alignItems: 'start' }}>
        <Card title={<span className="row"><Layers size={16} /> Bewerbungstrichter</span>}>
          <div style={{ height: Math.max(200, funnelData.length * 40) }}>
            <ResponsiveContainer>
              <BarChart data={funnelData} layout="vertical" margin={{ top: 0, right: 28, left: 20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-200)" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={120} tickLine={false} axisLine={false} style={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: 'var(--blue-50)' }} />
                <Bar dataKey="Anzahl" radius={[0, 4, 4, 0]} barSize={18}>
                  {funnelData.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Bewerbungen je Kanal" flush>
          {bySource.length === 0 ? (
            <EmptyState title="Noch keine Bewerbungen" />
          ) : (
            <div className="hm-table-wrap">
              <table className="hm-table">
                <thead>
                  <tr>
                    <th>Kanal</th>
                    <th style={{ textAlign: 'right' }}>Bewerbungen</th>
                    <th style={{ textAlign: 'right' }}>Anteil</th>
                    <th style={{ textAlign: 'right' }}>Eingestellt</th>
                  </tr>
                </thead>
                <tbody>
                  {bySource.map((r) => (
                    <tr key={r.source}>
                      <td style={{ fontWeight: 550 }}>{sourceLabel(r.source)}</td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                        {totalApplications > 0 ? Math.round((r.count / totalApplications) * 100) : 0}%
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--success)' }}>{r.hired}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
