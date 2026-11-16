import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * Tastatur und Label-Klick für Panels im Popover (Portal am <body>), die
 * auch in einem Modal stehen: ColorPicker und MultiSelect. Die Fokusfalle
 * und das Escape des Modals sehen das portalierte Panel als „draußen“; die
 * Panels behandeln Tab und Escape deshalb selbst und stoppen die Weitergabe.
 */

/** Fokussierbare Ziele innerhalb eines Panels (Tab-Zyklus). */
export const PANEL_FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab bleibt im Panel: vom letzten Ziel zum ersten und mit Umschalt zurück.
 * Sonst holte die Fokusfalle eines Modals den Fokus auf ihren ersten Knopf,
 * und die Ziele im Panel wären per Tastatur unerreichbar.
 */
export function keepTabInPanel(e: KeyboardEvent, panel: HTMLElement | null): void {
  e.stopPropagation();
  if (!panel) return;
  const nodes = Array.from(panel.querySelectorAll<HTMLElement>(PANEL_FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  );
  if (nodes.length === 0) return;
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** So lange gilt ein Druck auf die Beschriftung; danach verfällt der Wächter. */
const LABEL_CLICK_WINDOW_MS = 1000;

/**
 * Steht der Auslöser in einem <label> (Field), schließt ein Klick auf die
 * Beschriftung das offene Panel über den Außenklick des Popovers und reicht
 * dann einen Klick an den Auslöser weiter, der es sofort wieder öffnete. Der
 * Wächter merkt sich beim Drücken, dass der nächste Klick des Auslösers
 * geschluckt werden soll; die Rückgabe fragt das im Klick-Handler ab (und
 * verbraucht es). Gesetzt wird er nur, solange das Panel offen ist (die
 * Listener am Dokument hängen nur dann). Zurück setzen ihn jeder Druck und
 * jede Taste am Auslöser selbst, auch bei geschlossenem Panel: Ein
 * weitergereichter Klick des Labels kommt ohne beides an, ein echter Klick
 * oder Enter nicht. Ein Druck ohne folgenden Klick verfällt zudem nach
 * kurzer Zeit.
 */
export function useLabelClickGuard(triggerRef: RefObject<HTMLElement>, open: boolean): () => boolean {
  const until = useRef(0);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      const trigger = triggerRef.current;
      until.current =
        trigger && target && !trigger.contains(target) && target.closest('label')?.contains(trigger)
          ? performance.now() + LABEL_CLICK_WINDOW_MS
          : 0;
    };
    const onKey = () => {
      until.current = 0;
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, triggerRef]);
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const clear = () => {
      until.current = 0;
    };
    trigger.addEventListener('pointerdown', clear);
    trigger.addEventListener('keydown', clear);
    return () => {
      trigger.removeEventListener('pointerdown', clear);
      trigger.removeEventListener('keydown', clear);
    };
  }, [triggerRef]);
  return useCallback(() => {
    const swallow = performance.now() < until.current;
    until.current = 0;
    return swallow;
  }, []);
}
