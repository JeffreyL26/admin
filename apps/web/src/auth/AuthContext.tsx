import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  checkIntervalMs,
  hasFeature,
  portalSessionAction,
  PORTAL_IDLE_CHECK_MS,
  PORTAL_IDLE_LOGOUT_MS,
  sessionEndReached,
  sessionEndsAt as endsAtFrom,
  sessionEndWarningMs,
  SESSION_END_NOTICE,
  type AuthUserDto,
  type LicenseStatusPublic,
} from '@ohrganize/shared';
import {
  api,
  hasToken,
  refreshToken,
  setLicenseHandler,
  setSignedOutElsewhereHandler,
  setToken,
  setUnauthorizedHandler,
  tokenLifetime,
  tokenState,
} from '../api/client';

/*
 * Die Abmeldung nach Inaktivität (PORTAL_IDLE_LOGOUT_MS, 60 Minuten) ist
 * bewusst eine eigene Frist und nicht die Token-Laufzeit des Servers
 * (OHRGANIZE_TOKEN_TTL): Wer aktiv ist, bleibt angemeldet, weil das Token
 * dann verlängert wird. Die Entscheidung selbst (abmelden, verlängern,
 * nichts) trifft portalSessionAction in packages/shared/src/session.ts.
 */
const IDLE_NOTICE = `Sie wurden nach ${PORTAL_IDLE_LOGOUT_MS / 60_000} Minuten ohne Aktivität abgemeldet.`;
/**
 * Grund der letzten Abmeldung mit Hinweis, für alle Tabs: Der Tab, der
 * abmeldet, schreibt ihn VOR dem Entfernen des Tokens; die anderen lesen ihn,
 * wenn sie das Entfernen bemerken (setSignedOutElsewhereHandler). Die
 * Anmeldung löscht ihn, ein Logout von Hand schreibt keinen.
 */
const LOGOUT_REASON_KEY = 'ohrganize.portal.logout-reason';
type LogoutReason = 'idle' | 'session-end';
const NOTICE_OF: Record<LogoutReason, string> = { idle: IDLE_NOTICE, 'session-end': SESSION_END_NOTICE };

function storedLogoutReason(): LogoutReason | null {
  const value = localStorage.getItem(LOGOUT_REASON_KEY);
  return value === 'idle' || value === 'session-end' ? value : null;
}
/** Aktivität sind nur echte Eingaben; Abfragen im Hintergrund zählen nicht. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/**
 * Letzte Aktivität für alle Tabs, damit ein Tab, in dem gerade niemand
 * arbeitet, die anderen nicht abmeldet. Geschrieben höchstens alle 15 s.
 */
const ACTIVITY_KEY = 'ohrganize.portal.activity';
const ACTIVITY_WRITE_MS = 15_000;
/*
 * Verlängert wird ein Token, das älter als fünf Minuten ist (bei kurzer
 * Laufzeit spätestens nach der halben), wenn seit seinem Empfang jemand aktiv
 * war; geprüft bei Aktivität und im Takt der Leerlaufprüfung. Bei der
 * Vorgabe von einer Stunde reicht so jedes Token bis mindestens 60 Minuten
 * nach der letzten Aktivität (kein 401 vor der Abmeldung mit Hinweis), und
 * der Server beendet die Sitzung spätestens rund 65 Minuten danach von
 * selbst. Ist die Laufzeit kürzer als 60 Minuten, endet eine Sitzung ohne
 * Eingabe schon nach dieser Laufzeit, dann ohne Hinweis.
 */

