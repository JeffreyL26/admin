import { LICENSE_ERROR_CODES, LICENSE_STATE_HEADER, type LicenseState } from '@ohrganize/shared';

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

const TOKEN_KEY = 'ohrganize.portal.token';

let authToken: string | null = localStorage.getItem(TOKEN_KEY);

export function setToken(token: string | null): void {
  authToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function hasToken(): boolean {
  return authToken !== null;
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
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
    if (res.status === 401 && err.code !== 'UNAUTHORIZED_LOGIN') onUnauthorized?.();
    if (res.status === 403 && err.code === LICENSE_ERROR_CODES.EXPIRED) onLicenseState?.(true);
    throw new ApiRequestError(res.status, err.code, err.message, err.details);
  }
  return json as T;
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
