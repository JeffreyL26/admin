import { useCallback, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarDays, Building2, CalendarClock, CalendarRange, MessagesSquare, Megaphone, BarChart3, Cake,
  UserPlus, UsersRound, Gauge, BadgeCheck, AlarmClock, Send, Stethoscope, Wallet, FilePenLine, FolderClock,
} from 'lucide-react';
import {
  AREA_MODULES, mergeVisibleOrder, moduleEnabled, widgetAllowedByFeatures, type AdminArea, type ModuleKey,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import type { AreaKey } from './dashboardModel';

/**
 * Widget-Register des Dashboards.
 *
 * Auswahl, Reihenfolge und Breite der Widgets sind eine Anzeige-Praeferenz je
 * Geraet (localStorage `ohrganize.dashboard`), wie das Theme, nicht im
 * Backend. Neue Widgets kuenftiger Module werden hier registriert
 * (`WIDGET_DEFS` mit Bereich, dazu `WIDGET_ORDER`) und erscheinen
 * fuer Bestandsnutzer ueber „Anpassen → Widget hinzufügen“. Jedes Widget
 * gehoert zu einem Bereich der Bereichsleiste; „Anpassen“ bietet bei
 * gewaehltem Bereich nur dessen Widgets an.
 */

/**
 * Akzentfarbe der Bestands-Widgets (widgets.tsx): ein CSS-Token, das in allen
 * vier Themes definiert ist (Palette des Organigramms plus Semantik).
 */
export const ORG_ACCENTS = ['--org-1', '--org-2', '--org-3', '--org-4', '--org-5', '--org-6'] as const;
export type Accent = (typeof ORG_ACCENTS)[number] | '--success' | '--warning' | '--danger';

export type DashboardWidgetKey =
  | 'absent-today'
  | 'sick'
  | 'requests'
  | 'plan'
  | 'absence-chart'
  | 'follow-ups'
  | 'announcements'
  | 'surveys'
  | 'profile'
  | 'documents'
  | 'birthdays'
  | 'department-chart'
  | 'salary'
  | 'interviews'
  | 'onboarding'
  | 'meetings'
  | 'leadership-team'
  | 'leadership-report'
  | 'license';

/** Frueherer Name, den widgets.tsx und gespeicherte Konfigurationen noch kennen. */
export type WidgetKey = DashboardWidgetKey;

export type WidgetSize = 'wide' | 'half';

export interface DashboardWidgetDef {
  key: DashboardWidgetKey;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Akzent der Bestands-Widgets (Diagrammfarben in widgets.tsx). */
  accent: Accent;
  /** Bereich der Bereichsleiste (Filter, Farbe, Etikett). */
  area: AreaKey;
  /**
   * Rechtebereich der angezeigten Daten. `undefined` = kein eigener Bereich
   * (Mein Team haengt an der Freischaltung der Person, die Lizenz kommt mit
   * jedem Admin-Konto). Fehlt der Bereich dem Konto, ist das Widget weder
   * sichtbar noch in „Anpassen“ angeboten.
   */
  adminArea?: AdminArea;
  /** Fachmodul, falls es nicht aus `adminArea` folgt; Widgets fehlender Module gibt es nicht. */
  module?: ModuleKey;
  /** Vorgabe der Breite; vom Nutzer je Widget umschaltbar. */
  size: WidgetSize;
}

export const WIDGET_DEFS: Record<DashboardWidgetKey, DashboardWidgetDef> = {
  'absent-today': {
    key: 'absent-today', title: 'Heute abwesend', icon: CalendarDays, accent: '--org-2', area: 'abwesenheit',
    adminArea: 'abwesenheit', size: 'half',
    description: 'Wer heute fehlt, mit Art und Rückkehr, dazu die nächsten 7 Tage',
  },
  sick: {
    key: 'sick', title: 'Krankheit und AU', icon: Stethoscope, accent: '--org-5', area: 'abwesenheit',
    adminArea: 'abwesenheit', size: 'half',
    description: 'Aktuell Kranke mit Lohnfortzahlung und fehlende AU-Nachweise',
  },
  requests: {
    key: 'requests', title: 'Abwesenheitsanträge', icon: Send, accent: '--org-3', area: 'abwesenheit',
    adminArea: 'abwesenheit', size: 'half',
    description: 'Offene Urlaubs- und Abwesenheitsanträge zur Entscheidung',
  },
  plan: {
    key: 'plan', title: 'Wer fehlt wann', icon: CalendarRange, accent: '--org-2', area: 'abwesenheit',
    adminArea: 'abwesenheit', size: 'wide',
    description: 'Anwesenheitsplan über 10 Wochen mit offenen und genehmigten Abwesenheiten',
  },
  'absence-chart': {
    key: 'absence-chart', title: 'Abwesenheitstage je Monat', icon: CalendarDays, accent: '--org-1', area: 'abwesenheit',
    adminArea: 'abwesenheit', size: 'half',
    description: 'Genehmigte Tage im Jahresverlauf',
  },
  'follow-ups': {
    key: 'follow-ups', title: 'Wiedervorlagen', icon: AlarmClock, accent: '--org-6', area: 'kommunikation',
    adminArea: 'kommunikation', size: 'half',
    description: 'Fällige Wiedervorlagen aus Gesprächsprotokollen, nach Verzug',
  },
  announcements: {
    key: 'announcements', title: 'Ankündigungen und Bestätigungen', icon: Megaphone, accent: '--org-5', area: 'kommunikation',
    adminArea: 'kommunikation', size: 'half',
    description: 'Laufende Ankündigungen und wer noch nicht bestätigt hat',
  },
  surveys: {
    key: 'surveys', title: 'Laufende Umfragen', icon: BarChart3, accent: '--org-2', area: 'kommunikation',
    adminArea: 'kommunikation', size: 'half',
    description: 'Teilnahmestand aktiver Umfragen',
  },
  profile: {
    key: 'profile', title: 'Stammdaten-Anträge', icon: FilePenLine, accent: '--org-6', area: 'personal',
    adminArea: 'personal', size: 'half',
    description: 'Änderungsanträge aus dem Portal (Anschrift, Bank, Krankenkasse)',
  },
  documents: {
    key: 'documents', title: 'Ablaufende Dokumente', icon: FolderClock, accent: '--org-4', area: 'personal',
    adminArea: 'personal', size: 'half',
    description: 'Dokumente in ihrer Erinnerungsfrist und bereits abgelaufene',
  },
  birthdays: {
    key: 'birthdays', title: 'Nächste Geburtstage', icon: Cake, accent: '--org-5', area: 'personal',
    adminArea: 'personal', size: 'half',
    description: 'Wer demnächst feiert',
  },
  'department-chart': {
    key: 'department-chart', title: 'Mitarbeitende je Abteilung', icon: Building2, accent: '--org-3', area: 'personal',
    adminArea: 'personal', size: 'half',
    description: 'Verteilung der Belegschaft',
  },
  salary: {
    key: 'salary', title: 'Gehaltsanträge', icon: Wallet, accent: '--org-4', area: 'verguetung',
    adminArea: 'verguetung', size: 'half',
    description: 'Gehaltsänderungen, die auf eine zweite Person warten',
  },
  interviews: {
    key: 'interviews', title: 'Anstehende Interviews', icon: CalendarClock, accent: '--org-3', area: 'recruiting',
    adminArea: 'recruiting', size: 'half',
    description: 'Nächste Recruiting-Termine',
  },
  // Laedt seine Daten ueber /api/admin/onboarding; ohne 'verwaltung' antwortete
  // das Backend mit 403.
  onboarding: {
    key: 'onboarding', title: 'On- und Offboarding', icon: UserPlus, accent: '--org-4', area: 'verwaltung',
    adminArea: 'verwaltung', size: 'half',
    description: 'Wer gerade anfängt oder geht, mit Fortschritt der Aufgaben',
  },
  meetings: {
    key: 'meetings', title: 'Nächste Gespräche', icon: MessagesSquare, accent: '--org-4', area: 'leistung',
    adminArea: 'leistung', size: 'half',
    description: 'Feedback-Termine der nächsten 3 Wochen',
  },
  // Kein `adminArea`: Wie der Sidebar-Eintrag „Mein Team“ (nav.ts, leaderOnly)
  // haengt die Fuehrungsfunktion an der Freischaltung der Person, nicht am
  // Rechtebereich `fuehrung`. Das Widget laedt selbst und blendet sich fuer
  // Nicht-Fuehrungskraefte inhaltlich aus.
  'leadership-team': {
    key: 'leadership-team', title: 'Mein Team', icon: UsersRound, accent: '--org-2', area: 'leistung',
    module: 'performance', size: 'half',
    description: 'Bewertungsstand Ihres Zuständigkeitsbereichs',
  },
  'leadership-report': {
    key: 'leadership-report', title: 'Satisfaction-Report', icon: Gauge, accent: '--org-3', area: 'leistung',
    adminArea: 'fuehrung', size: 'half',
    description: 'Bewertungsstand je Führungskraft im Zeitraum',
  },
  // Kein `adminArea`: Der Lizenzzustand kommt mit Login und /api/auth/me zu
  // jedem Admin-Konto. Standardmaessig ausgeblendet; die Banner sagen ohnehin Bescheid.
  license: {
    key: 'license', title: 'Lizenz', icon: BadgeCheck, accent: '--org-6', area: 'einstellungen',
    size: 'half',
    description: 'Zustand, Laufzeit und Plätze der Lizenz',
  },
};

/** Reihenfolge in „Anpassen“ und in der Liste aller Widgets. */
export const WIDGET_ORDER: DashboardWidgetKey[] = [
  'absent-today', 'sick', 'requests', 'plan', 'absence-chart', 'follow-ups', 'announcements', 'surveys',
  'profile', 'documents', 'birthdays', 'department-chart', 'salary', 'interviews', 'onboarding', 'meetings',
  'leadership-team', 'leadership-report', 'license',
];

export function widgetDef(key: DashboardWidgetKey): DashboardWidgetDef {
  return WIDGET_DEFS[key];
}

/**
 * Darf dieses Widget angezeigt werden? `allowed` sind die vom Backend
 * gemeldeten lesbaren Bereiche (`allowed_areas` aus GET /api/dashboard).
 *
 * Reine Anzeige, die Sicherheitsgrenze ist das Backend. Das Ergebnis wird NICHT
 * in die gespeicherte Auswahl zurueckgeschrieben: Bekommt das Konto den Bereich
 * spaeter wieder, tauchen die gewaehlten Widgets unveraendert wieder auf.
 */
export function widgetAllowed(
  key: DashboardWidgetKey,
  allowed: ReadonlySet<AdminArea>,
  features: readonly string[] | null = null,
): boolean {
  const def = WIDGET_DEFS[key];
  // Modul der Variante: Widgets eines Moduls, das dieser Build nicht enthaelt,
  // werden weder angezeigt noch angeboten (auch nicht aus einer gespeicherten Auswahl).
  if (!moduleEnabled(VARIANT, def.module ?? (def.adminArea ? AREA_MODULES[def.adminArea] : null))) return false;
  if (!widgetAllowedByFeatures(key, features)) return false;
  return def.adminArea === undefined || allowed.has(def.adminArea);
}

// ---------------------------------------------------------------------------
// Auswahl je Geraet
// ---------------------------------------------------------------------------

export interface DashboardLayout {
  /** Fassung des gespeicherten Formats; 2 seit dem Dashboard aus HR-Sicht. */
  v: 2;
  widgets: DashboardWidgetKey[];
  /** Vom Nutzer gewaehlte Breite; fehlt ein Eintrag, gilt die Vorgabe des Widgets. */
  sizes: Partial<Record<DashboardWidgetKey, WidgetSize>>;
}

/**
 * Vorgabe in der Reihenfolge eines HR-Morgens: wer fehlt heute, wer ist krank,
 * der Plan, was zu entscheiden ist, wer anfaengt oder geht, faellige
 * Wiedervorlagen, der Verlauf, dann Kommunikation, Personal, Verguetung und
 * Recruiting.
 */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  v: 2,
  widgets: [
    'absent-today', 'sick', 'plan', 'requests', 'onboarding', 'follow-ups', 'absence-chart',
    'announcements', 'profile', 'documents', 'salary', 'birthdays', 'interviews',
  ],
  sizes: {},
};

