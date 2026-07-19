import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarX2 } from 'lucide-react';
import { formatDate, ABSENCE_STATUS_LABELS, type CalendarEmployee } from '@hrmonic/shared';
import { Card, EmptyState, PageHeader, Spinner, Tabs } from '../../components/ui';
import { useAbsenceTypes, useCalendar, useDepartments, useTeams, type CalendarData } from './api';

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
const WEEKDAY_LETTERS = ['S', 'M', 'D', 'M', 'D', 'F', 'S'];

function eachDayLocal(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const isWeekendDay = (date: string) => {
  const wd = weekdayOf(date);
  return wd === 0 || wd === 6;
};

export function CalendarPage() {
  const now = new Date();
  const [view, setView] = useState<'monat' | 'jahr'>('monat');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [teamId, setTeamId] = useState<number | null>(null);

  const { data, isLoading } = useCalendar(year, view === 'monat' ? month : null, departmentId, teamId);
  const { data: types } = useAbsenceTypes();
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();

  const prev = () => {
    if (view === 'jahr') return setYear(year - 1);
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else setMonth(month - 1);
  };
  const next = () => {
    if (view === 'jahr') return setYear(year + 1);
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else setMonth(month + 1);
  };

  return (
    <>
      <PageHeader
        title="Abwesenheitskalender"
        subtitle="Wer ist wann abwesend — inklusive Feiertagen, Betriebsruhe und Team-Konflikten."
        actions={
          <div className="row">
            <button className="hm-btn hm-btn--secondary hm-btn--icon" onClick={prev} aria-label="Zurück">
              <ChevronLeft size={16} />
            </button>
            <span style={{ fontWeight: 650, minWidth: 150, textAlign: 'center' }}>
              {view === 'monat' ? `${MONTH_NAMES[month - 1]} ${year}` : `Jahr ${year}`}
            </span>
            <button className="hm-btn hm-btn--secondary hm-btn--icon" onClick={next} aria-label="Weiter">
              <ChevronRight size={16} />
            </button>
          </div>
        }
      />
      <div className="row row--between" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
        <Tabs
          tabs={[
            { key: 'monat', label: 'Monatsansicht' },
            { key: 'jahr', label: 'Jahresansicht' },
          ]}
          active={view}
          onChange={(k) => setView(k as typeof view)}
        />
        <div className="row">
          <select
            className="hm-select"
            style={{ width: 190 }}
            value={departmentId ?? ''}
            onChange={(e) => {
              setDepartmentId(e.target.value ? Number(e.target.value) : null);
              setTeamId(null);
            }}
          >
            <option value="">Alle Abteilungen</option>
            {(departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            className="hm-select"
            style={{ width: 170 }}
            value={teamId ?? ''}
            onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Alle Teams</option>
            {(teams ?? [])
              .filter((t) => !departmentId || t.department_id === departmentId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      {isLoading || !data ? (
        <Spinner center />
      ) : data.employees.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarX2 size={40} />}
            title="Keine Mitarbeitenden im gewählten Filter"
            hint="Wählen Sie eine andere Abteilung oder ein anderes Team."
          />
        </Card>
      ) : view === 'monat' ? (
        <MonthGrid data={data} />
      ) : (
        <YearGrid data={data} year={year} />
      )}

      <Card title="Legende" style={{ marginTop: 16 }}>
        <div className="row row--wrap" style={{ gap: 16 }}>
          {(types ?? [])
            .filter((t) => t.active === 1)
            .map((t) => (
              <span key={t.id} className="row" style={{ gap: 6, fontSize: 'var(--text-sm)' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: t.color, display: 'inline-block' }} />
                {t.name}
              </span>
            ))}
          <span className="row" style={{ gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--gray-100)', border: '1px solid var(--border)', display: 'inline-block' }} />
            Wochenende
          </span>
          <span className="row" style={{ gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--blue-100)', display: 'inline-block' }} />
            Feiertag
          </span>
          <span className="row" style={{ gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'repeating-linear-gradient(45deg, var(--gray-100), var(--gray-100) 3px, var(--gray-300) 3px, var(--gray-300) 5px)', display: 'inline-block' }} />
            Betriebsruhe
          </span>
          <span className="row" style={{ gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, boxShadow: 'inset 0 0 0 2px var(--danger)', display: 'inline-block' }} />
            Konflikt (&gt; 50 % des Teams abwesend)
          </span>
          <span className="row" style={{ gap: 6, fontSize: 'var(--text-sm)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--gray-400)', opacity: 0.55, display: 'inline-block' }} />
            heller = erst beantragt
          </span>
        </div>
      </Card>
    </>
  );
}

function MonthGrid({ data }: { data: CalendarData }) {
  const days = useMemo(() => eachDayLocal(data.range.from, data.range.to), [data.range]);
  const closureDays = useMemo(() => {
    const set = new Set<string>();
    for (const c of data.closures) {
      for (const d of eachDayLocal(c.date_from < data.range.from ? data.range.from : c.date_from, c.date_to > data.range.to ? data.range.to : c.date_to)) {
        set.add(d);
      }
    }
    return set;
  }, [data]);
  const holidayByLand = useMemo(() => {
    const map = new Map<string, Map<string, string>>();
    for (const [land, list] of Object.entries(data.holidays)) {
      map.set(land, new Map(list.map((h) => [h.date, h.name])));
    }
    return map;
  }, [data]);
  const conflictDates = useMemo(() => new Set(data.conflicts.map((c) => c.date)), [data]);
  const conflictByDayTeam = useMemo(
    () => new Set(data.conflicts.map((c) => `${c.date}|${c.team_id}`)),
    [data],
  );

  const cellFor = (emp: CalendarEmployee, day: string) => {
    const holidayName = holidayByLand.get(emp.bundesland)?.get(day);
    const weekend = isWeekendDay(day);
    const closure = closureDays.has(day);
    const absence = emp.absences.find((a) => a.date_from <= day && a.date_to >= day);
    const conflict = emp.team_id !== null && conflictByDayTeam.has(`${day}|${emp.team_id}`);

    let background = 'transparent';
    if (weekend) background = 'var(--gray-100)';
    if (holidayName) background = 'var(--blue-100)';
    if (closure) background = 'repeating-linear-gradient(45deg, var(--gray-100), var(--gray-100) 3px, var(--gray-300) 3px, var(--gray-300) 5px)';

    const tooltipParts: string[] = [formatDate(day)];
    if (holidayName) tooltipParts.push(`Feiertag: ${holidayName}`);
    if (closure) tooltipParts.push('Betriebsruhe');
    if (absence) {
      tooltipParts.push(
        `${absence.type_name} (${ABSENCE_STATUS_LABELS[absence.status]}) ${formatDate(absence.date_from)} – ${formatDate(absence.date_to)}`,
      );
      if (absence.half_day_start === 1 && absence.date_from === day) tooltipParts.push('halber Tag');
      if (absence.half_day_end === 1 && absence.date_to === day) tooltipParts.push('halber Tag');
    }
    if (conflict) tooltipParts.push('Konflikt: über 50 % des Teams abwesend');

    return (
      <div
        key={day}
        title={tooltipParts.join(' · ')}
        style={{
          height: 30,
          background,
          borderLeft: '1px solid var(--gray-100)',
          position: 'relative',
          boxShadow: conflict && absence ? 'inset 0 0 0 2px var(--danger)' : undefined,
        }}
      >
        {absence && !weekend && !holidayName && !closure && (
          <div
            style={{
              position: 'absolute',
              inset: '6px 1px',
              borderRadius: 4,
              background: absence.color,
              opacity: absence.status === 'beantragt' ? 0.45 : 1,
              width:
                (absence.half_day_start === 1 && absence.date_from === day) ||
                (absence.half_day_end === 1 && absence.date_to === day)
                  ? '50%'
                  : undefined,
              marginLeft: absence.half_day_end === 1 && absence.date_to === day && absence.date_from !== day ? 0 : undefined,
            }}
          />
        )}
      </div>
    );
  };

  return (
    <Card flush>
      <div className="hm-table-wrap">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `200px repeat(${days.length}, minmax(24px, 1fr))`,
            minWidth: 200 + days.length * 24,
          }}
        >
          {/* Kopfzeile */}
          <div
            style={{
              padding: '8px 14px',
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)',
              background: 'var(--gray-25)',
            }}
          >
            Mitarbeiter:in
          </div>
          {days.map((d) => (
            <div
              key={d}
              title={conflictDates.has(d) ? 'An diesem Tag existiert ein Team-Konflikt' : formatDate(d)}
              style={{
                textAlign: 'center',
                padding: '4px 0',
                fontSize: 'var(--text-xs)',
                color: isWeekendDay(d) ? 'var(--text-muted)' : 'var(--text-secondary)',
                background: isWeekendDay(d) ? 'var(--gray-100)' : 'var(--gray-25)',
                borderBottom: conflictDates.has(d) ? '2px solid var(--danger)' : '1px solid var(--border)',
                borderLeft: '1px solid var(--gray-100)',
              }}
            >
              <div style={{ opacity: 0.7 }}>{WEEKDAY_LETTERS[weekdayOf(d)]}</div>
              <div style={{ fontWeight: 600 }}>{Number(d.slice(8, 10))}</div>
            </div>
          ))}
          {/* Zeilen */}
          {data.employees.map((emp) => (
            <React.Fragment key={emp.id}>
              <div
                style={{
                  padding: '6px 14px',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 550,
                  borderBottom: '1px solid var(--gray-100)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {emp.last_name}, {emp.first_name}
              </div>
              {days.map((d) => cellFor(emp, d))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Jahresansicht: Mitarbeitende × Monate mit aggregierten Abwesenheitstagen (Werktage). */
function YearGrid({ data, year }: { data: CalendarData; year: number }) {
  const monthDays = (emp: CalendarEmployee, month: number): number => {
    const mm = String(month).padStart(2, '0');
    const from = `${year}-${mm}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
    let count = 0;
    for (const a of emp.absences) {
      if (a.date_from > to || a.date_to < from) continue;
      for (const d of eachDayLocal(a.date_from < from ? from : a.date_from, a.date_to > to ? to : a.date_to)) {
        if (!isWeekendDay(d)) count++;
      }
    }
    return count;
  };

  return (
    <Card flush>
      <div className="hm-table-wrap">
        <table className="hm-table">
          <thead>
            <tr>
              <th>Mitarbeiter:in</th>
              {MONTH_NAMES.map((m) => (
                <th key={m} className="num">
                  {m.slice(0, 3)}
                </th>
              ))}
              <th className="num">Gesamt</th>
            </tr>
          </thead>
          <tbody>
            {data.employees.map((emp) => {
              const perMonth = Array.from({ length: 12 }, (_, i) => monthDays(emp, i + 1));
              const total = perMonth.reduce((a, b) => a + b, 0);
              return (
                <tr key={emp.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {emp.last_name}, {emp.first_name}
                  </td>
                  {perMonth.map((n, i) => (
                    <td key={i} className="num">
                      {n > 0 ? (
                        <span
                          style={{
                            display: 'inline-block',
                            minWidth: 26,
                            padding: '2px 6px',
                            borderRadius: 6,
                            fontWeight: 650,
                            background: `rgb(8 100 198 / ${Math.min(0.12 + n * 0.045, 0.55)})`,
                          }}
                        >
                          {n}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>·</span>
                      )}
                    </td>
                  ))}
                  <td className="num" style={{ fontWeight: 650 }}>
                    {total}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
