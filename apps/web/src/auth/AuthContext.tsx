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
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  login: async () => {},
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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}
