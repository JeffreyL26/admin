/**
 * Gemeinsames Handwerkszeug der Betreiberwerkzeuge (status, admin-reset,
 * migrate-check).
 *
 * Die wichtigste Regel steht hier als Kommentar, weil sie sonst beim naechsten
 * Werkzeug vergessen wird: Diese Skripte importieren NIEMALS `config.ts`.
 * Schon der Import legt Verzeichnisse an und erzeugt ein `secret.key` (mit den
 * Rechten des aufrufenden Kontos). Ein Betreiber, der als root schnell den
 * Zustand einer Kundeninstanz nachsieht, haette damit root-eigene Dateien im
 * Datenverzeichnis des Dienstbenutzers hinterlassen, und die Instanz startet
 * beim naechsten Mal nicht mehr. Das Datenverzeichnis kommt deshalb
 * ausschliesslich aus --data-dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { VARIANT, VARIANT_MARKER } from '@variant-manifest';
import { APP_VERSION } from '../core/version.js';
import { openDatabase } from '../db/encryption.js';
import { STORAGE_CONVERSION_DIR } from '../core/fileCrypto.js';
import { errorText } from '../core/errorText.js';

/**
 * Kopfzeile jedes Werkzeugs: Version, Ausgabe und der Variantenmarker.
 *
 * Der Marker steht hier nicht nur zur Information: Er ist die Zeichenkette,
 * an der `scripts/check-variant.mjs` und das Release-Skript ein Bundle einer
 * Variante zuordnen. Ohne eine Verwendung im Code liesse esbuild ihn beim
 * Buendeln weg, und ein Werkzeug der falschen Ausgabe waere nicht mehr als
 * solches erkennbar.
 */
export function variantBanner(): string {
  return `oHRganize ${APP_VERSION} (${VARIANT.label}, ${VARIANT.id}) ${VARIANT_MARKER}`;
}

export function fail(message: string): never {
  console.error(`Abbruch: ${message}`);
  process.exit(1);
}

/** Einfacher Argumentleser: --name wert, --flag. */
export function parseArgs(argv: string[]): { values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next;
      i++;
    } else {
      flags.add(name);
    }
  }
  return { values, flags };
}

/**
 * Werkzeuge laufen als Dienstbenutzer, nicht als root.
 *
 * Grund: Jeder Zugriff auf eine SQLite-Datenbank im WAL-Modus legt `-wal` und
 * `-shm` daneben an, auch ein lesender. Als root gehoeren die beiden dann
 * root, und die naechste Schreibsperre des Dienstes scheitert an den Rechten.
 * Der Betreiber ruft die Werkzeuge deshalb ueber
 * `runuser -u ohrganize -- node ...` auf (provision.sh macht das).
 *
 * Windows kennt kein `process.getuid`; dort greift die Regel nicht (die
 * Rechte haengen an NTFS-ACLs, und der Dienst laeuft unter einem eigenen
 * Konto). Deshalb wird die Funktion erst gar nicht aufgerufen, wenn es
 * getuid nicht gibt.
 */
export function refuseRoot(hint: string): void {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid !== 'function') return; // Windows
  if (getuid.call(process) !== 0) return;
  fail(
    `Dieses Werkzeug darf nicht als root laufen: Ein Zugriff als root legt SQLite-Hilfsdateien ` +
      `(-wal, -shm) mit falschem Eigentuemer an, und der Dienst startet danach nicht mehr. ` +
      `Bitte als Dienstbenutzer aufrufen, z. B.:\n  ${hint}`,
  );
}

export interface DataDir {
  dir: string;
  db: string;
  license: string;
  initialPassword: string;
  storage: string;
}

/** Pfade im Datenverzeichnis, ohne irgendetwas anzulegen. */
export function dataDirFrom(raw: string | undefined, toolName: string): DataDir {
  if (!raw) {
    fail(
      `--data-dir fehlt. Beispiel:\n  node ${toolName} --data-dir /var/lib/ohrganize/musterfirma`,
    );
  }
  const dir = path.resolve(raw);
  if (!fs.existsSync(dir)) fail(`Datenverzeichnis ${dir} existiert nicht.`);
  return {
    dir,
    db: path.join(dir, 'ohrganize.db'),
    license: path.join(dir, 'lizenz.ohrganize'),
    initialPassword: path.join(dir, 'initial-admin-password.txt'),
    storage: path.join(dir, 'storage'),
  };
}

/**
 * Öffnet die Datenbank einer Instanz für ein Werkzeug.
 *
 * Verschlüsselte Bestände brauchen data.key aus dem Verzeichnis der
 * Datenbank (db/encryption.ts); ein Klartextbestand (Instanz, die seit dem
 * Update noch nicht gestartet wurde) wird ohne Schlüssel geöffnet. Ein
 * Werkzeug erzeugt nie einen Schlüssel und stellt nie um. Fehlt der
 * Schlüssel oder passt er nicht, endet das Werkzeug mit dem Klartextsatz
 * statt mit "file is not a database".
 */
export function openInstanceDb(
  dbPath: string,
  options: { readonly?: boolean; dataDir?: string } = {},
): Database.Database {
  try {
    return openDatabase(dbPath, {
      dataDir: options.dataDir ?? path.dirname(dbPath),
      readonly: options.readonly,
      fileMustExist: true,
    }).db;
  } catch (err) {
    fail(errorText(err));
  }
}

/** Heutiger Kalendertag in LOKALER Zeit, wie todayIsoLocal im Backend. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Groesse eines Verzeichnisses in Bytes; fehlende Verzeichnisse zaehlen als 0.
 * Ohne das Arbeitsverzeichnis der Dateiumstellung (STORAGE_CONVERSION_DIR):
 * Dort entstehen und verschwinden Zwischendateien, solange der Dienst
 * umstellt, und sie gehoeren nicht zum Bestand. Eine Datei, die zwischen
 * Auflisten und stat verschwindet, zaehlt nicht mit, statt den Lauf
 * abzubrechen (status.cjs muss auch dann eine Auskunft geben).
 */
export function directorySize(dir: string): { files: number; bytes: number } {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === STORAGE_CONVERSION_DIR) continue;
      const sub = directorySize(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      let size: number;
      try {
        size = fs.statSync(full).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      files++;
      bytes += size;
    }
  }
  return { files, bytes };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Temporaeres Arbeitsverzeichnis des aufrufenden Kontos. */
export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
