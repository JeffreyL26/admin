import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Modul-lokaler Stapel offener Dialog-Schichten. Jede Instanz legt beim Öffnen
 * ein eigenes Token oben auf und reagiert auf Tastatur nur, solange ihr Token
 * das letzte ist — sonst schlösse ein einziges Escape ein Editor-Modal samt
 * darüberliegendem ConfirmDialog auf einen Schlag, und zwei Fokus-Traps
 * kämpften gegeneinander.
 *
 * Bewusst ein Stapel statt eines Zählers: Ein Zähler desynchronisierte, sobald
 * eine UNTERE Schicht zuerst schloss (ihr Cleanup dekrementierte, die gemerkte
 * Tiefe der oberen Instanz blieb stehen — Escape und Fokus-Trap dort waren
 * fortan tot). Das Token wird beim Schließen an beliebiger Position entfernt;
 * „oberste Schicht“ ist schlicht das letzte Element.
 */
const openLayers: symbol[] = [];

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  wide,
}: {
  title: React.ReactNode;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Identifiziert diese Instanz im Schichten-Stapel; stabil über Renders,
  // damit Öffnen- und Tastatur-Effekt vom selben Token sprechen.
  const layerTokenRef = useRef(Symbol('modal-layer'));

  // Fokus-Verwaltung getrennt vom Tastatur-Effekt: onClose ist bei den
  // Aufrufern meist eine Inline-Funktion und würde diesen Effekt sonst bei
  // jedem Render neu ausführen — der Dialog stähle dem gerade benutzten
  // Eingabefeld nach jedem Tastendruck den Fokus.
  useEffect(() => {
    if (!open) return;
    const token = layerTokenRef.current;
    openLayers.push(token);
    // aria-modal allein hält den Fokus nicht im Dialog: Ohne initialen Fokus
    // bliebe er auf dem Auslöser hinter dem Overlay, und Tab wanderte durch
    // die verdeckte Seite (Enter aktivierte dort unsichtbare Links).
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      // Gezielt das eigene Token entfernen — nicht das oberste: Schließt eine
      // untere Schicht zuerst, steckt ihr Token mitten im Stapel.
      const index = openLayers.indexOf(token);
      if (index !== -1) openLayers.splice(index, 1);
      previous?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (openLayers[openLayers.length - 1] !== layerTokenRef.current) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Leichtgewichtiger Fokus-Trap: Tab zirkuliert innerhalb des Dialogs.
      // getClientRects filtert unsichtbare Ziele (display:none in eingeklappten
      // Bereichen) heraus, die sonst den Fokus scheinbar verschluckten.
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && dialog.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="hm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`hm-modal${wide ? ' hm-modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={{ outline: 'none' }}
      >
        <div className="hm-modal__header">
          <div className="hm-modal__title">{title}</div>
          <button className="hm-btn hm-btn--ghost hm-btn--icon" onClick={onClose} aria-label="Schließen">
            <X size={18} />
          </button>
        </div>
        <div className="hm-modal__body">{children}</div>
        {footer && <div className="hm-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Löschen',
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className={`hm-btn ${danger ? 'hm-btn--danger' : 'hm-btn--primary'}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-secondary)' }}>{message}</p>
    </Modal>
  );
}
