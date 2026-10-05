import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { API_BASE } from '../api/client';

/**
 * Foto einer Person in Organigramm und Kolleg:innen-Verzeichnis.
 *
 * `photoUrl` kommt signiert aus der Listenantwort (Vorschaubild, sonst
 * Original) und bleibt innerhalb eines Zeitfensters gleich (signPhotoUrl in
 * core/files.ts): Ein Refetch ändert das src-Attribut dann nicht, und das
 * Bild wird nicht neu geladen. Gilt der Link nicht mehr (die Karte wurde erst
 * nach Ablauf sichtbar, `loading="lazy"`), scheitert das Bild: Dann zeigt der
 * Avatar die Initialen, und die Abfrage, die den Link geliefert hat, holt
 * frische Links. Einen
 * gescheiterten Link versucht der Avatar nie zweimal (keine Schleife); ein
 * neuer Link aus dem Refetch lädt wieder.
 */
export function usePhotoSrc(photoUrl: string | null | undefined): { src: string | null; onError: () => void } {
  const qc = useQueryClient();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = photoUrl && photoUrl !== failedUrl ? `${API_BASE}${photoUrl}` : null;
  return {
    src,
    onError: () => {
      setFailedUrl(photoUrl ?? null);
      if (photoUrl) refreshPhotoLinks(qc, photoUrl);
    },
  };
}

/** Letzte Erneuerung je Abfrage (queryHash), für die Drossel unten. */
const refreshedAt = new Map<string, number>();

/**
 * Nur die aktiven Abfragen neu holen, deren Daten den gescheiterten Link
 * enthalten, nicht alles auf der Seite. Je Abfrage höchstens einmal je halbe
 * Minute: Meist scheitern mehrere Fotos derselben Liste zugleich.
 */
function refreshPhotoLinks(qc: QueryClient, photoUrl: string): void {
  const now = Date.now();
  for (const [hash, at] of refreshedAt) if (now - at >= 30_000) refreshedAt.delete(hash);
  void qc.refetchQueries({
    type: 'active',
    predicate: (q) => {
      if (q.state.data === undefined || refreshedAt.has(q.queryHash)) return false;
      if (!JSON.stringify(q.state.data).includes(photoUrl)) return false;
      refreshedAt.set(q.queryHash, now);
      return true;
    },
  });
}
