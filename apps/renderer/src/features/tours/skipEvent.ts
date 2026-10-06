/**
 * "Es wurde etwas uebersprungen": Einrichtungs-Assistent und Einfuehrungen
 * melden es, die Shell zeigt die gruene Meldung zur Dokumentation
 * (SkipNoticeBridge.tsx). Reines Ereignis, damit die Stores nichts von React kennen.
 */
export const SKIP_EVENT = 'ohrganize:skipped';

export function announceSkip(): void {
  window.dispatchEvent(new Event(SKIP_EVENT));
}
