import { useLocation } from 'react-router-dom';

/**
 * Rücksprungziel für Absprünge zwischen Seiten (Personalakte → Vorgesetzte,
 * Änderungsantrag → Personalakte, Personalakte → Gehälter): Der Absender gibt
 * es als Router-State mit, die Zielseite zeigt statt „Zur Übersicht“ einen
 * Knopf mit `label`, der auf `path` zurückführt. Kein State = altes Verhalten.
 */
export interface BackTo {
  path: string;
  /** Vollständige Beschriftung des Knopfs, z. B. „Zurück zu Katrin Albrecht“. */
  label: string;
}

export function backToState(path: string, label: string): { backTo: BackTo } {
  return { backTo: { path, label } };
}

export function useBackTo(): BackTo | null {
  const { state } = useLocation();
  const backTo = (state as { backTo?: Partial<BackTo> } | null)?.backTo;
  return backTo && typeof backTo.path === 'string' && typeof backTo.label === 'string'
    ? { path: backTo.path, label: backTo.label }
    : null;
}
