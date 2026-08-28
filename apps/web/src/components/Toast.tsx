import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error';
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ success: () => {}, error: () => {} });

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, kind: Toast['kind']) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const apiRef = useRef<ToastApi>({
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
  });

  return (
    <ToastContext.Provider value={apiRef.current}>
      {children}
      <div className="pt-toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`pt-toast${t.kind === 'error' ? ' pt-toast--error' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
