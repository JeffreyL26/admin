/**
 * Lesen bis zur gewünschten Länge oder zum Dateiende.
 *
 * fs.readSync darf weniger liefern als verlangt; wer das übersieht, hält
 * einen kurzen Lesevorgang für das Dateiende. Rein und ohne config.ts, damit
 * db/encryption.ts, core/fileCrypto.ts und die Betreiberwerkzeuge es nutzen
 * können.
 */
import fs from 'node:fs';

/** Füllt `target` ab `position`; Rückgabe ist die Zahl gelesener Bytes (weniger nur am Dateiende). */
export function readFullSync(fd: number, target: Buffer, position: number): number {
  let read = 0;
  while (read < target.length) {
    const n = fs.readSync(fd, target, read, target.length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}
