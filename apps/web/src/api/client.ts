import {
  LICENSE_ERROR_CODES,
  LICENSE_STATE_HEADER,
  tokenLifetimeMs,
  tokenSessionInfo,
  type LicenseState,
  type TokenState,
} from '@ohrganize/shared';

/**
 * API-Client des Mitarbeitenden-Portals.
 *
 * Basis-URL:
 * - Dev: http://127.0.0.1:3001 (Backend aus `npm run dev`)
 * - Prod: standardmäßig same-origin ('') — im Deploy liegt das Portal hinter
 *   einem Reverse-Proxy, der /api/* an das Backend weiterreicht
 *   (siehe docs/web-portal.md). Abweichend per VITE_API_BASE konfigurierbar.
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://127.0.0.1:3001' : '');

/**
 * Token in localStorage: Alle Tabs des Portals teilen eine Sitzung. Ein in
 * einem Tab verlängertes Token kommt über das storage-Ereignis in den anderen
 * an, ein Logout in einem Tab meldet alle ab (unten).
 */
const TOKEN_KEY = 'ohrganize.portal.token';
/**
 * Empfangszeitpunkt des Tokens nach der Uhr dieses Geräts (ms), für alle Tabs.
 * Bewusst nicht das iat aus dem Token: Geräte- und Serveruhr gehen
 * auseinander, und eine vorgehende Uhr hielte jedes frische Token für alt.
 */
const TOKEN_AT_KEY = 'ohrganize.portal.token.at';

let authToken: string | null = localStorage.getItem(TOKEN_KEY);
let tokenReceivedAt = Number(localStorage.getItem(TOKEN_AT_KEY)) || 0;

export function setToken(token: string | null): void {
  authToken = token;
  tokenReceivedAt = token ? Date.now() : 0;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_AT_KEY, String(tokenReceivedAt));
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_AT_KEY);
  }
}

export function hasToken(): boolean {
  return authToken !== null;
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

let onSignedOutElsewhere: (() => void) | null = null;
/** Ein anderer Tab hat abgemeldet (Logout, Leerlauf, abgelaufene Sitzung). */
export function setSignedOutElsewhereHandler(fn: () => void): void {
  onSignedOutElsewhere = fn;
}

// storage feuert nur in den ANDEREN Tabs desselben Ursprungs. key null heißt
// localStorage.clear().
window.addEventListener('storage', (e) => {
  if (e.storageArea !== localStorage) return;
  if (e.key === TOKEN_AT_KEY) {
    tokenReceivedAt = Number(e.newValue) || 0;
  } else if (e.key === TOKEN_KEY || e.key === null) {
    authToken = e.key === null ? null : e.newValue;
    if (authToken === null) {
      tokenReceivedAt = 0;
      onSignedOutElsewhere?.();
    }
  }
});

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
 * Nur-Lese-Betrieb (Lizenz abgelaufen): Der Kontext hält das Bit aus Login
 * und /api/auth/me; dieser Handler hält es zwischen zwei Anmeldungen aktuell —
 * aus dem Zustands-Header, den das Backend auf jede Antwort setzt, und aus
 * einem 403 LICENSE_EXPIRED, falls ein Client noch für schreibbar hält, was
 * der Server inzwischen sperrt.
 */
let onLicenseState: ((readOnly: boolean) => void) | null = null;
export function setLicenseHandler(fn: (readOnly: boolean) => void): void {
  onLicenseState = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Bei FormData setzt der Browser Content-Type samt multipart-Boundary
  // selbst — ein eigener Header würde die Boundary abschneiden und das
  // Backend fände keine Datei mehr.
  const isForm = body instanceof FormData;
  // Token beim Absenden festhalten: Ein 401 auf ein inzwischen ersetztes Token
  // (Verlängerung, auch in einem anderen Tab, oder Passwortwechsel) beendet
  // nicht die neue Sitzung.
  const sentToken = authToken;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}),
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  // Same-origin (Prod hinter dem Reverse-Proxy) ist der Header lesbar; über
  // Origins hinweg (Dev 5174 → 3001) verbirgt CORS ihn ohne exposedHeaders —
  // dann bleibt null, und das JSON-Feld `license` aus Login und /api/auth/me
  // sowie die 403-Auswertung unten sind maßgeblich. Das Portal kennt nur ein Bit.
  const licenseState = res.headers.get(LICENSE_STATE_HEADER) as LicenseState | null;
  if (licenseState !== null) onLicenseState?.(licenseState === 'expired');
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    // Nur ein 401 auf ein mitgesendetes, noch aktuelles Token beendet die
    // Sitzung. Ohne Token (etwa ein falsches Passwort auf der Anmeldeseite)
    // gibt es nichts zu beenden.
    if (res.status === 401 && sentToken !== null && authToken === sentToken) onUnauthorized?.();
    if (res.status === 403 && err.code === LICENSE_ERROR_CODES.EXPIRED) onLicenseState?.(true);
    throw new ApiRequestError(res.status, err.code, err.message, err.details);
  }
  return json as T;
}

let refreshing: Promise<void> | null = null;

/**
 * Sitzung verlängern (POST /api/auth/refresh), höchstens ein Aufruf zugleich.
 * Wann, entscheidet auth/AuthContext.tsx (nur nach echter Aktivität). Die
 * Antwort gilt nur, wenn das Token inzwischen weder ersetzt noch entfernt
 * wurde: Ein Logout während des Aufrufs bleibt ein Logout. Ein 401 meldet über
 * den Unauthorized-Handler ab; Netzfehler werfen, der nächste Anlass versucht
 * es erneut.
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
};

/**
 * Datei mit Metadaten als multipart/form-data hochladen.
 *
 * Anders als in der Desktop-App gibt es im Portal keinen generischen
 * `/api/files`-Upload (die Route ist der HR-Administration vorbehalten): Der
 * Pfad wird deshalb übergeben, aktuell `/api/me/documents`. Leere Felder
 * werden weggelassen, damit das Backend seine Vorgabewerte greifen lässt.
 */
export async function uploadFile<T>(
  path: string,
  file: File,
  fields: Record<string, string | undefined> = {},
): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== '') form.append(key, value);
  }
  return api.post<T>(path, form);
}

/**
 * Signierte Download-URL holen und den Download anstoßen.
 *
 * Die Antwort enthält einen RELATIVEN Pfad (`/api/files/…`) — er muss mit
 * API_BASE zusammengesetzt werden, sonst zeigt der Link im Dev-Betrieb auf den
 * Vite-Server statt auf das Backend. Der Download braucht keinen Auth-Header:
 * die Signatur in der URL ist der Nachweis, deshalb genügt ein <a>-Klick.
 */
export async function downloadFile(signPath: string): Promise<void> {
  const { url } = await api.post<{ url: string }>(signPath);
  const a = document.createElement('a');
  a.href = `${API_BASE}${url}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
