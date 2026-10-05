/**
 * Prüft die Sitzungsregeln der Clients (packages/shared/src/session.ts):
 * Abmeldung des Portals nach 60 Minuten ohne Eingabe, Verlängerung nur nach
 * Aktivität, Verlängerung nach der Token-Laufzeit des Servers und das Ende
 * jeder Sitzung nach ihrer Höchstdauer. Dazu Simulationen gegen einen
 * nachgebildeten Server über Stunden und Tage: Wer arbeitet, behält ein
 * gültiges Token bis zur Höchstdauer, wer nichts tut, wird nach 60 Minuten
 * abgemeldet, und am Ende der Sitzung wird nicht mehr verlängert.
 *
 * Aufruf: tsx src/test/sessionPolicyTest.ts (Teil von npm test)
 */
import {
  checkIntervalMs,
  desktopSessionAction,
  DESKTOP_REFRESH_AFTER_MS,
  DESKTOP_REFRESH_CHECK_MS,
  portalSessionAction,
  PORTAL_IDLE_CHECK_MS,
  PORTAL_IDLE_LOGOUT_MS,
  PORTAL_REFRESH_AFTER_MS,
  refreshAfterMs,
  sessionEndReached,
  SESSION_END_NOTICE,
  SESSION_END_WARNING_MS,
  sessionEndsAt,
  sessionEndWarningMs,
  sessionEndWarningText,
  tokenLifetimeMs,
  tokenReachesSessionEnd,
  tokenSessionInfo,
  type TokenState,
} from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) {
    failures++;
    console.log(`FEHLER ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function token(payload: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signatur`;
}

// --- Angaben aus dem Token ----------------------------------------------------
check('Laufzeit 1h aus exp - iat', tokenLifetimeMs(token({ iat: 1_700_000_000, exp: 1_700_003_600 })) === HOUR);
check('Laufzeit 3d', tokenLifetimeMs(token({ iat: 1_700_000_001, exp: 1_700_259_201 })) === 3 * DAY);
check('Umlaute im Namen (base64url mit - und _)', tokenLifetimeMs(token({ name: 'Jürgen Wilms ÄÖÜß??>>', iat: 10, exp: 310 })) === 300_000);
check('ohne Token: null', tokenLifetimeMs(null) === null);
check('ohne exp: null', tokenLifetimeMs(token({ iat: 10 })) === null);
check('exp vor iat: null', tokenLifetimeMs(token({ iat: 10, exp: 5 })) === null);
check('kaputtes Token: null', tokenLifetimeMs('abc.%%%.def') === null && tokenLifetimeMs('nurEinTeil') === null);
check('Token bis zum Sitzungsende', tokenReachesSessionEnd(token({ iat: 10, exp: 100, session_end: 100 })));
check('Token vor dem Sitzungsende', !tokenReachesSessionEnd(token({ iat: 10, exp: 50, session_end: 100 })));
check('Token ohne Sitzungsende (ältere Fassung)', !tokenReachesSessionEnd(token({ iat: 10, exp: 100 })));
check('ohne Token: kein Sitzungsende', !tokenReachesSessionEnd(null));
const info = tokenSessionInfo(token({ iat: 10, exp: 100, session_end: 100 }));
check('Laufzeit und Sitzungsende aus einem Lesen', info.lifetimeMs === 90_000 && info.atSessionEnd, info);
check('Ohne Token: keine Angaben', JSON.stringify(tokenSessionInfo(null)) === JSON.stringify({ lifetimeMs: null, atSessionEnd: false }));
check('Hinweistext für beide Clients', SESSION_END_NOTICE.includes('erneut an'));
check(
  'Vorwarnung: erst in den letzten zehn Minuten vor dem Sitzungsende',
  sessionEndWarningMs({ tokenAgeMs: DAY - 11 * MIN, lifetimeMs: DAY, atSessionEnd: true }) === null &&
    sessionEndWarningMs({ tokenAgeMs: DAY - 9 * MIN, lifetimeMs: DAY, atSessionEnd: true }) === 9 * MIN &&
    sessionEndWarningMs({ tokenAgeMs: DAY - 9 * MIN, lifetimeMs: DAY, atSessionEnd: false }) === null &&
    sessionEndWarningMs({ tokenAgeMs: DAY, lifetimeMs: DAY, atSessionEnd: true }) === null &&
    SESSION_END_WARNING_MS === 10 * MIN,
);
check(
  'Vorwarnung: Endzeitpunkt bei jeder Prüfung gleich (auf die Sekunde)',
  sessionEndsAt(9 * MIN, 1_000_000_400) === sessionEndsAt(9 * MIN - 300, 1_000_000_700) && sessionEndsAt(null, 5) === null,
);
check('Vorwarnung nennt die Uhrzeit', sessionEndWarningText('14:32').includes('um 14:32 Uhr'));

// --- Schwellen ---------------------------------------------------------------
const fresh = (tokenAgeMs: number | null, lifetimeMs: number | null): TokenState => ({
  tokenAgeMs,
  lifetimeMs,
  atSessionEnd: false,
});
check('Desktop-Vorgabe ohne Laufzeit', refreshAfterMs(DESKTOP_REFRESH_AFTER_MS, null) === 10 * MIN);
check('Desktop 3d: zehn Minuten', refreshAfterMs(DESKTOP_REFRESH_AFTER_MS, 3 * DAY) === 10 * MIN);
check('Desktop 5m: halbe Laufzeit', refreshAfterMs(DESKTOP_REFRESH_AFTER_MS, 5 * MIN) === 2.5 * MIN);
check('Portal 3m: halbe Laufzeit', refreshAfterMs(PORTAL_REFRESH_AFTER_MS, 3 * MIN) === 1.5 * MIN);
check('Prüftakt 1h: Vorgabe', checkIntervalMs(PORTAL_IDLE_CHECK_MS, HOUR) === PORTAL_IDLE_CHECK_MS);
check('Prüftakt 2m: ein Viertel', checkIntervalMs(DESKTOP_REFRESH_CHECK_MS, 2 * MIN) === 30_000);
check('Prüftakt 2s: nicht unter einer Sekunde', checkIntervalMs(DESKTOP_REFRESH_CHECK_MS, 2_000) === 1_000);
check('Desktop: junges Token bleibt', desktopSessionAction(fresh(9 * MIN, 3 * DAY)) === 'none');
check('Desktop: zehn Minuten alt wird verlängert', desktopSessionAction(fresh(10 * MIN, 3 * DAY)) === 'refresh');
check('Desktop: ohne Token nichts', desktopSessionAction(fresh(null, null)) === 'none');
check(
  'Desktop am Sitzungsende: nicht verlängern',
  desktopSessionAction({ tokenAgeMs: 2 * HOUR, lifetimeMs: DAY, atSessionEnd: true }) === 'none',
);
check(
  'Desktop am Sitzungsende: abgelaufen, sobald das letzte Token um ist',
  desktopSessionAction({ tokenAgeMs: DAY, lifetimeMs: DAY, atSessionEnd: true }) === 'expired',
);
check(
  'Hinweis nach 401: nur am Ende der Sitzung (eine Minute Spielraum)',
  sessionEndReached({ tokenAgeMs: DAY - 30_000, lifetimeMs: DAY, atSessionEnd: true }) &&
    !sessionEndReached({ tokenAgeMs: DAY - 10 * MIN, lifetimeMs: DAY, atSessionEnd: true }) &&
    !sessionEndReached({ tokenAgeMs: DAY, lifetimeMs: DAY, atSessionEnd: false }),
);

// --- Portal: Einzelentscheidungen ---------------------------------------------
const now = 10 * HOUR;
const base = { now, tokenAgeMs: 6 * MIN, lifetimeMs: HOUR, atSessionEnd: false, mustChangePassword: false };
check('60 Minuten ohne Eingabe: abmelden', portalSessionAction({ ...base, lastActivity: now - PORTAL_IDLE_LOGOUT_MS }) === 'logout');
check('59 Minuten ohne Eingabe, Token älter: nichts (keine Aktivität seit Empfang)',
  portalSessionAction({ ...base, lastActivity: now - 59 * MIN }) === 'none');
check('Eingabe nach Empfang, Token älter als 5 Minuten: verlängern',
  portalSessionAction({ ...base, lastActivity: now - MIN }) === 'refresh');
check('Eingabe nach Empfang, Token jünger: nichts',
  portalSessionAction({ ...base, tokenAgeMs: 4 * MIN, lastActivity: now - MIN }) === 'none');
check('Wechselzwang: nie verlängern', portalSessionAction({ ...base, lastActivity: now, mustChangePassword: true }) === 'none');
check('Wechselzwang: Leerlauf meldet trotzdem ab',
  portalSessionAction({ ...base, lastActivity: now - 61 * MIN, mustChangePassword: true }) === 'logout');
check('ohne Token: nichts', portalSessionAction({ ...base, tokenAgeMs: null, lastActivity: now }) === 'none');
check('Sitzungsende, Token noch gültig: trotz Eingabe nicht verlängern',
  portalSessionAction({ ...base, atSessionEnd: true, lastActivity: now - MIN }) === 'none');
check('Sitzungsende, Token abgelaufen: abmelden mit Hinweis',
  portalSessionAction({ ...base, atSessionEnd: true, tokenAgeMs: HOUR, lastActivity: now - MIN }) === 'expired');

// --- Simulation gegen einen nachgebildeten Server ------------------------------
/** Laufzeit und Höchstdauer wie OHRGANIZE_*_TOKEN_TTL und OHRGANIZE_*_SESSION_MAX (ms). */
interface ServerConfig {
  ttl: number;
  sessionMax: number;
}
interface IssuedToken {
  received: number;
  exp: number;
  lifetime: number;
  atEnd: boolean;
}
/** Wie core/auth.ts signToken: Ablauf nach der Laufzeit, spätestens am Ende der Sitzung (Beginn 0). */
function issue(server: ServerConfig, t: number): IssuedToken {
  const end = server.sessionMax;
  const exp = Math.min(t + server.ttl, end);
  return { received: t, exp, lifetime: exp - t, atEnd: exp >= end };
}
const stateOf = (tok: IssuedToken, t: number): TokenState => ({
  tokenAgeMs: t - tok.received,
  lifetimeMs: tok.lifetime,
  atSessionEnd: tok.atEnd,
});

interface SimulationResult {
  /** Token abgelaufen, ohne dass die Sitzung zu Ende war: Abmeldung ohne Grund. */
  unexpectedExpiry: boolean;
  endedAt: number | null;
  reason: 'logout' | 'expired' | null;
  refreshes: number;
  /** Verlängert, obwohl das Token schon bis zum Ende reichte (sinnlos). */
  refreshesAtEnd: number;
  lastRefresh: number;
}

/**
 * Portal im Prüftakt; `activeUntil` ist das Ende der Arbeit (Eingaben im
 * Abstand `inputEveryMs`, jede Eingabe prüft wie im Client sofort).
 */
function simulatePortal(server: ServerConfig, activeUntil: number, inputEveryMs: number, durationMs: number): SimulationResult {
  let tok = issue(server, 0);
  const tick = checkIntervalMs(PORTAL_IDLE_CHECK_MS, tok.lifetime);
  const result: SimulationResult = {
    unexpectedExpiry: false, endedAt: null, reason: null, refreshes: 0, refreshesAtEnd: 0, lastRefresh: 0,
  };
  let lastActivity = 0;
  for (let t = 0; t <= durationMs; t += 1_000) {
    const input = t < activeUntil && t % inputEveryMs === 0;
    if (input) lastActivity = t;
    if (t % tick !== 0 && !input) continue;
    if (t >= tok.exp && !tok.atEnd) return { ...result, unexpectedExpiry: true, endedAt: t };
    const action = portalSessionAction({ ...stateOf(tok, t), now: t, lastActivity, mustChangePassword: false });
    if (action === 'logout' || action === 'expired') return { ...result, endedAt: t, reason: action };
    if (action === 'refresh') {
      if (tok.atEnd) result.refreshesAtEnd += 1;
      tok = issue(server, t);
      result.refreshes += 1;
      result.lastRefresh = t;
    }
  }
  return result;
}

const portal = { ttl: HOUR, sessionMax: 6 * HOUR };
const working = simulatePortal(portal, 8 * HOUR, 2 * MIN, 8 * HOUR);
check(
  'Portal 1h/6h: Arbeit ohne Pause endet nach sechs Stunden mit Hinweis, vorher nie abgelaufen',
  !working.unexpectedExpiry && working.reason === 'expired' &&
    working.endedAt !== null && working.endedAt >= 6 * HOUR && working.endedAt <= 6 * HOUR + PORTAL_IDLE_CHECK_MS,
  working,
);
check('Portal 1h/6h: am Sitzungsende keine sinnlosen Verlängerungen', working.refreshesAtEnd === 0, working);
const fullDay = simulatePortal({ ttl: HOUR, sessionMax: 9 * HOUR }, 8 * HOUR, 2 * MIN, 8 * HOUR);
check('Portal 1h/9h: acht Stunden Arbeit, nie abgelaufen, nie abgemeldet', !fullDay.unexpectedExpiry && fullDay.endedAt === null, fullDay);
const pause = simulatePortal(portal, 30 * MIN, MIN, 3 * HOUR);
check('Portal 1h: nach der letzten Eingabe Abmeldung mit Hinweis nach 60 Minuten, Token bis dahin gültig',
  !pause.unexpectedExpiry && pause.reason === 'logout' && pause.endedAt !== null &&
    pause.endedAt >= 29 * MIN + PORTAL_IDLE_LOGOUT_MS && pause.endedAt <= 30 * MIN + PORTAL_IDLE_LOGOUT_MS + PORTAL_IDLE_CHECK_MS,
  pause);
check('Portal 1h: ohne Eingabe keine Verlängerung mehr (der Server beendet die Sitzung auch ohne Client)',
  pause.lastRefresh <= 30 * MIN + PORTAL_REFRESH_AFTER_MS, pause);
for (const ttlMin of [3, 10, 15]) {
  const short = simulatePortal({ ttl: ttlMin * MIN, sessionMax: 6 * HOUR }, 2 * HOUR, 20_000, 2 * HOUR);
  check(`Portal ${ttlMin}m: wer arbeitet, behält ein gültiges Token`, !short.unexpectedExpiry && short.endedAt === null, short);
}

/** Desktop im Prüftakt über `durationMs`, ohne Leerlaufregel. */
function simulateDesktop(server: ServerConfig, durationMs: number): SimulationResult {
  let tok = issue(server, 0);
  const tick = checkIntervalMs(DESKTOP_REFRESH_CHECK_MS, tok.lifetime);
  const result: SimulationResult = {
    unexpectedExpiry: false, endedAt: null, reason: null, refreshes: 0, refreshesAtEnd: 0, lastRefresh: 0,
  };
  for (let t = 0; t <= durationMs; t += tick) {
    if (t >= tok.exp && !tok.atEnd) return { ...result, unexpectedExpiry: true, endedAt: t };
    const action = desktopSessionAction(stateOf(tok, t));
    if (action === 'expired') return { ...result, endedAt: t, reason: 'expired' };
    if (action === 'refresh') {
      if (tok.atEnd) result.refreshesAtEnd += 1;
      tok = issue(server, t);
      result.refreshes += 1;
      result.lastRefresh = t;
    }
  }
  return result;
}

const desktop = simulateDesktop({ ttl: 3 * DAY, sessionMax: 5 * DAY }, 6 * DAY);
check(
  'Desktop 3d/5d: angemeldet bis zum fünften Tag, dann Abmeldung mit Hinweis',
  !desktop.unexpectedExpiry && desktop.reason === 'expired' &&
    desktop.endedAt !== null && desktop.endedAt >= 5 * DAY && desktop.endedAt <= 5 * DAY + DESKTOP_REFRESH_CHECK_MS,
  desktop,
);
check(
  'Desktop 3d/5d: keine Verlängerung mehr, sobald das Token bis zum Ende reicht (ab Tag zwei)',
  desktop.refreshesAtEnd === 0 && desktop.lastRefresh <= 2 * DAY + DESKTOP_REFRESH_AFTER_MS,
  desktop,
);
for (const ttl of [MIN, 5 * MIN, 15 * MIN, 3 * DAY]) {
  const day = simulateDesktop({ ttl, sessionMax: 5 * DAY }, 10 * HOUR);
  check(`Desktop ${ttl / MIN}m: angemeldet bis zum Schließen`, !day.unexpectedExpiry && day.endedAt === null, day);
}

if (failures > 0) {
  console.log(`sessionPolicyTest: ${failures} Fehler`);
  process.exit(1);
}
console.log('sessionPolicyTest: alle Pruefungen bestanden');
