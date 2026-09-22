import type { LucideIcon } from 'lucide-react';
import {
  Users, CalendarDays, Send, Stethoscope, FolderClock, Wallet, Briefcase,
  CalendarClock, TrendingUp, Building2, MessagesSquare, Megaphone, BarChart3, Cake,
  UserPlus, UsersRound, Gauge, FilePenLine, BadgeCheck, AlarmClock,
} from 'lucide-react';
import { AREA_MODULES, moduleEnabled, widgetAllowedByFeatures, type AdminArea, type ModuleKey } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import type { DashboardStats } from './api';

/**
 * Registry des personalisierbaren Dashboards.
 *
 * Die Auswahl (welche Widgets, welche KPI-Kacheln, in welcher Reihenfolge)
 * ist eine reine Anzeige-Präferenz und wird deshalb — wie das Theme — lokal
 * im localStorage persistiert (`ohrganize.dashboard`), nicht im Backend.
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
  | 'openProfileChanges'
  | 'openSalaryRequests'
  | 'openPositions'
  | 'upcomingInterviews';

/**
 * `openProfileChanges` gehört zur Antwort von GET /api/dashboard, steht aber
 * nicht im Typ `DashboardStats` (features/dashboard/api.ts). Lokale Erweiterung
 * statt Fremdänderung — sie bleibt auch dann korrekt, wenn das Feld dort später
 * ergänzt wird.
 */
type StatsWithProfileChanges = DashboardStats & { openProfileChanges?: number };

/**
 * Akzentfarbe einer Kachel: ein CSS-Token, das in allen vier Themes definiert
 * ist. Die Palette ist bewusst die des Organigramms (`--org-1` bis `--org-6`)
 * plus die semantischen Farben, damit nichts Neues in tokens.css entsteht.
 */
export const ORG_ACCENTS = ['--org-1', '--org-2', '--org-3', '--org-4', '--org-5', '--org-6'] as const;
export type Accent = (typeof ORG_ACCENTS)[number] | '--success' | '--warning' | '--danger';

export type SubTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface StatDef {
  label: string;
  icon: LucideIcon;
  accent: Accent;
  /** Navigationsziel beim Klick auf die Kachel. */
  path: string;
  /**
   * Rechtebereich, aus dem die Zahl stammt. Fehlt er dem Konto, liefert das
   * Backend den Wert nicht (siehe api.ts) und die Kachel wird ausgeblendet —
   * eine Kachel mit „0“ wäre eine Falschaussage, keine Zugriffsmeldung.
   */
  area: AdminArea;
  /** Fachmodul, falls es vom Bereich abweicht; sonst aus `area` abgeleitet (AREA_MODULES). */
  module?: ModuleKey;
  value: (s: DashboardStats) => number | undefined;
  sub?: (s: DashboardStats) => string | undefined;
  /** Farbe des Untertitel-Chips; ohne Angabe neutral. */
  subTone?: (s: DashboardStats) => SubTone;
}

/** Offene Vorgaenge: neutral bei 0, sonst Hinweis in Warnfarbe. */
const pendingTone = (n: number | undefined): SubTone => (n !== undefined && n > 0 ? 'warning' : 'neutral');

