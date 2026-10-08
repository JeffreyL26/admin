import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  areaOpen,
  checkIntervalMs,
  desktopSessionAction,
  DESKTOP_REFRESH_CHECK_MS,
  FULL_ACCESS,
  hasFeature,
  sameRecordExcept,
  sessionEndReached,
  sessionEndsAt as endsAtFrom,
  sessionEndWarningMs,
  SESSION_END_NOTICE,
  type AdminArea,
  type AdminPermissions,
  type LicenseStatus,
} from '@ohrganize/shared';
import {
  api,
  hasToken,
  refreshToken,
  setLicenseStateHandler,
  setToken,
  setUnauthorizedHandler,
  tokenLifetime,
  tokenState,
} from '../api/client';
import { VARIANT } from '@variant-manifest';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  employee_id: number | null;
  /** `null` heißt Vollzugriff, nicht „keine Rechte“ (siehe Migration 002). */
  admin_role_id: number | null;
  /**
   * 0/1 (SQLite kennt kein Boolean). Solange 1, beantwortet das Backend jede
   * Route außer `/api/auth/me` und `/api/auth/password` mit 403
   * `PASSWORD_CHANGE_REQUIRED`. Die Oberfläche muss dann den
   * Passwort-setzen-Schirm zeigen (App.tsx) — ohne das säße man nach der
   * Erstinbetriebnahme vor lauter Fehlermeldungen fest.
   */
  must_change_password?: number;
}

/**
 * Die Desktop-App ist der HR-Administration vorbehalten; Mitarbeitenden-
 * Accounts (role 'mitarbeiter') gehören ins Web-Portal. Das Backend erzwingt
 * das ohnehin (403 auf allen Admin-Routen) — hier gibt es nur die passende
 * Meldung statt kryptischer Fehler.
 */
const ADMIN_ONLY_MESSAGE =
  'Dieser Zugang ist der HR-Administration vorbehalten. Bitte melden Sie sich im oHRganize Mitarbeitenden-Portal an.';

/** Antwort von Login und /api/auth/me — `license` fehlt bei älteren Backends. */
interface MeResponse {
  user: AuthUser;
  permissions?: AdminPermissions;
  license?: LicenseStatus;
}

interface AuthState {
  user: AuthUser | null;
  /**
   * Lizenzzustand des Backends, wie ihn Login und /api/auth/me mitliefern
   * (packages/shared/src/license.ts). Für Admin-Konten die volle Fassung;
   * `null`, solange niemand angemeldet ist oder das Backend das Feld nicht
   * kennt. Reine Anzeige (Banner, Einstellungen → Lizenz, Dashboard-Widget) —
   * durchgesetzt wird der Nur-Lese-Betrieb im Backend (403 LICENSE_EXPIRED).
   */
  license: LicenseStatus | null;
  /**
   * Lizenzzustand neu laden (nach dem Einspielen einer Lizenzdatei, bei einem
   * Signal aus dem API-Client). Holt /api/auth/me und übernimmt nur `license`.
   */
  refreshLicense: () => Promise<void>;
  /**
   * Rechte des angemeldeten Kontos. REINE ANZEIGEHILFE — sie steuern, welche
   * Menüpunkte und Knöpfe erscheinen. Die Durchsetzung passiert ausschließlich
   * im Backend-Hook (core/permissions.ts); wer hier etwas umgeht, bekommt dort
   * ein 403.
   */
  permissions: AdminPermissions;
  /**
   * Kurzform für Sichtbarkeitsprüfungen in der Oberfläche. Ein Bereich, dessen
   * Modul die Variante nicht enthält, ist für niemanden offen (auch nicht bei
   * Vollzugriff): Seitenleiste, Kürzel, Palette und Einführungen fragen alle
   * hier und führen so nie auf Seiten, die es im Build nicht gibt.
   */
  can: (area: AdminArea, needed?: 'lesen' | 'bearbeiten') => boolean;
  /**
   * Freigeschaltete Feature-Schluessel der Lizenz (null = alles an). Reine
   * Anzeigehilfe wie `can`; durchgesetzt wird es im Backend
   * (core/featureGate.ts, 403 LICENSE_FEATURE_MISSING).
   */
  features: string[] | null;
  hasFeature: (key: string) => boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /**
   * Passwort setzen. MUSS über den Kontext laufen und nicht direkt über
   * `api.put('/api/auth/password')`: Der Wechsel entwertet serverseitig alle
   * älteren Tokens (users.sessions_valid_from). Wer das zurückgelieferte
   * frische Token nicht übernimmt, fliegt beim nächsten Request mit 401
   * heraus — genau das passierte vor dieser Änderung.
   */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
  /** Hinweis für die Anmeldeseite (Ende der Sitzung nach ihrer Höchstdauer), sonst null. */
  notice: string | null;
  /**
   * Ende der Sitzung (ms), sobald es in die Vorwarnung fällt (zehn Minuten
   * vorher, layout/SessionEndBanner.tsx); sonst null.
   */
  sessionEndsAt: number | null;
}

