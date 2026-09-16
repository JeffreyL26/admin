import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Gebrandeter Tooltip — Spiegel von `apps/renderer/src/components/Tooltip.tsx`
 * mit `pt-`-Klassen, damit Portal und Desktop-App dieselbe Optik zeigen
 * (Farben über --tooltip-bg/--tooltip-text je Theme).
 *
 * Rendert per Portal an <body> mit `position: fixed` und wird deshalb von
 * keinem `overflow: hidden` (Karten, Kalenderzellen) abgeschnitten. Mittig
 * über dem Auslöser, bei Platzmangel darunter; der Pfeil folgt dem Auslöser.
 * Kurze Öffnungsverzögerung, sofortiges Schließen; Escape, Scrollen und Resize
 * schließen. Öffnet auch bei Tastaturfokus und verknüpft sich per aria-describedby.
 *
 * Inhalt strukturieren: `.pt-tooltip__title` (Was) und `.pt-tooltip__line`
 * (Details); Werte mit „·“ trennen, keine Sätze. Ohne `content` wird das Kind
 * unverändert gerendert.
 */
interface Props {
  content: React.ReactNode;
  /** Genau ein Host-Element (span, div, button, td …), das Ref und Maus-/Fokus-Handler annimmt. */
  children: React.ReactElement;
  placement?: 'top' | 'bottom';
  delay?: number;
}

const GAP = 8;
const RAND = 8;
const ARROW_INSET = 10;

type Pos = { top: number; left: number; arrowX: number; below: boolean };

type AnchorProps = {
  onMouseEnter?: React.MouseEventHandler;
  onMouseLeave?: React.MouseEventHandler;
  onFocus?: React.FocusEventHandler;
  onBlur?: React.FocusEventHandler;
  'aria-describedby'?: string;
};

export function Tooltip({ content, children, placement = 'top', delay = 150 }: Props) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const id = useId();

  const cancelTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const show = () => {
    cancelTimer();
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = useCallback(() => {
    cancelTimer();
    setOpen(false);
  }, []);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const centerX = r.left + r.width / 2;
    const left = Math.max(RAND, Math.min(centerX - w / 2, window.innerWidth - w - RAND));
    const fitsTop = r.top - GAP - h >= RAND;
    const fitsBottom = r.bottom + GAP + h <= window.innerHeight - RAND;
    const below = placement === 'bottom' ? fitsBottom || !fitsTop : !fitsTop && fitsBottom;
    setPos({
      top: below ? r.bottom + GAP : r.top - GAP - h,
      left,
      arrowX: Math.max(ARROW_INSET, Math.min(centerX - left, w - ARROW_INSET)),
      below,
    });
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [open, measure, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  useEffect(() => cancelTimer, []);

  if (content === null || content === undefined || content === false) return children;

  const child = React.Children.only(children) as React.ReactElement<AnchorProps> & {
    ref?: React.Ref<HTMLElement>;
  };
  const childProps = child.props;
  const childRef = child.ref;

  const anchor = React.cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      if (typeof childRef === 'function') childRef(node);
      else if (childRef && typeof childRef === 'object') {
        (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    },
    onMouseEnter: (e: React.MouseEvent) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      childProps.onFocus?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      hide();
    },
    'aria-describedby': open ? id : childProps['aria-describedby'],
  } as AnchorProps & { ref: React.Ref<HTMLElement> });

  return (
    <>
      {anchor}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={`pt-tooltip${pos?.below ? ' pt-tooltip--below' : ''}`}
            style={
              {
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                visibility: pos ? 'visible' : 'hidden',
                '--pt-tooltip-arrow-x': `${pos?.arrowX ?? 0}px`,
              } as React.CSSProperties
            }
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
