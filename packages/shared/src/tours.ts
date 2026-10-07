/**
 * Fortschrittsregel der Seiten-Einfuehrungen, ohne DOM, damit Backend-Test und Renderer
 * dieselbe Rechnung benutzen (Vorbild: setup.ts). Die Schritte, Texte und der Zustand
 * stehen im Renderer (features/tours).
 */

/** Was die Regel von einem Schritt braucht. */
export interface TourStepProgress {
  event: string;
  /** Schluessel der Seite; fehlt er oder ist er unbekannt, gilt die erste Seite. */
  page?: string;
  catchUp?: boolean;
}

/**
 * Index des Schritts, den das Ereignis `name` abhakt, oder -1. Der Schritt, der dran ist
 * (`index`), zaehlt immer; ein spaeterer nur mit `catchUp` und nur, wenn alle Schritte
 * dazwischen auf derselben Seite liegen wie er: Ein Ereignis einer spaeteren Seite hakt nie
 * Schritte einer anderen ab. `pageKeys` sind die Seiten der Einfuehrung, die erste ist die
 * Vorgabe (die erste Seite darf ohne `page` stehen und gilt trotzdem als dieselbe).
 */
export function tourStepHit(
  steps: readonly TourStepProgress[],
  pageKeys: readonly string[],
  index: number,
  total: number,
  name: string,
): number {
  if (steps[index]?.event === name) return index;
  const pageOf = (s: TourStepProgress) => (s.page !== undefined && pageKeys.includes(s.page) ? s.page : pageKeys[0]);
  return steps.findIndex(
    (s, i) =>
      i > index &&
      i < total &&
      s.catchUp === true &&
      s.event === name &&
      steps.slice(index, i).every((p) => pageOf(p) === pageOf(s)),
  );
}
