/**
 * Dashboard der Desktop-App: Regeln ohne DOM, damit sie testbar sind
 * (Test: apps/backend/src/test/dashboardLogicTest.ts, Teil von npm test).
 *
 * - Datumstexte im Fliesstext schreiben den Monat aus („1. September“).
 *   Endet ein Satz mit einem Datum, entsteht so kein doppelter Punkt wie bei
 *   „ab 01.09..“. Kompakte Spalten bleiben numerisch (formatDate, TT.MM.).
 * - Benachrichtigungs-Quadrat je Bereich und Widget: offene Punkte (rot, Zahl)
 *   schlagen Laufendes (grau, Sanduhr), sonst kein Quadrat.
 * - Reihenfolge der Widgets: Umsortieren in einer gefilterten Ansicht laesst
 *   die ausgeblendeten Widgets auf ihren Plaetzen.
 */

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return [y, m, d];
}

/** „1. September“; liegt das Datum nicht im Jahr von `today`, mit Jahr („1. September 2027“). */
export function formatDateInText(iso: string, today: string): string {
  const [y, m, d] = parts(iso);
  return `${d}. ${MONTHS_DE[m - 1]}${y === parts(today)[0] ? '' : ` ${y}`}`;
}

/**
 * Zeitraum fuer Fliesstext: „16. bis 22. Juli“, „28. September bis 2. Oktober“,
 * ueber den Jahreswechsel beide Daten mit Jahr.
 */
export function formatRangeInText(from: string, to: string, today: string): string {
  if (from.slice(0, 10) === to.slice(0, 10)) return formatDateInText(from, today);
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (fy !== ty) return `${fd}. ${MONTHS_DE[fm - 1]} ${fy} bis ${td}. ${MONTHS_DE[tm - 1]} ${ty}`;
  if (fm === tm) return `${fd}. bis ${formatDateInText(to, today)}`;
  return `${fd}. ${MONTHS_DE[fm - 1]} bis ${formatDateInText(to, today)}`;
}

/**
 * Naechster Arbeitstag nach `iso`: Montag bis Freitag und nicht `isOff`
 * (Feiertag der Region, Betriebsruhe, anschliessende Abwesenheiten; das
 * Backend kennt das und reicht es hinein). Die Grenze von zehn Jahren reicht
 * fuer aneinandergereihte Abschnitte einer Elternzeit.
 */
