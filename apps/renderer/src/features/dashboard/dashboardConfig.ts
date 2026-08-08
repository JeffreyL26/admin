import type { LucideIcon } from 'lucide-react';
import {
  Users, CalendarDays, Send, Stethoscope, FolderClock, Wallet, Briefcase,
  CalendarClock, TrendingUp, Building2, MessagesSquare, Megaphone, BarChart3, Cake,
  UserPlus,
} from 'lucide-react';
import type { DashboardStats } from './api';

/**
 * Registry des personalisierbaren Dashboards.
 *
 * Die Auswahl (welche Widgets, welche KPI-Kacheln, in welcher Reihenfolge)
 * ist eine reine Anzeige-Präferenz und wird deshalb — wie das Theme — lokal
 * im localStorage persistiert (`hrmonic.dashboard`), nicht im Backend.
 * Neue Widgets künftiger Module werden hier registriert und erscheinen für
 * Bestandsnutzer über „Anpassen → Widget hinzufügen“.
 */

// ---------------------------------------------------------------------------
// KPI-Kacheln
// ---------------------------------------------------------------------------

export type StatKey =
  | 'headcount'
  | 'absentToday'
  | 'pendingAbsences'
  | 'missingSickNotes'
  | 'expiringDocuments'
  | 'openSalaryRequests'
  | 'openPositions'
  | 'upcomingInterviews';

export interface StatDef {
  label: string;
  icon: LucideIcon;
  /** Navigationsziel beim Klick auf die Kachel. */
  path: string;
  value: (s: DashboardStats) => number;
  sub?: (s: DashboardStats) => string | undefined;
}

export const STAT_DEFS: Record<StatKey, StatDef> = {
  headcount: {
    label: 'Aktive Mitarbeitende',
    icon: Users,
    path: '/personal/mitarbeitende',
    value: (s) => s.headcount,
    sub: (s) => `${s.hiresYtd} Neueintritte dieses Jahr`,
  },
  absentToday: {
    label: 'Heute abwesend',
    icon: CalendarDays,
    path: '/abwesenheit/kalender',
    value: (s) => s.absentTodayCount,
  },
  pendingAbsences: {
    label: 'Offene Anträge',
    icon: Send,
    path: '/abwesenheit/antraege',
    value: (s) => s.pendingAbsences,
    sub: () => 'Abwesenheit',
  },
  missingSickNotes: {
    label: 'Fehlende AU',
    icon: Stethoscope,
    path: '/abwesenheit/krankmeldungen',
    value: (s) => s.missingSickNotes,
    sub: (s) => (s.missingSickNotes > 0 ? 'Frist überschritten' : 'Alles fristgerecht'),
  },
  expiringDocuments: {
    label: 'Ablaufende Dokumente',
    icon: FolderClock,
    path: '/personal/dokumente',
    value: (s) => s.expiringDocuments,
    sub: () => 'innerhalb 30 Tagen',
  },
  openSalaryRequests: {
    label: 'Gehaltsanträge',
    icon: Wallet,
    path: '/verguetung/gehaelter',
    value: (s) => s.openSalaryRequests,
    sub: () => 'zur Entscheidung',
  },
  openPositions: {
    label: 'Offene Stellen',
    icon: Briefcase,
    path: '/recruiting/stellen',
    value: (s) => s.openPositions,
    sub: (s) => `${s.activeApplications} aktive Bewerbungen`,
  },
  upcomingInterviews: {
    label: 'Anstehende Interviews',
    icon: CalendarClock,
    path: '/recruiting/interviews',
    value: (s) => s.upcomingInterviewsCount,
  },
};

export const ALL_STATS = Object.keys(STAT_DEFS) as StatKey[];

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export type WidgetKey =
  | 'kpis'
  | 'absence-chart'
  | 'department-chart'
  | 'absent-today'
  | 'interviews'
  | 'meetings'
  | 'announcements'
  | 'surveys'
  | 'birthdays'
  | 'onboarding';

export interface WidgetDef {
  title: string;
  description: string;
  icon: LucideIcon;
  /** true = Widget belegt die volle Breite (KPI-Leiste). */
  wide?: boolean;
}

export const WIDGET_DEFS: Record<WidgetKey, WidgetDef> = {
  kpis: { title: 'Kennzahlen', description: 'Frei wählbare KPI-Kacheln', icon: TrendingUp, wide: true },
  'absence-chart': { title: 'Abwesenheitstage je Monat', description: 'Genehmigte Tage im Jahresverlauf', icon: CalendarDays },
  'department-chart': { title: 'Mitarbeitende je Abteilung', description: 'Verteilung der Belegschaft', icon: Building2 },
  'absent-today': { title: 'Heute abwesend', description: 'Wer heute nicht an Bord ist', icon: CalendarDays },
  interviews: { title: 'Anstehende Interviews', description: 'Nächste Recruiting-Termine', icon: CalendarClock },
  meetings: { title: 'Nächste Gespräche', description: 'Feedback-Termine der nächsten 3 Wochen', icon: MessagesSquare },
  announcements: { title: 'Aktive Ankündigungen', description: 'Laufende Mitteilungen', icon: Megaphone },
  surveys: { title: 'Laufende Umfragen', description: 'Teilnahmestand aktiver Umfragen', icon: BarChart3 },
  birthdays: { title: 'Nächste Geburtstage', description: 'Wer demnächst feiert', icon: Cake },
  onboarding: { title: 'On- & Offboarding', description: 'Wer gerade an- oder abreist', icon: UserPlus },
};

export const ALL_WIDGETS = Object.keys(WIDGET_DEFS) as WidgetKey[];

// ---------------------------------------------------------------------------
// Konfiguration + Persistenz
// ---------------------------------------------------------------------------

export interface DashboardConfig {
  /** Sichtbare Widgets in Anzeige-Reihenfolge. */
  widgets: WidgetKey[];
  /** Sichtbare KPI-Kacheln (Reihenfolge folgt ALL_STATS). */
  kpis: StatKey[];
}

/** Bewusst kuratierter, aufgeräumter Default — alles Weitere ist zuschaltbar. */
export const DEFAULT_CONFIG: DashboardConfig = {
  widgets: ['kpis', 'absence-chart', 'absent-today', 'interviews', 'meetings', 'birthdays'],
  kpis: ['headcount', 'absentToday', 'pendingAbsences', 'missingSickNotes', 'openPositions'],
};

const STORAGE_KEY = 'hrmonic.dashboard';

export function loadDashboardConfig(): DashboardConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<DashboardConfig>;
    // Unbekannte Schlüssel (z. B. aus älteren Versionen) still herausfiltern.
    const widgets = (parsed.widgets ?? []).filter((w): w is WidgetKey => w in WIDGET_DEFS);
    const kpis = ALL_STATS.filter((k) => (parsed.kpis ?? []).includes(k));
    return { widgets: [...new Set(widgets)], kpis };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveDashboardConfig(config: DashboardConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
