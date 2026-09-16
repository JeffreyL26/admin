import { useLayoutEffect, useState, type RefObject } from 'react';

export interface FillViewportOptions {
  /**
   * Element unterhalb, das ohne Scrollen sichtbar bleiben soll (z. B. die
   * Legende). Alles, was danach folgt, darf unter den Rand rutschen.
   */
  keep?: RefObject<HTMLElement>;
  /** Untergrenze, damit das Element auf kleinen Fenstern bedienbar bleibt. */
  min?: number;
}

/**
 * Begrenzt ein Element auf den Platz bis zum unteren Rand seines Scrollbereichs
 * (abzüglich dessen, was darunter sichtbar bleiben soll). Das Element scrollt
 * dann selbst — und erst dadurch bleibt eine `position: sticky`-Kopfzeile
 * darin stehen: Ein horizontal scrollender Wrapper ist immer auch der
 * vertikale Sticky-Bezug; wächst er mit dem Inhalt, klebt die Kopfzeile an
 * nichts. Gemessen wird am DOM (Lage, `keep`, Innenabstand des Scrollbereichs),
 * nicht mit festen Reserven, damit Änderungen unterhalb des Elements nicht
 * still die Zusage brechen.
 */
export function useFillViewport<T extends HTMLElement>(
  ref: RefObject<T>,
  { keep, min = 280 }: FillViewportOptions = {},
): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const scroller = scrollParent(el);
      const rect = el.getBoundingClientRect();
      const top = scroller
        ? rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
        : rect.top + window.scrollY;
      const viewport = scroller ? scroller.clientHeight : window.innerHeight;
      // Abstand von der Unterkante des Elements bis zur Unterkante von `keep`
      // ist von der eigenen Höhe unabhängig, weil `keep` im Fluss danach folgt.
      const keepEl = keep?.current;
      const below = keepEl ? Math.max(0, keepEl.getBoundingClientRect().bottom - rect.bottom) : 0;
      const pad = scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) || 0 : 0;
      setMaxHeight(Math.max(min, Math.floor(viewport - top - below - pad)));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [ref, keep, min]);
  return maxHeight;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}
