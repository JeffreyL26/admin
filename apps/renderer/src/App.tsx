import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import { LoginPage } from './features/auth/LoginPage';
import { PasswordChangePage } from './features/auth/PasswordChangePage';
import { Spinner } from './components/ui';
import { TitleBar } from './layout/TitleBar';
import { router } from './router';

/**
 * Aktualisierungsverhalten im Mehrplatzbetrieb.
 *
 * Solange die App allein auf einem Rechner lief, war ein träger Cache richtig:
 * Änderungen kamen nur vom eigenen Fenster und wurden nach jeder Mutation
 * gezielt invalidiert. Mit mehreren Arbeitsplätzen am selben Backend ändern
 * andere die Daten, ohne dass dieses Fenster etwas davon mitbekommt.
 *
 * - `refetchOnWindowFocus`: Wer zwischen Programmen wechselt und zurückkommt,
 *   sieht den aktuellen Stand. Das ist der häufigste Moment, in dem jemand
 *   Neues erwartet.
 * - `refetchOnReconnect`: Nach einem Netz- oder Serverausfall wird nicht
 *   stillschweigend mit veralteten Daten weitergearbeitet.
 * - `staleTime` von 15 auf 5 Sekunden: kurz genug, dass ein Reiterwechsel
 *   frische Daten bringt, lang genug, dass schnelles Hin- und Herklicken nicht
 *   jedes Mal eine Abfrage auslöst.
 *
 * Bewusst KEIN Dauer-Polling: Das erzeugte Last auch dann, wenn niemand
 * hinsieht. Wer eine Seite offen stehen lässt, bekommt den neuen Stand beim
 * nächsten Fokus oder Seitenwechsel.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 5_000,
    },
  },
});

function Gate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!user) return <LoginPage />;
  // Spiegelt die Sperre im Backend-Hook (server.ts): Bei erzwungenem
  // Passwortwechsel beantwortet der Server jede Fachroute mit 403. Ohne
  // diesen Schirm liefe die reguläre Oberfläche in lauter Fehler, ohne dass
  // die Seite erreichbar wäre, auf der man das Passwort setzt.
  if (user.must_change_password === 1) return <PasswordChangePage />;
  return <RouterProvider router={router} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <div className="app-root">
            <TitleBar />
            <div className="app-body">
              <Gate />
            </div>
          </div>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
