/**
 * Firmenweiter Abwesenheitskalender (GET /api/me/calendar).
 *
 * Zweck: Kolleg:innen sehen, wer wann fehlt — Grundlage für Urlaubs- und
 * Vertretungsplanung. Gezeigt werden ausschließlich genehmigte Abwesenheiten;
 * das Backend maskiert Arten, die nicht im Klartext erscheinen dürfen, mit
 * `type_id: null` (Anzeige dann exakt „Abwesend", ohne jede Ergänzung).
 *
 * Der Monat steht im Query-Parameter (`?jahr=&monat=`), damit ein Link auf
 * einen bestimmten Monat teilbar bleibt und der Zurück-Knopf des Browsers
 * durch die besuchten Monate blättert. Ohne (oder mit unbrauchbaren)
 * Parametern zeigt die Seite den laufenden Monat, ohne die URL zu beschreiben.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MeCalendarEmployee, MeCalendarEntry, OrgTreeNode } from '@hrmonic/shared';
import { useMyCalendar, useMyOrgTree, useMyProfile } from '../api/hooks';
import { Card, EmptyState, LoadError, Skeleton } from '../components/ui';
import { formatDate, todayIso } from '../lib/format';

const MONTH_NAMES = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/**
 * Anzeigename maskierter Einträge. Er wird bewusst hier gesetzt und nicht aus
 * `type_name` übernommen: bei `type_id === null` hat niemand — auch nicht bei
 * einer späteren Backend-Änderung — Anspruch auf mehr als dieses eine Wort.
 */
const MASKED_LABEL = 'Abwesend';

/** Spaltenmaße für die Mindestbreite der Matrix (siehe .pt-cal in portal.css). */
const NAME_COL_PX = 220;
const DAY_COL_PX = 34;

/** Grenzen des Backends (calendarRoutes.ts) — außerhalb antwortet es mit 400. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

// ---------------------------------------------------------------------------
// Datumshilfen. Alle Rechnungen laufen über UTC-Mitternacht, damit die
// Sommerzeitumstellung keinen Tag verschluckt oder verdoppelt.
// ---------------------------------------------------------------------------

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function isWeekend(iso: string): boolean {
  const day = weekdayOf(iso);
  return day === 0 || day === 6;
}

// ---------------------------------------------------------------------------
// Icons. Bewusst lokal statt in components/icons.tsx: diese Datei ist das
// einzige Blatt, das die Pfeile braucht, und die geteilte Icon-Datei gehört
// einem anderen Paket. Stil identisch (24er-Raster, currentColor, 2px).
// ---------------------------------------------------------------------------

function ChevronLeft() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ableitungen aus der Antwort
// ---------------------------------------------------------------------------

/** Eine Abwesenheit an einem konkreten Tag, inklusive Randkennzeichnung. */
interface DayMark {
  entry: MeCalendarEntry;
  /** Halber Tag am Anfang bzw. Ende des Zeitraums, sonst null. */
  half: 'start' | 'end' | null;
}

interface CalendarRow {
  employee: MeCalendarEmployee;
  /** Tag (ISO) → Abwesenheiten dieses Tages. Vorberechnet statt je Zelle gesucht. */
  byDay: Map<string, DayMark[]>;
}

/** Anzeigename einer Abwesenheitsart — maskierte Einträge heißen nur „Abwesend". */
function labelOf(entry: MeCalendarEntry): string {
  return entry.type_id === null ? MASKED_LABEL : entry.type_name;
}

/** Alle Abteilungen des Organigramms flach als id → Name. */
function flattenDepartments(nodes: OrgTreeNode[], into: Map<number, string>): Map<number, string> {
  for (const node of nodes) {
    into.set(node.id, node.name);
    flattenDepartments(node.children, into);
  }
  return into;
}

/**
 * Entkoppelt die Namenssuche vom Matrix-Render: ohne Entprellung filtert jeder
 * Tastenanschlag die komplette N×31-Tabelle neu — auf Mittelklasse-Smartphones
 * spürbares Eingabe-Lag.
 */
