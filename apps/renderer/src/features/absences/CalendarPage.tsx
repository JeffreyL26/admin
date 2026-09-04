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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarX2, Palette, RotateCcw } from 'lucide-react';
import {
  formatDate,
  ABSENCE_STATUS_LABELS,
  type AbsenceType,
  type CalendarEmployee,
  type CalendarAbsenceEntry,
} from '@ohrganize/shared';
import { Avatar, Card, EmptyState, PageHeader, Spinner, Tabs } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import { useAbsenceTypes, useCalendar, useDepartments, useTeams, type CalendarData } from './api';
import { useColorOverrides, type ColorOverrides } from './absenceColors';

type LegendType = Pick<AbsenceType, 'id' | 'name' | 'color' | 'active'>;

/** „1 Tag“, „0,5 Tage“, „12 Tage“ — Zählung wie days_counted. */
function formatDays(n: number): string {
  return `${n.toLocaleString('de-DE')} ${n === 1 ? 'Tag' : 'Tage'}`;
}

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

const BAR_LABEL_FONT = "650 11px 'Inter Variable', 'Segoe UI', system-ui, sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;
const textWidthCache = new Map<string, number>();

/** Pixelbreite eines Labels im Balken-Font — gecacht, da nur elf Abwesenheitsarten
 * existieren und dieselbe Messung sonst pro Balken und Re-Render neu anfiele. */
function measureLabelWidth(text: string): number {
  const cached = textWidthCache.get(text);
  if (cached !== undefined) return cached;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  let width: number;
  if (measureCtx) {
    measureCtx.font = BAR_LABEL_FONT;
    width = measureCtx.measureText(text).width;
  } else {
    width = text.length * 7; // Canvas nicht verfügbar (Test-DOM) — grobe Schätzung.
  }
  textWidthCache.set(text, width);
  return width;
}

/** Schwarz oder Weiß als Textfarbe — je nachdem, was auf der Artfarbe die WCAG-
 * Mindestkontraste einhält. Die Palette reicht von kräftigem Blau bis zu hellem
 * Gold; ein pauschal weißer Schriftzug wäre auf den helleren Tönen kaum lesbar. */
function readableTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#fff';
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => toLinear(parseInt(h, 16)));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithWhite >= 3.4 ? '#fff' : 'rgba(0, 0, 0, 0.82)';
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

  // Lokale Farbwahl (siehe absenceColors.ts) einmal zentral auf Daten und
  // Legende anwenden — Monats- und Jahresansicht lesen weiterhin nur `a.color`
  // und müssen die Überschreibung gar nicht kennen.
  const { overrides, setColor, resetAll } = useColorOverrides();
  const [colorEditorOpen, setColorEditorOpen] = useState(false);
  const hasOverrides = Object.keys(overrides).length > 0;
  const displayData = useMemo(() => {
    if (!data || !hasOverrides) return data;
    return {
      ...data,
      employees: data.employees.map((emp) => ({
        ...emp,
        absences: emp.absences.map((a) => {
          const local = overrides[a.type_id];
          return local ? { ...a, color: local } : a;
        }),
      })),
    };
  }, [data, overrides, hasOverrides]);
  const displayTypes = useMemo(
    () => types?.map((t) => (overrides[t.id] ? { ...t, color: overrides[t.id] } : t)),
    [types, overrides],
  );

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
        subtitle="Wer ist wann abwesend? Inklusive Feiertagen, Betriebsruhe und Team-Konflikten."
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

      {isLoading || !displayData ? (
        <Spinner center />
      ) : displayData.employees.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarX2 size={40} />}
            title="Keine Mitarbeitenden im gewählten Filter"
            hint="Wählen Sie eine andere Abteilung oder ein anderes Team."
          />
        </Card>
      ) : view === 'monat' ? (
        <MonthGrid data={displayData} />
      ) : (
        <YearGrid data={displayData} year={year} />
      )}

      <Legend types={displayTypes} onEditColors={() => setColorEditorOpen(true)} />
      <ColorEditor
        open={colorEditorOpen}
        onClose={() => setColorEditorOpen(false)}
        types={types}
        overrides={overrides}
        onChange={setColor}
        onResetAll={resetAll}
      />
    </>
  );
}