export const STAT_DEFS: Record<StatKey, StatDef> = {
  headcount: {
    label: 'Aktive Mitarbeitende',
    icon: Users,
    accent: '--org-1',
    path: '/personal/mitarbeitende',
    area: 'personal',
    value: (s) => s.headcount,
    sub: (s) => (s.hiresYtd === undefined ? undefined : `${s.hiresYtd} Neueintritte dieses Jahr`),
    subTone: (s) => (s.hiresYtd !== undefined && s.hiresYtd > 0 ? 'success' : 'neutral'),
  },
  absentToday: {
    label: 'Heute abwesend',
    icon: CalendarDays,
    accent: '--org-2',
    path: '/abwesenheit/kalender',
    area: 'abwesenheit',
    value: (s) => s.absentTodayCount,
    sub: (s) =>
      s.absentTodayCount === undefined ? undefined : s.absentTodayCount === 0 ? 'Alle an Bord' : 'nicht im Haus',
    subTone: (s) => (s.absentTodayCount === 0 ? 'success' : 'neutral'),
  },
  pendingAbsences: {
    label: 'Offene Anträge',
    icon: Send,
    accent: '--org-3',
    path: '/abwesenheit/antraege',
    area: 'abwesenheit',
    value: (s) => s.pendingAbsences,
    sub: (s) => (s.pendingAbsences === 0 ? 'nichts zu entscheiden' : 'zur Entscheidung'),
    subTone: (s) => pendingTone(s.pendingAbsences),
  },
  missingSickNotes: {
    label: 'Fehlende AU',
    icon: Stethoscope,
    accent: '--org-5',
    path: '/abwesenheit/krankmeldungen',
    area: 'abwesenheit',
    value: (s) => s.missingSickNotes,
    sub: (s) =>
      s.missingSickNotes === undefined
        ? undefined
        : s.missingSickNotes > 0
          ? 'Frist überschritten'
          : 'Alles fristgerecht',
    subTone: (s) => (s.missingSickNotes !== undefined && s.missingSickNotes > 0 ? 'danger' : 'success'),
  },
  expiringDocuments: {
    label: 'Ablaufende Dokumente',
    icon: FolderClock,
    accent: '--org-4',
    path: '/personal/dokumente',
    area: 'personal',
    value: (s) => s.expiringDocuments,
    // Zaehlt wie Personal → Dokumente → Ablaufend: Erinnerungsfrist je
    // Dokument, nur gueltige und nicht abgeloeste Versionen.
    sub: () => 'Erinnerungsfrist erreicht',
    subTone: (s) => pendingTone(s.expiringDocuments),
  },
  openProfileChanges: {
    label: 'Stammdaten-Anträge',
    icon: FilePenLine,
    accent: '--org-6',
    path: '/personal/aenderungsantraege',
    area: 'personal',
    value: (s) => (s as StatsWithProfileChanges).openProfileChanges,
    sub: () => 'zur Entscheidung',
    subTone: (s) => pendingTone((s as StatsWithProfileChanges).openProfileChanges),
  },
  openSalaryRequests: {
    label: 'Gehaltsanträge',
    icon: Wallet,
    accent: '--org-4',
    path: '/verguetung/gehaelter',
    area: 'verguetung',
    value: (s) => s.openSalaryRequests,
    sub: () => 'zur Entscheidung',
    subTone: (s) => pendingTone(s.openSalaryRequests),
  },
  openPositions: {
    label: 'Offene Stellen',
    icon: Briefcase,
    accent: '--org-2',
    path: '/recruiting/stellen',
    area: 'recruiting',
    value: (s) => s.openPositions,
    sub: (s) =>
      s.activeApplications === undefined ? undefined : `${s.activeApplications} aktive Bewerbungen`,
  },
  upcomingInterviews: {
    label: 'Anstehende Interviews',
    icon: CalendarClock,
    accent: '--org-3',
    path: '/recruiting/interviews',
    area: 'recruiting',
    value: (s) => s.upcomingInterviewsCount,
    sub: () => 'in den nächsten Tagen',
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
  | 'follow-ups'
  | 'birthdays'
  | 'onboarding'
  | 'leadership-team'
  | 'leadership-report'
  | 'license';

export interface WidgetDef {
  title: string;
  description: string;
  icon: LucideIcon;
  accent: Accent;
  /**
   * Rechtebereich der angezeigten Daten. `undefined` = kein eigener Bereich
   * (die KPI-Leiste; deren Kacheln bringen ihren Bereich einzeln mit).
   * Fehlt der Bereich, blendet DashboardPage das Widget vollständig aus —
   * inklusive der Galerie „Widget hinzufügen“, sonst ließe es sich zuschalten
   * und stünde dann leer da.
   */
  area?: AdminArea;
  /** Fachmodul, falls es nicht aus `area` folgt (personengebundene Widgets); Widgets fehlender Module gibt es nicht. */
  module?: ModuleKey;
  /** true = Widget belegt die volle Breite (KPI-Leiste). */
  wide?: boolean;
}

export const WIDGET_DEFS: Record<WidgetKey, WidgetDef> = {
  kpis: { title: 'Kennzahlen', description: 'Frei wählbare KPI-Kacheln', icon: TrendingUp, accent: '--org-1', wide: true },
  'absence-chart': { title: 'Abwesenheitstage je Monat', description: 'Genehmigte Tage im Jahresverlauf', icon: CalendarDays, accent: '--org-1', area: 'abwesenheit' },
  'department-chart': { title: 'Mitarbeitende je Abteilung', description: 'Verteilung der Belegschaft', icon: Building2, accent: '--org-3', area: 'personal' },
  'absent-today': { title: 'Heute abwesend', description: 'Wer heute nicht an Bord ist', icon: CalendarDays, accent: '--org-2', area: 'abwesenheit' },
  interviews: { title: 'Anstehende Interviews', description: 'Nächste Recruiting-Termine', icon: CalendarClock, accent: '--org-3', area: 'recruiting' },
  meetings: { title: 'Nächste Gespräche', description: 'Feedback-Termine der nächsten 3 Wochen', icon: MessagesSquare, accent: '--org-4', area: 'leistung' },
  announcements: { title: 'Aktive Ankündigungen', description: 'Laufende Mitteilungen', icon: Megaphone, accent: '--org-5', area: 'kommunikation' },
  surveys: { title: 'Laufende Umfragen', description: 'Teilnahmestand aktiver Umfragen', icon: BarChart3, accent: '--org-2', area: 'kommunikation' },
  // Laedt seine Daten selbst (GET /api/communication/meetings/follow-ups).
  'follow-ups': { title: 'Wiedervorlagen', description: 'Fällige Wiedervorlagen aus Gesprächsprotokollen', icon: AlarmClock, accent: '--org-6', area: 'kommunikation' },
  birthdays: { title: 'Nächste Geburtstage', description: 'Wer demnächst feiert', icon: Cake, accent: '--org-5', area: 'personal' },
  // Lädt seine Daten selbst über /api/admin/onboarding — ohne 'verwaltung'
  // antwortet das Backend mit 403 und das Widget behauptete sonst, es sei
  // niemand im On-/Offboarding.
  onboarding: { title: 'On- & Offboarding', description: 'Wer gerade an- oder abreist', icon: UserPlus, accent: '--org-4', area: 'verwaltung' },
  // Kein `area`: Wie der Sidebar-Eintrag „Mein Team“ (nav.ts, leaderOnly)
  // hängt die Führungsfunktion an der Freischaltung der Person, nicht am
  // Rechtebereich `fuehrung`. Mit einem Bereich wäre das Widget für genau die
  // Führungskräfte ohne HR-Rechte nicht anbietbar, für die es gedacht ist. Das
  // Widget lädt seine Daten selbst und blendet sich für Nicht-Führungskräfte
  // inhaltlich aus, statt gar nicht erst angeboten zu werden.
  'leadership-team': { title: 'Mein Team', description: 'Bewertungsstand Ihres Zuständigkeitsbereichs', icon: UsersRound, accent: '--org-2', module: 'leadership' },
  'leadership-report': { title: 'Satisfaction-Report', description: 'Bewertungsstand je Führungskraft im Zeitraum', icon: Gauge, accent: '--org-3', area: 'fuehrung' },
  // Kein `area`: Der Lizenzzustand kommt mit Login und /api/auth/me zu jedem
  // Admin-Konto (Auth-Kontext), unabhängig vom Bereich `einstellungen` — das
  // Widget braucht keine eigene Abfrage. Nur der Sprung zur Lizenzseite hängt
  // am Bereich. Standardmäßig ausgeblendet; die Banner sagen ohnehin Bescheid.
  license: { title: 'Lizenz', description: 'Zustand, Laufzeit und Plätze der Lizenz', icon: BadgeCheck, accent: '--org-6' },
};

export const ALL_WIDGETS = Object.keys(WIDGET_DEFS) as WidgetKey[];

// ---------------------------------------------------------------------------
// Rechtefilter (reine Anzeige — die Sicherheitsgrenze ist das Backend)
// ---------------------------------------------------------------------------

/**
 * Darf dieses Widget angezeigt werden? `allowed` sind die vom Backend
 * gemeldeten lesbaren Bereiche (`allowed_areas` aus GET /api/dashboard).
 *
 * Wichtig: Das Ergebnis wird NICHT in die gespeicherte Konfiguration
 * zurückgeschrieben. Bekommt das Konto den Bereich später wieder, tauchen die
 * gewählten Widgets unverändert wieder auf.
 */
export function widgetAllowed(
  key: WidgetKey,
  allowed: ReadonlySet<AdminArea>,
  features: readonly string[] | null = null,
): boolean {
  const def = WIDGET_DEFS[key];
  const area = def.area;
  // Modul der Variante: Widgets eines Moduls, das dieser Build nicht
  // enthaelt, werden weder angezeigt noch angeboten (auch nicht aus einer
  // gespeicherten Konfiguration).
  if (!moduleEnabled(VARIANT, def.module ?? (area ? AREA_MODULES[area] : null))) return false;
  if (!widgetAllowedByFeatures(key, features)) return false;
  return area === undefined || allowed.has(area);
}

/** Wie widgetAllowed, für die KPI-Kacheln. */
export function statAllowed(
  key: StatKey,
  allowed: ReadonlySet<AdminArea>,
  features: readonly string[] | null = null,
): boolean {
  const def = STAT_DEFS[key];
  if (!moduleEnabled(VARIANT, def.module ?? AREA_MODULES[def.area])) return false;
  if (!widgetAllowedByFeatures(key, features)) return false;
  return allowed.has(def.area);
}

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

const STORAGE_KEY = 'ohrganize.dashboard';

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
