/**
 * Seedet die Demo-Daten in die Datenbank der INSTALLIERTEN Desktop-App
 * (nicht in die Dev-Datenbank unter apps/backend/data).
 *
 * Die Desktop-App speichert ihre Daten in Electrons userData-Verzeichnis, das
 * sich aus dem Produktnamen "oHRganize" ableitet — hier ohne Electron
 * nachgebildet. Anschließend wird das reguläre Seed-Skript mit diesem
 * Datenverzeichnis ausgeführt.
 *
 * WICHTIG: Die Desktop-App muss dabei GESCHLOSSEN sein (SQLite-Dateisperre).
 * Aufruf:  npm run seed:desktop -- --force
 */
import path from 'node:path';
import os from 'node:os';

function desktopUserDataDir(): string {
  const appName = 'oHRganize';
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, appName);
}

// Muss VOR dem Import von seed.ts gesetzt sein — config.ts liest die Variable
// beim Laden aus (dieselbe Ableitung wie desktop/src/main.ts: userData + /data).
process.env.OHRGANIZE_DATA_DIR = path.join(desktopUserDataDir(), 'data');

// seed.ts bricht ab, sobald OHRGANIZE_DATA_DIR nicht auf die Dev-Datenbank zeigt
// (Schutz vor einem versehentlichen Lauf auf einem Kundensystem). Genau das ist
// hier aber die Absicht: Das Ziel ist die lokal installierte Desktop-App auf
// dem Entwicklungs- bzw. Demo-Rechner. Der Ausweg wird deshalb bewusst gesetzt
// — ebenfalls vor dem Import, weil die Sperre beim Laden von seed.ts greift.
process.env.OHRGANIZE_ALLOW_SEED = '1';

console.log(`Ziel-Datenverzeichnis (installierte App): ${process.env.OHRGANIZE_DATA_DIR}`);

await import('./seed.js');
