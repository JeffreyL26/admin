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

const days = (n: number) => n.toLocaleString('de-DE');

/**
 * Herleitung der vier Kacheln: Anspruch und Übertrag als Rechenweg, dann je
 * saldowirksamem Antrag der Anteil an „genommen“ (bis heute) und „verplant“
 * (ab morgen sowie alles Beantragte). Die Spaltensummen sind die Kacheln.
 */
function BalanceBreakdown({ balance, breakdown }: { balance: AbsenceBalance; breakdown: AbsenceBalanceBreakdown }) {
  const { year } = balance;
  const prorated = breakdown.counted_months < 12;
  const expired = breakdown.carryover_raw - balance.carryover;
  const takenLabel = breakdown.taken_until ? `Genommen bis ${formatDate(breakdown.taken_until)}` : 'Genommen';
  const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

  return (
    <Card title={`Aufschlüsselung ${year}`} flush>
      <div className="stack" style={{ gap: 6, padding: '12px 16px', fontSize: 'var(--text-sm)' }}>
        <div className="row row--between">
          <span>
            Jahresanspruch laut Personalakte
            {prorated && (
              <span style={muted}> · {breakdown.counted_months} von 12 Monaten beschäftigt, anteilig</span>
            )}
          </span>
          <span className="num" style={{ fontWeight: 650 }}>
            {prorated
              ? `${days(breakdown.annual_leave_days)} × ${breakdown.counted_months}/12 = ${days(balance.entitlement)}`
              : days(balance.entitlement)}
          </span>
        </div>
        <div className="row row--between">
          <span>
            Übertrag aus {year - 1}
            {expired > 0 && (
              <span style={muted}>
                {' '}· {days(expired)} Tage am {formatDate(breakdown.carryover_deadline)} verfallen
              </span>
            )}
          </span>
          <span className="num" style={{ fontWeight: 650 }}>+ {days(balance.carryover)}</span>
        </div>
      </div>

      {breakdown.requests.length === 0 ? (
        <div style={{ ...muted, padding: '0 16px 14px' }}>Keine saldowirksamen Anträge in {year}.</div>
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Antrag</th>
                <th>Zeitraum</th>
                <th className="num">Tage {year}</th>
                <th className="num">{takenLabel}</th>
                <th className="num">Verplant</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.requests.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="hm-badge" style={{ background: `${r.type_color}22`, color: r.type_color }}>
                        {r.type_name}
                      </span>
                      <Badge tone={STATUS_TONES[r.status]}>{ABSENCE_STATUS_LABELS[r.status]}</Badge>
                    </span>
                  </td>
                  <td>
                    {formatDate(r.date_from)} – {formatDate(r.date_to)}
                  </td>
                  <td className="num">{days(r.days)}</td>
                  <td className="num">{r.taken > 0 ? days(r.taken) : <span style={muted}>—</span>}</td>
                  <td className="num">{r.planned > 0 ? days(r.planned) : <span style={muted}>—</span>}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 650 }}>
                <td colSpan={3}>Summe</td>
                <td className="num">{days(balance.taken)}</td>
                <td className="num">{days(balance.planned)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div
        className="row row--between"
        style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 'var(--text-sm)' }}
      >
        <span style={muted}>
          Rest = Anspruch + Übertrag − genommen − verplant
        </span>
        <span className="num" style={{ fontWeight: 650 }}>
          {days(balance.entitlement)} + {days(balance.carryover)} − {days(balance.taken)} − {days(balance.planned)} ={' '}
          {days(balance.remaining)}
        </span>
      </div>
    </Card>
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

export function EmployeeCompensationTab({ employeeId, employeeName }: { employeeId: number; employeeName: string }) {
  const navigate = useNavigate();
  const { data: salary, isLoading } = useQuery({
    queryKey: ['compensation', 'salary', employeeId],
    queryFn: () =>
      api.get<{ salary: SalaryInfo }>(`/api/compensation/employees/${employeeId}/salary`),
    select: (d) => d.salary,
  });

  if (isLoading) return <Spinner center />;

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
