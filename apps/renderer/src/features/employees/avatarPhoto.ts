import { useSeenOnce } from '../../lib/useSeenOnce';
import { usePhotoUrl } from './api';

/** Die Fotospalten einer Person, wie Listen, Karten und die Personalakte sie liefern. */
export interface PersonPhoto {
  photo_file_id?: number | null;
  photo_thumb_file_id?: number | null;
  /** Vom Server mitsigniert, zeigt auf dieselbe Datei wie avatarFileId. */
  photo_url?: string | null;
}

/**
 * Datei für Avatare und Karten: das Vorschaubild, ohne Vorschaubild (Bestand
 * von vorher) das Original. Dieselbe Regel wie signPhotoUrl im Backend, damit
 * der mitgelieferte Link und der Cache-Schlüssel dieselbe Datei meinen.
 * Das Vorschaubild reicht für jede Avatargröße bis zum größten Zoom
 * (Rechnung an PHOTO_THUMB_EDGE in packages/shared).
 */
export function avatarFileId(person: PersonPhoto | null | undefined): number | null {
  return person?.photo_thumb_file_id ?? person?.photo_file_id ?? null;
}

/**
 * Foto eines Avatars in Listen und Karten: Vorschaubild statt Original, und
 * erst geladen, wenn das Element in Sichtnähe kommt. `ref` gehört an das
 * Element, das den Avatar zeichnet; `src` ist die Object-URL oder undefined
 * (dann Initialen); `seen`, ob das Element schon in Sichtnähe war.
 */
export function useAvatarPhoto<T extends Element = HTMLSpanElement>(person: PersonPhoto | null | undefined) {
  const fileId = avatarFileId(person);
  const [ref, seen] = useSeenOnce<T>(fileId !== null);
  const photo = usePhotoUrl(fileId, person?.photo_url, seen);
  return { ref, src: photo.data, seen };
}
