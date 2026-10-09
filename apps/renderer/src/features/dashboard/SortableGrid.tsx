import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { moveItem } from '@ohrganize/shared';

/**
 * Sortierbares Widget-Raster ohne Fremdbibliothek (keine neue Abhaengigkeit).
 *
 * Ablauf: Zeiger am Kopf eines Widgets druecken und ziehen. Ab 5 px Weg loest
 * sich das Widget vom Raster (position: fixed, folgt dem Zeiger direkt ueber
 * das DOM, ohne React-Render je Bewegung), an seinem Platz steht ein
 * Platzhalter. Liegt der Zeiger ueber einem anderen Widget, rueckt der
 * Platzhalter dorthin; die uebrigen Widgets gleiten per FLIP an ihre neue
 * Stelle. Am Rand des Scrollbereichs rollt die Seite mit. Loslassen uebernimmt
 * die Reihenfolge, das Widget gleitet in seinen Platz. Escape oder ein Abbruch
 * durch den Browser (pointercancel) verwirft den Zug.
 *
 * Tastatur: Griff fokussieren, Pfeiltasten verschieben um eine Stelle. Der
 * Griff behaelt dabei den Fokus (React verschiebt beim Schritt nach rechts den
 * Knoten selbst, und Chromium nimmt ihm dabei den Fokus).
 *
 * Das gezogene Widget bleibt dasselbe Element an seiner Stelle im Raster (nur
 * per Stil geloest), damit sein Zustand das Ziehen uebersteht.
 *
 * `position: fixed` bezieht sich auf einen Vorfahren, sobald einer `transform`,
 * `filter` oder Containment traegt (etwa `.page-enter` waehrend der
 * Einblende-Animation). Deshalb misst der Start die tatsaechliche Lage und
 * gleicht die Abweichung aus (`fix`).
 */

export interface HandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

interface Props<K extends string> {
  items: K[];
  enabled: boolean;
  wide: (k: K) => boolean;
  onCommit: (order: K[]) => void;
  renderItem: (k: K, handle: HandleProps | null, dragging: boolean) => React.ReactNode;
  className?: string;
}

interface DragState<K> {
  key: K;
  order: K[];
  offX: number;
  offY: number;
  w: number;
  h: number;
  startLeft: number;
  startTop: number;
}

const START_DISTANCE = 5;
const EDGE = 80;
const SETTLE_MS = 220;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null;
  while (n) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return null;
}

