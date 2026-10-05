/**
 * Zentraler API-Client. Basis-URL:
 * - Desktop (Electron): vom Preload-Skript via window.ohrganize.apiBaseUrl injiziert
 *   (Backend läuft eingebettet auf zufälligem 127.0.0.1-Port)
 * - Browser-Dev: http://127.0.0.1:3001
 */
import {
  CLIENT_VERSION_HEADER,
  LICENSE_ERROR_CODES,
  LICENSE_STATE_HEADER,
  tokenLifetimeMs,
  tokenSessionInfo,
  type LicenseState,
  type TokenState,
} from '@ohrganize/shared';

declare global {
  interface Window {
    ohrganize?: {
      apiBaseUrl: string;
      platform: string;
      appVersion: string;
      /** Fenster-Controls der eigenen Titelleiste (nur Electron). */
      window?: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizeChange: (cb: (max: boolean) => void) => () => void;
        onFullscreenChange: (cb: (fs: boolean) => void) => () => void;
      };
      /** App-Aktionen des Titelleisten-Menüs (nur Electron). */
      app?: {
        reload: () => void;
        toggleDevTools: () => void;
        toggleFullscreen: () => void;
        zoom: (delta: number) => void;
        openExternal: (url: string) => void;
      };
    };
  }
}

/** True, wenn die App im Electron-Desktop läuft (nicht im Browser-Dev). */
export const IS_ELECTRON = Boolean(window.ohrganize?.window);

export const API_BASE = window.ohrganize?.apiBaseUrl ?? 'http://127.0.0.1:3001';

/**
 * Version dieser App für den Abgleich mit dem Backend (core/version.ts).
 * Im Browser-Dev fehlt window.ohrganize — dann geht der Header nicht mit, und
 * das Backend prüft folgerichtig nichts. Das ist gewollt: Geprüft wird, wer
 * sich als Client zu erkennen gibt.
 */
const CLIENT_VERSION = window.ohrganize?.appVersion;

/**
 * Token der laufenden Sitzung in sessionStorage: Es übersteht das Neuladen
 * über das Titelleistenmenü und endet mit dem Schließen des Fensters. Solange
 * die App läuft, verlängert auth/AuthContext.tsx es nach zehn Minuten,
 * spätestens nach der halben Laufzeit (refreshToken); die lange Laufzeit des Desktop-Tokens im Backend
 * überbrückt nur den Ruhezustand des Rechners.
 */
const TOKEN_KEY = 'ohrganize.token';
/**
 * Empfangszeitpunkt des Tokens nach der Uhr DIESES Rechners (ms). Bewusst
 * nicht das iat aus dem Token: Im Serverbetrieb gehen Arbeitsplatz- und
 * Serveruhr auseinander, und eine vorgehende Uhr hielte jedes frische Token
 * für alt und verlängerte im Minutentakt.
 */
const TOKEN_AT_KEY = 'ohrganize.token.at';

// Frühere Fassungen hielten das Token in localStorage, wo es das Schließen
// der App überdauerte. Ein dort liegengebliebenes Token einmal entfernen.
localStorage.removeItem(TOKEN_KEY);

let authToken: string | null = sessionStorage.getItem(TOKEN_KEY);
let tokenReceivedAt = Number(sessionStorage.getItem(TOKEN_AT_KEY)) || 0;

export function setToken(token: string | null): void {
  authToken = token;
  tokenReceivedAt = token ? Date.now() : 0;
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(TOKEN_AT_KEY, String(tokenReceivedAt));
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_AT_KEY);
  }
}

export function hasToken(): boolean {
  return authToken !== null;
}

/** Token für eigene fetch-Aufrufe (Exporte als Datei); null, wenn abgemeldet. */
export function getToken(): string | null {
  return authToken;
}

/** Alter des Tokens seit Empfang in ms (lokale Uhr); null ohne Token. */
export function tokenAgeMs(): number | null {
  return authToken === null ? null : Date.now() - tokenReceivedAt;
}

/** Laufzeit des Tokens laut Server (exp - iat) in ms; null ohne Token oder Felder. */
export function tokenLifetime(): number | null {
  return tokenLifetimeMs(authToken);
}

