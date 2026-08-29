import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { FULL_ACCESS, permits, type AdminArea, type AdminPermissions } from '@hrmonic/shared';
import { api, hasToken, setToken, setUnauthorizedHandler } from '../api/client';

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
  'Dieser Zugang ist der HR-Administration vorbehalten. Bitte melden Sie sich im HRMONIC Mitarbeitenden-Portal an.';

interface AuthState {
  user: AuthUser | null;
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
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setPermissions(FULL_ACCESS);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    api
      .get<{ user: AuthUser; permissions?: AdminPermissions }>('/api/auth/me')
      .then((res) => {
        if (res.user.role !== 'admin') setToken(null);
        else {
          setUser(res.user);
          setPermissions(res.permissions ?? FULL_ACCESS);
        }
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: AuthUser; permissions?: AdminPermissions }>(
      '/api/auth/login',
      { email, password },
    );
    if (res.user.role !== 'admin') throw new Error(ADMIN_ONLY_MESSAGE);
    setToken(res.token);
    setUser(res.user);
    setPermissions(res.permissions ?? FULL_ACCESS);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.put<{ ok: boolean; token: string }>('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    // Erst das neue Token setzen, dann die Identität neu laden: /api/auth/me
    // liefert must_change_password = 0 und die (bei einem gesperrten Konto
    // bisher nicht abrufbaren) Rechte.
    setToken(res.token);
    const me = await api.get<{ user: AuthUser; permissions?: AdminPermissions }>('/api/auth/me');
    setUser(me.user);
    setPermissions(me.permissions ?? FULL_ACCESS);
  }, []);

  const can = useCallback(
    (area: AdminArea, needed: 'lesen' | 'bearbeiten' = 'lesen') => permits(permissions[area], needed),
    [permissions],
  );

  return (
    <AuthContext.Provider
      value={{ user, permissions, can, loading, login, changePassword, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
