import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Ausklappbares Panel, das an einem Auslöser hängt.
 *
 * WARUM ein Portal und nicht einfach `position: absolute` im Elternelement:
 * `.hm-card` setzt `overflow: hidden` (nötig, damit Tabellen die abgerundeten
 * Kartenecken nicht überzeichnen). Ein absolut positioniertes Panel innerhalb
 * einer Karte wird davon abgeschnitten — bei den Filtern der Mitarbeiterliste
 * war es teilweise, beim Spalten-Panel vollständig unsichtbar. Das Panel steht
 * dann im DOM, ist aber nicht zu sehen: ein Fehlerbild, das eine reine
 * DOM-Prüfung nicht findet.
 *
 * Deshalb landet der Inhalt per Portal am <body> und wird mit `position: fixed`
 * an der Bildschirmposition des Auslösers ausgerichtet. Damit ist er von keinem
 * `overflow` eines Vorfahren mehr betroffen.
 *
 * Geschlossen wird über Klick daneben und Escape — bewusst OHNE unsichtbare
 * Klickfänger-Fläche über dem Bildschirm: Eine solche Fläche schluckt auch das
 * Scrollen, was sich anfühlt, als hinge die Anwendung.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  /** Element, an dem das Panel ausgerichtet wird. */
  anchorRef: React.RefObject<HTMLElement>;
  /** Rechtsbündig ausrichten (für Panels am rechten Rand). */
  align?: 'left' | 'right';
  /** Mindestbreite; ohne Angabe so breit wie der Auslöser. */
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
}

const GAP = 4;
const RAND = 8;

export function Popover({
  open,
  onClose,
  anchorRef,
  align = 'left',
  minWidth,
  maxWidth = 320,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(
    null,
  );

  // Position aus der Bildschirmlage des Auslösers berechnen. Reicht der Platz
  // darunter nicht, klappt das Panel nach oben — sonst stünde es bei einer
  // Zeile am unteren Bildschirmrand außerhalb des Sichtbereichs.
  const messen = React.useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const hoehe = panelRef.current?.offsetHeight ?? 0;
    const platzUnten = window.innerHeight - r.bottom - GAP - RAND;
    const platzOben = r.top - GAP - RAND;
    const nachOben = hoehe > platzUnten && platzOben > platzUnten;

    const breite = Math.min(Math.max(minWidth ?? r.width, r.width), maxWidth);
    let left = align === 'right' ? r.right - breite : r.left;
    // In den Bildschirm zurückschieben, statt am Rand abzuschneiden.
    left = Math.max(RAND, Math.min(left, window.innerWidth - breite - RAND));

    setPos({
      top: nachOben ? Math.max(RAND, r.top - GAP - hoehe) : r.bottom + GAP,
      left,
      width: breite,
      maxHeight: Math.max(120, nachOben ? platzOben : platzUnten),
    });
  }, [align, anchorRef, maxWidth, minWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    messen();
    // Zweite Messung, sobald der Inhalt steht: Erst dann ist die Höhe bekannt
    // und die Entscheidung "nach oben klappen" belastbar.
    const id = requestAnimationFrame(messen);
    return () => cancelAnimationFrame(id);
  }, [open, messen, children]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Beim Scrollen mitwandern statt stehen zu bleiben. `capture` erwischt auch
    // scrollende Container zwischen Auslöser und <body>.
    const onScroll = () => messen();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, onClose, anchorRef, messen]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="hm-popover"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: pos?.width,
        maxHeight: pos?.maxHeight,
        // Vor der ersten Messung unsichtbar, damit es nicht kurz an der
        // falschen Stelle aufblitzt.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