export function SortableGrid<K extends string>({ items, enabled, wide, onCommit, renderItem, className }: Props<K>) {
  const [drag, setDrag] = useState<DragState<K> | null>(null);
  const dragRef = useRef<DragState<K> | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const overlay = useRef<HTMLElement | null>(null);
  const prevRects = useRef<Map<string, DOMRect> | null>(null);
  const lockUntil = useRef(0);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef<{ key: K; x: number; y: number } | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const fix = useRef({ x: 0, y: 0, measured: false });
  const refocus = useRef<K | null>(null);
  const latest = useRef({ items, onCommit });
  latest.current = { items, onCommit };

  const order = drag?.order ?? items;

  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    cells.current.forEach((el, k) => m.set(k, el.getBoundingClientRect()));
    prevRects.current = m;
  };

  // FLIP: nach jeder Umordnung von der alten an die neue Stelle gleiten.
  useLayoutEffect(() => {
    const before = prevRects.current;
    if (!before) return;
    prevRects.current = null;
    cells.current.forEach((el, k) => {
      if (el === overlay.current) return;
      const b = before.get(k);
      if (!b) return;
      const now = el.getBoundingClientRect();
      const dx = b.left - now.left;
      const dy = b.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetWidth;
      el.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.7, 0.2, 1)`;
      el.style.transform = '';
    });
  });

  // Nach dem Verschieben per Tastatur den Griff wieder fokussieren.
  useLayoutEffect(() => {
    const k = refocus.current;
    if (k === null) return;
    refocus.current = null;
    cells.current.get(k)?.querySelector<HTMLElement>('[data-drag-handle]')?.focus({ preventScroll: true });
  });

  const placeOverlay = (x: number, y: number) => {
    const d = dragRef.current;
    const el = overlay.current;
    if (!d || !el) return;
    el.style.left = `${x - d.offX - fix.current.x}px`;
    el.style.top = `${y - d.offY - fix.current.y}px`;
  };

  // Abweichung des Bezugspunkts einmal je Zug messen und ausgleichen.
  useLayoutEffect(() => {
    const d = dragRef.current;
    const el = overlay.current;
    if (!d || !el || fix.current.measured) return;
    const r = el.getBoundingClientRect();
    fix.current = { x: r.left - d.startLeft, y: r.top - d.startTop, measured: true };
    el.style.left = `${d.startLeft - fix.current.x}px`;
    el.style.top = `${d.startTop - fix.current.y}px`;
  });

  /** Liegt der Zeiger ueber einem anderen Widget, rueckt das gezogene an dessen Stelle. */
  const hitTest = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d || performance.now() < lockUntil.current) return;
    for (const k of d.order) {
      if (k === d.key) continue;
      const el = cells.current.get(k);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const next = moveItem(d.order, d.order.indexOf(d.key), d.order.indexOf(k));
      snapshot();
      lockUntil.current = performance.now() + SETTLE_MS;
      const nd = { ...d, order: next };
      dragRef.current = nd;
      setDrag(nd);
      return;
    }
  };

  useEffect(() => {
    if (!enabled) return undefined;
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const p = pending.current;
      if (p && !dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < START_DISTANCE) return;
        const el = cells.current.get(p.key);
        pending.current = null;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const st: DragState<K> = {
          key: p.key, order: latest.current.items, offX: p.x - r.left, offY: p.y - r.top,
          w: r.width, h: r.height, startLeft: e.clientX - (p.x - r.left), startTop: e.clientY - (p.y - r.top),
        };
        scroller.current = scrollParent(gridRef.current);
        fix.current = { x: 0, y: 0, measured: false };
        snapshot();
        dragRef.current = st;
        setDrag(st);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        return;
      }
      if (!dragRef.current) return;
      placeOverlay(e.clientX, e.clientY);
      hitTest(e.clientX, e.clientY);
    };
    /** Zug beenden: uebernehmen (Loslassen) oder verwerfen (Abbruch durch Browser, Escape). */
    const finish = (commit: boolean) => {
      pending.current = null;
      const d = dragRef.current;
      if (!d) return;
      snapshot();
      // Ab jetzt ist es wieder ein normales Rasterelement: FLIP laesst es von der Zeigerlage an seinen Platz gleiten.
      overlay.current = null;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDrag(null);
      if (commit) latest.current.onCommit(d.order);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      // Aushaengen mitten im Zug (Seitenwechsel per Tastenkuerzel): Seite nicht gesperrt zuruecklassen.
      pending.current = null;
      if (dragRef.current) {
        dragRef.current = null;
        overlay.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    // hitTest/placeOverlay lesen nur Refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Am oberen oder unteren Rand des Scrollbereichs mitrollen.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    let raf = 0;
    const tick = () => {
      const p = pointer.current;
      const sc = scroller.current;
      if (p && sc) {
        const r = sc.getBoundingClientRect();
        let dy = 0;
        if (p.y < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - p.y) / 5);
        else if (p.y > r.bottom - EDGE) dy = Math.ceil((p.y - (r.bottom - EDGE)) / 5);
        if (dy !== 0) {
          sc.scrollTop += dy;
          hitTest(p.x, p.y);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const handleFor = (k: K): HandleProps => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('button:not([data-drag-handle]), a, input, select, textarea')) return;
      e.preventDefault();
      pending.current = { key: k, x: e.clientX, y: e.clientY };
    },
    onKeyDown: (e) => {
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
      if (dir === 0) return;
      e.preventDefault();
      const list = latest.current.items;
      const i = list.indexOf(k);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      snapshot();
      refocus.current = k;
      latest.current.onCommit(moveItem(list, i, j));
    },
  });

  const cell = (k: K, isDragging: boolean) => (
    <div
      key={k}
      ref={(el) => {
        if (el) cells.current.set(k, el);
        else cells.current.delete(k);
        if (isDragging) overlay.current = el;
      }}
      className={`hm-db-cell${enabled ? ' hm-db-cell--edit' : ''}${isDragging ? ' hm-db-cell--dragging' : ''}`}
      style={
        isDragging && drag
          ? { position: 'fixed', left: drag.startLeft, top: drag.startTop, width: drag.w, zIndex: 60, pointerEvents: 'none' }
          : { gridColumn: wide(k) ? '1 / -1' : undefined }
      }
    >
      {renderItem(k, enabled ? handleFor(k) : null, isDragging)}
    </div>
  );

  return (
    <div ref={gridRef} className={className}>
      {/* Das gezogene Widget bleibt unter seinem Schluessel im Raster (kein
          Neueinhaengen); daneben haelt der Platzhalter seinen Platz. */}
      {order.flatMap((k) =>
        drag && k === drag.key
          ? [
              <div
                key="__platzhalter"
                className="hm-db-ph"
                aria-hidden="true"
                style={{ gridColumn: wide(k) ? '1 / -1' : undefined, height: drag.h }}
              />,
              cell(k, true),
            ]
          : [cell(k, false)],
      )}
    </div>
  );
}
