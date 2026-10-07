import { tourStepHit, type AdminArea } from '@ohrganize/shared';

/**
 * Seiten-Einfuehrungen. Ein Schritt ist erledigt, wenn die Seite sein Ereignis
 * meldet (`tourEvent`, events.ts): Die Schritte folgen den ECHTEN Aktionen,
 * nicht einem "Weiter". Die Reihenfolge ist ein Vorschlag, erledigt werden darf
 * in jeder; "dran" ist der erste offene.
 *
 * `target` und `altTarget` sind Namen in `data-tour` im DOM; ein Element darf mehrere
 * tragen, durch Leerzeichen getrennt (Suche Wort fuer Wort, `data-tour~=`): So dient ein
 * Element als Ziel der einen und als Ersatzziel einer anderen Stelle. Fehlt das Ziel
 * (andere Ansicht, Dialog zu), nimmt die Blase das `altTarget` mit dem Text
 * `<Tour>.step<N>.alt`; gibt es keins, bleibt nur die Leiste.
 */
export interface TourPage {
  key: string;
  path: string;
  area: AdminArea;
}

export interface TourStepDef {
  event: string;
  target: string;
  altTarget?: string;
  /** Fehlen Daten, auf die der Schritt wartet: Ziel mit Hinweistext `<Tour>.step<N>.empty`. */
  emptyTarget?: string;
  /**
   * `above`: Blase ueber das Ziel (Dialoge: darunter laegen die Knoepfe).
   * `left`: links daneben, auch ausserhalb des Dialogs; ohne Platz dort rechts im Dialog ueber der Zeile des Ziels.
   * Nur fuer das Hauptziel, Ersatzziele stehen normal.
   */
  placement?: 'above' | 'left';
  /** `bottom`: Das Ziel ist ein Formular, das den Dialog fuellt: Ring um den ganzen Dialog, Blase unten rechts. */
  anchor?: 'bottom';
  /**
   * Meldet die Seite dieses Ereignis, obwohl davor liegende Schritte noch offen sind
   * (optionale Eingaben uebersprungen), gelten sie mit als erledigt. Nur fuer
   * Schritte, deren Aktion die davor liegenden voraussetzt oder umfasst, und nur,
   * wenn alle uebersprungenen Schritte auf derselben Seite liegen wie dieser
   * (`stepHit`): Ein Ereignis einer spaeteren Seite hakt nie Schritte einer anderen ab.
   */
  catchUp?: boolean;
  /** Schluessel in `TourDef.pages`; Vorgabe: erste Seite. */
  page?: string;
  /** Wechselhinweis (`<Tour>.step<N>.enter`) beim automatischen Seitenwechsel auf diesen Schritt. */
  enter?: boolean;
}

export interface TourDef {
  id: string;
  /** Pfadpraefix der Seite: Die Leiste erscheint nur dort, pro Seite eine eigene. */
  path: string;
  /** Bereich, den das Konto zum Oeffnen der Seite braucht. */
  area: AdminArea;
  /**
   * Recht, das das Konto im Bereich braucht. Vorgabe `bearbeiten`, weil die
   * meisten Schritte etwas anlegen; reine Rundgaenge zum Ansehen setzen `lesen`.
   */
  minRight?: 'lesen' | 'bearbeiten';
  /** Nur Einfuehrungen ueber mehrere Seiten; pages[0] ist die Einstiegsseite (= path/area). */
  pages?: TourPage[];
  steps: TourStepDef[];
  /**
   * Ereignisse, die schon wahr sind, wenn die Einfuehrung startet (die Seite
   * wurde direkt in einer Unteransicht geoeffnet). Bekommt den Suchteil der URL.
   */
  initial?: (search: string) => string[];
}

/** Mehrseitige Einfuehrung: Einstiegsseite (`path`, `area`) kommt aus `pages[0]`, nicht doppelt. */
function multiPage(def: Omit<TourDef, 'path' | 'area'> & { pages: TourPage[] }): TourDef {
  return { ...def, path: def.pages[0]!.path, area: def.pages[0]!.area };
}