function useDebounced(value: string, delayMs = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function readMonthParams(params: URLSearchParams): { year: number; month: number } | null {
  const year = Number(params.get('jahr'));
  const month = Number(params.get('monat'));
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));

  const selected = readMonthParams(params) ?? { year: currentYear, month: currentMonth };
  const { year, month } = selected;
  const isCurrentMonth = year === currentYear && month === currentMonth;

  const { data, isLoading, error } = useMyCalendar(year, month);
  const { data: profile } = useMyProfile();
  const { data: org } = useMyOrgTree();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [department, setDepartment] = useState('alle');

  /** Monatswechsel legt einen History-Eintrag an — der Zurück-Knopf blättert. */
  const goToMonth = (nextYear: number, nextMonth: number) => {
    if (nextYear < MIN_YEAR || nextYear > MAX_YEAR) return;
    setParams({ jahr: String(nextYear), monat: String(nextMonth) });
  };
  const goPrevious = () => (month === 1 ? goToMonth(year - 1, 12) : goToMonth(year, month - 1));
  const goNext = () => (month === 12 ? goToMonth(year + 1, 1) : goToMonth(year, month + 1));

  const days = useMemo(
    () => (data ? eachDay(data.range.from, data.range.to) : []),
    [data],
  );

  /** Tage der Betriebsruhe als Menge — gilt für alle Mitarbeitenden gleich. */
  const closureDays = useMemo(() => {
    const set = new Set<string>();
    if (!data) return set;
    for (const closure of data.closures) {
      const from = closure.date_from < data.range.from ? data.range.from : closure.date_from;
      const to = closure.date_to > data.range.to ? data.range.to : closure.date_to;
      for (const day of eachDay(from, to)) set.add(day);
    }
    return set;
  }, [data]);

  /** Feiertage je Bundesland: Standort entscheidet, wer wann frei hat. */
  const holidaysByLand = useMemo(() => {
    const map = new Map<string, Map<string, string>>();
    if (!data) return map;
    for (const [land, list] of Object.entries(data.holidays)) {
      map.set(land, new Map(list.map((h) => [h.date, h.name])));
    }
    return map;
  }, [data]);

  /** Feiertagsnamen über alle Bundesländer — nur für die Kopfzeile. */
  const holidayNames = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!data) return map;
    for (const list of Object.values(data.holidays)) {
      for (const holiday of list) {
        const names = map.get(holiday.date) ?? new Set<string>();
        names.add(holiday.name);
        map.set(holiday.date, names);
      }
    }
    return map;
  }, [data]);

  const rows = useMemo<CalendarRow[]>(() => {
    if (!data) return [];
    return data.employees.map((employee) => {
      const byDay = new Map<string, DayMark[]>();
      for (const entry of employee.absences) {
        // Zeiträume ragen über den Monat hinaus — auf das Fenster beschneiden.
        const from = entry.date_from < data.range.from ? data.range.from : entry.date_from;
        const to = entry.date_to > data.range.to ? data.range.to : entry.date_to;
        for (const day of eachDay(from, to)) {
          const half: DayMark['half'] =
            entry.half_day_start === 1 && day === entry.date_from
              ? 'start'
              : entry.half_day_end === 1 && day === entry.date_to
                ? 'end'
                : null;
          const list = byDay.get(day) ?? [];
          list.push({ entry, half });
          byDay.set(day, list);
        }
      }
      return { employee, byDay };
    });
  }, [data]);

  /** Abteilungsnamen kommen aus dem Organigramm — der Kalender liefert nur IDs. */
  const departmentNames = useMemo(
    () => flattenDepartments(org?.tree ?? [], new Map<number, string>()),
    [org],
  );
  const departmentOptions = useMemo(() => {
    const ids = new Set<number>();
    for (const row of rows) {
      if (row.employee.department_id !== null) ids.add(row.employee.department_id);
    }
    return [...ids]
      .filter((id) => departmentNames.has(id))
      .map((id) => ({ id, name: departmentNames.get(id) as string }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [rows, departmentNames]);

  const filtered = useMemo(() => {
    const needle = debouncedSearch.trim().toLocaleLowerCase('de-DE');
    return rows.filter((row) => {
      if (department !== 'alle' && String(row.employee.department_id) !== department) return false;
      if (!needle) return true;
      const name =
        `${row.employee.first_name} ${row.employee.last_name}`.toLocaleLowerCase('de-DE');
      const reversed =
        `${row.employee.last_name} ${row.employee.first_name}`.toLocaleLowerCase('de-DE');
      return name.includes(needle) || reversed.includes(needle);
    });
  }, [rows, debouncedSearch, department]);

  const absenceCount = filtered.reduce((sum, row) => sum + row.employee.absences.length, 0);

  /** Legende: nur die Arten, die in der gezeigten Auswahl wirklich vorkommen. */
  const legend = useMemo(() => {
    const seen = new Map<string, { label: string; color: string }>();
    for (const row of filtered) {
      for (const entry of row.employee.absences) {
        const key = entry.type_id === null ? 'maskiert' : String(entry.type_id);
        if (!seen.has(key)) seen.set(key, { label: labelOf(entry), color: entry.color });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }, [filtered]);

  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
  const filtersActive = search.trim() !== '' || department !== 'alle';

  return (
    <div>
      <header className="portal-page-header row row--between">
        <div>
          <h1 className="portal-title">Abwesenheitskalender</h1>
          <p className="portal-subtitle">
            Wer ist wann abwesend — der Monatsüberblick über das ganze Unternehmen.
          </p>
        </div>
        <div className="pt-cal__nav">
          <button
            type="button"
            className="pt-btn pt-btn--secondary pt-cal__icon-btn"
            onClick={goPrevious}
            disabled={year <= MIN_YEAR && month === 1}
            aria-label="Vorheriger Monat"
          >
            <ChevronLeft />
          </button>
          {/* aria-live: Nach dem Klick auf die Pfeile erfährt die Sprachausgabe
              den neuen Monat, ohne dass der Fokus wandert. */}
          <span className="pt-cal__month" aria-live="polite">
            {monthLabel}
          </span>
          <button
            type="button"
            className="pt-btn pt-btn--secondary pt-cal__icon-btn"
            onClick={goNext}
            disabled={year >= MAX_YEAR && month === 12}
            aria-label="Nächster Monat"
          >
            <ChevronRight />
          </button>
          <button
            type="button"
            className="pt-btn pt-btn--secondary pt-btn--sm"
            onClick={() => goToMonth(currentYear, currentMonth)}
            disabled={isCurrentMonth}
          >
            Heute
          </button>
        </div>
      </header>

      <div className="pt-cal__toolbar">
        <input
          type="search"
          className="pt-input pt-cal__search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Namen suchen …"
          aria-label="Mitarbeitende nach Namen suchen"
        />
        {departmentOptions.length > 1 && (
          <select
            className="pt-select pt-cal__filter"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            aria-label="Nach Abteilung filtern"
          >
            <option value="alle">Alle Abteilungen</option>
            {departmentOptions.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {filtersActive && (
          <button
            type="button"
            className="pt-btn pt-btn--quiet pt-btn--sm"
            onClick={() => {
              setSearch('');
              setDepartment('alle');
            }}
          >
            Filter zurücksetzen
          </button>
        )}
      </div>

      {!isLoading && !error && rows.length > 0 && (
        <p className="pt-cal__count" aria-live="polite">
          {filtered.length === rows.length
            ? `${rows.length} Mitarbeitende`
            : `${filtered.length} von ${rows.length} Mitarbeitenden`}
          {' · '}
          {absenceCount === 1 ? '1 Abwesenheit' : `${absenceCount} Abwesenheiten`} im{' '}
          {monthLabel.replace(' ', ' ')}
        </p>
      )}

      <Card flush>
        {error ? (
          <div className="pt-card__body">
            <LoadError error={error} />
          </div>
        ) : isLoading || !data ? (
          <GridSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Keine aktiven Mitarbeitenden"
            hint="Sobald Kolleg:innen im System geführt werden, erscheinen sie hier."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Keine Mitarbeitenden gefunden"
            hint="Passen Sie die Suche oder den Abteilungsfilter an."
          />
        ) : absenceCount === 0 ? (
          <EmptyState
            title={`Im ${monthLabel} ist niemand abwesend`}
            hint={
              filtersActive
                ? 'In dieser Auswahl ist kein Urlaub und keine andere Abwesenheit eingetragen. Blättern Sie zu einem anderen Monat oder setzen Sie die Filter zurück.'
                : 'Ein ganzer Monat ohne eingetragene Abwesenheit — blättern Sie zu einem anderen Monat.'
            }
          />
        ) : (
          <CalendarGrid
            rows={filtered}
            days={days}
            today={today}
            monthLabel={monthLabel}
            ownEmployeeId={profile?.id ?? null}
            closureDays={closureDays}
            holidaysByLand={holidaysByLand}
            holidayNames={holidayNames}
          />
        )}
      </Card>

      {legend.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Card title="Legende">
            <div className="pt-cal__legend">
              {legend.map((item) => (
                <span key={item.label} className="pt-cal__legend-item">
                  <span className="pt-cal__swatch" style={{ background: item.color }} />
                  {item.label}
                </span>
              ))}
              <span className="pt-cal__legend-item">
                <span className="pt-cal__swatch pt-cal__swatch--half" />
                Halber Tag
              </span>
              <span className="pt-cal__legend-item">
                <span className="pt-cal__swatch pt-cal__swatch--weekend" />
                Wochenende
              </span>
              <span className="pt-cal__legend-item">
                <span className="pt-cal__swatch pt-cal__swatch--holiday" />
                Feiertag (nach Standort)
              </span>
              <span className="pt-cal__legend-item">
                <span className="pt-cal__swatch pt-cal__swatch--closure" />
                Betriebsruhe
              </span>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

// memo: Während des Tippens im Suchfeld rendert die Seite bei jedem Anschlag —
// die Matrix selbst ändert sich aber erst, wenn die entprellte Suche `filtered`
// tatsächlich verändert. Alle Props sind primitiv oder useMemo-stabil.
const CalendarGrid = memo(function CalendarGrid({
  rows,
  days,
  today,
  monthLabel,
  ownEmployeeId,
  closureDays,
  holidaysByLand,
  holidayNames,
}: {
  rows: CalendarRow[];
  days: string[];
  today: string;
  monthLabel: string;
  ownEmployeeId: number | null;
  closureDays: Set<string>;
  holidaysByLand: Map<string, Map<string, string>>;
  holidayNames: Map<string, Set<string>>;
}) {
  return (
    // Der Scroll gehört in diesen Container: die Seite selbst darf auf
    // Smartphone-Breite niemals horizontal wandern.
    <div className="pt-cal__scroll" tabIndex={0} role="group" aria-label="Kalendertabelle, horizontal scrollbar">
      <table className="pt-cal" style={{ minWidth: NAME_COL_PX + days.length * DAY_COL_PX }}>
        <caption className="pt-cal__sr">
          Abwesenheiten im {monthLabel}. Zeilen sind Mitarbeitende, Spalten die Tage des Monats.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="pt-cal__name">
              Mitarbeiter:in
            </th>
            {days.map((day) => {
              const weekend = isWeekend(day);
              const holidays = holidayNames.get(day);
              const titleParts = [formatDate(day)];
              if (holidays) titleParts.push(`Feiertag: ${[...holidays].join(', ')}`);
              if (closureDays.has(day)) titleParts.push('Betriebsruhe');
              return (
                <th
                  key={day}
                  scope="col"
                  className={`pt-cal__head-day${weekend ? ' pt-cal__head-day--weekend' : ''}`}
                  title={titleParts.join(' · ')}
                >
                  <span className="pt-cal__wd" aria-hidden="true">
                    {WEEKDAY_SHORT[weekdayOf(day)]}
                  </span>
                  <span className={day === today ? 'pt-cal__dnum pt-cal__dnum--today' : 'pt-cal__dnum'}>
                    {Number(day.slice(8, 10))}
                  </span>
                  <span className="pt-cal__sr">{formatDate(day)}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ employee, byDay }) => {
            const isSelf = ownEmployeeId !== null && employee.id === ownEmployeeId;
            const holidays = holidaysByLand.get(employee.bundesland);
            return (
              <tr key={employee.id} className={`pt-cal__row${isSelf ? ' pt-cal__row--self' : ''}`}>
                <th scope="row" className="pt-cal__name">
                  <span className="pt-cal__avatar" aria-hidden="true">
                    {`${employee.first_name[0] ?? ''}${employee.last_name[0] ?? ''}`.toUpperCase()}
                  </span>
                  <span className="pt-cal__name-text">
                    {employee.last_name}, {employee.first_name}
                    {isSelf && <span className="pt-cal__self-tag"> (Sie)</span>}
                  </span>
                </th>
                {days.map((day) => (
                  <DayCell
                    key={day}
                    day={day}
                    today={today}
                    marks={byDay.get(day)}
                    holidayName={holidays?.get(day)}
                    closure={closureDays.has(day)}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

// memo: Ändert sich die Zeilenauswahl, bleiben die Zellreferenzen der übrigen
// Zeilen stabil (rows/byDay kommen aus useMemo) — ohne memo baut jede Filterung
// Tooltip- und Screenreader-Strings für alle ~6 000 Zellen neu.
const DayCell = memo(function DayCell({
  day,
  today,
  marks,
  holidayName,
  closure,
}: {
  day: string;
  today: string;
  marks?: DayMark[];
  holidayName?: string;
  closure: boolean;
}) {
  const weekend = isWeekend(day);
  // Die Balken laufen bewusst ÜBER Wochenenden, Feiertage und Betriebsruhe
  // hinweg: ein Zeitraum liest sich so als eine durchgehende Pille statt als
  // zerhackte Einzeltage (Vorbild Personio). Die Spaltentönung dahinter
  // erhält die Wochenrhythmik.
  const visible = marks ?? [];

  const classes = ['pt-cal__cell'];
  if (closure) classes.push('pt-cal__cell--closure');
  else if (holidayName) classes.push('pt-cal__cell--holiday');
  else if (weekend) classes.push('pt-cal__cell--weekend');
  if (day === today) classes.push('pt-cal__cell--today');

  const titleParts = [formatDate(day)];
  if (holidayName) titleParts.push(`Feiertag: ${holidayName}`);
  if (closure) titleParts.push('Betriebsruhe');
  const srParts: string[] = [];
  if (holidayName) srParts.push(`Feiertag: ${holidayName}`);
  if (closure) srParts.push('Betriebsruhe');
  for (const mark of visible) {
    const label = labelOf(mark.entry);
    const range =
      mark.entry.date_from === mark.entry.date_to
        ? formatDate(mark.entry.date_from)
        : `${formatDate(mark.entry.date_from)} bis ${formatDate(mark.entry.date_to)}`;
    const half = mark.half ? ', halber Tag' : '';
    titleParts.push(`${label} (${range})${half}`);
    srParts.push(`${label}${half}`);
  }

  return (
    <td className={classes.join(' ')} title={titleParts.join(' · ')}>
      {visible.length > 0 && (
        <span className="pt-cal__marks">
          {visible.map((mark) => {
            // Runde Enden nur am echten Anfang/Ende des Zeitraums — ein am
            // Monatsrand beschnittener Balken endet flach („geht weiter").
            const roundLeft = day === mark.entry.date_from;
            const roundRight = day === mark.entry.date_to;
            const classes = ['pt-cal__bar'];
            if (roundLeft) classes.push('pt-cal__bar--start');
            if (roundRight) classes.push('pt-cal__bar--end');
            if (mark.half) classes.push(`pt-cal__bar--half-${mark.half}`);
            return (
              <span
                key={`${mark.entry.request_id}`}
                className={classes.join(' ')}
                style={{ background: mark.entry.color }}
              />
            );
          })}
        </span>
      )}
      {srParts.length > 0 && <span className="pt-cal__sr">{srParts.join(', ')}</span>}
    </td>
  );
});

/** Ladezustand: Platzhalterzeilen statt Spinner, wie überall im Portal. */
function GridSkeleton() {
  return (
    <div className="pt-card__body stack" style={{ gap: 12 }} aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="row" style={{ gap: 12 }}>
          <Skeleton width={`${34 - (i % 3) * 6}%`} />
          <Skeleton height={18} style={{ borderRadius: 4 }} />
        </div>
      ))}
    </div>
  );
}
