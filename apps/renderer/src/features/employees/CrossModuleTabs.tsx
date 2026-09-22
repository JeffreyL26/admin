import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ExternalLink, Receipt, Wallet } from 'lucide-react';
import {
  ABSENCE_STATUS_LABELS,
  formatDate,
  formatEuro,
  SALARY_COMPONENT_LABELS,
  type AbsenceBalance,
  type AbsenceBalanceBreakdown,
  type AbsenceRequest,
  type SalaryComponentKind,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Spinner, StatCard } from '../../components/ui';
import { Select } from '../../components/Select';
import { backToState } from '../../lib/backTo';

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
        <Select
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
        </Select>
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

      {balance?.breakdown && <BalanceBreakdown balance={balance} breakdown={balance.breakdown} />}

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

const days = (n: number) => `${n.toLocaleString('de-DE')} ${n === 1 ? 'Tag' : 'Tage'}`;

/**
 * Wann was genommen bzw. verplant ist: die Zeitabschnitte hinter den Kacheln.
 * Ein genehmigter Antrag, der über heute hinausläuft, steht mit seinem
 * bisherigen Teil unter „Genommen“ und dem Rest unter „Verplant“.
 */
function BalanceBreakdown({ balance, breakdown }: { balance: AbsenceBalance; breakdown: AbsenceBalanceBreakdown }) {
  const { year } = balance;
  const taken = breakdown.segments.filter((s) => s.kind === 'taken');
  const planned = breakdown.segments.filter((s) => s.kind === 'planned');
  const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

  const section = (title: string, sum: number, items: typeof taken, empty: string) => (
    <div style={{ padding: '12px 16px' }}>
      <div className="row row--between" style={{ marginBottom: 8 }}>
        <span style={{ fontWeight: 650 }}>{title}</span>
        <span className="num" style={{ fontWeight: 650 }}>{days(sum)}</span>
      </div>
      {items.length === 0 ? (
        <div style={muted}>{empty}</div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {items.map((s) => (
            <div key={`${s.request_id}-${s.kind}`} className="row row--between" style={{ fontSize: 'var(--text-sm)' }}>
              <span className="row" style={{ gap: 8 }}>
                <span className="hm-badge" style={{ background: `${s.type_color}22`, color: s.type_color }}>
                  {s.type_name}
                </span>
                <span>
                  {formatDate(s.date_from)} – {formatDate(s.date_to)}
                </span>
                {s.status === 'beantragt' && <Badge tone={STATUS_TONES.beantragt}>{ABSENCE_STATUS_LABELS.beantragt}</Badge>}
              </span>
              <span className="num">{days(s.days)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Card title={`Aufschlüsselung ${year}`} flush>
      {section(
        breakdown.taken_until ? `Genommen bis ${formatDate(breakdown.taken_until)}` : 'Genommen',
        balance.taken,
        taken,
        'Bisher nichts genommen.',
      )}
      <div style={{ borderTop: '1px solid var(--border)' }} />
      {section('Verplant', balance.planned, planned, 'Nichts verplant oder beantragt.')}
    </Card>
  );
}

interface SalaryInfo {
  employee_type: string;
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

export function EmployeeCompensationTab({ employeeId, employeeName }: { employeeId: number; employeeName: string }) {
  const navigate = useNavigate();
  const { data: salary, isLoading } = useQuery({
    queryKey: ['compensation', 'salary', employeeId],
    queryFn: () =>
      api.get<{ salary: SalaryInfo }>(`/api/compensation/employees/${employeeId}/salary`),
    select: (d) => d.salary,
  });

  if (isLoading) return <Spinner center />;

  // Freiberufler:innen haben keine Gehaltskomponenten (Backend: 400); ihre
  // Vergütung sind Honorarsätze und Rechnungen unter Freiberufler & Honorare.
  if (salary?.employee_type === 'freiberufler') {
    return (
      <Card>
        <EmptyState
          icon={<Receipt size={40} />}
          title="Vergütung über Honorare"
          hint="Für Freiberufler:innen gibt es keine Gehaltskomponenten. Honorarsätze und Rechnungen stehen im Bereich Freiberufler & Honorare."
          action={
            <button className="hm-btn hm-btn--primary" onClick={() => navigate('/verguetung/honorare')}>
              <Receipt size={16} /> Zu den Honoraren
            </button>
          }
        />
      </Card>
    );
  }

  // Absprung in die Vergütungsseite DIESER Person; von dort führt „Zurück“
  // wieder in diesen Tab statt in die Gehälterübersicht.
  const openSalary = () =>
    navigate(`/verguetung/gehaelter?person=${employeeId}`, {
      state: backToState(`/personal/mitarbeitende/${employeeId}?tab=verguetung`, `Zurück zu ${employeeName}`),
    });

  return (
    <div className="stack">
      <div className="row row--between">
        <StatCard
          label="Aktuelles Monatsbrutto"
          value={salary ? formatEuro(salary.monthly_gross_cents) : '—'}
          icon={<Wallet size={15} />}
          onClick={openSalary}
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