const AuthContext = createContext<AuthState>({
  user: null,
  license: null,
  refreshLicense: async () => {},
  permissions: FULL_ACCESS,
  // Wie im Provider: Vollzugriff, aber nur fuer Bereiche, deren Modul die Variante enthaelt.
  can: (area) => areaOpen(VARIANT, area, 'bearbeiten'),
  features: null,
  hasFeature: () => true,
  loading: true,
  login: async () => {},
  changePassword: async () => {},
  logout: () => {},
  notice: null,
  sessionEndsAt: null,
});

export const useAuth = () => useContext(AuthContext);

/**
 * Query der eigenen Identitaet (/api/auth/me). Der Auth-Kontext gleicht Konto, Rechte und Lizenz
 * darueber ab; wer die eigene Rolle aendern kann (Rollenverwaltung), invalidiert ihn danach.
 */
export const AUTH_ME_KEY = ['auth', 'me'] as const;

/** Gleicher Inhalt? Fuer den Abgleich bei jedem Fokus: Unveraendertes behaelt seine Identitaet. */
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Gleiches Konto? Login und /api/auth/me liefern `user` unterschiedlich: /me zusaetzlich mit den
 * Token-Angaben (iat, session, auth_time, exp), die sich bei jeder Verlaengerung aendern. Verglichen
 * wird alles ausser diesen, in fester Reihenfolge; ein neues Kontofeld zaehlt damit von selbst mit.
 */
