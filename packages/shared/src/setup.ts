import type { AdminArea } from './admin.js';
import { pathAllowedByFeatures } from './features.js';
import { moduleEnabled, type ModuleKey, type VariantManifest } from './variants/index.js';

/**
 * Einrichtungs-Assistent: Schritte und Fortschritt, ohne DOM, damit Backend-Test
 * und beide Clients dieselbe Rechnung benutzen. Die Texte stehen NICHT hier,
 * sondern im Renderer (features/setup/copy.ts).
 *
 * Der Fortschritt wird aus den Daten abgeleitet (GET /api/setup/status), nicht
 * gespeichert. Einzige Ausnahme ist der Schritt "abwesenheit": Die Arten sind
 * von Anfang an mitgeliefert, "erledigt" heisst dort nur "angeschaut". Die
 * Bestaetigung haelt der Server fuer die Installation (`absence_confirmed`),
 * nicht das Geraet.
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
  /**
   * Wer die Einrichtung uebernommen hat, aus Sicht des abfragenden Kontos
   * (siehe SetupOwner). Ohne Bereichsbindung und ohne Konto-ID: Es sagt nichts
   * ueber Fachdaten und nicht, WER es ist.
   */
  assistant_owner: SetupOwner;
  /**
   * Kann das abfragende Konto die Einrichtung jetzt uebernehmen? Nur, solange
   * `assistant_owner` `none` ist, und nur mit mindestens einem sichtbaren
   * Schritt (visibleSetupStepKeys). Dieselbe Pruefung wie POST /api/setup/started.
   */
  assistant_claimable: boolean;
  company_saved?: boolean;
  locations?: number;
  departments?: number;
  employees_active?: number;
  employees_with_manager?: number;
  absence_types_active?: number;
  /** Schritt "abwesenheit" auf irgendeinem Arbeitsplatz bestaetigt. */
  absence_confirmed?: boolean;
  admin_users?: number;
  portal_users?: number;
  employees_without_account?: number;
}

/**
 * Uebernahme der Einrichtung, gespeichert je Installation MIT Konto (Zeile
 * `assistent` in `setup_confirmations`): `none` = frei, `self` = das abfragende
 * Konto, `other` = ein anderes. Frei heisst auch: Konto geloescht, Eigentuemer
 * hat keinen Assistentenschritt mehr, oder nur das Startkonto des Betreibers
 * haelt sie (aus Sicht jedes anderen Kontos; core/setupRoutes.ts, ownerFor).
 * Uebernommen hat, wer den Assistenten kennengelernt hat (Willkommen gesehen
 * oder geoeffnet, lokaler Merker `welcomed`); das Ausblenden der Karte zaehlt
 * NICHT, es gilt nur fuer das eigene Geraet.
 */
export type SetupOwner = 'none' | 'self' | 'other';

