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
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    if (res.status === 401 && err.code !== 'UNAUTHORIZED_LOGIN') onUnauthorized?.();
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
