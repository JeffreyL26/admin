import { centsToDecimal, todayIsoLocal } from '@ohrganize/shared';
import { API_BASE, ApiRequestError, getToken } from '../../api/client';
import type { BadgeTone } from '../../components/ui';

/** '1.234,56' | '1234,56' | '1234.56' → Integer-Cent (null bei ungültig). */
export function parseEuroInput(input: string): number | null {
  const normalized = input.trim().replace(/\./g, '').replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/** Integer-Cent → Eingabewert '1234,56'. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return centsToDecimal(cents);
}

/** 'YYYY-MM' → 'MM/JJJJ'. */
export function formatMonth(month: string | null | undefined): string {
  if (!month) return '—';
  const [y, m] = month.split('-');
  return `${m}/${y}`;
}

// Lokal statt UTC: am Monatsersten vor 1/2 Uhr nachts wäre sonst der Vormonat vorausgewählt.
export function currentMonth(): string {
  return todayIsoLocal().slice(0, 7);
}

/**
 * Datei-Download eines auth-pflichtigen GET-Endpunkts (Exporte). Den
 * Dateinamen bestimmt der Server (Content-Disposition, per CORS
 * freigegeben); `fallbackFilename` greift nur, wenn die Kopfzeile fehlt.
 * Fehler kommen als ApiRequestError wie bei jedem anderen Aufruf, mit
 * `details` der Antwort (etwa dem DATEV-Pruefbericht bei 409).
 */
export async function downloadAuthenticated(path: string, fallbackFilename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiRequestError(
      res.status,
      json?.error?.code ?? 'UNKNOWN',
      json?.error?.message ?? `Export fehlgeschlagen (HTTP ${res.status})`,
      json?.error?.details,
    );
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const STATUS_TONES: Record<string, BadgeTone> = {
  // Läufe
  offen: 'yellow',
  geprueft: 'blue',
  exportiert: 'green',
  // Anträge
  beantragt: 'yellow',
  genehmigt: 'green',
  abgelehnt: 'red',
  // Boni
  geplant: 'neutral',
  freigegeben: 'blue',
  ausgezahlt: 'green',
  // Rechnungen
  bezahlt: 'green',
  // Bescheinigungen
  erstellt: 'blue',
  ausgehaendigt: 'green',
};

export const FLAG_TONES: Record<string, BadgeTone> = {
  neueintritt: 'green',
  austritt: 'yellow',
  gehaltsaenderung: 'blue',
  unbezahlte_abwesenheit: 'yellow',
  lohnfortzahlung_ende: 'red',
};
