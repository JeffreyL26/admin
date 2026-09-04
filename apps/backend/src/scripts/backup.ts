/**
 * oHRganize — Datensicherung (M10).
 *
 * Aufruf:
 *   Dev:    npm run backup -w apps/backend -- --out /pfad/zum/ziel --keep 14
 *   Server: node /opt/ohrganize/apps/backend/dist/backup.cjs --out /var/backups/ohrganize --keep 14
 *           (der systemd-Timer aus deploy/ohrganize-backup.timer macht genau das)
 *
 * Der Nutzdatenbestand liegt in DREI Objekten — ein Backup ist nur mit allen
 * dreien vollständig:
 *   1. ohrganize.db  — Datenbank (WAL-Modus!)
 *   2. storage/      — die Datei-Blobs (Verträge, Bescheinigungen, Fotos …)
 *   3. secret.key    — JWT-/Signatur-Secret
 *
 * Warum nicht einfach `cp ohrganize.db`: Die Datenbank läuft im WAL-Modus. Eine
 * nackte Dateikopie ohne `-wal` ist KEIN gültiges Backup — die jüngsten
 * Transaktionen fehlen, und eine Kopie während eines laufenden Schreibvorgangs
 * kann sogar in sich inkonsistent sein. Dieses Skript benutzt deshalb die
 * Online-Backup-API von SQLite (`db.backup()`), die im laufenden Betrieb einen
 * konsistenten Stand herausschreibt.
 *
 * Warum secret.key mitgesichert wird: Ohne die Datei erzeugt
 * `loadOrCreateSecret()` (config.ts) beim ersten Start still ein neues Secret.
 * Nach einem Restore wären dann alle Sitzungen ungültig und alle bereits
 * ausgestellten signierten Download-Links tot — ohne dass irgendwo ein Fehler
 * auftaucht. Deshalb gehört sie ins Backup (und das Backup damit auf ein
 * ebenso geschütztes Medium wie die Datenbank selbst).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { getDb, closeDb } from '../db/db.js';

interface Options {
  out: string;
  keep: number;
  quiet: boolean;
}

const DEFAULT_KEEP = 14;
const BACKUP_DIR_PATTERN = /^ohrganize-\d{8}-\d{6}$/;

function parseArgs(argv: string[]): Options {
  const out: Options = {
    out:
      process.env.OHRGANIZE_BACKUP_DIR ??
      // Vorgabe bewusst innerhalb des Datenverzeichnisses: dort hat der
      // Dienstbenutzer garantiert Schreibrechte. Auf einem Server gehört das
      // Ziel auf ein anderes Dateisystem — dafür --out bzw. OHRGANIZE_BACKUP_DIR.
      path.join(config.dataDir, 'backups'),
    keep: DEFAULT_KEEP,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const value = argv[++i];
      if (!value) throw new Error('--out erwartet ein Verzeichnis');
      out.out = path.resolve(value);
    } else if (arg === '--keep' || arg === '-k') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--keep erwartet eine ganze Zahl >= 0 (0 = nichts löschen)');
      }
      out.keep = value;
    } else if (arg === '--quiet' || arg === '-q') {
      out.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'oHRganize Datensicherung',
          '',
          'Optionen:',
          '  --out, -o <verzeichnis>  Zielverzeichnis der Sicherungen',
          `                           (Vorgabe: $OHRGANIZE_BACKUP_DIR, sonst ${path.join(config.dataDir, 'backups')})`,
          `  --keep, -k <anzahl>      Anzahl aufzubewahrender Sicherungen (Vorgabe: ${DEFAULT_KEEP}, 0 = keine löschen)`,
          '  --quiet, -q              Nur Fehler ausgeben',
          '',
          'Gesichert werden ohrganize.db (Online-Backup), storage/ und secret.key.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`Unbekannte Option: ${arg}`);
    }
  }
  return out;
}

/** Zeitstempel für den Ordnernamen: ohrganize-JJJJMMTT-HHMMSS (Ortszeit). */
function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * Restore-Schritte für das MANIFEST — plattformabhängig.
 *
 * Das Skript selbst läuft auf beiden Systemen unverändert (reines Node), die
 * Anleitung daneben tat es nicht: Sie nannte fest systemctl, chown und
 * /var/lib/ohrganize. Auf einem Windows-Server erklärte die Sicherung damit
 * einen Weg, den es dort nicht gibt — und zwar genau in dem Moment, in dem
 * jemand unter Druck davorsteht.
 */
