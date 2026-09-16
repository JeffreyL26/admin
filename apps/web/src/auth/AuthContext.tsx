import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { hasFeature, type AuthUserDto, type LicenseStatusPublic } from '@ohrganize/shared';
import { api, hasToken, setLicenseHandler, setToken, setUnauthorizedHandler } from '../api/client';

/**
 * Das Portal steht allen Accounts mit verknüpftem Personalprofil offen —
 * Mitarbeitenden (role 'mitarbeiter') ebenso wie HR-Admins, deren Account
 * mit einem Profil verknüpft ist. Reine Admin-Accounts gehören in die
 * Desktop-App; das Backend blockt sie auf /api/me/* ohnehin (403).
 */
const NO_PROFILE_MESSAGE =
  'Für diesen Zugang ist kein Personalprofil hinterlegt. HR-Administrationskonten melden sich in der oHRganize Desktop-App an.';

/**
 * Antwort von Login und /api/auth/me, soweit das Portal sie liest. `license`
 * ist für Portal-Konten `{ read_only }`; ein verknüpftes Admin-Konto bekommt
 * den vollen Lizenzstatus, der dieses Feld ebenfalls trägt — mehr als das
 * eine Bit wertet das Portal in keinem Fall aus.
 */
interface SessionResponse {
  user: AuthUserDto;
  license?: LicenseStatusPublic;
  /** Was die Fachrollen im Portal freigeben (fehlt bei älterem Backend ⇒ alles sichtbar). */
  portal?: { calendar: boolean };
}

interface AuthState {
  user: AuthUserDto | null;
  loading: boolean;
  /**
   * Nur-Lese-Betrieb des Servers (Lizenz abgelaufen): Anträge, Krankmeldungen,
   * Änderungsanträge und Uploads sind gesperrt, Lesen und Herunterladen nicht.
   * Quelle ist das Feld `license` aus Login und /api/auth/me; der API-Client
   * hält den Wert danach über den Zustands-Header bzw. ein 403 LICENSE_EXPIRED
   * aktuell (setLicenseHandler).
   */
  readOnly: boolean;
  /**
   * Freigeschaltete Feature-Schluessel der Lizenz (null = alles an), fuer die
   * Navigation. Reine Anzeige; das Backend antwortet auf gesperrte Routen mit
   * 403 LICENSE_FEATURE_MISSING.
   */
  features: string[] | null;
  hasFeature: (key: string) => boolean;
  /**
   * Firmenweiter Abwesenheitskalender laut Fachrolle (roles.can_view_calendar).
   * Anzeigehilfe für Navigation und Route; das Backend weist
   * GET /api/me/calendar ohne Recht mit 403 ab.
   */
  canViewCalendar: boolean;
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
  readOnly: false,
  features: null,
  hasFeature: () => true,
  canViewCalendar: true,
  login: async () => {},
  changePassword: async () => {},
  logout: () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [loading, setLoading] = useState(true);
  // Fehlt das Feld (älteres Backend), gilt schreibbar — der Server lehnt
  // Schreibzugriffe ohnehin selbst ab, und der Client folgt dann dem 403.
  const [readOnly, setReadOnly] = useState(false);
  const [features, setFeatures] = useState<string[] | null>(null);
  const [canViewCalendar, setCanViewCalendar] = useState(true);
  const queryClient = useQueryClient();

  const adoptSession = useCallback((res: SessionResponse) => {
    setUser(res.user);
    setReadOnly(res.license?.read_only === true);
    setFeatures(res.license?.features ?? null);
    setCanViewCalendar(res.portal?.calendar !== false);
  }, []);
  const hasFeatureFn = useCallback((key: string) => hasFeature(features, key), [features]);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    // Gecachte Personaldaten dürfen einen Kontowechsel am selben Gerät
    // nicht überleben.
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    setLicenseHandler(setReadOnly);
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    api
      .get<SessionResponse>('/api/auth/me')
      .then((res) => {
        if (res.user.employee_id === null) setToken(null);
        else adoptSession(res);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [logout, adoptSession]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<SessionResponse & { token: string }>('/api/auth/login', {
      email,
      password,
    });
    if (res.user.employee_id === null) throw new Error(NO_PROFILE_MESSAGE);
    queryClient.clear();
    setToken(res.token);
    adoptSession(res);
  }, [queryClient, adoptSession]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.put<{ ok: boolean; token: string }>('/api/auth/password', {
      currentPassword,
      newPassword,
    });
    // Erst das neue Token setzen, dann die Identität neu laden: /api/auth/me
    // liefert danach must_change_password = 0, und der Wechselzwang-Schirm
    // verschwindet von selbst.
    setToken(res.token);
    const me = await api.get<SessionResponse>('/api/auth/me');
    adoptSession(me);
  }, [adoptSession]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        readOnly,
        features,
        hasFeature: hasFeatureFn,
        canViewCalendar,
        login,
        changePassword,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
