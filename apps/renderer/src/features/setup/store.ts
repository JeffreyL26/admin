import { useSyncExternalStore } from 'react';
import { SETUP_STEP_KEYS, type SetupStepKey } from '@ohrganize/shared';
import { readJson, subscribeTo, writeJson } from '../../lib/localStore';
import { announceSkip } from '../tours/skipEvent';

/**
 * Zustand des Einrichtungs-Assistenten auf diesem Geraet. Wie Seitenleiste und
 * Dashboard eine Arbeitsplatz-, keine Firmeneinstellung (layout/sidebarConfig.ts):
 * localStorage, je Konto ein eigener Schluessel, damit ein Kontowechsel am
 * selben Geraet den Stand des anderen nicht uebernimmt.
 *
 * Was NICHT hier steht: der fachliche Fortschritt. Er kommt aus den Daten
 * (GET /api/setup/status, shared/setup.ts) und kann deshalb nicht driften.
 */

export type SetupView = 'welcome' | 'step' | 'celebrate' | 'done';

interface Persisted {
  /** Willkommen gesehen oder Assistent bewusst geoeffnet: ab dann gibt es den Launcher. */
  welcomed: boolean;
  /** Dialog offen (sonst Launcher). */
  open: boolean;
  view: SetupView;
  current: SetupStepKey | null;
  skipped: SetupStepKey[];
  absenceConfirmed: boolean;
  cardDismissed: boolean;
  doneSeen: boolean;
}

/** Nur fuer die laufende Sitzung: Werte fuer den Erfolgsmoment. */
interface Session {
  celebrate: { key: SetupStepKey; vars: Record<string, string | number> } | null;
  /** Geoeffnet ueber Konto oder Befehlspalette: Der Abschluss heisst dann "Zurueck". */
  reopened: boolean;
  /** Stand ist an Installation und Konto gebunden (erst dann gilt er). */
  bound: boolean;
}

const DEFAULTS: Persisted = {
  welcomed: false,
  open: false,
  view: 'welcome',
  current: null,
  skipped: [],
  absenceConfirmed: false,
  cardDismissed: false,
  doneSeen: false,
};

const EVENT = 'ohrganize:setup';
const storageKey = (key: string) => `ohrganize.setup.${key}`;

let activeKey: string | null = null;
let state: Persisted = { ...DEFAULTS };
let session: Session = { celebrate: null, bound: false, reopened: false };
let snapshotCache: SetupSnapshot = makeSnapshot();

export type SetupSnapshot = Persisted & Session;

function makeSnapshot(): SetupSnapshot {
  return { ...state, ...session };
}

function load(key: string): Persisted {
  const p = readJson<Partial<Persisted>>(storageKey(key));
  if (!p || typeof p !== 'object') return { ...DEFAULTS };
  const isKey = (k: unknown): k is SetupStepKey => (SETUP_STEP_KEYS as readonly unknown[]).includes(k);
  return {
    welcomed: p.welcomed === true,
    open: p.open === true,
    // Ein Neustart mitten im Erfolgsmoment setzt bei dessen Schritt wieder an.
    view: p.view === 'step' || p.view === 'celebrate' ? 'step' : p.view === 'done' ? 'done' : 'welcome',
    current: isKey(p.current) ? p.current : null,
    skipped: Array.isArray(p.skipped) ? p.skipped.filter(isKey) : [],
    absenceConfirmed: p.absenceConfirmed === true,
    cardDismissed: p.cardDismissed === true,
    doneSeen: p.doneSeen === true,
  };
}

function persist(): void {
  if (activeKey !== null) writeJson(storageKey(activeKey), state);
}

function emit(): void {
  snapshotCache = makeSnapshot();
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Bindet den Stand an Installation UND Konto (`<Installation>.<Konto-ID>`).
 * Nur das Konto reichte nicht: Nach einer zurueckgesetzten oder ersetzten
 * Datenbank hat der Administrator wieder die ID 1 und erbte den Stand der
 * alten (Launcher schon da, Schritte schon "bestaetigt"). Beim Anmelden und
 * Kontowechsel aufrufen; `null` loest die Bindung (Abmeldung).
 */
export function bindSetupKey(key: string | null): void {
  if (key === activeKey) return;
  activeKey = key;
  state = key === null ? { ...DEFAULTS } : load(key);
  session = { celebrate: null, bound: key !== null, reopened: false };
  emit();
}

function update(patch: Partial<Persisted>, sessionPatch?: Partial<Session>): void {
  state = { ...state, ...patch };
  if (sessionPatch) session = { ...session, ...sessionPatch };
  persist();
  emit();
}

const subscribe = subscribeTo(EVENT);

export function useSetupState(): SetupSnapshot {
  return useSyncExternalStore(subscribe, () => snapshotCache, () => snapshotCache);
}

export const setupActions = {
  /** Willkommen zeigen (frische Installation, erster Start). */
  showWelcome: () => update({ welcomed: true, open: true, view: 'welcome' }, { reopened: false }),
  /** Dialog ab dem Schritt `key` oeffnen (Wiedereinstieg, Launcher, Karte). */
  openAt: (key: SetupStepKey) =>
    update({ welcomed: true, open: true, view: 'step', current: key }, { reopened: false }),
  /** Dialog oeffnen, wo der Stand ihn verlangt (Befehlspalette, Konto). */
  reopen: (key: SetupStepKey | null) =>
    update(
      { welcomed: true, open: true, view: key ? 'step' : 'done', current: key ?? state.current },
      { reopened: true },
    ),
  /** In den Launcher schieben. */
  minimize: () => update({ welcomed: true, open: false }),
  go: (key: SetupStepKey) => update({ view: 'step', current: key }, { celebrate: null }),
  skip: (key: SetupStepKey, next: SetupStepKey | null) => {
    announceSkip();
    update({
      skipped: state.skipped.includes(key) ? state.skipped : [...state.skipped, key],
      view: next ? 'step' : 'done',
      current: next ?? state.current,
    });
  },
  /** Schritt gespeichert: Erfolgsmoment mit den Werten dieses Laufs. */
  celebrate: (key: SetupStepKey, vars: Record<string, string | number>) =>
    update(
      { view: 'celebrate', current: key, skipped: state.skipped.filter((k) => k !== key) },
      { celebrate: { key, vars } },
    ),
  /** Nach dem Erfolgsmoment weiter: naechster Schritt oder Abschluss. */
  afterCelebrate: (next: SetupStepKey | null) =>
    update({ view: next ? 'step' : 'done', current: next ?? state.current }, { celebrate: null }),
  confirmAbsence: () => update({ absenceConfirmed: true }),
  closeDone: () => update({ open: false, doneSeen: true }),
  dismissCard: () => update({ cardDismissed: true }),
};
