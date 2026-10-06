import type { AdminArea } from '@ohrganize/shared';

/**
 * Seiten-Einfuehrungen. Ein Schritt ist erledigt, wenn die Seite sein Ereignis
 * meldet (`tourEvent`, events.ts): Die Schritte folgen den ECHTEN Aktionen,
 * nicht einem "Weiter". Die Reihenfolge ist ein Vorschlag, erledigt werden darf
 * in jeder; "dran" ist der erste offene.
 *
 * `target` und `altTarget` sind Werte von `data-tour` im DOM. Fehlt das Ziel
 * (andere Ansicht, Dialog zu), nimmt die Blase das `altTarget` mit dem Text
 * `<Tour>.step<N>.alt`; gibt es keins, bleibt nur die Leiste.
 */
export interface TourStepDef {
  event: string;
  target: string;
  altTarget?: string;
  /** `above`: Blase ueber das Ziel (Dialoge: darunter laegen die Knoepfe). */
  placement?: 'above';
}

export interface TourDef {
  id: string;
  /** Pfadpraefix der Seite: Die Leiste erscheint nur dort, pro Seite eine eigene. */
  path: string;
  /** Bereich, den das Konto zum Oeffnen der Seite braucht. */
  area: AdminArea;
  steps: TourStepDef[];
  /**
   * Ereignisse, die schon wahr sind, wenn die Einfuehrung startet (die Seite
   * wurde direkt in einer Unteransicht geoeffnet). Bekommt den Suchteil der URL.
   */
  initial?: (search: string) => string[];
}

export const TOURS: TourDef[] = [
  {
    id: 'gehaelter',
    path: '/verguetung/gehaelter',
    area: 'verguetung',
    initial: (search) => (new URLSearchParams(search).get('person') ? ['gehaelter.person-opened'] : []),
    steps: [
      { event: 'gehaelter.person-opened', target: 'gehaelter-overview' },
      { event: 'gehaelter.component-dialog', target: 'gehaelter-component-btn' },
      { event: 'gehaelter.component-saved', target: 'gehaelter-component-form', altTarget: 'gehaelter-component-btn', placement: 'above' },
      { event: 'gehaelter.request-dialog', target: 'gehaelter-request-btn' },
      { event: 'gehaelter.decided-viewed', target: 'gehaelter-decided', altTarget: 'gehaelter-back' },
    ],
  },
];

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
