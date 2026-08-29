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
 * - `staleTime` von 15 Sekunden auf 500 ms: Praktisch jeder Reiterwechsel holt
 *   damit frische Daten — legt jemand am Nebenplatz eine Person an, steht sie
 *   nach einem Wechsel hin und zurück in der Liste. Die halbe Sekunde bleibt
 *   stehen, damit ein Doppel-Mount (React StrictMode, schnelles Zurückklicken)
 *   nicht zwei identische Abfragen auslöst; das Fenster ist zu kurz, um eine
 *   Änderung merklich zu verzögern.
 *   Die Anzeige flackert dabei nicht: React Query liefert den Cache sofort und
 *   lädt im Hintergrund nach.
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
      staleTime: 500,
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