export const TOURS: TourDef[] = [
  {
    id: 'gehaelter',
    path: '/verguetung/gehaelter',
    area: 'verguetung',
    minRight: 'lesen',
    initial: (search) => (new URLSearchParams(search).get('person') ? ['gehaelter.person-opened'] : []),
    steps: [
      { event: 'gehaelter.person-opened', target: 'gehaelter-overview' },
      { event: 'gehaelter.component-dialog', target: 'gehaelter-component-btn' },
      { event: 'gehaelter.component-saved', target: 'gehaelter-component-form', altTarget: 'gehaelter-component-btn', placement: 'above' },
      { event: 'gehaelter.request-dialog', target: 'gehaelter-request-btn' },
      { event: 'gehaelter.decided-viewed', target: 'gehaelter-decided', altTarget: 'gehaelter-back' },
    ],
  },
  {
    id: 'ankuendigungen',
    path: '/kommunikation/ankuendigungen',
    area: 'kommunikation',
    steps: [
      { event: 'ankuendigungen.editor-dialog', target: 'ankuendigungen-create-btn' },
      { event: 'ankuendigungen.content-entered', target: 'ankuendigungen-content', altTarget: 'ankuendigungen-create-btn' },
      { event: 'ankuendigungen.schedule-set', target: 'ankuendigungen-publish', altTarget: 'ankuendigungen-create-btn' },
      { event: 'ankuendigungen.ack-checked', target: 'ankuendigungen-ack', altTarget: 'ankuendigungen-create-btn', catchUp: true },
      { event: 'ankuendigungen.saved', target: 'ankuendigungen-form', altTarget: 'ankuendigungen-create-btn', placement: 'above', anchor: 'bottom', catchUp: true },
      { event: 'ankuendigungen.detail-opened', target: 'ankuendigungen-row', altTarget: 'ankuendigungen-create-btn' },
      { event: 'ankuendigungen.detail-closed', target: 'ankuendigungen-status' },
    ],
  },
  {
    id: 'stellen',
    path: '/recruiting/stellen',
    area: 'recruiting',
    steps: [
      { event: 'stellen.editor-dialog', target: 'stellen-create-btn' },
      { event: 'stellen.saved', target: 'stellen-form', altTarget: 'stellen-create-btn', placement: 'above', anchor: 'bottom' },
      { event: 'stellen.status-opened', target: 'stellen-status', altTarget: 'stellen-create-btn' },
      { event: 'stellen.detail-opened', target: 'stellen-card', altTarget: 'stellen-create-btn' },
      { event: 'stellen.detail-closed', target: 'stellen-stages' },
      { event: 'stellen.filter-used', target: 'stellen-filter' },
    ],
  },
  multiPage({
    id: 'rollen-rechte',
    pages: [
      { key: 'rollen', path: '/verwaltung/rollen', area: 'verwaltung' },
      { key: 'benutzer', path: '/verwaltung/benutzer', area: 'benutzer' },
    ],
    steps: [
      { event: 'rollen-rechte.role-dialog', target: 'rollen-create-btn' },
      { event: 'rollen-rechte.role-saved', target: 'rollen-form', altTarget: 'rollen-create-btn', placement: 'above' },
      { event: 'rollen-rechte.members-dialog', target: 'rollen-members-btn', altTarget: 'rollen-create-btn' },
      {
        event: 'rollen-rechte.members-saved',
        target: 'rollen-members-list',
        emptyTarget: 'rollen-members-empty',
        altTarget: 'rollen-members-btn',
        placement: 'above',
      },
      { event: 'rollen-rechte.admin-role-dialog', page: 'benutzer', enter: true, target: 'rechte-role-btn', altTarget: 'rechte-tab-rollen' },
      { event: 'rollen-rechte.admin-role-saved', page: 'benutzer', target: 'rechte-role-form', altTarget: 'rechte-role-btn', placement: 'left' },
      {
        event: 'rollen-rechte.assign-opened',
        page: 'benutzer',
        target: 'rechte-assign-select',
        emptyTarget: 'rechte-account-create-btn',
        altTarget: 'rechte-tab-konten',
      },
    ],
  }),
  multiPage({
    id: 'leistung-fuehrung',
    pages: [
      { key: 'einrichtung', path: '/fuehrung/einrichtung', area: 'fuehrung' },
      { key: 'report', path: '/fuehrung/report', area: 'fuehrung' },
      { key: 'beurteilungen', path: '/leistung/beurteilungen', area: 'leistung' },
    ],
    steps: [
      { event: 'leistung-fuehrung.grant-dialog', target: 'lf-grant-btn', altTarget: 'lf-tab-leaders' },
      {
        event: 'leistung-fuehrung.grant-saved',
        target: 'lf-grant-form',
        emptyTarget: 'lf-grant-empty',
        altTarget: 'lf-grant-alt',
        placement: 'above',
        anchor: 'bottom',
      },
      { event: 'leistung-fuehrung.categories-tab', target: 'lf-tab-categories' },
      { event: 'leistung-fuehrung.scale-tab', target: 'lf-tab-scale' },
      {
        event: 'leistung-fuehrung.breakdown-opened',
        page: 'report',
        enter: true,
        target: 'lf-report-row',
        emptyTarget: 'lf-report-empty',
      },
      { event: 'leistung-fuehrung.templates-tab', page: 'beurteilungen', enter: true, target: 'lf-tab-templates' },
      {
        event: 'leistung-fuehrung.template-dialog',
        page: 'beurteilungen',
        target: 'lf-template-btn',
        altTarget: 'lf-tab-templates',
        catchUp: true,
      },
      {
        event: 'leistung-fuehrung.template-saved',
        page: 'beurteilungen',
        target: 'lf-template-form',
        altTarget: 'lf-template-btn',
        placement: 'above',
        catchUp: true,
      },
    ],
  }),
];