// Gleich halten mit dem, was der globale Hook an req.user haengt (apps/backend/src/server.ts,
// `req.user = { ...account, iat, session, auth_time }`); ein neuer Claim dort gehoert hierher.
const TOKEN_CLAIMS = new Set(['iat', 'session', 'auth_time', 'exp']);
const sameUser = (a: AuthUser, b: AuthUser) =>
  sameRecordExcept(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>, TOKEN_CLAIMS);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<AdminPermissions>(FULL_ACCESS);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionEndsAt, setSessionEndsAt] = useState<number | null>(null);
  const queryClient = useQueryClient();
  // Für den Signal-Handler des API-Clients: Der läuft außerhalb des Renderings
  // und soll den jeweils aktuellen Zustand sehen, nicht den beim Registrieren.
  const licenseRef = useRef<LicenseStatus | null>(null);
  licenseRef.current = license;

  /**
   * Identität, Rechte und Lizenz aus einer Login-/me-Antwort übernehmen. Unverändertes wird nicht
   * neu gesetzt: Der Abgleich läuft bei jedem Fokus, und neue Objekte ließen jede abhängige
   * Ansicht neu rechnen.
   */
  const applyMe = useCallback((res: MeResponse) => {
    setUser((prev) => (prev !== null && sameUser(prev, res.user) ? prev : res.user));
    const nextPermissions = res.permissions ?? FULL_ACCESS;
    setPermissions((prev) => (sameJson(prev, nextPermissions) ? prev : nextPermissions));
    const nextLicense = res.license ?? null;
    setLicense((prev) => (sameJson(prev, nextLicense) ? prev : nextLicense));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setPermissions(FULL_ACCESS);
    setLicense(null);
    setSessionEndsAt(null);
    // Gecachte Personaldaten dürfen einen Kontowechsel am selben Gerät nicht
    // überleben — mit den abgestuften Admin-Rollen sähe das nächste Konto sonst
    // minutenlang Daten aus Bereichen, die ihm gar nicht zustehen.
    queryClient.clear();
  }, [queryClient]);

  /**
   * Startwert des Abgleichs (unten) aus einer Antwort, die schon vorliegt, damit er nicht gleich
   * ein zweites Mal fragt. Ein Abruf, der noch unterwegs ist, wird vorher verworfen: Er kann mit
   * dem alten Token und dem alten Stand gestartet sein (etwa vor einem Passwortwechsel) und würde
   * den frischen Stand sonst beim Eintreffen überschreiben.
   */
  const seedMe = useCallback(
    async (me: MeResponse) => {
      await queryClient.cancelQueries({ queryKey: AUTH_ME_KEY });
      queryClient.setQueryData(AUTH_ME_KEY, me);
    },
    [queryClient],
  );

  /**
   * Sitzung von außen beendet (401) oder an ihrer Höchstdauer angekommen. War
   * es das Ende der Sitzung, mit Hinweis; ein 401 aus anderem Grund (etwa
   * Passwortwechsel auf einem anderen Gerät) meldet ohne Hinweis ab.
   */
  const endSession = useCallback(() => {
    const ended = sessionEndReached(tokenState());
    logout();
    if (ended) setNotice(SESSION_END_NOTICE);
  }, [logout]);

  // Lizenz nachladen heißt: den Abgleich unten neu fragen; er übernimmt Konto, Rechte und Lizenz
  // in einem Weg. Fehler bleiben still (meta.silentError), ein 401 landet im Unauthorized-Handler.
  const refreshLicense = useCallback(async () => {
    if (!hasToken()) return;
    await queryClient.refetchQueries({ queryKey: AUTH_ME_KEY });
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(endSession);
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    api
      .get<MeResponse>('/api/auth/me')
      .then((res) => {
        if (res.user.role !== 'admin') {
          // Konto ist inzwischen ein Portal-Konto: derselbe Hinweis wie bei Anmeldung und Abgleich.
          setToken(null);
          setNotice(ADMIN_ONLY_MESSAGE);
        } else {
          applyMe(res);
          void seedMe(res);
        }
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [endSession, applyMe, seedMe]);

  // Abgleich während der Sitzung (Prinzip 3 in CLAUDE.md): Ändert jemand die eigene Rolle, deren
  // Rechte oder die Zuweisung, ziehen Seitenleiste, Kürzel und jedes `can` nach, ohne Neustart:
  // bei Rückkehr ins Fenster (App.tsx, RefetchOnWindowFocus), Neuverbindung und Menüwechsel
  // (AppShell). Kein Polling. Das Backend liest das Konto bei jeder Anfrage frisch (server.ts),
  // /api/auth/me ist also immer aktuell. Wird das Konto zum Portal-Konto, endet die Sitzung mit
  // demselben Hinweis wie bei der Anmeldung.
  const signedIn = user !== null;
  const { data: freshMe } = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: () => api.get<MeResponse>('/api/auth/me'),
    enabled: signedIn,
    // Ein 401 beendet die Sitzung über den Unauthorized-Handler; alles andere lässt den Stand stehen.
    meta: { silentError: true },
  });
  useEffect(() => {
    if (!freshMe || !hasToken()) return;
    if (freshMe.user.role !== 'admin') {
      logout();
      setNotice(ADMIN_ONLY_MESSAGE);
      return;
    }
    applyMe(freshMe);
  }, [freshMe, applyMe, logout]);

  // Zustandswechsel mitten in der Sitzung (Header oder 403 LICENSE_EXPIRED,
  // siehe api/client.ts): nur nachladen, wenn sich wirklich etwas geändert
  // hat — die Antwort auf das Nachladen trägt denselben Header und bliebe
  // damit still.
  useEffect(() => {
    setLicenseStateHandler((state) => {
      // Beim Kaltstart trägt schon die Antwort auf das erste /api/auth/me den
      // Header, und der Client liest ihn VOR dem Body: Der Handler feuert
      // also, bevor applyMe den Zustand aus derselben Antwort übernommen hat.
      // Solange noch kein Zustand vorliegt, kommt er aus genau dieser Antwort
      // — ein zweites /api/auth/me wäre reine Doppelarbeit.
      if (!hasToken() || licenseRef.current === null || licenseRef.current.state === state) return;
      // Kam das Signal aus der Antwort des Abgleichs selbst (der Client liest den Header vor dem
      // Body), bringt genau diese Antwort den neuen Stand: laufenden Abruf mitnutzen, nicht abbrechen.
      void queryClient.refetchQueries({ queryKey: AUTH_ME_KEY }, { cancelRefetch: false });
    });
    return () => setLicenseStateHandler(null);
  }, [queryClient]);

  // Solange angemeldet: Token verlängern, sobald es zehn Minuten alt ist, bei
  // kurzer Laufzeit (OHRGANIZE_DESKTOP_TOKEN_TTL) spätestens nach der halben
  // (Regeln in packages/shared/src/session.ts). Geprüft wird jede Minute und
  // zusätzlich sofort, wenn das Fenster wieder sichtbar wird, den Fokus
  // bekommt oder das Netz zurückkommt: Im Hintergrund und im Ruhezustand
  // drosselt Chromium die Timer oder hält sie an, nach dem Aufwachen soll die
  // Verlängerung nicht auf den nächsten Takt warten. Angemeldet bleibt man so
  // bis zum Schließen der App oder zum Logout, höchstens bis zum Ende der
  // Sitzung (OHRGANIZE_DESKTOP_SESSION_MAX, Vorgabe fünf Tage): Reicht das Token
  // bis dorthin, wird nicht mehr verlängert, und nach seinem Ablauf meldet die
  // App mit Hinweis ab. Nicht bei erzwungenem
  // Passwortwechsel (das Backend lehnt dort jede Verlängerung mit 403 ab; der
  // Wechsel selbst liefert ein frisches Token). Logout stoppt die Timer über
  // das Aufräumen; eine danach eintreffende Antwort verwirft refreshToken.
  const sessionActive = user !== null && user.must_change_password !== 1;
  useEffect(() => {
    if (!sessionActive) return;
    const maybeRefresh = () => {
      const state = tokenState();
      setSessionEndsAt(endsAtFrom(sessionEndWarningMs(state), Date.now()));
      const action = desktopSessionAction(state);
      if (action === 'expired') {
        endSession();
        return;
      }
      if (action !== 'refresh') return;
      // Netzfehler: nächster Versuch beim nächsten Anlass. Ein 401 meldet der
      // API-Client selbst ab (Unauthorized-Handler).
      refreshToken().catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') maybeRefresh();
    };
    const timer = window.setInterval(maybeRefresh, checkIntervalMs(DESKTOP_REFRESH_CHECK_MS, tokenLifetime()));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', maybeRefresh);
    window.addEventListener('online', maybeRefresh);
    // Nach dem Neuladen kann das Token schon älter sein.
    maybeRefresh();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', maybeRefresh);
      window.removeEventListener('online', maybeRefresh);
    };
  }, [sessionActive, endSession]);

  const login = useCallback(async (email: string, password: string) => {
    // client 'desktop': lange Laufzeit, die das Backend nur Admin-Konten gibt.
    const res = await api.post<MeResponse & { token: string }>('/api/auth/login', {
      email,
      password,
      client: 'desktop',
    });
    if (res.user.role !== 'admin') throw new Error(ADMIN_ONLY_MESSAGE);
    // Auch hier leeren: Nicht jedes Sitzungsende läuft durch logout() — so gilt
    // die Regel unabhängig davon, wie die vorherige Sitzung endete.
    queryClient.clear();
    setToken(res.token);
    setNotice(null);
    applyMe(res);
    const { token: _token, ...me } = res;
    await seedMe(me);
  }, [queryClient, applyMe, seedMe]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.put<{ ok: boolean; token: string }>('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    // Erst das neue Token setzen, dann die Identität neu laden: /api/auth/me
    // liefert must_change_password = 0 und die (bei einem gesperrten Konto
    // bisher nicht abrufbaren) Rechte.
    setToken(res.token);
    const me = await api.get<MeResponse>('/api/auth/me');
    applyMe(me);
    await seedMe(me);
  }, [applyMe, seedMe]);

  const can = useCallback(
    (area: AdminArea, needed: 'lesen' | 'bearbeiten' = 'lesen') => areaOpen(VARIANT, area, permissions[area], needed),
    [permissions],
  );
  const features = license?.features ?? null;
  const hasFeatureFn = useCallback((key: string) => hasFeature(features, key), [features]);

  return (
    <AuthContext.Provider
      value={{
        user, license, refreshLicense, permissions, can, features, hasFeature: hasFeatureFn, loading, login,
        changePassword, logout, notice, sessionEndsAt,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
