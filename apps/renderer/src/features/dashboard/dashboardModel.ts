import { useMemo, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AREA_MODULES, MEETING_OCCASION_LABELS, ONBOARDING_KIND_LABELS, comparePlanRows, daysInText, formatDateInText,
  formatRangeInText, moduleEnabled, todayIsoLocal, dashboardSourceStatus, isOwnPersonDecision, isOwnRequestDecision,
  type DashboardSourceState,
  type AbsenceRequest, type AbsenceRequestStatus, type AdminArea,
  type EmployeeChangeRequestForHr, type OnboardingProcess, type SickNote,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { LOCALE } from '../../lib/locale';
import type { Announcement, Meeting } from '../communication/api';
import type { DocumentRow } from '../employees/api';
import { useDashboard } from './api';

/**
 * Datenmodell des Dashboards: eine Aufgabenliste aus Sicht der HR (was ist
 * ueberfaellig, was zu entscheiden, was laeuft), dazu heutige und kommende
 * Abwesenheiten, aktuell Kranke, der Anwesenheitsplan und die Zahlen der
 * Bereichsleiste.
 *
 * Die Daten kommen aus den Endpunkten der Fachseiten, meist unter deren
 * Query-Keys (useAbsenceRequests, useMissingSickNotes, useFollowUps,
 * useOnboardingProcesses, useEmployeeChangeRequests, Gehaltsantraege), also
 * ein Cache. Eigene Keys (heute Abwesende, naechste 7 Tage, Krankmeldungen von
 * heute, aktive Ankuendigungen) liegen unter dem Praefix der Fachseite und
 * laufen mit deren Invalidierung mit; kein eigener staleTime. Abgefragt wird nur, was das
 * Konto laut `allowed_areas` lesen darf und die Variante enthaelt; sonst
 * antwortete das Backend mit 403 und die App zeigte eine Fehlermeldung. Auch
 * gelesen wird nur dann: Eine abgeschaltete Abfrage liefert weiter ihren
 * Cache, nach einem Rechteentzug zaehlten sonst alte Daten mit.
 *
 * Offen (rotes Quadrat, „Aufgaben fuer Sie“) ist nur, was das Konto auch
 * erledigen kann: Recht `bearbeiten` im Bereich und keine Entscheidung, die
 * das Backend nach dem Vier-Augen-Prinzip abweist (Abwesenheit und
 * Stammdaten: die eigene Person; Gehalt: der selbst gestellte Antrag). Die
 * Widgets zeigen trotzdem alles.
 *
 * Laden: Den Spinner gibt es nur beim ersten Aufbau. Kommt spaeter eine
 * Abfrage neu hinzu (neues Datum, neues Recht), zeigt nur ihr Widget, dass es
 * laedt; die Seite bleibt stehen.
 */

/** Quellen des Modells; scheitert eine, zeigen ihre Widgets das statt einer Leermeldung. */
export type DashboardSource =
  | 'today' | 'pending' | 'window' | 'soon' | 'missing' | 'sickNotes' | 'followUps' | 'announcements'
  | 'salary' | 'changes' | 'documents' | 'onboarding';

export type Tone = 'overdue' | 'decide' | 'running';
export type TaskKind =
  | 'sick' | 'request' | 'followup' | 'salary' | 'profile' | 'document' | 'onboarding' | 'announcement' | 'survey';

export interface TaskAction {
  label: string;
  primary?: boolean;
  /** Fachseite, die die Aktion ausfuehrt (oder bei Inline-Aktionen den Rest erledigt). */
  to: string;
  /** Genehmigt diesen Abwesenheitsantrag direkt auf dem Dashboard. */
  approveId?: number;
  /** Rechtebereich, fuer den die Aktion `bearbeiten` braucht; fehlt er, entfaellt der Knopf. */
  area?: AdminArea;
  /** Entscheidung ueber einen Antrag: nicht fuer den eigenen (Vier-Augen-Prinzip). */
  decision?: boolean;
}

export interface DashboardTask {
  key: string;
  kind: TaskKind;
  tone: Tone;
  /** Kann dieses Konto die Aufgabe erledigen (Recht bearbeiten, nicht der eigene Antrag)? */
  actionable: boolean;
  employeeId: number | null;
  person: string;
  title: string;
  meta: string;
  age: string;
  unit: string;
  /** Sortierwert innerhalb der Stufe: groesser = dringender. */
  weight: number;
  /** Anzahl erledigt / gesamt (Onboarding, Bestaetigungen), sonst null. */
  progress: { done: number; total: number } | null;
  actions: TaskAction[];
  to: string;
}

export interface PlanRow {
  id: number;
  employeeId: number;
  person: string;
  typeName: string;
  category: string | undefined;
  status: 'beantragt' | 'genehmigt';
  color: string;
  from: string;
  to: string;
  days: number;
  proxy: boolean;
  left: number;
  width: number;
}

/** Bereiche der Dashboard-Aufschluesselung, in der Reihenfolge ihrer Alltagsrelevanz fuer die HR. */
export type AreaKey =
  | 'abwesenheit' | 'personal' | 'kommunikation' | 'verguetung' | 'recruiting' | 'verwaltung' | 'leistung' | 'einstellungen';

/** Reihenfolge der Bereichsleiste; 'einstellungen' traegt nur das Lizenz-Widget und hat kein Feld. */
const BAND_ORDER: Exclude<AreaKey, 'einstellungen'>[] = [
  'abwesenheit', 'personal', 'kommunikation', 'verguetung', 'recruiting', 'verwaltung', 'leistung',
];

export const AREA_LABELS: Record<AreaKey, string> = {
  abwesenheit: 'Abwesenheit',
  personal: 'Personal',
  kommunikation: 'Kommunikation',
  verguetung: 'Vergütung',
  recruiting: 'Recruiting',
  verwaltung: 'Verwaltung',
  leistung: 'Leistung & Führung',
  einstellungen: 'System',
};

/** Akzentfarbe je Bereich aus der Organigramm-Palette (in allen Themes definiert). */
export const AREA_COLORS: Record<AreaKey, string> = {
  abwesenheit: 'var(--org-2)',
  personal: 'var(--org-1)',
  kommunikation: 'var(--org-5)',
  verguetung: 'var(--org-4)',
  recruiting: 'var(--org-3)',
  verwaltung: 'var(--org-6)',
  leistung: 'var(--blue-700)',
  einstellungen: 'var(--gray-500)',
};

/** Fachseite je Bereich: Ziel, wenn ein gefilterter Bereich kein Widget hat. */
export const AREA_PATHS: Record<AreaKey, string> = {
  abwesenheit: '/abwesenheit/antraege',
  personal: '/personal/aenderungsantraege',
  kommunikation: '/kommunikation/ankuendigungen',
  verguetung: '/verguetung/gehaelter',
  recruiting: '/recruiting/stellen',
  verwaltung: '/verwaltung/onboarding',
  leistung: '/leistung/feedback',
  einstellungen: '/einstellungen',
};

/** Quellen, aus denen die Zahlen eines Bereichs der Leiste entstehen. */
const AREA_SOURCES: Record<Exclude<AreaKey, 'einstellungen'>, DashboardSource[]> = {
  abwesenheit: ['today', 'pending', 'missing'],
  personal: ['changes', 'documents'],
  kommunikation: ['followUps', 'announcements'],
  verguetung: ['salary'],
  recruiting: [],
  verwaltung: ['onboarding'],
  leistung: [],
};

/** Rechtebereich, der ein Feld der Bereichsleiste lesbar macht. */
const AREA_ADMIN: Record<Exclude<AreaKey, 'einstellungen'>, AdminArea> = {
  abwesenheit: 'abwesenheit',
  personal: 'personal',
  kommunikation: 'kommunikation',
  verguetung: 'verguetung',
  recruiting: 'recruiting',
  verwaltung: 'verwaltung',
  leistung: 'leistung',
};

export interface AreaSummary {
  key: AreaKey;
  label: string;
  /**
   * Offene Punkte: was die HR in diesem Bereich noch entscheiden oder nachholen
   * muss (laufende Vorgaenge und Termine zaehlen nicht). Zahl im roten Quadrat.
   */
  open: number;
  /**
   * Die Zahl, die ein Mensch in der HR bei diesem Bereich zuerst wissen will
   * (Abwesenheit: wer heute fehlt, nicht wie viele Antraege liegen).
   */
  value: number;
  valueLabel: string;
  /** Ergaenzung zur Zahl, etwa weitere Abwesende laut offenem Antrag. */
  extra: string;
  /** Eine Quelle des Bereichs fehlt (Fehler oder laedt noch): Zahlen sind unvollstaendig. */
  incomplete: boolean;
  /**
   * Laufende Vorgaenge, die auf andere warten (unbestaetigte Ankuendigungen,
   * On- und Offboarding). Ohne offene Punkte zeigt der Bereich dafuer die Sanduhr.
   */
  running: number;
}

export interface TodayAbsence {
  key: string;
  employeeId: number;
  name: string;
  typeName: string;
  color: string;
  to: string;
  /** Naechster Arbeitstag nach dem Ende (Backend: ohne Feiertage der Region und Betriebsruhe). */
  back: string;
  /** Antrag hinter der Zeile. */
  requestId: number;
  pending: boolean;
  /** Heute nur ein halber Tag abwesend. */
  halfToday: boolean;
  /** Heute wieder da (halber letzter Tag). */
  backToday: boolean;
}

export interface SoonAbsence {
  key: string;
  employeeId: number;
  name: string;
  typeName: string;
  color: string;
  from: string;
  to: string;
  pending: boolean;
}

export interface CurrentSick {
  key: string;
  employeeId: number;
  name: string;
  from: string;
  to: string;
  childSick: boolean;
  hasCertificate: boolean;
  /** Kalendertage der AU-Kette bis heute (Entgeltfortzahlung, 42 Tage). */
  payUsed: number;
  exceeded: boolean;
}

export interface DashboardAnnouncement {
  id: number;
  title: string;
  audience: string;
  publishAt: string;
  ack: number;
  total: number;
}

export interface DashboardModel {
  loading: boolean;
  allowed: ReadonlySet<AdminArea>;
  areas: AreaSummary[];
  announcements: DashboardAnnouncement[];
  today: string;
  /** Quellen ohne Daten, weil ihre Abfrage gescheitert ist. */
  failed: ReadonlySet<DashboardSource>;
  /** Davon ohne Netz pausiert: laden von selbst, sobald die Verbindung besteht. */
  offline: ReadonlySet<DashboardSource>;
  /** Quellen, die zum ersten Mal laden (nach dem ersten Aufbau, etwa nach einem neuen Recht). */
  pendingSources: ReadonlySet<DashboardSource>;
  tasks: DashboardTask[];
  /** Ueberfaellig oder zu entscheiden und vom Konto erledigbar: „Aufgaben fuer Sie“. */
  openTasks: DashboardTask[];
  /** Heute genehmigt abwesend (zaehlt als fehlt heute). */
  todayAbsences: TodayAbsence[];
  /** Heute laut offenem Antrag abwesend: faktisch weg, aber nicht entschieden (ohne die schon genehmigt Abwesenden). */
  pendingToday: TodayAbsence[];
  /** Davon vom Konto entscheidbar (Quadrat und Hinweis „Jetzt entscheiden“). */
  pendingTodayDecidable: TodayAbsence[];
  /** Beginnt in den naechsten 7 Tagen. */
  soonAbsences: SoonAbsence[];
  currentSick: CurrentSick[];
  plan: { weeks: { kw: number; date: string }[]; rows: PlanRow[]; todayLeft: number; todayWidth: number; from: string; to: string };
}

// ---------------------------------------------------------------------------
// Datumshilfen (reine ISO-Strings, ohne Zeitzonenfalle)
// ---------------------------------------------------------------------------

const dayNum = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const isoOf = (n: number): string => new Date(n * 86400000).toISOString().slice(0, 10);
const diffDays = (later: string, earlier: string): number => dayNum(later) - dayNum(earlier);

/** Kurzdatum fuer kompakte Spalten: 24.09. (Jahr nur, wenn es nicht das von `today` ist). */
export function shortDate(iso: string, today: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y === today.slice(0, 4) ? `${d}.${m}.` : `${d}.${m}.${y}`;
}

/** Montag der Woche, in der `iso` liegt (1.1.1970 war ein Donnerstag). */
const mondayOf = (iso: string): number => {
  const n = dayNum(iso);
  return n - ((n + 3) % 7);
};

function isoWeek(n: number): number {
  const d = new Date(n * 86400000);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
}

/** Zeile aus GET /api/absences/today. */
interface TodayRow {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  status: AbsenceRequestStatus;
  date_from: string;
  date_to: string;
  type_name: string;
  type_color: string;
  back_on: string;
  /** Heute nur ein halber Tag (erster oder letzter Tag halb). */
  half_today: boolean;
  /** back_on ist heute (nach dem Datum des Servers, nicht des Clients). */
  back_today: boolean;
}

interface SalaryRequestRow {
  id: number;
  employee_id: number;
  /** Konto, das den Antrag gestellt hat; es genehmigt ihn nicht selbst (Vier-Augen-Prinzip). */
  requested_by_user_id: number | null;
  first_name: string;
  last_name: string;
  effective_date: string;
  created_at: string;
}

const ROUTES = {
  requests: '/abwesenheit/antraege',
  sick: '/abwesenheit/krankmeldungen',
  salary: '/verguetung/gehaelter',
  profile: '/personal/aenderungsantraege',
  followups: '/kommunikation/gespraeche',
  calendar: '/abwesenheit/kalender',
  onboarding: '/verwaltung/onboarding',
  announcements: '/kommunikation/ankuendigungen',
  surveys: '/kommunikation/umfragen',
};

/** Antragsseite, Reiter „Offen“, mit Sprung zu genau diesem Antrag. */
export const requestLink = (id: number) => `${ROUTES.requests}?tab=offen&antrag=${id}`;
/** Abwesenheitskalender mit markierter Person. */
export const calendarLink = (employeeId: number) => `${ROUTES.calendar}?person=${employeeId}`;

export function useDashboardModel({ needsPlan = true }: { needsPlan?: boolean } = {}): DashboardModel {
  const today = todayIsoLocal();
  const dash = useDashboard();
  const { user, can } = useAuth();
  const readable = new Set<AdminArea>(dash.data?.allowed_areas ?? []);
  const may = (area: AdminArea) => readable.has(area) && moduleEnabled(VARIANT, AREA_MODULES[area]);
  const abs = may('abwesenheit');
  const komm = may('kommunikation');
  const pers = may('personal');
  const verg = may('verguetung');
  const verw = may('verwaltung');

  const winStart = mondayOf(today) - 35;
  const winFrom = isoOf(winStart);
  const winTo = isoOf(winStart + 69);

  const absentNow = useQuery({
    queryKey: ['absences', 'today'],
    queryFn: () => api.get<{ absences: TodayRow[] }>('/api/absences/today'),
    select: (d) => d.absences,
    enabled: abs,
  });
  const pending = useQuery({
    queryKey: ['absences', 'requests', { status: 'beantragt' }],
    queryFn: () => api.get<{ requests: AbsenceRequest[] }>('/api/absences/requests?status=beantragt'),
    select: (d) => d.requests,
    enabled: abs,
  });
  const windowReqs = useQuery({
    queryKey: ['absences', 'requests', { from: winFrom, to: winTo }],
    queryFn: () => api.get<{ requests: AbsenceRequest[] }>(`/api/absences/requests?from=${winFrom}&to=${winTo}`),
    select: (d) => d.requests,
    // Neues Fenster am Montag: das alte stehen lassen, bis das neue da ist.
    placeholderData: keepPreviousData,
    // Zehn Wochen der ganzen Firma: nur, wenn der Plan zu sehen ist.
    enabled: abs && needsPlan,
  });
  // Naechste 7 Tage (Widget Heute abwesend): enges Fenster statt des Plans.
  const soonFrom = isoOf(dayNum(today) + 1);
  const soonTo = isoOf(dayNum(today) + 7);
  const soonReqs = useQuery({
    queryKey: ['absences', 'requests', { from: soonFrom, to: soonTo }],
    queryFn: () => api.get<{ requests: AbsenceRequest[] }>(`/api/absences/requests?from=${soonFrom}&to=${soonTo}`),
    select: (d) => d.requests,
    placeholderData: keepPreviousData,
    enabled: abs,
  });
  const missing = useQuery({
    queryKey: ['absences', 'sick-notes', 'missing'],
    queryFn: () => api.get<{ sick_notes: SickNote[] }>('/api/absences/sick-notes/missing'),
    select: (d) => d.sick_notes,
    enabled: abs,
  });
  // Nur wer heute krankgemeldet ist, nicht das ganze Jahr (Kettenanreicherung je Zeile im Backend).
  const sickNotes = useQuery({
    queryKey: ['absences', 'sick-notes', { activeOn: today }],
    queryFn: () => api.get<{ sick_notes: SickNote[] }>(`/api/absences/sick-notes?active_on=${today}`),
    select: (d) => d.sick_notes,
    // Neuer Tag: den alten Stand zeigen, bis der neue da ist.
    placeholderData: keepPreviousData,
    enabled: abs,
  });
  const followUps = useQuery({
    queryKey: ['communication', 'meetings', 'follow-ups'],
    queryFn: () => api.get<{ meetings: Meeting[] }>('/api/communication/meetings/follow-ups'),
    select: (d) => d.meetings,
    enabled: komm,
  });
  const announcements = useQuery({
    // Nur heute gueltige (Filter am Endpunkt); Invalidierung ueber ['communication', 'announcements'] trifft auch diesen Key.
    queryKey: ['communication', 'announcements', { status: 'aktiv' }],
    queryFn: () => api.get<{ announcements: Announcement[] }>('/api/communication/announcements?status=aktiv'),
    select: (d) => d.announcements,
    enabled: komm,
  });
  const salary = useQuery({
    queryKey: ['compensation', 'change-requests', 'beantragt'],
    queryFn: () => api.get<{ requests: SalaryRequestRow[] }>('/api/compensation/change-requests?status=beantragt'),
    select: (d) => d.requests,
    enabled: verg,
  });
  const changes = useQuery({
    queryKey: ['employees', 'change-requests', { status: 'beantragt' }],
    queryFn: () =>
      api.get<{ requests: EmployeeChangeRequestForHr[]; open_count: number }>('/api/employees/change-requests?status=beantragt'),
    enabled: pers,
  });
  const documents = useQuery({
    queryKey: ['documents', 'expiring'],
    queryFn: () => api.get<{ documents: DocumentRow[] }>('/api/documents/expiring'),
    select: (d) => d.documents,
    enabled: pers,
  });
  const onboarding = useQuery({
    queryKey: ['admin', 'onboarding', 'laufend', ''],
    queryFn: () => api.get<{ processes: OnboardingProcess[] }>('/api/admin/onboarding?status=laufend'),
    select: (d) => d.processes,
    enabled: verw,
  });

  // Ohne Leserecht sind die Abfragen abgeschaltet und laden nie (isLoading bleibt false).
  // Beim ersten Aufbau wird auf alle gewartet (sonst zeigten Widgets ihre
  // Leermeldung); danach laedt eine neu hinzukommende Abfrage nur in ihrem Widget.
  const queries = {
    today: absentNow, pending, window: windowReqs, soon: soonReqs, missing, sickNotes, followUps, announcements,
    salary, changes, documents, onboarding,
  } satisfies Record<DashboardSource, { isLoading: boolean; isError: boolean; fetchStatus: string; data: unknown }>;
  // Regeln (Spinner nur beim ersten Aufbau, Fehler nur ohne Daten, pausiert
  // ohne Netz zaehlt als fehlend) DOM-frei in shared/dashboard.ts.
  const states = Object.fromEntries(
    (Object.keys(queries) as DashboardSource[]).map((k) => [k, {
      loading: queries[k].isLoading,
      error: queries[k].isError,
      paused: queries[k].fetchStatus === 'paused',
      hasData: queries[k].data !== undefined,
    }]),
  ) as Record<DashboardSource, DashboardSourceState>;
  const builtOnce = useRef(false);
  const status = dashboardSourceStatus(states, builtOnce.current);
  if (!status.anyLoading && !dash.isLoading && dash.data) builtOnce.current = true;
  const loading = dash.isLoading || status.initialLoading;
  // Mengen nur neu bauen, wenn sich ihr Inhalt aendert (stabile Abhaengigkeiten fuer das Modell).
  const pendingKey = status.pending.join(',');
  const failedKey = status.failed.join(',');
  const offlineKey = status.offline.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pendingSet = useMemo(() => new Set(status.pending), [pendingKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const failedSet = useMemo(() => new Set(status.failed), [failedKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const offlineSet = useMemo(() => new Set(status.offline), [offlineKey]);

  // Daten nur mit Recht lesen (abgeschaltete Abfragen liefern sonst ihren alten Cache).
  const absentNowData = abs ? absentNow.data : undefined;
  const pendingData = abs ? pending.data : undefined;
  const windowData = abs && needsPlan ? windowReqs.data : undefined;
  const soonData = abs ? soonReqs.data : undefined;
  const missingData = abs ? missing.data : undefined;
  const sickData = abs ? sickNotes.data : undefined;
  const followUpData = komm ? followUps.data : undefined;
  const announcementData = komm ? announcements.data : undefined;
  const salaryData = verg ? salary.data : undefined;
  const changesData = pers ? changes.data : undefined;
  const documentData = pers ? documents.data : undefined;
  const onboardingData = verw ? onboarding.data : undefined;
  const userEmployeeId = user?.employee_id ?? null;
  const userId = user?.id ?? null;

  return useMemo<DashboardModel>(() => {
    const tasks: DashboardTask[] = [];
    // Erledigbar: Recht bearbeiten im Bereich und keine Entscheidung, die das Vier-Augen-Prinzip sperrt.
    // Vier-Augen-Regeln aus shared/fourEyes.ts, dieselben wie im Backend.
    const doable = (area: AdminArea, blocked = false) => can(area, 'bearbeiten') && !blocked;
    const isOwnPerson = (employeeId: number | null) => isOwnPersonDecision(userEmployeeId, employeeId);
    const nameOf = (f?: string, l?: string) => `${f ?? ''} ${l ?? ''}`.trim();

    for (const n of missingData ?? []) {
      const late = Math.max(0, diffDays(today, n.certificate_due_date));
      tasks.push({
        key: `sick-${n.id}`, kind: 'sick', tone: 'overdue', actionable: doable('abwesenheit'),
        employeeId: n.employee_id ?? null,
        person: nameOf(n.first_name, n.last_name), title: 'AU fehlt',
        meta: `Krank vom ${formatRangeInText(n.date_from ?? today, n.date_to ?? today, today)}, ${daysInText(n.days_counted ?? 0, LOCALE, n.closure_covered === 1)}. Der Nachweis war am ${formatDateInText(n.certificate_due_date, today)} fällig.`,
        age: String(late), unit: 'Tage überfällig', weight: 1000 + late, progress: null,
        actions: [{ label: 'AU eingegangen', primary: true, to: ROUTES.sick, area: 'abwesenheit' }, { label: 'Öffnen', to: ROUTES.sick }],
        to: ROUTES.sick,
      });
    }

    for (const r of pendingData ?? []) {
      const started = r.date_from <= today;
      const ended = r.date_to < today;
      const type = r.type_name ?? 'Abwesenheit';
      let age: string; let unit: string; let title: string;
      if (ended) {
        age = String(diffDays(today, r.date_to)); unit = 'Tage seit Ende'; title = `${type}, schon vorbei`;
      } else if (started) {
        age = 'läuft'; unit = `seit ${shortDate(r.date_from, today)}`; title = `${type} läuft, nicht entschieden`;
      } else {
        age = String(diffDays(r.date_from, today)); unit = 'Tage bis Beginn'; title = type;
      }
      // Was die Antragsseite vor dem Entscheiden zeigt, steht auch hier: Halbtage,
      // Betriebsruhe und der Kommentar der Person.
      const halves = [r.half_day_start === 1 ? 'erster Tag halb' : '', r.half_day_end === 1 ? 'letzter Tag halb' : '']
        .filter(Boolean).join(', ');
      const note = (r.comment ?? '').trim();
      tasks.push({
        key: `req-${r.id}`, kind: 'request', tone: started ? 'overdue' : 'decide',
        actionable: doable('abwesenheit', isOwnPerson(r.employee_id)), employeeId: r.employee_id,
        person: nameOf(r.first_name, r.last_name), title,
        meta: `${formatRangeInText(r.date_from, r.date_to, today)}, ${daysInText(r.days_counted, LOCALE, r.closure_covered === 1)}${halves ? ` (${halves})` : ''}. ${r.created_by_proxy ? 'Vom HR erfasst.' : 'Aus dem Portal beantragt.'}${note ? ` Kommentar: „${note}“` : ''}`,
        age, unit, weight: started ? (ended ? 760 : 900) : 100 - diffDays(r.date_from, today),
        progress: null,
        actions: [
          { label: 'Genehmigen', primary: true, to: requestLink(r.id), approveId: r.id, area: 'abwesenheit', decision: true },
          // Ablehnen verlangt eine Begruendung: dafuer die Antragsseite, direkt beim Antrag.
          { label: 'Ablehnen', to: requestLink(r.id), area: 'abwesenheit', decision: true },
        ],
        to: requestLink(r.id),
      });
    }

    for (const m of followUpData ?? []) {
      if (!m.follow_up_date) continue;
      const late = Math.max(0, diffDays(today, m.follow_up_date));
      const agreements = (m.agreements ?? '').trim();
      const fuLink = `${ROUTES.followups}?employee=${m.employee_id}`;
      tasks.push({
        key: `fu-${m.id}`, kind: 'followup', tone: 'overdue', actionable: doable('kommunikation'),
        employeeId: m.employee_id,
        person: nameOf(m.first_name, m.last_name), title: `Wiedervorlage ${MEETING_OCCASION_LABELS[m.occasion]}`,
        meta: `Seit ${formatDateInText(m.follow_up_date, today)} fällig.${agreements ? ` ${agreements.length > 90 ? `${agreements.slice(0, 90)}...` : agreements}` : ''}`,
        age: late === 0 ? 'heute' : String(late), unit: late === 0 ? 'fällig' : 'Tage überfällig', weight: 700 + late, progress: null,
        actions: [{ label: 'Gespräch erfassen', primary: true, to: fuLink, area: 'kommunikation' }, { label: 'Protokoll', to: fuLink }],
        to: fuLink,
      });
    }

    for (const s of salaryData ?? []) {
      tasks.push({
        // Gehalt: gesperrt ist, wer den Antrag gestellt hat (salaryRoutes.ts), nicht die betroffene Person.
        key: `sal-${s.id}`, kind: 'salary', tone: 'decide',
        actionable: doable('verguetung', isOwnRequestDecision(userId, s.requested_by_user_id)),
        employeeId: s.employee_id,
        person: nameOf(s.first_name, s.last_name), title: 'Gehaltsänderung',
        meta: `Wirksam ab ${formatDateInText(s.effective_date, today)}. Entscheidet eine zweite Person.`,
        age: String(diffDays(today, s.created_at.slice(0, 10))), unit: 'Tage offen',
        weight: 50 + diffDays(today, s.created_at.slice(0, 10)), progress: null,
        actions: [{ label: 'Prüfen', primary: true, to: ROUTES.salary }], to: ROUTES.salary,
      });
    }

    for (const c of changesData?.requests ?? []) {
      const labels = (c.fields ?? []).map((f) => f.label).join(', ');
      const chgLink = `${ROUTES.profile}?antrag=${c.id}`;
      tasks.push({
        key: `chg-${c.id}`, kind: 'profile', tone: 'decide', actionable: doable('personal', isOwnPerson(c.employee_id)),
        employeeId: c.employee_id,
        person: nameOf(c.first_name, c.last_name), title: 'Stammdaten ändern',
        meta: labels ? `Beantragt: ${labels}.` : 'Änderungsantrag aus dem Portal.',
        age: String(diffDays(today, c.created_at.slice(0, 10))), unit: 'Tage offen',
        weight: 40 + diffDays(today, c.created_at.slice(0, 10)), progress: null,
        actions: [{ label: 'Prüfen', primary: true, to: chgLink }], to: chgLink,
      });
    }

    for (const d of documentData ?? []) {
      if (!d.expiry_date) continue;
      const left = d.days_until_expiry ?? diffDays(d.expiry_date, today);
      const expired = left < 0;
      tasks.push({
        key: `doc-${d.id}`, kind: 'document', tone: expired ? 'overdue' : 'decide',
        actionable: doable('personal'), employeeId: d.employee_id,
        person: d.employee_name ?? 'Ohne Zuordnung', title: d.title,
        meta: expired
          ? `Abgelaufen am ${formatDateInText(d.expiry_date, today)}.`
          : `Läuft am ${formatDateInText(d.expiry_date, today)} ab.`,
        age: expired ? String(-left) : left === 0 ? 'heute' : String(left),
        unit: expired ? 'Tage abgelaufen' : left === 0 ? 'läuft ab' : 'Tage bis Ablauf',
        weight: expired ? 600 - left : 60 - left, progress: null,
        actions: [{ label: 'Öffnen', primary: true, to: `/personal/dokumente?dokument=${d.id}` }],
        to: `/personal/dokumente?dokument=${d.id}`,
      });
    }

    for (const p of onboardingData ?? []) {
      const done = p.done_tasks ?? 0;
      const total = p.total_tasks ?? 0;
      tasks.push({
        key: `onb-${p.id}`, kind: 'onboarding', tone: 'running', actionable: false, employeeId: p.employee_id,
        person: nameOf(p.first_name, p.last_name), title: ONBOARDING_KIND_LABELS[p.kind],
        meta: p.note ?? [p.job_title, p.department_name].filter(Boolean).join(', '),
        age: `${done} von ${total}`, unit: 'Aufgaben erledigt', weight: total - done, progress: { done, total },
        actions: [{ label: 'Aufgaben öffnen', to: ROUTES.onboarding }], to: ROUTES.onboarding,
      });
    }

    for (const a of announcementData ?? []) {
      if (!a.requires_ack || a.status !== 'aktiv' || a.ack_count >= a.recipients) continue;
      tasks.push({
        key: `ann-${a.id}`, kind: 'announcement', tone: 'running', actionable: false, employeeId: null, person: '',
        title: `Ankündigung: ${a.title}`,
        meta: `${a.audience_name ?? 'Alle'}, seit ${formatDateInText(a.publish_at, today)}. Bestätigung verlangt.`,
        age: `${a.ack_count} von ${a.recipients}`, unit: 'haben bestätigt', weight: diffDays(today, a.publish_at),
        progress: { done: a.ack_count, total: a.recipients },
        actions: [{ label: 'Öffnen', to: ROUTES.announcements }], to: ROUTES.announcements,
      });
    }

    for (const s of dash.data?.runningSurveys ?? []) {
      if (s.date_to < today) continue;
      tasks.push({
        key: `sur-${s.id}`, kind: 'survey', tone: 'running', actionable: false, employeeId: null, person: '',
        title: `Umfrage: ${s.title}`, meta: `Läuft bis ${formatDateInText(s.date_to, today)}.`,
        age: String(s.participations), unit: 'Teilnahmen bisher', weight: 0, progress: null,
        actions: [{ label: 'Öffnen', to: ROUTES.surveys }], to: ROUTES.surveys,
      });
    }

    const order: Record<Tone, number> = { overdue: 0, decide: 1, running: 2 };
    tasks.sort((a, b) => order[a.tone] - order[b.tone] || b.weight - a.weight);

    // Anwesenheitsplan: 10 Wochen, 5 zurueck bis 5 voraus.
    const rows: PlanRow[] = (windowData ?? [])
      .filter((r) => r.status === 'beantragt' || r.status === 'genehmigt')
      .map((r) => {
        const left = ((dayNum(r.date_from) - winStart) / 70) * 100;
        const right = ((dayNum(r.date_to) + 1 - winStart) / 70) * 100;
        return {
          id: r.id, employeeId: r.employee_id, person: nameOf(r.first_name, r.last_name),
          typeName: r.type_name ?? 'Abwesenheit', category: r.type_category,
          status: r.status as 'beantragt' | 'genehmigt', color: r.type_color ?? 'var(--gray-400)', from: r.date_from, to: r.date_to,
          days: r.days_counted, proxy: Boolean(r.created_by_proxy),
          left: Math.max(0, left), width: Math.max(1.2, Math.min(100, right) - Math.max(0, left)),
        };
      })
      .sort((a, b) => comparePlanRows(a, b, today) || a.person.localeCompare(b.person));
    const weeks = Array.from({ length: 10 }, (_, i) => {
      const n = winStart + i * 7;
      const [, m, d] = isoOf(n).split('-');
      return { kw: isoWeek(n), date: `${d}.${m}.` };
    });
    const todayLeft = ((dayNum(today) - winStart) / 70) * 100;

    // Heute und demnaechst: was die HR beim ersten Blick wissen will.
    const todayN = dayNum(today);
    const currentSick: CurrentSick[] = (sickData ?? [])
      .filter((n) => n.date_from && n.date_to && n.date_from <= today && n.date_to >= today && n.request_status !== 'storniert' && n.request_status !== 'abgelehnt')
      .map((n) => ({
        key: `cs-${n.id}`, employeeId: n.employee_id ?? 0, name: nameOf(n.first_name, n.last_name),
        from: n.date_from ?? today, to: n.date_to ?? today, childSick: n.child_sick === 1,
        // Wie die Liste fehlender AU (sick-notes/missing): massgeblich ist die hochgeladene Bescheinigung.
        hasCertificate: n.certificate_file_id !== null,
        payUsed: n.sick_pay_days_used ?? 0, exceeded: Boolean(n.sick_pay_exceeded),
      }));
    const toAbsence = (a: TodayRow): TodayAbsence => ({
      key: `ta-${a.id}`, employeeId: a.employee_id, name: nameOf(a.first_name, a.last_name), typeName: a.type_name,
      color: a.type_color, to: a.date_to, back: a.back_on, pending: a.status === 'beantragt', requestId: a.id,
      halfToday: a.half_today, backToday: a.back_today,
    });
    // Je Person eine Zeile; wer genehmigt fehlt, zaehlt nicht zusaetzlich „laut Antrag“.
    const seen = new Set<number>();
    const firstPerPerson = (a: TodayRow) => !seen.has(a.employee_id) && Boolean(seen.add(a.employee_id));
    const todayAbsences: TodayAbsence[] = (absentNowData ?? [])
      .filter((a) => a.status === 'genehmigt' && firstPerPerson(a))
      .map(toAbsence);
    const pendingToday: TodayAbsence[] = (absentNowData ?? [])
      .filter((a) => a.status === 'beantragt' && firstPerPerson(a))
      .map(toAbsence);
    const pendingTodayDecidable = pendingToday.filter((a) => doable('abwesenheit', isOwnPerson(a.employeeId)));
    const soonAbsences: SoonAbsence[] = (soonData ?? [])
      .filter((r) => (r.status === 'beantragt' || r.status === 'genehmigt') && dayNum(r.date_from) > todayN && dayNum(r.date_from) <= todayN + 7)
      .map((r) => ({
        key: `so-${r.id}`, employeeId: r.employee_id, name: nameOf(r.first_name, r.last_name),
        typeName: r.type_name ?? 'Abwesenheit', color: r.type_color ?? 'var(--gray-400)',
        from: r.date_from, to: r.date_to, pending: r.status === 'beantragt',
      }))
      .sort((a, b) => a.from.localeCompare(b.from));

    const allowed = new Set<AdminArea>(dash.data?.allowed_areas ?? []);
    const stats = dash.data?.stats ?? {};
    // Zaehlungen der Leiste: nur, was das Konto erledigen kann.
    const ofKind = (...kinds: TaskKind[]) => tasks.filter((t) => t.actionable && kinds.includes(t.kind));
    const absTasks = ofKind('sick', 'request');
    const profileTasks = ofKind('profile');
    const docTasks = ofKind('document');
    const docsExpired = docTasks.filter((t) => t.tone === 'overdue').length;
    const docsSoon = docTasks.length - docsExpired;
    const salaryTasks = ofKind('salary');
    const fuTasks = ofKind('followup');
    const annTasks = tasks.filter((t) => t.kind === 'announcement');
    const onbTasks = tasks.filter((t) => t.kind === 'onboarding');
    const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    // Laufend (Sanduhr) ist ein Vorgang nur, solange Aufgaben offen sind.
    const onbWithOpenTasks = onbTasks.filter((t) => (t.progress?.total ?? 0) > (t.progress?.done ?? 0)).length;
    const meetings = dash.data?.upcomingMeetings ?? [];
    type Raw = Omit<AreaSummary, 'key' | 'label' | 'incomplete'>;
    const raw: Record<Exclude<AreaKey, 'einstellungen'>, Raw> = {
      abwesenheit: {
        open: absTasks.length,
        value: todayAbsences.length, valueLabel: 'heute abwesend',
        extra: pendingToday.length > 0 ? `+${pendingToday.length} laut Antrag` : '',
        running: 0,
      },
      personal: {
        open: profileTasks.length + docTasks.length,
        value: profileTasks.length, valueLabel: 'Stammdaten-Anträge',
        extra: [
          docsExpired > 0 ? `+${pl(docsExpired, 'Dokument', 'Dokumente')} abgelaufen` : '',
          docsSoon > 0 ? `+${pl(docsSoon, 'Dokument läuft', 'Dokumente laufen')} ab` : '',
        ].filter(Boolean).join(' · '),
        running: 0,
      },
      kommunikation: {
        open: fuTasks.length,
        value: fuTasks.length, valueLabel: 'Wiedervorlagen fällig', extra: '',
        running: annTasks.length,
      },
      verguetung: {
        open: salaryTasks.length,
        value: salaryTasks.length, valueLabel: 'Gehaltsanträge', extra: '',
        running: 0,
      },
      recruiting: {
        open: 0,
        value: stats.upcomingInterviewsCount ?? 0, valueLabel: 'Interviews', extra: '',
        running: 0,
      },
      verwaltung: {
        open: 0,
        value: onbTasks.length, valueLabel: 'On- und Offboarding',
        extra: '',
        running: onbWithOpenTasks,
      },
      leistung: {
        open: 0,
        value: meetings.length, valueLabel: 'Gespräche in 3 Wochen', extra: '',
        running: 0,
      },
    };
    // Fehlt eine Quelle (Fehler oder laedt noch), sind die Zahlen des Bereichs unvollstaendig.
    const missingSources = new Set([...failedSet, ...pendingSet]);
    const areas: AreaSummary[] = BAND_ORDER.flatMap((key) => {
      const admin = AREA_ADMIN[key];
      if (!allowed.has(admin) || !moduleEnabled(VARIANT, AREA_MODULES[admin])) return [];
      const incomplete = AREA_SOURCES[key].some((src) => missingSources.has(src));
      return [{ key, label: AREA_LABELS[key], ...raw[key], incomplete }];
    });

    const announcementsOut: DashboardAnnouncement[] = (announcementData ?? [])
      .filter((a) => a.status === 'aktiv')
      .map((a) => ({
        id: a.id, title: a.title, audience: a.audience_name ?? 'Alle', publishAt: a.publish_at,
        ack: a.requires_ack ? a.ack_count : -1, total: a.recipients,
      }));

    return {
      loading,
      allowed,
      areas,
      announcements: announcementsOut,
      today,
      failed: failedSet,
      offline: offlineSet,
      pendingSources: pendingSet,
      tasks,
      openTasks: tasks.filter((t) => t.actionable && t.tone !== 'running'),
      todayAbsences,
      pendingToday,
      pendingTodayDecidable,
      soonAbsences,
      currentSick,
      plan: { weeks, rows, todayLeft, todayWidth: 100 / 70, from: winFrom, to: winTo },
    };
  }, [
    today, loading, failedSet, pendingSet, offlineSet, dash.data, absentNowData, pendingData, missingData, followUpData, salaryData,
    changesData, onboardingData, announcementData, windowData, soonData, sickData, documentData, winStart, winFrom, winTo,
    can, userEmployeeId, userId,
  ]);
}

/** Farbe einer Person aus der Organigramm-Palette (stabil je Personal-ID). */
export const personColor = (id: number | null): string => `var(--org-${((id ?? 0) % 6) + 1})`;
