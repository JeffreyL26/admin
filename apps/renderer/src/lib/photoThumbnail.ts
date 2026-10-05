import { PHOTO_THUMB_EDGE } from '@ohrganize/shared';

/** WebP-Qualität des Vorschaubilds: sichtbar verlustfrei bei Avatargröße. */
const QUALITY = 0.9;

/**
 * Vorschaubild eines Mitarbeiterfotos für Listen, Karten und Avatare:
 * mittiger quadratischer Ausschnitt mit höchstens PHOTO_THUMB_EDGE Pixeln
 * Kantenlänge (Rechnung dort), als WebP (klein, behält Transparenz). Das
 * Original wird unverändert daneben gespeichert; kleinere Fotos werden nicht
 * hochgerechnet.
 *
 * EXIF-Orientierung: `imageOrientation: 'from-image'` stellt Handyfotos so
 * auf, wie sie aufgenommen wurden (in Chromium ohnehin die Vorgabe, hier
 * ausdrücklich). Der zweite Schritt schneidet aus der bereits gedrehten
 * Bitmap aus und verkleinert mit `resizeQuality: 'high'`; ein einzelnes
 * drawImage von 4000 auf 512 Pixel wirkte körnig.
 *
 * `null`, wenn der Browser das Bild nicht lesen kann (etwa HEIC oder SVG):
 * Dann bleibt es beim Original, und die Anzeige fällt darauf zurück.
 */
export async function createPhotoThumbnail(file: File): Promise<File | null> {
  let source: ImageBitmap | null = null;
  let scaled: ImageBitmap | null = null;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const side = Math.min(source.width, source.height);
    if (side < 1) return null;
    const edge = Math.min(PHOTO_THUMB_EDGE, side);
    scaled = await createImageBitmap(
      source,
      Math.floor((source.width - side) / 2),
      Math.floor((source.height - side) / 2),
      side,
      side,
      { resizeWidth: edge, resizeHeight: edge, resizeQuality: 'high' },
    );
    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(scaled, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
    if (!blob) return null;
    // Kann der Browser kein WebP schreiben, liefert toBlob PNG.
    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    const base = file.name.replace(/\.[^.]*$/, '') || 'foto';
    return new File([blob], `${base}_vorschau.${extension}`, { type: blob.type });
  } catch {
    return null;
  } finally {
    source?.close();
    scaled?.close();
  }
}