const STORAGE_KEY = 'ohrganize.dashboard';

const isKey = (k: unknown): k is DashboardWidgetKey => typeof k === 'string' && k in WIDGET_DEFS;

/**
 * Gespeicherte Auswahl lesen. Die Fassung 1 (bis Oktober 2026: Kennzahlen-
 * Kacheln `kpis` plus Widgets) wird uebernommen: Die dort gewaehlten Widgets
 * bleiben, die Kennzahlen entfallen (die Bereichsleiste ersetzt sie), und die
 * neuen Widgets fuer den HR-Alltag kommen vorn hinzu.
 */
export function loadDashboardLayout(): DashboardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DASHBOARD_LAYOUT;
    const p = JSON.parse(raw) as { v?: number; widgets?: unknown[]; sizes?: Record<string, unknown> };
    const chosen = (p.widgets ?? []).filter(isKey);
    if (p.v !== 2) {
      const daily: DashboardWidgetKey[] = ['absent-today', 'sick', 'plan', 'requests', 'onboarding', 'follow-ups'];
      return { v: 2, widgets: [...new Set([...daily, ...chosen])], sizes: {} };
    }
    const sizes: DashboardLayout['sizes'] = {};
    for (const [k, v] of Object.entries(p.sizes ?? {})) {
      if (isKey(k) && (v === 'wide' || v === 'half')) sizes[k] = v;
    }
    return { v: 2, widgets: [...new Set(chosen)], sizes };
  } catch {
    return DEFAULT_DASHBOARD_LAYOUT;
  }
}

