import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Hourglass } from 'lucide-react';
import type { DashboardNotice } from '@ohrganize/shared';

/**
 * Bereichsleiste als horizontale Scroll-Leiste.
 *
 * Immer eine Reihe. Passen die Zellen nicht in die Breite (mehr Bereiche,
 * schmales Fenster), scrollt die Leiste seitlich: Einrasten je Zelle, weiche
 * Kanten und Pfeilknoepfe nur in die Richtung, in der noch etwas kommt. Die
 * gewaehlte Zelle wird in den sichtbaren Bereich geholt. Neue Bereiche
 * brauchen nur einen weiteren Eintrag in `cells`, keine Layout-Aenderung.
 */

// ---------------------------------------------------------------------------
// Benachrichtigungs-Quadrat (Leiste und Widgets)
// ---------------------------------------------------------------------------

/**
 * Wie eine App-Benachrichtigung. Rangfolge (dashboardNotice in shared):
 * offene Punkte (rot, mit Zahl) schlagen Laufendes (grau, Sanduhr: wartet auf
 * andere, etwa Bestaetigungen oder Onboarding-Aufgaben). Ohne beides nichts.
 */
export type Notice = DashboardNotice;

export function NotificationBadge({ notice, className }: { notice: Notice | null; className?: string }) {
  if (!notice) return null;
  if (notice.count > 0) {
    return (
      <span className={`hm-db-badge hm-db-badge--count${className ? ` ${className}` : ''}`}>
        <span aria-hidden="true">{notice.count > 99 ? '99+' : notice.count}</span>
        <span className="hm-db-sr">{notice.count} offen</span>
      </span>
    );
  }
  if (notice.waiting) {
    return (
      <span className={`hm-db-badge hm-db-badge--wait${className ? ` ${className}` : ''}`}>
        <Hourglass size={13} strokeWidth={2.4} aria-hidden="true" />
        <span className="hm-db-sr">läuft, wartet auf andere</span>
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leiste
// ---------------------------------------------------------------------------

export interface AreaBandCell {
  key: string;
  label: string;
  value: number;
  valueLabel: string;
  /** Ergaenzung unter der Beschriftung, etwa „+1 laut Antrag“. */
  extra?: string;
  notice: Notice | null;
  /** Akzentfarbe (CSS-Wert) fuer Punkt und Auswahl. */
  color?: string;
}

interface Props {
  cells: AreaBandCell[];
  selected: string;
  onSelect: (key: string) => void;
  ariaLabel: string;
}

export function AreaBand({ cells, selected, onSelect, ariaLabel }: Props) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft < max - 2;
    // Nur bei Aenderung setzen: measure laeuft nach jedem Rendern.
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Nach jedem Rendern: Zahlen und Ergaenzungen koennen die Breite der Zellen
  // aendern, ohne dass sich die Leiste selbst in der Groesse aendert.
  useLayoutEffect(measure);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure]);

  // Gewaehlte Zelle sichtbar halten, nur waagrecht (scrollIntoView rollte auch die Seite).
  useEffect(() => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`[data-cell="${selected}"]`);
    if (!sc || !el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < sc.scrollLeft) sc.scrollTo({ left, behavior: 'smooth' });
    else if (right > sc.scrollLeft + sc.clientWidth) sc.scrollTo({ left: right - sc.clientWidth, behavior: 'smooth' });
  }, [selected]);

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <div className={`hm-db-bandscroll${edges.start ? ' is-start' : ''}${edges.end ? ' is-end' : ''}`}>
      {edges.start && (
        <button className="hm-db-bandscroll__nav hm-db-bandscroll__nav--prev" aria-label="Weitere Bereiche links" onClick={() => page(-1)}>
          <ChevronLeft size={18} strokeWidth={2.4} />
        </button>
      )}
      <div ref={scroller} className="hm-db-band" role="group" aria-label={ariaLabel}>
        {cells.map((c) => (
          <button
            key={c.key}
            data-cell={c.key}
            className="hm-db-band__cell"
            aria-pressed={selected === c.key}
            onClick={() => onSelect(c.key)}
            style={c.color ? ({ '--hm-db-c': c.color } as React.CSSProperties) : undefined}
          >
            <span className="hm-db-band__label">
              {c.color && <i className="hm-db-band__dot" />}
              {c.label}
            </span>
            <NotificationBadge notice={c.notice} className="hm-db-badge--corner" />
            <span className="hm-db-band__main">
              <span className="hm-db-band__num">{c.value}</span>
              <span className="hm-db-band__caption">
                {c.valueLabel}
                {c.extra && <em>{c.extra}</em>}
              </span>
            </span>
          </button>
        ))}
      </div>
      {edges.end && (
        <button className="hm-db-bandscroll__nav hm-db-bandscroll__nav--next" aria-label="Weitere Bereiche rechts" onClick={() => page(1)}>
          <ChevronRight size={18} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}
