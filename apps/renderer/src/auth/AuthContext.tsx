import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  FULL_ACCESS,
  permits,
  type AdminArea,
  type AdminPermissions,
  type LicenseStatus,
} from '@ohrganize/shared';
import { api, hasToken, setLicenseStateHandler, setToken, setUnauthorizedHandler } from '../api/client';

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
  /** Kurzform für Sichtbarkeitsprüfungen in der Oberfläche. */
  can: (area: AdminArea, needed?: 'lesen' | 'bearbeiten') => boolean;
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
}

const AuthContext = createContext<AuthState>({
  user: null,
  license: null,
  refreshLicense: async () => {},
  permissions: FULL_ACCESS,
  can: () => true,
  loading: true,
  login: async () => {},
  changePassword: async () => {},
  logout: () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<AdminPermissions>(FULL_ACCESS);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  // Für den Signal-Handler des API-Clients: Der läuft außerhalb des Renderings
  // und soll den jeweils aktuellen Zustand sehen, nicht den beim Registrieren.
  const licenseRef = useRef<LicenseStatus | null>(null);
  licenseRef.current = license;

  /** Identität, Rechte und Lizenz aus einer Login-/me-Antwort übernehmen. */
  const applyMe = useCallback((res: MeResponse) => {
    setUser(res.user);
    setPermissions(res.permissions ?? FULL_ACCESS);
    setLicense(res.license ?? null);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setPermissions(FULL_ACCESS);
    setLicense(null);
    // Gecachte Personaldaten dürfen einen Kontowechsel am selben Gerät nicht
    // überleben — mit den abgestuften Admin-Rollen sähe das nächste Konto sonst
    // minutenlang Daten aus Bereichen, die ihm gar nicht zustehen.
    queryClient.clear();
  }, [queryClient]);

  const refreshLicense = useCallback(async () => {
    if (!hasToken()) return;
    try {
      const me = await api.get<MeResponse>('/api/auth/me');
      if (me.user.role === 'admin') setLicense(me.license ?? null);
    } catch {
      // Ein 401 landet ohnehin im Unauthorized-Handler; alles andere lässt den
      // bisherigen Zustand stehen — ein Banner ist kein Grund für einen Fehler.
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    api
      .get<MeResponse>('/api/auth/me')
      .then((res) => {
        if (res.user.role !== 'admin') setToken(null);
        else applyMe(res);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [logout, applyMe]);

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
      void refreshLicense();
    });
    return () => setLicenseStateHandler(null);
  }, [refreshLicense]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<MeResponse & { token: string }>('/api/auth/login', { email, password });
    if (res.user.role !== 'admin') throw new Error(ADMIN_ONLY_MESSAGE);
    // Auch hier leeren: Nicht jedes Sitzungsende läuft durch logout() — so gilt
    // die Regel unabhängig davon, wie die vorherige Sitzung endete.
    queryClient.clear();
    setToken(res.token);
    applyMe(res);
  }, [queryClient, applyMe]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.put<{ ok: boolean; token: string }>('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    // Erst das neue Token setzen, dann die Identität neu laden: /api/auth/me
    // liefert must_change_password = 0 und die (bei einem gesperrten Konto
    // bisher nicht abrufbaren) Rechte.
    setToken(res.token);
    applyMe(await api.get<MeResponse>('/api/auth/me'));
  }, [applyMe]);

  const can = useCallback(
    (area: AdminArea, needed: 'lesen' | 'bearbeiten' = 'lesen') => permits(permissions[area], needed),
    [permissions],
  );

  return (
    <AuthContext.Provider
      value={{ user, license, refreshLicense, permissions, can, loading, login, changePassword, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
