import type { AdminArea } from './admin.js';
import type { ModuleKey } from './variants/index.js';

/**
 * Einrichtungs-Assistent: Schritte und Fortschritt, ohne DOM, damit Backend-Test
 * und beide Clients dieselbe Rechnung benutzen. Die Texte stehen NICHT hier,
 * sondern im Renderer (features/setup/copy.ts).
 *
 * Der Fortschritt wird aus den Daten abgeleitet (GET /api/setup/status), nicht
 * gespeichert. Einzige Ausnahme ist der Schritt "abwesenheit": Die Arten sind
 * von Anfang an mitgeliefert, "erledigt" heisst dort nur "angeschaut".
 */

export const SETUP_STEP_KEYS = [
  'firma',
  'abteilungen',
  'mitarbeitende',
  'vorgesetzte',
  'abwesenheit',
  'adminkonto',
  'portal',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export interface SetupStepDef {
  key: SetupStepKey;
  /** Bereich, in dem das Konto BEARBEITEN darf, damit der Schritt erscheint. */
  area: AdminArea;
  /** Modul der Variante, ohne das der Schritt keinen Sinn hat. */
  module: ModuleKey;
  /** Eintrag der Seitenleiste, der beim Schritt hervorgehoben wird. */
  navPath: string;
  /** Grobe Dauer in Minuten (Anzeige, bewusst knapp gerechnet). */
  minutes: number;
}

export const SETUP_STEPS: readonly SetupStepDef[] = [
  { key: 'firma', area: 'einstellungen', module: 'admin', navPath: '/einstellungen', minutes: 1 },
  { key: 'abteilungen', area: 'personal', module: 'employees', navPath: '/personal/organisation', minutes: 1 },
  { key: 'mitarbeitende', area: 'personal', module: 'employees', navPath: '/personal/mitarbeitende', minutes: 2 },
  { key: 'vorgesetzte', area: 'personal', module: 'employees', navPath: '/personal/organisation', minutes: 1 },
  { key: 'abwesenheit', area: 'abwesenheit', module: 'absences', navPath: '/abwesenheit/arten', minutes: 1 },
  { key: 'adminkonto', area: 'benutzer', module: 'admin', navPath: '/verwaltung/benutzer', minutes: 1 },
  { key: 'portal', area: 'benutzer', module: 'me', navPath: '/verwaltung/benutzer', minutes: 1 },
];

/**
 * Antwort von GET /api/setup/status. Felder gesperrter Bereiche FEHLEN
 * (Muster des Dashboards): fehlendes Feld heisst "kein Recht", nie 0.
 */
export interface SetupStatus {
  allowed_areas: AdminArea[];
  /**
   * Kennung DIESER Installation (Hash, nicht die Lizenz-ID). Der Client haengt
   * den lokalen Assistentenstand daran: Nach einer zurueckgesetzten oder
   * ersetzten Datenbank trifft Konto 1 sonst auf den Stand der alten.
   */
  instance: string;
  company_saved?: boolean;
  locations?: number;
  departments?: number;
  employees_active?: number;
  employees_with_manager?: number;
  absence_types_active?: number;
  admin_users?: number;
  portal_users?: number;
  employees_without_account?: number;
}

/** Was nur dieses Geraet weiss (localStorage, je Konto). */
export interface SetupLocalState {
  /** Schritt "abwesenheit" angeschaut und bestaetigt. */
  absenceConfirmed: boolean;
  /** Schritte, die jemand bewusst uebersprungen hat. */
  skipped: SetupStepKey[];
}

export interface SetupStepState {
  def: SetupStepDef;
  /** Laufende Nummer unter den ANGEZEIGTEN Schritten, ab 1. */
  n: number;
  done: boolean;
  skipped: boolean;
  /** Schritt geht nur, wenn ein frueherer erledigt ist (zum Beispiel zwei Personen). */
  blocked: boolean;
}

export interface SetupProgress {
  steps: SetupStepState[];
  total: number;
  doneCount: number;
  remainingMinutes: number;
  /** Erster offener, nicht uebersprungener, nicht blockierter Schritt. */
  next: SetupStepKey | null;
  complete: boolean;
}

/** Ist der Schritt laut Daten erledigt? Fehlende Felder gelten als nicht erledigt. */
export function isStepDone(key: SetupStepKey, s: SetupStatus, local: SetupLocalState): boolean {
  switch (key) {
    case 'firma':
      return s.company_saved === true;
    case 'abteilungen':
      return (s.departments ?? 0) > 0;
    case 'mitarbeitende':
      return (s.employees_active ?? 0) >= 1;
    case 'vorgesetzte':
      return (s.employees_with_manager ?? 0) >= 1;
    case 'abwesenheit':
      return local.absenceConfirmed;
    case 'adminkonto':
      return (s.admin_users ?? 0) >= 2;
    case 'portal':
      return (s.portal_users ?? 0) >= 1;
  }
}

/**
 * Berechnet Fortschritt fuer genau die Schritte, die das Konto ausfuehren darf.
 * `visible` kommt vom Aufrufer (Recht, Variante und Lizenzfeature stehen im
 * Client); dieselbe Funktion bleibt so ohne Kontextwissen testbar.
 */
export function deriveSetupProgress(
  status: SetupStatus,
  local: SetupLocalState,
  visible: readonly SetupStepKey[],
): SetupProgress {
  const shown = SETUP_STEPS.filter((d) => visible.includes(d.key));
  const steps: SetupStepState[] = shown.map((def, i) => {
    const done = isStepDone(def.key, status, local);
    const blocked = def.key === 'vorgesetzte' && !done && (status.employees_active ?? 0) < 2;
    return { def, n: i + 1, done, skipped: !done && local.skipped.includes(def.key), blocked };
  });
  const doneCount = steps.filter((s) => s.done).length;
  const open = steps.filter((s) => !s.done);
  const next = open.find((s) => !s.skipped && !s.blocked) ?? open.find((s) => !s.blocked) ?? null;
  return {
    steps,
    total: steps.length,
    doneCount,
    remainingMinutes: open.reduce((a, s) => a + s.def.minutes, 0),
    next: next ? next.def.key : null,
    complete: steps.length > 0 && doneCount === steps.length,
  };
}

/**
 * Naechster Schritt nach `after`: erst die folgenden offenen, dann die frueheren.
 * Gesperrte und erledigte Schritte entfallen. Fuer "Ueberspringen" und
 * "Weiter" nach dem Erfolgsmoment.
 */
export function nextOpenAfter(progress: SetupProgress, after: SetupStepKey): SetupStepKey | null {
  const open = (s: SetupStepState) => !s.done && !s.blocked && s.def.key !== after;
  const i = progress.steps.findIndex((s) => s.def.key === after);
  const later = progress.steps.slice(i + 1).find(open);
  const earlier = progress.steps.slice(0, Math.max(i, 0)).find((s) => open(s) && !s.skipped);
  return (later ?? earlier)?.def.key ?? null;
}

/**
 * Gehoert die Installation noch niemandem? Dann oeffnet der Assistent von
 * selbst. Fehlende Felder (gesperrte Bereiche) zaehlen als "nicht leer": Wer
 * nicht sehen kann, ob etwas da ist, wird nicht ueberfallen.
 */
export function isFreshInstallation(s: SetupStatus): boolean {
  return s.company_saved === false && s.departments === 0 && s.employees_active === 0;
}
