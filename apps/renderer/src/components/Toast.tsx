import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';

interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

const ToastContext = createContext<{
  success: (message: string) => void;
  error: (message: string) => void;
}>({ success: () => {}, error: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastItem['kind'], message: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const value = {
    success: useCallback((m: string) => push('success', m), [push]),
    error: useCallback((m: string) => push('error', m), [push]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="hm-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`hm-toast hm-toast--${t.kind}`}>
            <span className="hm-toast__icon" style={{ display: 'inline-flex' }}>
              {t.kind === 'success' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
            </span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