/** Alter, Laufzeit und Sitzungsende des Tokens für die Sitzungsregeln (packages/shared/src/session.ts). */
export function tokenState(): TokenState {
  return { tokenAgeMs: tokenAgeMs(), ...tokenSessionInfo(authToken) };
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/**
 * Lizenzsignal aus dem laufenden Verkehr. Die verbindliche Quelle für den
 * Lizenzzustand ist das Feld `license` in Login und /api/auth/me
 * (auth/AuthContext.tsx); hier geht es nur darum, einen Wechsel MITTEN in der
 * Sitzung zu bemerken (Kulanz läuft ab, jemand spielt am Nebenplatz eine Lizenz
 * ein). Zwei Quellen:
 * - der Header `x-ohrganize-license`, den das Backend auf jede angemeldete
 *   Antwort setzt (öffentliche Routen wie der Login tragen ihn nicht) —
 *   lesbar aber nur, wenn CORS ihn freigibt; sonst liefert `headers.get` null
 *   und dieser Zweig bleibt still;
 * - ein 403 `LICENSE_EXPIRED` auf einen Schreibzugriff — der zuverlässige Weg,
 *   weil er ohne Header-Freigabe auskommt.
 * Der Handler bekommt nur den Zustand; die Vertragsdaten holt er sich selbst
 * über /api/auth/me. Gemeldet wird nur ein Wechsel, sonst feuerte jede Antwort.
 */
let onLicenseState: ((state: LicenseState) => void) | null = null;
let lastLicenseState: string | null = null;
export function setLicenseStateHandler(fn: ((state: LicenseState) => void) | null): void {
  onLicenseState = fn;
}
function noteLicenseState(state: string | null): void {
  if (state === null || state === lastLicenseState) return;
  lastLicenseState = state;
  onLicenseState?.(state as LicenseState);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  // Token beim Absenden festhalten: Ein 401 auf ein inzwischen ersetztes Token
  // (Verlängerung, Passwortwechsel, neue Anmeldung) beendet nicht die neue
  // Sitzung.
  const sentToken = authToken;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}),
      ...(CLIENT_VERSION ? { [CLIENT_VERSION_HEADER]: CLIENT_VERSION } : {}),
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  noteLicenseState(res.headers.get(LICENSE_STATE_HEADER));
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    // Nur ein 401 auf ein mitgesendetes, noch aktuelles Token beendet die
    // Sitzung. Ohne Token (etwa ein falsches Passwort auf der Anmeldeseite)
    // gibt es nichts zu beenden.
    if (res.status === 401 && sentToken !== null && authToken === sentToken) onUnauthorized?.();
    // Nur-Lese-Betrieb erst jetzt bemerkt (Header nicht lesbar, Zustand seit
    // dem Login gekippt): den Zustand nachziehen, damit das Banner erscheint.
    if (res.status === 403 && err.code === LICENSE_ERROR_CODES.EXPIRED) noteLicenseState('expired');
    throw new ApiRequestError(res.status, err.code, err.message, err.details);
  }
  return json as T;
}

let refreshing: Promise<void> | null = null;

/**
 * Sitzung verlängern (POST /api/auth/refresh), höchstens ein Aufruf zugleich.
 * Die Antwort gilt nur, wenn das Token inzwischen weder ersetzt noch entfernt
 * wurde: Ein Logout während des Aufrufs bleibt ein Logout. Ein 401 meldet wie
 * jeder Aufruf über den Unauthorized-Handler ab; Netzfehler werfen, und der
 * Aufrufer versucht es beim nächsten Anlass erneut.
 */
export function refreshToken(): Promise<void> {
  if (refreshing) return refreshing;
  const sent = authToken;
  if (sent === null) return Promise.resolve();
  refreshing = request<{ token: string }>('POST', '/api/auth/refresh')
    .then((res) => {
      if (authToken === sent && res?.token) setToken(res.token);
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Datei hochladen → files-Eintrag. */
export async function uploadFile(file: File): Promise<{ file: { id: number; original_name: string } }> {
  const form = new FormData();
  form.append('file', file);
  return api.post('/api/files', form);
}

/** Signierte Download-URL holen und Download im Browser/OS anstoßen. */
export async function downloadFile(fileId: number): Promise<void> {
  return downloadSignedFile(`/api/files/${fileId}/sign`);
}

/**
 * Wie downloadFile, aber über eine beliebige Signier-Route (POST). Nötig für
 * Self-Service-Anhänge (POST /api/me/announcements/:id/attachments/:fileId/sign),
 * die ihre Berechtigung an der Zielgruppe prüfen statt am Bereich `personal`.
 */
export async function downloadSignedFile(signPath: string): Promise<void> {
  const { url } = await api.post<{ url: string }>(signPath);
  const a = document.createElement('a');
  a.href = `${API_BASE}${url}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