/** Was nur dieses Geraet weiss (localStorage, je Konto). */
export interface SetupLocalState {
  /**
   * Schritt "abwesenheit" auf DIESEM Geraet bestaetigt. Zaehlt sofort, bis der
   * Server `absence_confirmed` meldet; der Client traegt es dorthin nach (auch
   * Bestaetigungen aus der Zeit, als nur das Geraet sie kannte).
   */
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
      return s.absence_confirmed === true || local.absenceConfirmed;
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

/**
 * Schritte, die ein Konto im Assistenten sieht: Bereich bearbeitbar
 * (`mayEdit`, im Client `can`, im Backend areaOpen), Modul in der Variante,
 * Pfad von der Lizenz freigegeben. Client (useSetup) und Backend (Recht zur
 * Uebernahme) rufen dieselbe Funktion, sonst laege die Grenze an zwei Stellen.
 */
export function visibleSetupStepKeys(
  mayEdit: (area: AdminArea) => boolean,
  variant: Pick<VariantManifest, 'modules'>,
  features: readonly string[] | null | undefined,
): SetupStepKey[] {
  return SETUP_STEPS.filter(
    (d) => mayEdit(d.area) && moduleEnabled(variant, d.module) && pathAllowedByFeatures(d.navPath, features),
  ).map((d) => d.key);
}

/** Lokaler Zustand, an dem die Sichtbarkeit haengt (renderer features/setup/store.ts). */
export interface SetupViewState {
  /** Willkommen gesehen oder Assistent geoeffnet (ab dann gibt es den Launcher). */
  welcomed: boolean;
  /** Dialog offen. */
  open: boolean;
  /** Karte auf diesem Geraet ausgeblendet. */
  cardDismissed: boolean;
}

/**
 * Bieten Karte und Willkommen die Einrichtung diesem Konto an? Nicht, wenn ein
 * ANDERES Konto sie uebernommen hat: Sonst bekaeme jede neue HR-Person bei der
 * ersten Anmeldung den Stand der Einrichtung vorgesetzt. Das eigene Konto
 * bekommt sie auf jedem Arbeitsplatz wieder angeboten.
 */
export function setupOfferedTo(status: Pick<SetupStatus, 'assistant_owner'>): boolean {
  return status.assistant_owner !== 'other';
}

/** Oeffnet sich der Willkommensdialog von selbst? Nur bei leerer Firma, einmal je Konto und Geraet. */
export function setupWelcomeDue(status: SetupStatus, view: SetupViewState): boolean {
  return !view.welcomed && setupOfferedTo(status) && isFreshInstallation(status);
}

/**
 * Schritt, den die Dashboard-Karte anbietet, oder null, wenn sie nicht
 * erscheint. Wer den Launcher hat, braucht sie nicht doppelt.
 */
export function setupCardStep(status: SetupStatus, progress: SetupProgress, view: SetupViewState): SetupStepKey | null {
  const shown =
    progress.total > 0 &&
    !progress.complete &&
    !view.cardDismissed &&
    !view.open &&
    !view.welcomed &&
    setupOfferedTo(status);
  return shown ? progress.next : null;
}

/**
 * Erscheint der Launcher unten rechts? Fuer das Konto, das den Assistenten
 * kennt, bis der Abschluss gesehen ist; nicht, wenn ein ANDERES Konto die
 * Einrichtung uebernommen hat (sonst bliebe der Knopf etwa nach zwei
 * gleichzeitigen Anmeldungen bei leerer Firma fuer immer stehen). Fehlt das
 * Feld (aeltere Fassung des Servers), bleibt es wie bisher.
 */
export function setupLauncherVisible(
  status: Pick<SetupStatus, 'assistant_owner'>,
  progress: SetupProgress,
  view: SetupViewState & { doneSeen: boolean },
): boolean {
  return view.welcomed && !(progress.complete && view.doneSeen) && setupOfferedTo(status);
}

/**
 * Soll dieses Konto die Uebernahme melden? Wer den Assistenten kennengelernt
 * hat, solange niemand uebernommen hat und das Konto es darf. Traegt auch
 * Merker nach, die nur das Geraet kennt (gesetzt vor diesem Serverfeld).
 */
export function setupClaimOwed(status: SetupStatus, view: SetupViewState): boolean {
  return view.welcomed && status.assistant_owner === 'none' && status.assistant_claimable;
}

/**
 * Lohnt das Nachladen des Status beim Seitenwechsel? Nur, solange Assistent
 * oder Karte etwas zeigen koennen: nicht nach dem Abschluss, nicht nach dem
 * Ausblenden, und gar nicht, wenn ein anderes Konto uebernommen hat (dann
 * zeigen weder Karte noch Launcher etwas). Ohne Status (noch nicht geladen)
 * gilt beides als moeglich.
 */
export function setupStatusWatched(
  status: SetupStatus | undefined,
  progress: SetupProgress,
  view: SetupViewState,
): boolean {
  return (
    !progress.complete &&
    (status === undefined || setupOfferedTo(status)) &&
    (view.welcomed || !view.cardDismissed)
  );
}
