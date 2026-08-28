import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import { PortalShell } from './layout/PortalShell';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { RequestsPage } from './pages/RequestsPage';
import { NewRequestPage } from './pages/NewRequestPage';
import { SickNotePage } from './pages/SickNotePage';
import { ProfilePage } from './pages/ProfilePage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

/** Platzhalter-Shell, bis die Sitzung wiederhergestellt ist. */
function SessionSkeleton() {
  return (
    <div>
      <div style={{ height: 'var(--header-height)', background: 'var(--brand-navy-deep)' }} />
      <div className="portal-main">
        <span className="pt-skeleton" style={{ width: 260, height: 30, display: 'block' }} />
        <span className="pt-skeleton" style={{ width: '100%', height: 180, display: 'block', marginTop: 28 }} />
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <SessionSkeleton />;
  if (!user) return <Navigate to="/anmelden" replace state={{ from: location.pathname }} />;
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
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/antraege', element: <RequestsPage /> },
      { path: '/antraege/neu', element: <NewRequestPage /> },
      { path: '/krankmeldung', element: <SickNotePage /> },
      { path: '/profil', element: <ProfilePage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
