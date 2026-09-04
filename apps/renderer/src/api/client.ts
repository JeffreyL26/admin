/**
 * Zentraler API-Client. Basis-URL:
 * - Desktop (Electron): vom Preload-Skript via window.ohrganize.apiBaseUrl injiziert
 *   (Backend läuft eingebettet auf zufälligem 127.0.0.1-Port)
 * - Browser-Dev: http://127.0.0.1:3001
 */
import { CLIENT_VERSION_HEADER } from '@ohrganize/shared';

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

let authToken: string | null = localStorage.getItem('ohrganize.token');

export function setToken(token: string | null): void {
  authToken = token;
  if (token) localStorage.setItem('ohrganize.token', token);
  else localStorage.removeItem('ohrganize.token');
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
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(CLIENT_VERSION ? { [CLIENT_VERSION_HEADER]: CLIENT_VERSION } : {}),
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
  const { url } = await api.post<{ url: string }>(`/api/files/${fileId}/sign`);
  const a = document.createElement('a');
  a.href = `${API_BASE}${url}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
