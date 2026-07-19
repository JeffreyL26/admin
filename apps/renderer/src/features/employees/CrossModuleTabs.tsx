import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ExternalLink, Wallet } from 'lucide-react';
import {
  ABSENCE_STATUS_LABELS,
  formatDate,
  formatEuro,
  SALARY_COMPONENT_LABELS,
  type AbsenceBalance,
  type AbsenceRequest,
  type SalaryComponentKind,
} from '@hrmonic/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Spinner, StatCard } from '../../components/ui';

/**
 * Modulübergreifende Tabs der Personalakte: Abwesenheit und Vergütung werden
 * hier nur GELESEN (die Pflege bleibt in den Fachmodulen) — mit Absprung.
 */

const STATUS_TONES: Record<AbsenceRequest['status'], 'blue' | 'green' | 'red' | 'neutral'> = {
  beantragt: 'blue',
  genehmigt: 'green',
  abgelehnt: 'red',
  storniert: 'neutral',
};

export function EmployeeAbsenceTab({ employeeId }: { employeeId: number }) {
  const navigate = useNavigate();
  const [year, setYear] = useState(new Date().getFullYear());

  const { data: balance } = useQuery({
    queryKey: ['absences', 'balance', employeeId, year],
    queryFn: () =>
      api.get<{ balance: AbsenceBalance }>(`/api/absences/balance/${employeeId}/${year}`),
    select: (d) => d.balance,
  });
  const { data: requests, isLoading } = useQuery({
    queryKey: ['absences', 'requests', 'employee', employeeId],
    queryFn: () =>
      api.get<{ requests: AbsenceRequest[] }>(`/api/absences/requests?employee_id=${employeeId}`),
    select: (d) => d.requests,
  });

  return (
    <div className="stack">
      <div className="row row--between">
        <select
          className="hm-select"
          style={{ width: 110 }}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[year - 1, year, year + 1].filter((v, i, a) => a.indexOf(v) === i).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button
          className="hm-btn hm-btn--secondary hm-btn--sm"
          onClick={() => navigate('/abwesenheit/antraege')}
        >
          <ExternalLink size={14} /> Zum Abwesenheitsmodul
        </button>
      </div>

      <div className="grid-stats" style={{ marginBottom: 0 }}>
        <StatCard label={`Anspruch ${year}`} value={balance ? balance.entitlement : '—'} sub={balance && balance.carryover > 0 ? `+ ${balance.carryover} Übertrag` : undefined} icon={<CalendarDays size={15} />} />
        <StatCard label="Genommen" value={balance ? balance.taken : '—'} />
        <StatCard label="Verplant" value={balance ? balance.planned : '—'} />
        <StatCard label="Rest" value={balance ? balance.remaining : '—'} />
      </div>

      <Card title="Abwesenheiten" flush>
        {isLoading ? (
          <Spinner center />
        ) : (requests ?? []).length === 0 ? (
          <EmptyState title="Keine Abwesenheiten erfasst" />
        ) : (
          <div className="hm-table-wrap" style={{ maxHeight: 360 }}>
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Zeitraum</th>
                  <th className="num">Tage</th>
                  <th>Status</th>
                  <th>Kommentar</th>
                </tr>
              </thead>
              <tbody>
                {(requests ?? []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span
                        className="hm-badge"
                        style={{ background: `${r.type_color}22`, color: r.type_color }}
                      >
                        {r.type_name}
                      </span>
                    </td>
                    <td>
                      {formatDate(r.date_from)} – {formatDate(r.date_to)}
                    </td>
                    <td className="num">{r.days_counted}</td>
                    <td>
                      <Badge tone={STATUS_TONES[r.status]}>{ABSENCE_STATUS_LABELS[r.status]}</Badge>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.comment ?? r.rejection_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

interface SalaryInfo {
  monthly_gross_cents: number;
  components: {
    id: number;
    kind: SalaryComponentKind;
    amount_cents: number;
    monthly_cents: number;
    valid_from: string;
    note: string | null;
  }[];
}

export function EmployeeCompensationTab({ employeeId }: { employeeId: number }) {
  const navigate = useNavigate();
  const { data: salary, isLoading } = useQuery({
    queryKey: ['compensation', 'salary', employeeId],
    queryFn: () =>
      api.get<{ salary: SalaryInfo }>(`/api/compensation/employees/${employeeId}/salary`),
    select: (d) => d.salary,
  });

  if (isLoading) return <Spinner center />;

  return (
    <div className="stack">
      <div className="row row--between">
        <StatCard
          label="Aktuelles Monatsbrutto"
          value={salary ? formatEuro(salary.monthly_gross_cents) : '—'}
          icon={<Wallet size={15} />}
        />
        <button
          className="hm-btn hm-btn--secondary hm-btn--sm"
          onClick={() => navigate('/verguetung/gehaelter')}
        >
          <ExternalLink size={14} /> Zum Vergütungsmodul
        </button>
      </div>

      <Card title="Aktive Komponenten" flush>
        {(salary?.components ?? []).length === 0 ? (
          <EmptyState title="Keine Gehaltskomponenten hinterlegt" />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th>Komponente</th>
                  <th className="num">Monatswert</th>
                  <th>Gültig seit</th>
                  <th>Notiz</th>
                </tr>
              </thead>
              <tbody>
                {(salary?.components ?? []).map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 550 }}>{SALARY_COMPONENT_LABELS[c.kind] ?? c.kind}</td>
                    <td
                      className="num"
                      style={c.monthly_cents < 0 ? { color: 'var(--danger)' } : undefined}
                    >
                      {formatEuro(c.monthly_cents)}
                    </td>
                    <td>{formatDate(c.valid_from)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{c.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
