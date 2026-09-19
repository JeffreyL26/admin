/**
 * Textdateien lesen, wie Windows sie liefert.
 *
 * Der Bericht einer Windows-Instanz entsteht mit
 *   node status.cjs --data-dir ... --json > bericht.json
 * und Windows PowerShell 5.1 schreibt bei `>` UTF-16 LE mit BOM (je nach
 * Einstellung auch UTF-8 mit BOM); Excel exportiert CSV ebenfalls mit BOM.
 * `JSON.parse` lehnt beides ab ("Unexpected token"), und der Fehler faellt
 * erst beim Import auf, nachdem die Datei schon einmal den Weg vom Kunden
 * hierher gemacht hat. Deshalb wird die Kodierung an der BOM erkannt statt
 * vorausgesetzt; ohne BOM gilt UTF-8.
 */
import fs from 'node:fs';

export function readTextFile(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    // swap16 verlangt eine gerade Laenge; ein ueberzaehliges Byte ist Muell.
    return (body.length % 2 === 0 ? body : body.subarray(0, body.length - 1)).swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}
