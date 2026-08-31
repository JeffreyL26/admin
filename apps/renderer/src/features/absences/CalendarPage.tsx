/**
 * Abwesenheitskalender (Admin): Mitarbeitende × Tage als horizontale Timeline.
 *
 * Designentscheidungen nach dem Vorbild moderner HR-Tools (Personio u. a.):
 * - Abwesenheiten sind EINE durchgehende Pille über alle Tage, nicht einzelne
 *   Tageskästchen. Ragt der Zeitraum über den Monat hinaus, endet die Pille
 *   flach statt rund — das signalisiert „geht weiter".
 * - Genehmigt = Vollfläche, beantragt = Schraffur in der Artfarbe. Die
 *   Schraffur bleibt auch für Farbfehlsichtige unterscheidbar (Opazität allein
 *   wäre es nicht).
 * - Wochenenden/Feiertage/Betriebsruhe tönen die ganze Spalte; die Pille läuft
 *   darüber hinweg, damit der Zeitraum als ein Block lesbar bleibt.
 * - Halbe Tage belegen die halbe Spaltenbreite (erster Tag: nachmittags →
 *   rechte Hälfte, letzter Tag: vormittags → linke Hälfte).
 */
import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarX2 } from 'lucide-react';
import { formatDate, ABSENCE_STATUS_LABELS, type CalendarEmployee, type CalendarAbsenceEntry } from '@hrmonic/shared';
import { Avatar, Card, EmptyState, PageHeader, Spinner, Tabs } from '../../components/ui';
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

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Schraffur für beantragte Anträge — Artfarbe über abgeschwächtem Grund. */
function pendingPattern(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 4px, color-mix(in srgb, ${color} 22%, transparent) 4px 9px)`;
}

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

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

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
  const goToday = () => {
    setYear(now.getFullYear());
    setMonth(now.getMonth() + 1);
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
            <button
              className="hm-btn hm-btn--secondary"
              onClick={goToday}
              disabled={view === 'monat' ? isCurrentMonth : year === now.getFullYear()}
            >
              Heute
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

      <Legend types={types} />
    </>
  );
}

function Legend({ types }: { types?: { id: number; name: string; color: string; active: number }[] }) {
  const sample = (types ?? []).find((t) => t.active === 1)?.color ?? 'var(--gray-400)';
  return (
    <div className="hm-cal-legend">
      {(types ?? [])
        .filter((t) => t.active === 1)
        .map((t) => (
          <span key={t.id} className="hm-cal-legend__item">
            <span className="hm-cal-legend__swatch" style={{ background: t.color }} />
            {t.name}
          </span>
        ))}
      <span className="hm-cal-legend__item">
        <span className="hm-cal-legend__swatch" style={{ background: pendingPattern(sample) }} />
        Beantragt (schraffiert)
      </span>
      <span className="hm-cal-legend__item">
        <span className="hm-cal-legend__swatch hm-cal-legend__swatch--weekend" />
        Wochenende
      </span>
      <span className="hm-cal-legend__item">
        <span className="hm-cal-legend__swatch hm-cal-legend__swatch--holiday" />
        Feiertag
      </span>
      <span className="hm-cal-legend__item">
        <span className="hm-cal-legend__swatch hm-cal-legend__swatch--closure" />
        Betriebsruhe
      </span>
      <span className="hm-cal-legend__item">
        <span className="hm-cal-legend__swatch hm-cal-legend__swatch--conflict" />
        Konflikt (&gt; 50 % des Teams abwesend)
      </span>
    </div>
  );
}

function MonthGrid({ data }: { data: CalendarData }) {
  const days = useMemo(() => eachDayLocal(data.range.from, data.range.to), [data.range]);
  const today = todayIso();
  const todayIndex = days.indexOf(today);

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

  return (
    <Card flush>
      <div className="hm-table-wrap">
        <div className="hm-cal" style={{ minWidth: 220 + days.length * 34 }}>
          {/* Kopfzeile */}
          <div className="hm-cal__row hm-cal__row--head" style={{ gridTemplateColumns: `220px 1fr` }}>
            <div className="hm-cal__namehead">Mitarbeiter:in</div>
            <div className="hm-cal__days" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
              {days.map((d) => {
                const weekend = isWeekendDay(d);
                const isToday = d === today;
                const conflict = conflictDates.has(d);
                return (
                  <div
                    key={d}
                    className={
                      'hm-cal__headday' +
                      (weekend ? ' hm-cal__headday--weekend' : '') +
                      (isToday ? ' hm-cal__headday--today' : '')
                    }
                    title={conflict ? `${formatDate(d)} · An diesem Tag existiert ein Team-Konflikt` : formatDate(d)}
                  >
                    <span className="hm-cal__wd">{WEEKDAY_LETTERS[weekdayOf(d)]}</span>
                    <span className={'hm-cal__dnum' + (isToday ? ' hm-cal__dnum--today' : '')}>
                      {Number(d.slice(8, 10))}
                    </span>
                    {conflict && <span className="hm-cal__conflict-dot" />}
                  </div>
                );
              })}
            </div>
          </div>
          {/* Zeilen */}
          {data.employees.map((emp) => (
            <EmployeeRow
              key={emp.id}
              emp={emp}
              days={days}
              todayIndex={todayIndex}
              holidays={holidayByLand.get(emp.bundesland)}
              closureDays={closureDays}
              conflictByDayTeam={conflictByDayTeam}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function EmployeeRow({
  emp,
  days,
  todayIndex,
  holidays,
  closureDays,
  conflictByDayTeam,
}: {
  emp: CalendarEmployee;
  days: string[];
  todayIndex: number;
  holidays?: Map<string, string>;
  closureDays: Set<string>;
  conflictByDayTeam: Set<string>;
}) {
  const n = days.length;
  const from = days[0];
  const to = days[n - 1];
  const dayIndex = (d: string) => days.indexOf(d);

  // Sichtbare Abwesenheiten als Pillen: Position/Breite in Prozent der Timeline.
  const bars = emp.absences
    .filter((a) => a.date_from <= to && a.date_to >= from)
    .map((a) => {
      const clippedStart = a.date_from < from;
      const clippedEnd = a.date_to > to;
      let start = clippedStart ? 0 : dayIndex(a.date_from);
      let end = (clippedEnd ? n - 1 : dayIndex(a.date_to)) + 1;
      // Halbe Tage: erster Tag nachmittags (rechte Hälfte), letzter vormittags.
      if (!clippedStart && a.half_day_start === 1) start += 0.5;
      if (!clippedEnd && a.half_day_end === 1) end -= 0.5;
      return { a, start, end, clippedStart, clippedEnd };
    });

  const barTitle = (a: CalendarAbsenceEntry) => {
    const parts = [
      `${a.type_name} (${ABSENCE_STATUS_LABELS[a.status]})`,
      `${formatDate(a.date_from)} – ${formatDate(a.date_to)}`,
    ];
    if (a.half_day_start === 1) parts.push('erster Tag halb');
    if (a.half_day_end === 1) parts.push('letzter Tag halb');
    return parts.join(' · ');
  };

  return (
    <div className="hm-cal__row" style={{ gridTemplateColumns: `220px 1fr` }}>
      <div className="hm-cal__name">
        <Avatar name={`${emp.first_name} ${emp.last_name}`} size={28} />
        <span className="hm-cal__name-text">
          {emp.last_name}, {emp.first_name}
        </span>
      </div>
      <div className="hm-cal__timeline">
        <div className="hm-cal__days" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
          {days.map((d) => {
            const holidayName = holidays?.get(d);
            const weekend = isWeekendDay(d);
            const closure = closureDays.has(d);
            const conflict = emp.team_id !== null && conflictByDayTeam.has(`${d}|${emp.team_id}`);
            const titleParts = [formatDate(d)];
            if (holidayName) titleParts.push(`Feiertag: ${holidayName}`);
            if (closure) titleParts.push('Betriebsruhe');
            if (conflict) titleParts.push('Konflikt: über 50 % des Teams abwesend');
            return (
              <div
                key={d}
                title={titleParts.join(' · ')}
                className={
                  'hm-cal__cell' +
                  (closure
                    ? ' hm-cal__cell--closure'
                    : holidayName
                      ? ' hm-cal__cell--holiday'
                      : weekend
                        ? ' hm-cal__cell--weekend'
                        : '') +
                  (conflict ? ' hm-cal__cell--conflict' : '')
                }
              />
            );
          })}
        </div>
        {todayIndex >= 0 && (
          <span
            className="hm-cal__todayline"
            style={{ left: `${((todayIndex + 0.5) / n) * 100}%` }}
            aria-hidden="true"
          />
        )}
        {bars.map(({ a, start, end, clippedStart, clippedEnd }) => (
          <span
            key={a.request_id}
            className={
              'hm-cal__bar' +
              (clippedStart ? ' hm-cal__bar--cut-left' : '') +
              (clippedEnd ? ' hm-cal__bar--cut-right' : '')
            }
            style={{
              left: `${(start / n) * 100}%`,
              width: `${((end - start) / n) * 100}%`,
              background: a.status === 'beantragt' ? pendingPattern(a.color) : a.color,
            }}
            title={barTitle(a)}
          />
        ))}
      </div>
    </div>
  );
}

/** Jahresansicht: Mitarbeitende × Monate mit aggregierten Abwesenheitstagen —
 * gezählt wie überall sonst (days_counted): ohne Wochenenden, Feiertage des
 * jeweiligen Bundeslands und Betriebsruhe, sonst widerspricht die Summenspalte
 * den Salden und der Antragsliste. */
function YearGrid({ data, year }: { data: CalendarData; year: number }) {
  const closureDays = useMemo(() => {
    const set = new Set<string>();
    for (const c of data.closures) {
      const from = c.date_from < data.range.from ? data.range.from : c.date_from;
      const to = c.date_to > data.range.to ? data.range.to : c.date_to;
      for (const d of eachDayLocal(from, to)) set.add(d);
    }
    return set;
  }, [data]);
  const holidaysByLand = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [land, list] of Object.entries(data.holidays)) {
      map.set(land, new Set(list.map((h) => h.date)));
    }
    return map;
  }, [data]);

  const rows = useMemo(() => {
    const monthDays = (emp: CalendarEmployee, month: number): number => {
      const mm = String(month).padStart(2, '0');
      const from = `${year}-${mm}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
      const holidays = holidaysByLand.get(emp.bundesland);
      // Tagesgenau über ein Set statt je Antrag zählen: Krankmeldungen dürfen
      // genehmigten Urlaub überlappen — pro Antrag summiert zählte ein voll
      // überlagerter Urlaub doppelt (10 Tage Urlaub + Krankmeldung = 20).
      const counted = new Set<string>();
      for (const a of emp.absences) {
        if (a.date_from > to || a.date_to < from) continue;
        for (const d of eachDayLocal(a.date_from < from ? from : a.date_from, a.date_to > to ? to : a.date_to)) {
          if (!isWeekendDay(d) && !closureDays.has(d) && !holidays?.has(d)) counted.add(d);
        }
      }
      return counted.size;
    };
    return data.employees.map((emp) => {
      const perMonth = Array.from({ length: 12 }, (_, i) => monthDays(emp, i + 1));
      return { emp, perMonth, total: perMonth.reduce((a, b) => a + b, 0) };
    });
  }, [data, year, closureDays, holidaysByLand]);

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
            {rows.map(({ emp, perMonth, total }) => {
              return (
                <tr key={emp.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="row" style={{ gap: 10 }}>
                      <Avatar name={`${emp.first_name} ${emp.last_name}`} size={24} />
                      {emp.last_name}, {emp.first_name}
                    </span>
                  </td>
                  {perMonth.map((count, i) => (
                    <td key={i} className="num">
                      {count > 0 ? (
                        <span
                          style={{
                            display: 'inline-block',
                            minWidth: 26,
                            padding: '2px 6px',
                            borderRadius: 6,
                            fontWeight: 650,
                            background: `rgb(8 100 198 / ${Math.min(0.12 + count * 0.045, 0.55)})`,
                          }}
                        >
                          {count}
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
