import React, { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryCache, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { LICENSE_ERROR_CODES } from '@ohrganize/shared';
import { ApiRequestError } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ToastProvider, useToast } from './components/Toast';
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
/**
 * Sicherheitsnetz für fehlgeschlagene Abfragen: Die Seiten rendern keinen
 * eigenen Fehlerzustand — ohne zentrale Meldung sähe ein Backend-Fehler exakt
 * aus wie „keine Daten“ oder ein endlos drehender Spinner. Der QueryCache lebt
 * außerhalb des React-Baums und kann keine Hooks benutzen; deshalb reicht die
 * Brücke unten die Toast-Funktion in diese Modul-Variable durch.
 */
let notifyQueryError: ((message: string) => void) | null = null;

/**
 * Ein Fokus-Refetch lässt bei Serverproblemen alle sichtbaren Abfragen
 * gleichzeitig scheitern — ohne Deduplizierung stapelte sich derselbe Toast
 * mehrfach übereinander.
 */
const recentQueryErrors = new Map<string, number>();
const QUERY_ERROR_DEDUPE_MS = 5000;

function reportQueryError(error: unknown, query: { meta?: Record<string, unknown> }): void {
  // Gezieltes Opt-out einzelner Abfragen: Wer sein Scheitern selbst behandelt
  // (etwa ein optionales Foto), setzt meta.silentError und bleibt toastfrei.
  if (query.meta?.silentError === true) return;
  // 401 mündet über den Unauthorized-Handler des API-Clients ohnehin im
  // Logout — ein zusätzlicher Toast würde nur vom Login-Schirm ablenken.
  if (error instanceof ApiRequestError && error.status === 401) return;
  // 403 ebenfalls nicht melden: Das Rollenmodell blendet gesperrte Bereiche in
  // Navigation und Palette bereits aus; was an 403 übrig bleibt, sind
  // Querbezüge in eigentlich erlaubte Seiten hinein (Kalender-Filter, Fotos),
  // die bewusst still degradieren. Ein Toast machte aus jedem Seitenbesuch
  // eine Dauermeldung über Rechte, die der Admin absichtlich so vergeben hat.
  // Ausnahme: Eine Funktion, die der Build enthaelt, die Lizenz aber nicht
  // freischaltet (LICENSE_FEATURE_MISSING). Das ist keine Rechtefrage der
  // Administration, sondern eine Vertragsfrage; der Hinweis muss sichtbar sein.
  if (error instanceof ApiRequestError && error.status === 403 && error.code !== LICENSE_ERROR_CODES.FEATURE_MISSING) return;
  const message =
    error instanceof ApiRequestError
      ? `Daten konnten nicht geladen werden: ${error.message}`
      : 'Daten konnten nicht geladen werden: Server nicht erreichbar.';
  const now = Date.now();
  // Die Karte lebt für die gesamte Sitzung — abgelaufene Einträge beim
  // Einfügen mit ausräumen, sonst sammelte sich jede je gesehene Meldung
  // dauerhaft an.
  for (const [key, ts] of recentQueryErrors) {
    if (now - ts >= QUERY_ERROR_DEDUPE_MS) recentQueryErrors.delete(key);
  }
  if (recentQueryErrors.has(message)) return;
  recentQueryErrors.set(message, now);
  notifyQueryError?.(message);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportQueryError }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 500,
    },
  },
});

/** Setzt die Toast-Funktion für den QueryCache — siehe notifyQueryError. */
function QueryErrorBridge() {
  const toast = useToast();
  useEffect(() => {
    notifyQueryError = toast.error;
    return () => {
      notifyQueryError = null;
    };
  }, [toast.error]);
  return null;
}

/**
 * Rückkehr ins Fenster per Alt+Tab oder Klick: React Query (v5) hört von sich aus nur auf
 * `visibilitychange`. Das feuert, wenn ein Fenster verdeckt oder minimiert war, nicht beim Wechsel
 * zu einem Fenster, das die ganze Zeit sichtbar blieb (zweiter Bildschirm, nebeneinander). Gemeint
 * ist mit `refetchOnWindowFocus` aber genau dieser Moment. Der Fensterfokus löst deshalb zusätzlich
 * dasselbe aus wie ein Sichtbarwerden (`QueryCache.onFocus`: jede Abfrage nach ihren eigenen Regeln,
 * also `refetchOnWindowFocus` und `staleTime`), ohne den Fokuszustand anzufassen, an dem
 * `refetchInterval` hängt (sonst pausierte das Nachladen in einem sichtbaren, unfokussierten Fenster).
 * Das Portal (apps/web/src/App.tsx) hat dieselbe Komponente; beide zusammen ändern.
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
      <RefetchOnWindowFocus />
      <AuthProvider>
        <ToastProvider>
          <QueryErrorBridge />
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