function restoreSteps(): string[] {
  if (process.platform === 'win32') {
    return [
      '  nssm stop oHRganize',
      '  Rename-Item C:\\ProgramData\\oHRganize\\data data.alt',
      '  New-Item -ItemType Directory C:\\ProgramData\\oHRganize\\data',
      '  Copy-Item ohrganize.db, secret.key, storage -Destination C:\\ProgramData\\oHRganize\\data -Recurse',
      '  powershell -File <Programmverzeichnis>\\deploy\\windows\\harden-data-dir.ps1',
      '  nssm start oHRganize',
    ];
  }
  return [
    '  systemctl stop ohrganize-backend',
    '  mv /var/lib/ohrganize /var/lib/ohrganize.alt',
    '  install -d -o ohrganize -g ohrganize -m 0700 /var/lib/ohrganize',
    '  cp -a ohrganize.db storage secret.key /var/lib/ohrganize/',
    '  chown -R ohrganize:ohrganize /var/lib/ohrganize && chmod -R go-rwx /var/lib/ohrganize',
    '  systemctl start ohrganize-backend',
  ];
}

function formatBytes(bytes: number): string {
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

/** Zählt Dateien und Bytes in storage/ (flache Ablage: <uuid><ext>). */
function measureDir(dir: string): { files: number; bytes: number } {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measureDir(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files++;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

/**
 * Prüft die frisch geschriebene Kopie, bevor sie als gültige Sicherung gilt:
 * Ein Backup, das man erst im Ernstfall zum ersten Mal öffnet, ist keins.
 */
function verifyBackup(dbFile: string): { integrity: string; fileRows: number; userRows: number } {
  const copy = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma('integrity_check', { simple: true }) as string;
    const fileRows = (copy.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
    const userRows = (copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    return { integrity, fileRows, userRows };
  } finally {
    copy.close();
    // Die Kopie erbt journal_mode=WAL, deshalb legt schon das Öffnen zum Prüfen
    // leere -wal/-shm-Dateien daneben an. Eine lesende Verbindung kann sie beim
    // Schließen nicht selbst aufräumen. Sie müssen weg: Das Backup soll aus
    // genau einer Datenbankdatei bestehen — sonst kopiert sie jemand beim
    // Restore mit und überschreibt damit den gerade eingespielten Stand.
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${dbFile}${suffix}`, { force: true });
    }
  }
}

/** Alte Sicherungen abräumen; Ordnernamen sortieren chronologisch. */
function prune(outDir: string, keep: number, log: (msg: string) => void): void {
  if (keep === 0) return;
  const existing = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BACKUP_DIR_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const name of existing.slice(keep)) {
    fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    log(`  alte Sicherung entfernt: ${name}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(msg);
  };

  if (!fs.existsSync(config.dbPath)) {
    throw new Error(
      `Keine Datenbank unter ${config.dbPath} gefunden. ` +
        'Stimmt OHRGANIZE_DATA_DIR? (Der Dienst benutzt /etc/ohrganize/ohrganize.env.)',
    );
  }

  // mode 0o700: Die Sicherung enthält denselben Personaldatenbestand wie das
  // Datenverzeichnis. Ein weltlesbares Backup-Verzeichnis hebt die Rechte aus
  // M9 wieder auf. (mode wirkt nur beim Neuanlegen — deshalb unten zusätzlich
  // chmod auf das Zielverzeichnis.)
  fs.mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  fs.chmodSync(opts.out, 0o700);

  const started = new Date();
  const name = `ohrganize-${stamp(started)}`;
  const finalDir = path.join(opts.out, name);
  if (fs.existsSync(finalDir)) {
    throw new Error(`Sicherung ${finalDir} existiert bereits — bitte eine Sekunde warten.`);
  }

  // Erst in einen temporären Ordner schreiben und am Ende umbenennen. Bricht
  // der Lauf ab (Platte voll, Prozess getötet), bleibt kein halbes Backup
  // stehen, das später für vollständig gehalten wird.
  const tmpDir = path.join(opts.out, `.tmp-${name}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { mode: 0o700 });

  try {
    // ---------------------------------------------------------------
    // 1. Datenbank ZUERST (Online-Backup-API, konsistent im laufenden Betrieb)
    // ---------------------------------------------------------------
    // Die Reihenfolge DB → storage ist zwingend, nicht Geschmack:
    // core/files.ts schreibt den Blob VOR dem Datensatz. Wer zuerst storage/
    // kopiert und danach die Datenbank, erwischt Datensätze, deren Blob beim
    // Kopieren noch nicht existierte — beim Restore fehlt die Datei
    // ("Dateiinhalt fehlt im Storage"). Andersherum entsteht schlimmstenfalls
    // ein Blob ohne Datensatz: unbenutzter Speicherplatz, kein Datenverlust.
    const dbTarget = path.join(tmpDir, 'ohrganize.db');
    log(`Sichere Datenbank … (${config.dbPath})`);
    const result = await getDb().backup(dbTarget);
    fs.chmodSync(dbTarget, 0o600);
    log(`  ${result.totalPages} Seiten geschrieben, ${formatBytes(fs.statSync(dbTarget).size)}`);

    const check = verifyBackup(dbTarget);
    if (check.integrity !== 'ok') {
      throw new Error(`Integritätsprüfung der Sicherung fehlgeschlagen: ${check.integrity}`);
    }
    log(`  Integritätsprüfung ok · ${check.userRows} Konten · ${check.fileRows} Dateieinträge`);

    // ---------------------------------------------------------------
    // 2. Danach die Datei-Blobs
    // ---------------------------------------------------------------
    const storageTarget = path.join(tmpDir, 'storage');
    const storage = measureDir(config.storageDir);
    log(`Sichere Dateien … (${storage.files} Dateien, ${formatBytes(storage.bytes)})`);
    fs.mkdirSync(storageTarget, { mode: 0o700 });
    if (fs.existsSync(config.storageDir)) {
      fs.cpSync(config.storageDir, storageTarget, { recursive: true });
    }

    // ---------------------------------------------------------------
    // 3. Secret (ohne das sind nach dem Restore alle Sitzungen und
    //    Download-Links tot — siehe Kopfkommentar)
    // ---------------------------------------------------------------
    const secretSource = path.join(config.dataDir, 'secret.key');
    if (fs.existsSync(secretSource)) {
      const secretTarget = path.join(tmpDir, 'secret.key');
      fs.copyFileSync(secretSource, secretTarget);
      fs.chmodSync(secretTarget, 0o600);
      log('Sichere secret.key …');
    } else {
      console.warn(
        `WARNUNG: ${secretSource} existiert nicht — nach einem Restore sind alle ` +
          'Sitzungen und Download-Links ungültig.',
      );
    }

    // Kurzprotokoll neben den Daten: Wer im Ernstfall vor dem Backup steht,
    // soll die Restore-Schritte nicht erst im Repository suchen müssen.
    const manifest = [
      'oHRganize — Datensicherung',
      `Erstellt:            ${started.toISOString()}`,
      `Quelle:              ${config.dataDir}`,
      `Rechner:             ${process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'unbekannt'}`,
      `Datenbankseiten:     ${result.totalPages}`,
      `Integritätsprüfung:  ${check.integrity}`,
      `Konten:              ${check.userRows}`,
      `Dateieinträge (DB):  ${check.fileRows}`,
      `Dateien (storage/):  ${storage.files} (${formatBytes(storage.bytes)})`,
      '',
      'Inhalt:',
      '  ohrganize.db  Datenbank (konsistenter Online-Backup-Stand, kein -wal nötig)',
      '  storage/      Datei-Blobs',
      '  secret.key    JWT-/Signatur-Secret',
      '',
      'Restore (Dienst muss gestoppt sein):',
      ...restoreSteps(),
      '',
      'Achtung: Vorhandene .db-wal/.db-shm des alten Standes NICHT mitkopieren.',
      'Ausführliche Fassung: docs/inbetriebnahme.md, Abschnitt "Restore-Probe".',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.txt'), `${manifest}\n`, { mode: 0o600 });

    fs.renameSync(tmpDir, finalDir);
    const total = measureDir(finalDir);
    log(`Sicherung fertig: ${finalDir} (${formatBytes(total.bytes)})`);

    prune(opts.out, opts.keep, log);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  } finally {
    closeDb();
  }
}

main().catch((err: unknown) => {
  console.error('Datensicherung fehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
