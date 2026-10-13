/**
 * Windows-1252 (ANSI), der Zeichensatz, den LODAS und Lohn und Gehalt beim
 * ASCII-Import erwarten. Node bringt nur einen Decoder dafuer mit; der
 * Encoder hier ist bewusst klein: Zeichen unter 0x80 und von 0xA0 bis 0xFF
 * sind ihr eigenes Byte, die Sonderzeichen des Bereichs 0x80 bis 0x9F
 * (Euro, typografische Anfuehrungszeichen, Gedankenstriche, Š, Ž, Œ, Ÿ)
 * stehen in CP1252_EXTRA. Alles andere wird '?', der Pruefbericht nennt es
 * vorher (cp1252Unencodable in packages/shared/src/datev.ts). Beide arbeiten
 * auf der NFC-Form, sonst wuerde ein zusammengesetztes ü zu "u?".
 */
import { cp1252Byte } from '@ohrganize/shared';

export function encodeCp1252(text: string): Buffer {
  const normalized = text.normalize('NFC');
  // Jeder Codepunkt wird genau ein Byte; mehr Bytes als UTF-16-Einheiten gibt es nie.
  const out = Buffer.allocUnsafe(normalized.length);
  let n = 0;
  for (const ch of normalized) {
    out[n++] = cp1252Byte(ch.codePointAt(0)!) ?? 0x3f;
  }
  return out.subarray(0, n);
}