function storedActivity(): number {
  return Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
}

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
  /** Hinweis für die Anmeldeseite (Abmeldung nach Inaktivität), sonst null. */
  notice: string | null;
  /**
   * Ende der Sitzung (ms), sobald es in die Vorwarnung fällt (zehn Minuten
   * vorher, components/SessionEndNotice.tsx); sonst null.
   */
  sessionEndsAt: number | null;
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
  notice: null,
  sessionEndsAt: null,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionEndsAt, setSessionEndsAt] = useState<number | null>(null);
  const queryClient = useQueryClient();
  // Letzte Eingabe in DIESEM Tab und wann sie zuletzt für alle Tabs
  // geschrieben wurde (ms).
  const lastActivity = useRef(0);
  const lastWritten = useRef(0);

  const adoptSession = useCallback((res: SessionResponse) => {
    setUser(res.user);
    setReadOnly(res.license?.read_only === true);
    setFeatures(res.license?.features ?? null);
    setCanViewCalendar(res.portal?.calendar !== false);
  }, []);
  const hasFeatureFn = useCallback((key: string) => hasFeature(features, key), [features]);

  /** Letzte Aktivität über alle Tabs (0 = keine bekannt). */
  const latestActivity = useCallback(() => Math.max(lastActivity.current, storedActivity()), []);
  const idleExpired = useCallback(() => {
    const last = latestActivity();
    return last > 0 && Date.now() - last >= PORTAL_IDLE_LOGOUT_MS;
  }, [latestActivity]);
  const markActivity = useCallback((now: number) => {
    lastActivity.current = now;
    if (now - lastWritten.current < ACTIVITY_WRITE_MS) return;
    lastWritten.current = now;
    localStorage.setItem(ACTIVITY_KEY, String(now));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setSessionEndsAt(null);
    // Gecachte Personaldaten dürfen einen Kontowechsel am selben Gerät
    // nicht überleben.
    queryClient.clear();
  }, [queryClient]);

  /** Abmelden mit Hinweis, für alle Tabs (LOGOUT_REASON_KEY). */
  const logoutWithReason = useCallback(
    (reason: LogoutReason) => {
      localStorage.setItem(LOGOUT_REASON_KEY, reason);
      logout();
      setNotice(NOTICE_OF[reason]);
    },
    [logout],
  );

  /**
   * Sitzung von außen beendet: 401 (auch auf die Verlängerung) oder Logout in
   * einem anderen Tab. War Inaktivität oder das Ende der Sitzung der Grund,
   * mit Hinweis; im zweiten Fall nennt ihn der abmeldende Tab.
   */
  const endSession = useCallback(() => {
    if (idleExpired()) logoutWithReason('idle');
    else if (sessionEndReached(tokenState())) logoutWithReason('session-end');
    else {
      const reason = hasToken() ? null : storedLogoutReason();
      logout();
      if (reason) setNotice(NOTICE_OF[reason]);
    }
  }, [idleExpired, logout, logoutWithReason]);

  useEffect(() => {
    setUnauthorizedHandler(endSession);
    setSignedOutElsewhereHandler(endSession);
    setLicenseHandler(setReadOnly);
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    // Eine Sitzung, in der seit 60 Minuten niemand aktiv war, gar nicht erst
    // wiederherstellen (Tab nach der Mittagspause neu geladen).
    if (idleExpired()) {
      localStorage.setItem(LOGOUT_REASON_KEY, 'idle');
      setToken(null);
      setNotice(IDLE_NOTICE);
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
  }, [endSession, adoptSession, idleExpired]);

  // Solange angemeldet: Eingaben als Aktivität zählen, Leerlauf prüfen und
  // das Token verlängern (Regeln an den Konstanten oben).
  const sessionUserId = user?.id ?? null;
  const mustChangePassword = user?.must_change_password === 1;
  useEffect(() => {
    if (sessionUserId === null) return;
    // Ohne gemerkte Aktivität (erster Start nach dem Update) zählt der
    // Leerlauf ab jetzt.
    if (latestActivity() === 0) lastActivity.current = Date.now();

    const maintain = () => {
      const state = tokenState();
      setSessionEndsAt(endsAtFrom(sessionEndWarningMs(state), Date.now()));
      const action = portalSessionAction({
        ...state,
        now: Date.now(),
        lastActivity: latestActivity(),
        // Beim Wechselzwang lehnt das Backend die Verlängerung ab (403); der
        // Passwortwechsel liefert selbst ein frisches Token.
        mustChangePassword,
      });
      if (action === 'logout') {
        logoutWithReason('idle');
      } else if (action === 'expired') {
        logoutWithReason('session-end');
      } else if (action === 'refresh') {
        // Netzfehler: nächster Versuch beim nächsten Anlass; 401 meldet ab.
        refreshToken().catch(() => undefined);
      }
    };
    const onActivity = () => {
      const now = Date.now();
      // Drossel: wheel und keydown feuern in schneller Folge.
      if (now - lastActivity.current < 1_000) return;
      // Eine Eingabe nach Ablauf der Frist belebt die Sitzung nicht wieder.
      if (idleExpired()) {
        maintain();
        return;
      }
      markActivity(now);
      maintain();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') maintain();
    };
    const listenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, listenerOptions);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(maintain, checkIntervalMs(PORTAL_IDLE_CHECK_MS, tokenLifetime()));
    maintain();
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, listenerOptions);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [sessionUserId, mustChangePassword, latestActivity, idleExpired, markActivity, logout]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<SessionResponse & { token: string }>('/api/auth/login', {
      email,
      password,
      client: 'portal',
    });
    if (res.user.employee_id === null) throw new Error(NO_PROFILE_MESSAGE);
    queryClient.clear();
    setToken(res.token);
    // Die Anmeldung selbst ist Aktivität; für alle Tabs sofort festhalten.
    lastWritten.current = 0;
    markActivity(Date.now());
    localStorage.removeItem(LOGOUT_REASON_KEY);
    setNotice(null);
    adoptSession(res);
  }, [queryClient, adoptSession, markActivity]);

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
        notice,
        sessionEndsAt,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
