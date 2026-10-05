/**
 * Sitzungsregeln der Clients: wann das Token verlängert und wann das Portal
 * nach Inaktivität abmeldet. Reine Funktionen ohne DOM, damit beide Clients
 * dieselbe Entscheidung treffen und src/test/sessionPolicyTest.ts im Backend
 * sie prüfen kann; Zeitgeber, Ereignisse und Speicher bleiben in den
 * AuthContext-Dateien der Clients.
 *
 * Die Token-Laufzeit stellt der Betreiber ein (OHRGANIZE_TOKEN_TTL,
 * OHRGANIZE_DESKTOP_TOKEN_TTL). Die Clients lesen sie aus dem Token selbst
 * (exp - iat, beides Serveruhr, also unabhängig davon, wie weit die Uhr des
 * Geräts abweicht) und verlängern spätestens nach der halben Laufzeit. Eine
 * kurze Laufzeit heißt dann häufiger verlängern, nicht abgemeldet werden.
 *
 * Höchstdauer (OHRGANIZE_SESSION_MAX, OHRGANIZE_DESKTOP_SESSION_MAX): Jede
 * Sitzung endet eine feste Zeit nach der Anmeldung (Claim `session_end`), und
 * das Token läuft spätestens dann ab. Reicht es schon bis dorthin, verlängern
 * die Clients nicht mehr (es käme nur dasselbe Ende zurück) und melden nach
 * seinem Ablauf mit Hinweis ab.
 */

/** Desktop: verlängern, sobald das Token zehn Minuten alt ist. */
export const DESKTOP_REFRESH_AFTER_MS = 10 * 60_000;
export const DESKTOP_REFRESH_CHECK_MS = 60_000;

/** Portal: Abmeldung nach so langer Inaktivität (in allen Tabs). */
export const PORTAL_IDLE_LOGOUT_MS = 60 * 60_000;
/** Portal: verlängern ab diesem Alter, wenn seit Empfang jemand aktiv war. */
export const PORTAL_REFRESH_AFTER_MS = 5 * 60_000;
export const PORTAL_IDLE_CHECK_MS = 30_000;

/** Unterster Prüftakt, auch bei absurd kurzen Laufzeiten. */
const MIN_CHECK_MS = 1_000;

interface TokenTimes {
  iat: number;
  exp: number;
  /** Ende der Sitzung (Unix-Sekunden); fehlt bei Tokens älterer Fassungen. */
  sessionEnd: number | null;
}

/**
 * Zeitangaben eines JWT (Unix-Sekunden, Serveruhr); null, wenn das Token
 * keine lesbaren Felder trägt (dann gelten die festen Vorgaben). Prüft
 * nichts: Die Signatur prüft allein der Server.
 */
function tokenTimes(token: string | null): TokenTimes | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown; iat?: unknown; session_end?: unknown };
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
    return {
      iat: payload.iat,
      exp: payload.exp,
      sessionEnd: typeof payload.session_end === 'number' ? payload.session_end : null,
    };
  } catch {
    return null;
  }
}

/** Laufzeit eines JWT in ms aus `exp - iat`; null ohne lesbare Felder. */
export function tokenLifetimeMs(token: string | null): number | null {
  return tokenSessionInfo(token).lifetimeMs;
}

/**
 * Läuft das Token bis zum Ende der Sitzung? Dann bringt eine Verlängerung
 * nichts mehr: Der Server stellt danach kein Token aus und davor nur eines
 * mit demselben Ablauf.
 */
export function tokenReachesSessionEnd(token: string | null): boolean {
  return tokenSessionInfo(token).atSessionEnd;
}

/**
 * Laufzeit und Sitzungsende aus EINEM Lesen des Tokens, für tokenState in den
 * Clients (die Sitzungsregeln fragen beides bei jeder Prüfung).
 */
export function tokenSessionInfo(token: string | null): Pick<TokenState, 'lifetimeMs' | 'atSessionEnd'> {
  const times = tokenTimes(token);
  if (!times) return { lifetimeMs: null, atSessionEnd: false };
  const lifetime = (times.exp - times.iat) * 1000;
  return {
    lifetimeMs: lifetime > 0 ? lifetime : null,
    atSessionEnd: times.sessionEnd !== null && times.exp >= times.sessionEnd,
  };
}

/**
 * Hinweis auf der Anmeldeseite beider Clients, wenn die Sitzung ihre
 * Höchstdauer erreicht hat. Hier statt in den Clients, damit Desktop und
 * Portal dieselbe Regel gleich erklären.
 */
/** Vorwarnung vor dem Ende der Sitzung (Banner in beiden Clients). */
export const SESSION_END_WARNING_MS = 10 * 60_000;

/**
 * Restzeit bis zum Ende der Sitzung in ms, sobald sie in die Vorwarnung fällt
 * (das Token reicht bis zum Ende, und es bleiben höchstens zehn Minuten);
 * sonst null. Die Clients zeigen dann ein Banner, damit niemand mitten in
 * einer Eingabe auf der Anmeldeseite landet.
 */
export function sessionEndWarningMs(state: TokenState): number | null {
  const { tokenAgeMs, lifetimeMs, atSessionEnd } = state;
  if (!atSessionEnd || tokenAgeMs === null || lifetimeMs === null) return null;
  const remaining = lifetimeMs - tokenAgeMs;
  return remaining > 0 && remaining <= SESSION_END_WARNING_MS ? remaining : null;
}

/** Text der Vorwarnung; `endTime` ist die Uhrzeit, schon im Format des Clients. */
export function sessionEndWarningText(endTime: string): string {
  return (
    `Ihre Anmeldung endet aus Sicherheitsgründen um ${endTime} Uhr. Bitte speichern Sie offene Eingaben; ` +
    'danach melden Sie sich erneut an.'
  );
}

