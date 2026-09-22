/**
 * Optik des Dashboards: 'standard' ist die nuechterne Darstellung, 'farbenfroh'
 * gibt jeder Kachel einen eigenen Akzent (Plakette, Farbschimmer, Chips,
 * Avatare). Wie Theme und Widget-Auswahl eine Arbeitsplatz-Einstellung im
 * localStorage, keine Firmeneinstellung. Der Stil wirkt allein ueber die
 * Klasse .hm-dash--bunt; auch die Diagrammfarben kommen als Custom Properties
 * (--hm-bar*) aus components.css, weil sie in Inline-SVG vererbt werden.
 */
export type DashboardStyle = 'standard' | 'farbenfroh';

export const DASHBOARD_STYLE_LABELS: Record<DashboardStyle, string> = {
  standard: 'Standard',
  farbenfroh: 'Farbenfroh',
};

const STORAGE_KEY = 'ohrganize.dashboardStyle';

export function loadDashboardStyle(): DashboardStyle {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'farbenfroh' ? 'farbenfroh' : 'standard';
  } catch {
    return 'standard';
  }
}

export function saveDashboardStyle(style: DashboardStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* Speicher nicht verfuegbar: Wahl gilt nur fuer diese Sitzung. */
  }
}
