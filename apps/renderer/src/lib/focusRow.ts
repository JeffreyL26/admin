import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Eine Zeile per URL anspringen: `?<param>=<id>` liest die Seite beim Aufruf
 * aus, die Zeile trägt `data-focus-id={id}` und bei Gleichheit die Klasse
 * `hm-row--focus` (Hervorhebung blendet per CSS-Animation aus). Sobald die
 * Zeile im DOM steht (Daten kommen asynchron), wird sie in die Mitte gescrollt;
 * danach wird die ID losgelassen, sonst spränge jeder Filterwechsel erneut hin.
 */
export function useFocusRow(param: string): number | null {
  const [params] = useSearchParams();
  const [focusId, setFocusId] = useState<number | null>(() => {
    const id = Number(params.get(param));
    return Number.isInteger(id) && id > 0 ? id : null;
  });

  useEffect(() => {
    if (focusId === null) return;
    const deadline = Date.now() + 5000;
    let frame = 0;
    let release = 0;
    const tick = () => {
      const el = document.querySelector(`[data-focus-id="${focusId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        release = window.setTimeout(() => setFocusId(null), 3000);
        return;
      }
      if (Date.now() < deadline) frame = requestAnimationFrame(tick);
      else setFocusId(null);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(release);
    };
  }, [focusId]);

  return focusId;
}
