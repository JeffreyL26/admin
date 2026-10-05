import { useCallback, useRef, useState, type RefCallback } from 'react';

/**
 * Meldet einmalig, dass ein Element in die Nähe des sichtbaren Bereichs
 * gekommen ist, und bleibt danach dabei (kein Entladen beim Wegscrollen).
 *
 * Gedacht für Fotos in großen Listen (Verzeichnis, Organigramm, Führung):
 * Erst die sichtbare Karte holt ihr Bild. Ohne das fielen beim Öffnen einer
 * Liste mit 2000 Personen 2000 Abrufe an, beim Selbstsignieren samt
 * Audit-Zeile je Foto.
 *
 * Ein gemeinsamer Observer für alle Elemente statt eines je Karte. Wurzel ist
 * der Viewport: Er erfasst auch Karten auf einer per Transform bewegten
 * Fläche (Organigramm); was ein Container mit `overflow` abschneidet, zählt
 * nicht als sichtbar. Der Rand lädt knapp außerhalb des Bildes schon vor,
 * damit beim Scrollen keine Initialen aufblitzen.
 *
 * `active = false` beobachtet gar nicht erst (Person ohne Foto).
 */
export function useSeenOnce<T extends Element>(active = true): [RefCallback<T>, boolean] {
  const [seen, setSeen] = useState(false);
  const observed = useRef<T | null>(null);
  const ref = useCallback(
    (node: T | null) => {
      if (observed.current) unobserve(observed.current);
      observed.current = null;
      if (!node || seen || !active) return;
      if (!observe(node, () => setSeen(true))) {
        setSeen(true);
        return;
      }
      observed.current = node;
    },
    [seen, active],
  );
  return [ref, seen];
}

const ROOT_MARGIN = '200px';

const callbacks = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

/** `false`, wenn es keinen IntersectionObserver gibt: dann gilt alles als sichtbar. */
function observe(element: Element, onSeen: () => void): boolean {
  if (typeof IntersectionObserver === 'undefined') return false;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = callbacks.get(entry.target);
        unobserve(entry.target);
        callback?.();
      }
    },
    { rootMargin: ROOT_MARGIN },
  );
  callbacks.set(element, onSeen);
  observer.observe(element);
  return true;
}

function unobserve(element: Element): void {
  callbacks.delete(element);
  observer?.unobserve(element);
}
