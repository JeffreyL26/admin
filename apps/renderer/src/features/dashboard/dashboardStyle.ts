import { createContext, useContext } from 'react';

/**
 * Optik des Dashboards: 'standard' ist die nuechterne Darstellung, 'farbenfroh'
 * gibt jeder Kachel einen eigenen Akzent (Plakette, Farbschimmer, Chips,
 * Avatare). Wie Theme und Widget-Auswahl eine Arbeitsplatz-Einstellung im
 * localStorage, keine Firmeneinstellung.
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

/** Diagramme lesen den Stil hierueber, weil SVG-Fuellungen nicht an der CSS-Klasse haengen. */
export const DashboardStyleContext = createContext<DashboardStyle>('standard');

export function useDashboardStyle(): DashboardStyle {
  return useContext(DashboardStyleContext);
}
