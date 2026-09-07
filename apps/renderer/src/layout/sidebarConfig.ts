import { useSyncExternalStore } from 'react';
import { NAV_SECTIONS, type NavSection } from './nav';

/**
 * Reihenfolge der Seitenleiste. Wie die Dashboard-Konfiguration eine
 * Arbeitsplatz-, keine Firmeneinstellung: im localStorage
 * (`ohrganize.sidebar`), nicht im Backend. Zwei Abschnitte sind fest:
 * das Dashboard steht immer an erster, „System“ (Einstellungen) immer an
 * zweiter Stelle; alles dazwischen ordnet die Person selbst.
 */
const STORAGE_KEY = 'ohrganize.sidebar';
const EVENT = 'ohrganize:sidebar';

/** Feste Plätze, in dieser Reihenfolge. Nicht verschiebbar. */
export const SIDEBAR_FIXED_KEYS = ['dashboard', 'system'] as const;

const isFixed = (key: string) => (SIDEBAR_FIXED_KEYS as readonly string[]).includes(key);

/** Standardreihenfolge der verschiebbaren Abschnitte (Reihenfolge in nav.ts). */
export const SIDEBAR_DEFAULT_ORDER: string[] = NAV_SECTIONS.map((s) => s.key).filter((k) => !isFixed(k));

export function loadSidebarOrder(): string[] {
  let stored: string[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) stored = parsed.filter((k): k is string => typeof k === 'string');
    }
  } catch {
    // Kein Speicher oder unlesbar: Standard.
  }
  // Unbekannte Schlüssel fallen weg, neue Abschnitte (nach einem Update)
  // hängen sich in Standardreihenfolge hinten an.
  const known = stored.filter((k) => SIDEBAR_DEFAULT_ORDER.includes(k));
  const missing = SIDEBAR_DEFAULT_ORDER.filter((k) => !known.includes(k));
  return [...known, ...missing];
}

export function saveSidebarOrder(order: string[]): void {
  try {
    if (order.join() === SIDEBAR_DEFAULT_ORDER.join()) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ohne Speicher gilt die Reihenfolge nur bis zum Neuladen.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function resetSidebarOrder(): void {
  saveSidebarOrder([...SIDEBAR_DEFAULT_ORDER]);
}

/** Abschnitte in Anzeigereihenfolge: Dashboard, System, dann die gewählte Ordnung. */
export function orderedSections(order: string[] = loadSidebarOrder()): NavSection[] {
  const byKey = new Map(NAV_SECTIONS.map((s) => [s.key, s]));
  const keys = [...SIDEBAR_FIXED_KEYS, ...order];
  return keys.map((k) => byKey.get(k)).filter((s): s is NavSection => s !== undefined);
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

// Snapshot als String, damit useSyncExternalStore bei gleichem Inhalt nicht
// neu rendert (ein frisches Array wäre jedes Mal „anders“).
const snapshot = () => loadSidebarOrder().join('|');

/** Reihenfolge der verschiebbaren Abschnitte, reagiert auf Änderungen aus den Einstellungen. */
export function useSidebarOrder(): string[] {
  const joined = useSyncExternalStore(subscribe, snapshot, snapshot);
  return joined === '' ? [] : joined.split('|');
}

/** Alle Abschnitte in Anzeigereihenfolge (für die Shell). */
export function useSidebarSections(): NavSection[] {
  return orderedSections(useSidebarOrder());
}
