import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { Tooltip } from './Tooltip';

const CLOSE_LABEL = 'Hinweis schließen';

interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  message: React.ReactNode;
  /** Gruen hinterlegte Meldung (Hinweise, die man in Ruhe lesen soll). */
  green?: boolean;
  closable?: boolean;
}

export interface ToastOptions {
  /** Anzeigedauer in Millisekunden (Vorgabe 4200). */
  duration?: number;
  green?: boolean;
  /** X zum Schliessen, fuer lange stehende Meldungen. */
  closable?: boolean;
}

const ToastContext = createContext<{
  success: (message: React.ReactNode, options?: ToastOptions) => void;
  error: (message: React.ReactNode, options?: ToastOptions) => void;
}>({ success: () => {}, error: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastItem['kind'], message: React.ReactNode, options?: ToastOptions) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, message, green: options?.green, closable: options?.closable }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), options?.duration ?? 4200);
  }, []);

  const value = {
    success: useCallback((m: React.ReactNode, o?: ToastOptions) => push('success', m, o), [push]),
    error: useCallback((m: React.ReactNode, o?: ToastOptions) => push('error', m, o), [push]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="hm-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`hm-toast hm-toast--${t.kind}${t.green ? ' hm-toast--green' : ''}`}>
            <span className="hm-toast__icon" style={{ display: 'inline-flex' }}>
              {t.kind === 'success' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
            </span>
            {t.message}
            {t.closable && (
              <Tooltip content={<div className="hm-tooltip__title">{CLOSE_LABEL}</div>}>
                <button
                  type="button"
                  className="hm-toast__close"
                  aria-label={CLOSE_LABEL}
                  onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
                >
                  <X size={15} />
                </button>
              </Tooltip>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