export function nextWorkdayIso(iso: string, isOff: (iso: string) => boolean = () => false): string {
  const [y, m, d] = parts(iso);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  for (let i = 0; i < 3660; i++) {
    const day = date.getUTCDay();
    const cur = date.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !isOff(cur)) return cur;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Reihenfolge im Anwesenheitsplan: offene Antraege zuerst, dann wer heute
 * fehlt, dann was kommt (naechster Beginn zuerst), zuletzt Vergangenes
 * (juengstes Ende zuerst). Eingeklappt bleiben so die relevanten Zeilen oben.
 */
export function comparePlanRows(
  a: { status: string; from: string; to: string },
  b: { status: string; from: string; to: string },
  today: string,
): number {
  const group = (r: typeof a) => (r.status === 'beantragt' ? 0 : r.to < today ? 3 : r.from <= today ? 1 : 2);
  const ga = group(a);
  const gb = group(b);
  if (ga !== gb) return ga - gb;
  return ga === 3 ? b.to.localeCompare(a.to) : a.from.localeCompare(b.from);
}

/**
 * Monat-Tag-Werte (MM-DD) der Geburtstage, die an `today` gefeiert werden:
 * der Tag selbst, ausserhalb von Schaltjahren am 28. Februar zusaetzlich der
 * 29. Februar.
 */
export function birthdayMonthDays(today: string): string[] {
  const [y] = parts(today);
  const monthDay = today.slice(5, 10);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return !leap && monthDay === '02-28' ? ['02-28', '02-29'] : [monthDay];
}

/**
 * Gefuellte Kaestchen bei hoechstens `slots` Kaestchen fuer `done` von
 * `total`. Voll nur, wenn wirklich alle bestaetigt haben, und mindestens
 * eines, sobald jemand bestaetigt hat: Die Aussage „es fehlt noch jemand“ bzw.
 * „es hat schon jemand“ geht beim Runden nicht verloren.
 */
export function filledSlots(done: number, total: number, slots: number): number {
  if (total <= 0 || done <= 0 || slots <= 0) return 0;
  if (done >= total) return slots;
  return Math.min(slots - 1, Math.max(1, Math.floor((done / total) * slots)));
}

/** Zustand einer Datenquelle des Dashboards (aus der Abfrage abgelesen). */
export interface DashboardSourceState {
  /** Laedt zum ersten Mal (noch keine Daten). */
  loading: boolean;
  /** Letzter Abruf gescheitert. */
  error: boolean;
  /** Wartet auf eine Netzverbindung (React Query: fetchStatus 'paused'). */
  paused: boolean;
  /** Es liegen Daten vor (auch aeltere). */
  hasData: boolean;
}

/**
 * Was die Quellen fuer die Anzeige bedeuten:
 * - `initialLoading`: Spinner der Seite, nur bis zum ersten Aufbau (`builtOnce`).
 * - `pending`: danach neu hinzugekommene Quellen, die noch laden (nur ihr Widget wartet).
 * - `failed`: Quellen ohne Daten, weil der Abruf scheiterte oder ohne Netz
 *   pausiert; mit aelteren Daten bleibt der letzte Stand sichtbar.
 */
export function dashboardSourceStatus<K extends string>(
  states: Record<K, DashboardSourceState>,
  builtOnce: boolean,
): { anyLoading: boolean; initialLoading: boolean; pending: K[]; failed: K[]; offline: K[] } {
  const keys = Object.keys(states) as K[];
  const anyLoading = keys.some((k) => states[k].loading);
  return {
    anyLoading,
    initialLoading: !builtOnce && anyLoading,
    pending: builtOnce ? keys.filter((k) => states[k].loading) : [],
    failed: keys.filter((k) => !states[k].loading && !states[k].hasData && (states[k].error || states[k].paused)),
    // Davon ohne Netz pausiert: laedt von selbst, sobald die Verbindung besteht.
    offline: keys.filter((k) => !states[k].hasData && states[k].paused),
  };
}

/** Inhalt des Benachrichtigungs-Quadrats, null = keins. */
export interface DashboardNotice {
  /** Offene Punkte fuer die HR; > 0 heisst rotes Quadrat mit Zahl. */
  count: number;
  /** Nichts offen, aber etwas laeuft und wartet auf andere: graue Sanduhr. */
  waiting: boolean;
}

export function dashboardNotice(open: number, running: number): DashboardNotice | null {
  if (open > 0) return { count: open, waiting: false };
  if (running > 0) return { count: 0, waiting: true };
  return null;
}

/** Element von Position `from` nach `to` verschieben (neue Liste). */
/**
 * Tage im Fliesstext: „1 Tag“, „0,5 Tage“, „3 Tage“; deckt erst die
 * Betriebsruhe den Zeitraum (closure_covered), „Betriebsruhe“ statt der 0.
 */
export function daysInText(days: number, locale: string, closureCovered = false): string {
  if (closureCovered && days === 0) return 'Betriebsruhe';
  return `${days.toLocaleString(locale)} ${days === 1 ? 'Tag' : 'Tage'}`;
}

export function moveItem<K>(list: readonly K[], from: number, to: number): K[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Neue Reihenfolge der sichtbaren Elemente in die Gesamtliste uebernehmen:
 * Die sichtbaren besetzen der Reihe nach die Plaetze, die sie vorher hatten,
 * die ausgeblendeten bleiben, wo sie sind.
 */
export function mergeVisibleOrder<K>(all: readonly K[], visibleOrder: readonly K[]): K[] {
  const visible = new Set(visibleOrder);
  const queue = [...visibleOrder];
  return all.map((k) => (visible.has(k) ? (queue.shift() as K) : k));
}
