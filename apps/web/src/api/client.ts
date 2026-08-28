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

const TOKEN_KEY = 'hrmonic.portal.token';

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
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
