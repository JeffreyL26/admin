/**
 * Lizenzschluessel des Anbieters lesen.
 *
 * Der private Schluessel gehoert NICHT ins Register und nicht ins Repository:
 * Wer das Register hat, sieht, wer welche Lizenz hat; wer den Schluessel hat,
 * kann jede Lizenz erzeugen. Deshalb liegt er getrennt (Vorgabe:
 * `$OHRGANIZE_CONSPECTUS_DIR/schluessel/<kid>.pem`, ueberschreibbar mit
 * `--key`) und ist mit einer Passphrase geschuetzt
 * (OHRGANIZE_LICENSE_PASSPHRASE, dieselbe Variable wie im Werkzeug).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TRUSTED_LICENSE_KEYS_RAW } from '@ohrganize/backend/core/licenseKeys';
import { privateKeyMatches } from '@ohrganize/backend/core/licenseIssue';
import { ConspectusError, registerDir } from './db.js';

export function keyDir(): string {
  const dir = path.join(registerDir(), 'schluessel');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function loadPrivateKey(kid: string, explicitPath?: string): crypto.KeyObject {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(keyDir(), `${kid}.pem`);
  if (!fs.existsSync(file)) {
    throw new ConspectusError(
      `Privater Lizenzschluessel nicht gefunden: ${file}\n` +
        'Erzeugen mit `npm run lizenz -- keygen --out <verzeichnis> --kid <kid>` und die\n' +
        `Datei nach ${keyDir()} legen, oder den Pfad mit --key angeben.`,
    );
  }
  const passphrase = process.env.OHRGANIZE_LICENSE_PASSPHRASE?.trim() || undefined;
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: fs.readFileSync(file, 'utf8'), passphrase });
  } catch (err) {
    throw new ConspectusError(
      `Privater Schluessel nicht lesbar (${(err as Error).message}). ` +
        'Passphrase in OHRGANIZE_LICENSE_PASSPHRASE gesetzt?',
    );
  }
  // Gegenprobe: Passt der Schluessel zu dem kid, unter dem er ausgestellt
  // werden soll? Ohne sie entstuenden Dateien, die jeder Server fuer
  // unbrauchbar haelt, und der Fehler faellt erst beim Kunden auf.
  const trusted = TRUSTED_LICENSE_KEYS_RAW.find((k) => k.kid === kid);
  if (trusted && !privateKeyMatches(key, trusted.publicKey)) {
    throw new ConspectusError(
      `Der Schluessel ${file} passt nicht zum eingebauten oeffentlichen Schluessel mit kid "${kid}".\n` +
        'Eine damit ausgestellte Datei wuerde von jedem Server abgelehnt.',
    );
  }
  if (!trusted) {
    console.warn(
      `Achtung: kid "${kid}" steht nicht in core/licenseKeys.ts. Server ohne passenden ` +
        'Eintrag halten die Datei fuer unbrauchbar (docs/lizenzierung.md, Abschnitt 3.1).',
    );
  }
  return key;
}

/** Vorgabe-kid: der juengste eingebaute Schluessel (letzter Eintrag). */
export function defaultKid(): string {
  const last = TRUSTED_LICENSE_KEYS_RAW[TRUSTED_LICENSE_KEYS_RAW.length - 1];
  if (!last) throw new ConspectusError('In core/licenseKeys.ts steht kein Schluessel.');
  return last.kid;
}
