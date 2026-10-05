import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Gebrandeter Tooltip — Ersatz für das native `title`-Attribut.
 *
 * WARUM nicht `title`: Der Browser-Tooltip trägt OS-Optik statt oHRganize-Optik,
 * kennt keine Themes, erscheint erst nach ~1 s und lässt sich nicht
 * strukturieren (Titel + Detailzeilen). Für eine Anwendung, die ihre eigene
 * Titelleiste zeichnet, ist das ein Fremdkörper.
 *
 * WARUM ein Portal (wie `Popover.tsx`): `.hm-card` und `.hm-cal__bar` setzen
 * `overflow: hidden`; ein Tooltip als Kindelement würde dort abgeschnitten.
 * Der Inhalt landet deshalb am <body> und wird mit `position: fixed` an der
 * Bildschirmlage des Auslösers ausgerichtet — mittig darüber, bei Platzmangel
 * darunter, horizontal in den Bildschirm zurückgeschoben. Der Pfeil folgt
 * dabei dem Auslöser (CSS-Variable `--hm-tooltip-arrow-x`).
 *
 * Verhalten: kurze Verzögerung beim Öffnen (kein Flackern beim Überstreichen
 * einer Zeile), sofortiges Schließen; Escape, Scrollen und Resize schließen.
 * Öffnet auch bei Tastaturfokus und verknüpft sich per aria-describedby.
 *
 * Inhalt strukturieren: `.hm-tooltip__title` (Was) und `.hm-tooltip__line`
 * (Details); Werte mit „·“ trennen, keine Sätze. Ohne `content` wird das Kind
 * unverändert gerendert — so bleiben bedingte Tooltips im Aufrufer einzeilig.
 */
interface Props {
  content: React.ReactNode;
  /** Genau ein Host-Element (span, div, button, td …), das Ref und Maus-/Fokus-Handler annimmt. */
  children: React.ReactElement;
  /** Bevorzugte Seite; bei Platzmangel wird gewechselt. */
  placement?: 'top' | 'bottom';
  /** Öffnungsverzögerung in ms. */
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
    // Zweite Messung, sobald der Inhalt steht — erst dann sind Breite und
    // Höhe belastbar (Schriften, Umbrüche).
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [open, measure, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    // `capture` erwischt auch scrollende Container zwischen Auslöser und <body>.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  // Ausstehenden Öffnen-Timer beim Unmount verwerfen (Zeilenwechsel im Kalender).
  useEffect(() => cancelTimer, []);

  const empty = content === null || content === undefined || content === false;
  // Ein bereits offener Tooltip darf nicht mit altem Zustand wieder auftauchen,
  // sobald der Aufrufer den Inhalt zurückgibt.
  useEffect(() => {
    if (empty) hide();
  }, [empty, hide]);

  // Stabiler Ref, solange der Ref des Kindes gleich bleibt: Eine neue Funktion
  // je Rendern ließe React den Ref bei jedem Rendern lösen und neu setzen, und
  // ein Kind, das daran einen Beobachter hängt (useSeenOnce bei Avataren),
  // finge jedes Mal von vorn an. Vor dem frühen Return: Hooks immer gleich.
  const childRef = React.isValidElement(children)
    ? (children as React.ReactElement & { ref?: React.Ref<HTMLElement> }).ref
    : undefined;
  const mergedRef = useCallback(
    (node: HTMLElement | null) => {
      anchorRef.current = node;
      if (typeof childRef === 'function') childRef(node);
      else if (childRef && typeof childRef === 'object') {
        (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    },
    [childRef],
  );

  if (empty) return children;

  const child = React.Children.only(children) as React.ReactElement<AnchorProps>;
  const childProps = child.props;

  const anchor = React.cloneElement(child, {
    ref: mergedRef,
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
            className={`hm-tooltip${pos?.below ? ' hm-tooltip--below' : ''}`}
            style={
              {
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                // Vor der ersten Messung unsichtbar, damit nichts an der
                // falschen Stelle aufblitzt.
                visibility: pos ? 'visible' : 'hidden',
                '--hm-tooltip-arrow-x': `${pos?.arrowX ?? 0}px`,
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
