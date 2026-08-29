import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUserDto } from '@hrmonic/shared';
import { api, hasToken, setToken, setUnauthorizedHandler } from '../api/client';

/**
 * Das Portal steht allen Accounts mit verknüpftem Personalprofil offen —
 * Mitarbeitenden (role 'mitarbeiter') ebenso wie HR-Admins, deren Account
 * mit einem Profil verknüpft ist. Reine Admin-Accounts gehören in die
 * Desktop-App; das Backend blockt sie auf /api/me/* ohnehin (403).
 */
const NO_PROFILE_MESSAGE =
  'Für diesen Zugang ist kein Personalprofil hinterlegt. HR-Administrationskonten melden sich in der HRMONIC Desktop-App an.';

interface AuthState {
  user: AuthUserDto | null;
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
  loading: true,
  login: async () => {},
  changePassword: async () => {},
  logout: () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    // Gecachte Personaldaten dürfen einen Kontowechsel am selben Gerät
    // nicht überleben.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    api
      .get<{ user: AuthUserDto }>('/api/auth/me')
      .then((res) => {
        if (res.user.employee_id === null) setToken(null);
        else setUser(res.user);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: AuthUserDto }>('/api/auth/login', {
      email,
      password,
    });
    if (res.user.employee_id === null) throw new Error(NO_PROFILE_MESSAGE);
    queryClient.clear();
    setToken(res.token);
    setUser(res.user);
  }, [queryClient]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.put<{ ok: boolean; token: string }>('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    // Erst das neue Token setzen, dann die Identität neu laden: /api/auth/me
    // liefert danach must_change_password = 0, und der Wechselzwang-Schirm
    // verschwindet von selbst.
    setToken(res.token);
    const me = await api.get<{ user: AuthUserDto }>('/api/auth/me');
    setUser(me.user);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, changePassword, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
