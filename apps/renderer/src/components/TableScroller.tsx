import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Hülle für breite Tabellen, ersetzt `<div className="hm-table-wrap">`.
 *
 * Zwei Dinge, damit niemand für das waagerechte Verschieben bis unter die
 * letzte Zeile scrollen muss:
 * - Ziehen mit der Maus auf einer freien Stelle der Tabelle verschiebt sie
 *   (ab 4 px Weg; der anschließende Klick öffnet dann keine Zeile).
 * - Die Scrollleiste klebt am unteren Rand des Fensters, solange die Tabelle
 *   im Bild ist, und ruht am Tabellenende, sobald das erreicht ist. Sie
 *   ersetzt die eigene Leiste des Containers.
 *
 * Die Karte drumherum schneidet mit `overflow: clip` statt `hidden`
 * (components.css), sonst würde sie zum Scrollcontainer und die Leiste
 * klebte an ihr statt am Fenster.
 */
const DRAG_THRESHOLD = 4;
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]';

export function TableScroller({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState({ content: 0, view: 0 });
  const [dragging, setDragging] = useState(false);
  const overflows = width.content > width.view + 1;

  // Breite des Inhalts messen: beim Aufbau und bei jeder Größenänderung von
  // Container oder Tabelle (Spaltenauswahl, Fenstergröße, nachgeladene Zeilen).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth({ content: el.scrollWidth, view: el.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  // Beide Seiten gleich halten, ohne dass sich die Ereignisse gegenseitig
  // aufschaukeln: Geschrieben wird nur, wenn der Wert abweicht.
  const syncFromTable = () => {
    const el = scrollRef.current;
    const bar = barRef.current;
    if (el && bar && bar.scrollLeft !== el.scrollLeft) bar.scrollLeft = el.scrollLeft;
  };
  const syncFromBar = () => {
    const el = scrollRef.current;
    const bar = barRef.current;
    if (el && bar && el.scrollLeft !== bar.scrollLeft) el.scrollLeft = bar.scrollLeft;
  };

  useEffect(() => {
    if (overflows) syncFromTable();
  }, [overflows, width.content]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || !overflows || e.button !== 0 || e.pointerType !== 'mouse') return;
    if ((e.target as Element).closest(INTERACTIVE)) return;
    const startX = e.clientX;
    const startLeft = el.scrollLeft;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        window.getSelection()?.removeAllRanges();
      }
      el.scrollLeft = startLeft - dx;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!moved) return;
      setDragging(false);
      // Der Klick nach dem Ziehen gehört zum Ziehen, nicht zur Zeile darunter.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      // Kommt kein Klick (Maus ausserhalb losgelassen), darf der nächste echte
      // Klick nicht verschluckt werden.
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div className="hm-table-scroll">
      <div
        ref={scrollRef}
        className={`hm-table-wrap hm-table-scroll__view${overflows ? ' is-draggable' : ''}${dragging ? ' is-dragging' : ''}`}
        onScroll={syncFromTable}
        onPointerDown={onPointerDown}
      >
        {children}
      </div>
      {overflows && (
        <div ref={barRef} className="hm-table-scroll__bar" onScroll={syncFromBar} aria-hidden="true">
          <div style={{ width: width.content, height: 1 }} />
        </div>
      )}
    </div>
  );
}
