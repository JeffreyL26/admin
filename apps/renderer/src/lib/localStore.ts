/**
 * Bausteine fuer kleine Geraete-Staende im localStorage (Einrichtungs-
 * Assistent, Seiten-Einfuehrungen; Seitenleiste und Dashboard folgen demselben
 * Muster): Lesen und Schreiben ohne Absturz bei fehlendem Speicher, und das
 * Abonnement auf Aenderungen im selben Fenster (eigenes Ereignis) und in anderen
 * Fenstern (`storage`).
 */
export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kein Speicher: Der Stand gilt nur bis zum Neuladen.
  }
}

export function subscribeTo(eventName: string) {
  return (callback: () => void) => {
    window.addEventListener(eventName, callback);
    window.addEventListener('storage', callback);
    return () => {
      window.removeEventListener(eventName, callback);
      window.removeEventListener('storage', callback);
    };
  };
}

/** Platzhalter `{name}` in einem Text fuellen; unbekannte bleiben stehen. */
export function fillPlaceholders(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