function Legend({ types, onEditColors }: { types?: LegendType[]; onEditColors: () => void }) {
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
      <button
        type="button"
        className="hm-btn hm-btn--ghost hm-btn--sm"
        style={{ marginLeft: 'auto', gap: 6 }}
        onClick={onEditColors}
      >
        <Palette size={14} />
        Farben bearbeiten
      </button>
    </div>
  );
}

/** Lokaler Farbwähler je Abwesenheitsart — Standardfarbe (Verwaltung) bleibt
 * unangetastet, die Abweichung liegt nur auf diesem Gerät. Zeigt die aktiven
 * Arten mit der ursprünglichen Standardfarbe als Rücksetzziel. */
function ColorEditor({
  open,
  onClose,
  types,
  overrides,
  onChange,
  onResetAll,
}: {
  open: boolean;
  onClose: () => void;
  types?: LegendType[];
  overrides: ColorOverrides;
  onChange: (typeId: number, color: string | null) => void;
  onResetAll: () => void;
}) {
  const active = (types ?? []).filter((t) => t.active === 1);
  const hasOverrides = Object.keys(overrides).length > 0;
  return (
    <Modal
      title="Farben bearbeiten"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="hm-btn hm-btn--secondary" onClick={onResetAll} disabled={!hasOverrides}>
            Alle zurücksetzen
          </button>
          <button type="button" className="hm-btn hm-btn--primary" onClick={onClose}>
            Fertig
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 14px' }}>
        Gilt nur für diesen Arbeitsplatz. Die Standardfarben unter „Abwesenheitsarten" bleiben für alle
        unverändert.
      </p>
      <div className="stack" style={{ gap: 8 }}>
        {active.map((t) => {
          const current = overrides[t.id] ?? t.color;
          const isOverridden = overrides[t.id] !== undefined;
          return (
            <div key={t.id} className="row row--between" style={{ gap: 12 }}>
              <span className="row" style={{ gap: 10, minWidth: 0 }}>
                <span className="hm-cal-legend__swatch" style={{ background: current }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                {isOverridden && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>angepasst</span>
                )}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <input
                  type="color"
                  className="hm-input"
                  aria-label={`Farbe für ${t.name}`}
                  value={current}
                  onChange={(e) => onChange(t.id, e.target.value)}
                  style={{ padding: 3, height: 32, width: 44 }}
                />
                <Tooltip content="Auf Standardfarbe zurücksetzen">
                  <button
                    type="button"
                    className="hm-btn hm-btn--ghost hm-btn--icon"
                    onClick={() => onChange(t.id, null)}
                    disabled={!isOverridden}
                    aria-label={`${t.name} auf Standardfarbe zurücksetzen`}
                  >
                    <RotateCcw size={14} />
                  </button>
                </Tooltip>
              </span>
            </div>
          );
        })}
      </div>
    </Modal>
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

  // Spaltenbreite in Pixeln messen: alle Zeilen teilen dasselbe Grid, daher
  // reicht eine Messung an der Kopfzeile für alle Balken. Bestimmt, ob ein
  // Balken breit genug für seine Artbezeichnung ist (siehe EmployeeRow).
  const daysHeadRef = useRef<HTMLDivElement>(null);
  const [dayWidth, setDayWidth] = useState(34);
  useEffect(() => {
    const el = daysHeadRef.current;
    if (!el || days.length === 0) return;
    const update = () => setDayWidth(el.getBoundingClientRect().width / days.length);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [days.length]);

  return (
    <Card flush>
      <div className="hm-table-wrap">
        <div className="hm-cal" style={{ minWidth: 220 + days.length * 34 }}>
          {/* Kopfzeile */}
          <div className="hm-cal__row hm-cal__row--head" style={{ gridTemplateColumns: `220px 1fr` }}>
            <div className="hm-cal__namehead">Mitarbeiter:in</div>
            <div
              ref={daysHeadRef}
              className="hm-cal__days"
              style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
            >
              {days.map((d) => {
                const weekend = isWeekendDay(d);
                const isToday = d === today;
                const conflict = conflictDates.has(d);
                // Tooltip nur, wenn er etwas sagt, was die Kopfzeile nicht zeigt.
                return (
                  <Tooltip
                    key={d}
                    placement="bottom"
                    content={
                      conflict ? (
                        <>
                          <span className="hm-tooltip__title">{formatDate(d)}</span>
                          <span className="hm-tooltip__line">Team-Konflikt an diesem Tag</span>
                        </>
                      ) : null
                    }
                  >
                    <div
                      className={
                        'hm-cal__headday' +
                        (weekend ? ' hm-cal__headday--weekend' : '') +
                        (isToday ? ' hm-cal__headday--today' : '')
                      }
                    >
                      <span className="hm-cal__wd">{WEEKDAY_LETTERS[weekdayOf(d)]}</span>
                      <span className={'hm-cal__dnum' + (isToday ? ' hm-cal__dnum--today' : '')}>
                        {Number(d.slice(8, 10))}
                      </span>
                      {conflict && <span className="hm-cal__conflict-dot" />}
                    </div>
                  </Tooltip>
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
              dayWidth={dayWidth}
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
  dayWidth,
}: {
  emp: CalendarEmployee;
  days: string[];
  todayIndex: number;
  holidays?: Map<string, string>;
  closureDays: Set<string>;
  conflictByDayTeam: Set<string>;
  dayWidth: number;
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
      // Beschriftung nur, wenn mindestens die halbe Wortlänge Platz hat — bei
      // knapperem Platz kürzt CSS-Ellipsis den Rest (z. B. "Url…"), darunter
      // bleibt der Balken schmuck- und textlos statt einzelne Buchstaben zu zeigen.
      const barWidthPx = dayWidth * (end - start) - 16; // 16 = horizontales Innenpolster
      const showLabel = barWidthPx >= measureLabelWidth(a.type_name) / 2;
      return { a, start, end, clippedStart, clippedEnd, showLabel };
    });

  const barTip = (a: CalendarAbsenceEntry) => {
    const details = [formatDays(a.days_counted)];
    if (a.half_day_start === 1) details.push('erster Tag halb');
    if (a.half_day_end === 1) details.push('letzter Tag halb');
    return (
      <>
        <span className="hm-tooltip__title">
          {a.type_name} · {ABSENCE_STATUS_LABELS[a.status]}
        </span>
        <span className="hm-tooltip__line">
          {formatDate(a.date_from)} – {formatDate(a.date_to)}
        </span>
        <span className="hm-tooltip__line">{details.join(' · ')}</span>
      </>
    );
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
            // Nur besondere Tage erklären — ein Tooltip auf jeder leeren Zelle
            // würde beim Überstreichen der Zeile nur flackern.
            const notes: string[] = [];
            if (holidayName) notes.push(`Feiertag: ${holidayName}`);
            if (closure) notes.push('Betriebsruhe');
            if (conflict) notes.push('Konflikt: über 50 % des Teams abwesend');
            return (
              <Tooltip
                key={d}
                content={
                  notes.length > 0 ? (
                    <>
                      <span className="hm-tooltip__title">{formatDate(d)}</span>
                      {notes.map((n) => (
                        <span key={n} className="hm-tooltip__line">
                          {n}
                        </span>
                      ))}
                    </>
                  ) : null
                }
              >
                <div
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
              </Tooltip>
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
        {bars.map(({ a, start, end, clippedStart, clippedEnd, showLabel }) => (
          <Tooltip key={a.request_id} content={barTip(a)}>
            <span
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
            >
              {showLabel &&
                (a.status === 'beantragt' ? (
                  // Auf der Schraffur wechselt der Grund alle 4 px zwischen Artfarbe
                  // und fast transparent — keine einzelne Textfarbe ist darauf
                  // lesbar. Deshalb weiß mit schwarzem Umriss statt Kontrastwahl.
                  <span className="hm-cal__bar-label hm-cal__bar-label--outlined">{a.type_name}</span>
                ) : (
                  <span className="hm-cal__bar-label" style={{ color: readableTextColor(a.color) }}>
                    {a.type_name}
                  </span>
                ))}
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

/** Eine Monatskachel der Jahresansicht: Gesamtzahl plus Aufschlüsselung je
 * Art, absteigend nach Tagen (Index 0 = dominante Art, färbt die Kachel). */
type YearCell = { count: number; types: { name: string; color: string; days: number }[] };

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
    const monthCell = (emp: CalendarEmployee, month: number): YearCell => {
      const mm = String(month).padStart(2, '0');
      const from = `${year}-${mm}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
      const holidays = holidaysByLand.get(emp.bundesland);
      // Tagesgenau über ein Set statt je Antrag zählen: Krankmeldungen dürfen
      // genehmigten Urlaub überlappen — pro Antrag summiert zählte ein voll
      // überlagerter Urlaub doppelt (10 Tage Urlaub + Krankmeldung = 20).
      // Die Kachelzahl bleibt diese Vereinigung; je Art wird daneben getrennt
      // gezählt, damit Farbe und Tooltip die Art benennen können.
      const counted = new Set<string>();
      const byType = new Map<number, { name: string; color: string; days: Set<string> }>();
      for (const a of emp.absences) {
        if (a.date_from > to || a.date_to < from) continue;
        let entry = byType.get(a.type_id);
        if (!entry) {
          entry = { name: a.type_name, color: a.color, days: new Set() };
          byType.set(a.type_id, entry);
        }
        for (const d of eachDayLocal(a.date_from < from ? from : a.date_from, a.date_to > to ? to : a.date_to)) {
          if (!isWeekendDay(d) && !closureDays.has(d) && !holidays?.has(d)) {
            counted.add(d);
            entry.days.add(d);
          }
        }
      }
      // Dominante Art zuerst: Sie färbt die Kachel, die übrigen folgen im Tooltip.
      const types = [...byType.values()]
        .map((t) => ({ name: t.name, color: t.color, days: t.days.size }))
        .filter((t) => t.days > 0)
        .sort((x, y) => y.days - x.days);
      return { count: counted.size, types };
    };
    return data.employees.map((emp) => {
      const perMonth = Array.from({ length: 12 }, (_, i) => monthCell(emp, i + 1));
      return { emp, perMonth, total: perMonth.reduce((sum, c) => sum + c.count, 0) };
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
                  {perMonth.map((cell, i) => (
                    <td key={i} className="num" style={{ textAlign: 'center' }}>
                      {cell.count > 0 ? (
                        <Tooltip
                          content={
                            <>
                              <span className="hm-tooltip__title">
                                {MONTH_NAMES[i]} {year}
                              </span>
                              {cell.types.map((t) => (
                                <span key={t.name} className="hm-tooltip__line">
                                  {t.name} · {formatDays(t.days)}
                                </span>
                              ))}
                            </>
                          }
                        >
                          <span
                            style={{
                              display: 'inline-block',
                              minWidth: 26,
                              padding: '2px 6px',
                              borderRadius: 6,
                              fontWeight: 650,
                              cursor: 'default',
                              // Artfarbe statt festem Blau; Deckkraft wächst mit der Tagezahl.
                              background: `color-mix(in srgb, ${cell.types[0]?.color ?? 'var(--gray-400)'} ${Math.min(12 + cell.count * 4.5, 55)}%, transparent)`,
                            }}
                          >
                            {cell.count}
                          </span>
                        </Tooltip>
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