/**
 * Zeitpunkt des Endes (ms, Uhr des Geräts) aus der Restzeit, auf die Sekunde
 * gerundet: Bei jeder Prüfung derselbe Wert, also kein Neuzeichnen.
 */
export function sessionEndsAt(remainingMs: number | null, now: number): number | null {
  return remainingMs === null ? null : Math.round((now + remainingMs) / 1000) * 1000;
}

export const SESSION_END_NOTICE =
  'Ihre Anmeldung ist abgelaufen: Aus Sicherheitsgründen gilt sie nur eine begrenzte Zeit. Bitte melden Sie sich erneut an.';

/** Ab welchem Alter verlängert wird: die Vorgabe, höchstens die halbe Laufzeit. */
export function refreshAfterMs(preferredMs: number, lifetimeMs: number | null): number {
  return lifetimeMs === null ? preferredMs : Math.min(preferredMs, lifetimeMs / 2);
}

/**
 * Prüftakt: die Vorgabe, höchstens ein Viertel der Laufzeit. Zwischen der
 * Schwelle (halbe Laufzeit) und dem Ablauf liegen so mindestens zwei
 * Prüfungen, auch wenn eine Verlängerung am Netz scheitert.
 */
export function checkIntervalMs(preferredMs: number, lifetimeMs: number | null): number {
  return lifetimeMs === null ? preferredMs : Math.max(MIN_CHECK_MS, Math.min(preferredMs, lifetimeMs / 4));
}

/** Am Ende der Sitzung: abgelaufen, sobald das letzte Token seine Laufzeit hinter sich hat. */
function endOfSession(tokenAgeMs: number, lifetimeMs: number | null): 'expired' | 'none' {
  return lifetimeMs !== null && tokenAgeMs >= lifetimeMs ? 'expired' : 'none';
}

/** Zustand des aktuellen Tokens, wie die Clients ihn kennen (api/client.ts, tokenState). */
export interface TokenState {
  /** Alter des Tokens seit Empfang nach der Uhr des Geräts; null ohne Token. */
  tokenAgeMs: number | null;
  lifetimeMs: number | null;
  /** Das Token reicht bis zum Ende der Sitzung (tokenReachesSessionEnd). */
  atSessionEnd: boolean;
}

/**
 * Spielraum für sessionEndReached: Der Server misst den Ablauf ab dem
 * Ausstellen, der Client das Alter ab dem Empfang.
 */
const SESSION_END_TOLERANCE_MS = 60_000;

/**
 * Endete die Sitzung an ihrer Höchstdauer? Für den Hinweis auf der
 * Anmeldeseite, wenn der Server ein Token abweist (401): Nur dann war es das
 * Ende der Sitzung, sonst etwa ein Passwortwechsel auf einem anderen Gerät.
 */
export function sessionEndReached(state: TokenState): boolean {
  const { tokenAgeMs, lifetimeMs, atSessionEnd } = state;
  return atSessionEnd && tokenAgeMs !== null && lifetimeMs !== null && tokenAgeMs >= lifetimeMs - SESSION_END_TOLERANCE_MS;
}

export type DesktopSessionAction = 'refresh' | 'expired' | 'none';

/**
 * Desktop: verlängern, solange die App läuft (keine Abmeldung nach Leerlauf),
 * bis zum Ende der Sitzung; danach `expired`, sobald das letzte Token
 * abgelaufen ist (Abmeldung mit Hinweis).
 */
export function desktopSessionAction(state: TokenState): DesktopSessionAction {
  const { tokenAgeMs, lifetimeMs, atSessionEnd } = state;
  if (tokenAgeMs === null) return 'none';
  if (atSessionEnd) return endOfSession(tokenAgeMs, lifetimeMs);
  return tokenAgeMs >= refreshAfterMs(DESKTOP_REFRESH_AFTER_MS, lifetimeMs) ? 'refresh' : 'none';
}

export interface PortalSessionInput extends TokenState {
  now: number;
  /** Letzte Eingabe über alle Tabs (ms). */
  lastActivity: number;
  /** Beim Wechselzwang lehnt der Server jede Verlängerung ab (403). */
  mustChangePassword: boolean;
}

export type PortalSessionAction = 'logout' | 'expired' | 'refresh' | 'none';

/**
 * Portal: Nach 60 Minuten ohne Eingabe abmelden (`logout`); am Ende der
 * Sitzung abmelden, sobald das letzte Token abgelaufen ist (`expired`);
 * sonst verlängern, sobald das Token die Schwelle erreicht hat UND seit
 * seinem Empfang jemand aktiv war. Wer nichts tut, bekommt also kein neues
 * Token, und der Server beendet die Sitzung spätestens eine Laufzeit nach
 * der letzten Eingabe von selbst.
 */
export function portalSessionAction(input: PortalSessionInput): PortalSessionAction {
  const { now, lastActivity, tokenAgeMs, lifetimeMs, atSessionEnd, mustChangePassword } = input;
  if (now - lastActivity >= PORTAL_IDLE_LOGOUT_MS) return 'logout';
  if (tokenAgeMs === null) return 'none';
  if (atSessionEnd) return endOfSession(tokenAgeMs, lifetimeMs);
  if (mustChangePassword) return 'none';
  if (tokenAgeMs < refreshAfterMs(PORTAL_REFRESH_AFTER_MS, lifetimeMs)) return 'none';
  return lastActivity > now - tokenAgeMs ? 'refresh' : 'none';
}
