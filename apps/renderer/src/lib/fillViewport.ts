import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Begrenzt ein Element auf den Platz bis zum unteren Rand seines Scrollbereichs
 * (abzüglich `reserve` für das, was darunter noch stehen soll). Das Element
 * scrollt dann selbst — und erst dadurch bleibt eine `position: sticky`-
 * Kopfzeile darin stehen: Ein horizontal scrollender Wrapper ist immer auch
 * der vertikale Sticky-Bezug; wächst er mit dem Inhalt, klebt die Kopfzeile
 * an nichts.
 */
export function useFillViewport<T extends HTMLElement>(ref: RefObject<T>, reserve: number, min = 280): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const scroller = scrollParent(el);
      const top = scroller
        ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        : el.getBoundingClientRect().top + window.scrollY;
      const viewport = scroller ? scroller.clientHeight : window.innerHeight;
      setMaxHeight(Math.max(min, Math.floor(viewport - top - reserve)));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [ref, reserve, min]);
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