export function useDashboardLayout() {
  const [layout, setLayout] = useState<DashboardLayout>(loadDashboardLayout);

  const update = useCallback((next: DashboardLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Speicher gesperrt: Die Auswahl gilt dann nur fuer diese Sitzung.
    }
  }, []);

  const remove = (key: DashboardWidgetKey) => update({ ...layout, widgets: layout.widgets.filter((w) => w !== key) });
  const add = (key: DashboardWidgetKey) => update({ ...layout, widgets: [...layout.widgets, key] });
  const reset = () => update(DEFAULT_DASHBOARD_LAYOUT);
  const sizeOf = (key: DashboardWidgetKey): WidgetSize => layout.sizes[key] ?? WIDGET_DEFS[key].size;
  const toggleSize = (key: DashboardWidgetKey) =>
    update({ ...layout, sizes: { ...layout.sizes, [key]: sizeOf(key) === 'wide' ? 'half' : 'wide' } });
  /** Neue Reihenfolge der sichtbaren Widgets; ausgeblendete (Bereichsfilter) behalten ihre Plaetze. */
  const reorderVisible = (visibleOrder: DashboardWidgetKey[]) =>
    update({ ...layout, widgets: mergeVisibleOrder(layout.widgets, visibleOrder) });

  return { layout, remove, add, reset, sizeOf, toggleSize, reorderVisible };
}
