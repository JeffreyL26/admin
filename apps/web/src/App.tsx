import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import { PortalShell } from './layout/PortalShell';
import { LoginPage } from './pages/LoginPage';
import { PasswordChangePage } from './pages/PasswordChangePage';
import { portalRoutes } from '@variant';
import { OverviewPage } from './pages/OverviewPage';
import { StammdatenPage } from './pages/StammdatenPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { OrgPage } from './pages/OrgPage';
import { ProfilePage } from './pages/ProfilePage';

/**
 * Gleiches Aktualisierungsverhalten wie die Desktop-App (siehe dort für die
 * ausführliche Begründung): Beim Zurückkehren ins Fenster und nach einem
 * Verbindungsabriss wird neu geladen, der Cache gilt nur eine halbe Sekunde.
 * Im Portal zählt das besonders für Anträge — über deren Genehmigung
 * entscheidet jemand anderes, und zwar in einer anderen Anwendung.
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

/**
 * Nachladen auch bei Rückkehr per Alt+Tab, nicht nur nach Verdecken oder Minimieren. Gleich wie in
 * der Desktop-App, Begründung dort (apps/renderer/src/App.tsx, RefetchOnWindowFocus); beide Kopien
 * zusammen ändern.
 */
function RefetchOnWindowFocus() {
  const client = useQueryClient();
  useEffect(() => {
    const onFocus = () => client.getQueryCache().onFocus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [client]);
  return null;
}

/**
 * Platzhalter-Shell, bis die Sitzung wiederhergestellt ist. Sie zeichnet die
 * Seitenleiste als Fläche vor, damit beim Laden nichts springt.
 */
function SessionSkeleton() {
  return (
    <div className="portal-shell">
      <div
        aria-hidden="true"
        style={{
          width: 'var(--sidebar-width)',
          flex: 'none',
          height: '100dvh',
          background: 'var(--bg-sidebar)',
        }}
      />
      <div className="portal-content">
        <div className="portal-main">
          <span className="pt-skeleton" style={{ width: 260, height: 30, display: 'block' }} />
          <span
            className="pt-skeleton"
            style={{ width: '100%', height: 180, display: 'block', marginTop: 28 }}
          />
        </div>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <SessionSkeleton />;
  if (!user) return <Navigate to="/anmelden" replace state={{ from: location.pathname }} />;
  // Spiegelt die Sperre im Backend-Hook (server.ts): Bei erzwungenem
  // Passwortwechsel beantwortet der Server jede /api/me-Route mit 403. Ohne
  // diesen Schirm bliebe das Portal leer, ohne dass irgendwo das Passwort
  // gesetzt werden könnte.
  if (user.must_change_password === 1) return <PasswordChangePage />;
  return <>{children}</>;
}

// BrowserRouter (kein Hash): Das Portal wird über HTTP ausgeliefert; der
// Webserver braucht einen SPA-Fallback auf index.html (docs/web-portal.md).
const router = createBrowserRouter([
  { path: '/anmelden', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <PortalShell />
      </RequireAuth>
    ),
    // Basisseiten jeder Variante; die Seiten optionaler Module (Antraege,
    // Krankmeldung, Kalender, Gehalt) kommen aus @variant (src/variants/<id>.tsx,
    // erzeugt aus dem Variantenregister). Reihenfolge der Seitenleiste:
    // layout/PortalShell.tsx.
    children: [
      { path: '/', element: <OverviewPage /> },
      ...portalRoutes,
      { path: '/stammdaten', element: <StammdatenPage /> },
      { path: '/dokumente', element: <DocumentsPage /> },
      { path: '/organigramm', element: <OrgPage /> },
      { path: '/profil', element: <ProfilePage /> },
      // Fängt alles Unbekannte ab und muss deshalb der letzte Eintrag bleiben.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RefetchOnWindowFocus />
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