/** Die Einfuehrung, zu deren Seiten `pathname` gehoert (Einstiegsseite oder weitere). */
export function tourAt(pathname: string): TourDef | null {
  return TOURS.find((x) => [x.path, ...(x.pages ?? []).map((p) => p.path)].some((p) => pathname.startsWith(p))) ?? null;
}

/** Index des Schritts, den das Ereignis abhakt, oder -1 (Regel: packages/shared/src/tours.ts). */
export function stepHit(tour: TourDef, index: number, total: number, name: string): number {
  return tourStepHit(tour.steps, tourPages(tour).map((p) => p.key), index, total, name);
}

/** Die Seiten einer Einfuehrung; eine ohne `pages` hat genau eine (`main`). */
function tourPages(tour: TourDef): TourPage[] {
  return tour.pages ?? [{ key: 'main', path: tour.path, area: tour.area }];
}

/** Seite eines Schritts (Vorgabe: die erste). */
export function stepPage(tour: TourDef, step: TourStepDef): TourPage {
  const pages = tourPages(tour);
  return pages.find((p) => p.key === step.page) ?? pages[0]!;
}

/**
 * Anzahl der fuehrenden Schritte, deren Seitenbereich das Konto oeffnen darf.
 * Ein Praefix, kein Filter: Seiten mit moeglicherweise fehlendem Recht stehen am
 * Ende, damit `done` ein zusammenhaengender Anfang bleibt.
 */
export function visibleStepCount(tour: TourDef, can: (area: AdminArea, needed?: 'lesen' | 'bearbeiten') => boolean): number {
  const needed = tour.minRight ?? 'bearbeiten';
  let n = 0;
  while (n < tour.steps.length && can(stepPage(tour, tour.steps[n]).area, needed)) n++;
  return n;
}

/**
 * Anzahl der Segmentfarben (Variablen `--tour-1` bis `--tour-8` samt `--tour-N-on`
 * in design/tokens.css): die Farben der Leiste der Website, Schritt `i` nimmt
 * `i mod 8`.
 */
export const TOUR_COLOR_COUNT = 8;

export const tourColor = (i: number) => {
  const n = (i % TOUR_COLOR_COUNT) + 1;
  return { bg: `var(--tour-${n})`, on: `var(--tour-${n}-on)` };
};
