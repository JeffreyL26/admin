import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="hm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`hm-modal${wide ? ' hm-modal--wide' : ''}`} role="dialog" aria-modal="true">
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
