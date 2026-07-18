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

export const config = {
  dataDir,
  storageDir,
  dbPath: path.join(dataDir, 'hrmonic.db'),
  host: '127.0.0.1',
  port: Number(process.env.HRMONIC_PORT ?? 3001),
  secret: loadOrCreateSecret(),
  tokenTtl: '12h',
  downloadUrlTtlMs: 5 * 60 * 1000,
};
