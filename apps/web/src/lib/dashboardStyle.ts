/**
 * Optik der Übersicht, Gegenstück zu renderer/features/dashboard/dashboardStyle.ts.
 * Gerätebezogen im localStorage; wirkt allein über die Klasse .pt-dash--bunt.
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
    /* Speicher nicht verfügbar: Wahl gilt nur für diese Sitzung. */
  }
}
