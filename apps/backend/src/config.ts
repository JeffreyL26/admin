import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Datenverzeichnis: im Dev-Betrieb ./data neben dem Backend, im Desktop-Betrieb
// wird HRMONIC_DATA_DIR von Electron auf app.getPath('userData') gesetzt.
const dataDir = process.env.HRMONIC_DATA_DIR
  ? path.resolve(process.env.HRMONIC_DATA_DIR)
  : path.resolve(import.meta.dirname ?? process.cwd(), '../../..', 'apps/backend/data');

fs.mkdirSync(dataDir, { recursive: true });

const storageDir = path.join(dataDir, 'storage');
fs.mkdirSync(storageDir, { recursive: true });

// Das JWT-/Signatur-Secret wird pro Installation generiert und persistiert,
// damit Sitzungen und signierte Download-URLs Neustarts überleben.
function loadOrCreateSecret(): string {
  const secretPath = path.join(dataDir, 'secret.key');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

// CORS: ohne Konfiguration offen (Desktop-Client lädt von file://, Origin
// "null" — sicher, weil das Backend standardmäßig nur an 127.0.0.1 bindet).
// Für einen Server-Deploy hinter eigener Domain HRMONIC_CORS_ORIGIN auf eine
// kommaseparierte Origin-Liste setzen (z. B. https://portal.firma.de).
const corsOrigin: boolean | string[] = process.env.HRMONIC_CORS_ORIGIN
  ? process.env.HRMONIC_CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : true;

export const config = {
  dataDir,
  storageDir,
  dbPath: path.join(dataDir, 'hrmonic.db'),
  // Standard 127.0.0.1 (Desktop-Embedding). Für den Server-Deploy hinter
  // einem Reverse-Proxy HRMONIC_HOST setzen (z. B. 0.0.0.0 im Container).
  host: process.env.HRMONIC_HOST ?? '127.0.0.1',
  port: Number(process.env.HRMONIC_PORT ?? 3001),
  corsOrigin,
  secret: loadOrCreateSecret(),
  tokenTtl: '12h',
  downloadUrlTtlMs: 5 * 60 * 1000,
};
