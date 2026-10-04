/**
 * oHRganize — Datensicherung (M10).
 *
 * Aufruf:
 *   Dev:    npm run backup -w apps/backend -- --out /pfad/zum/ziel --keep 14
 *   Server: node /opt/ohrganize/apps/backend/dist/backup.cjs --out /var/backups/ohrganize --keep 14
 *           (der systemd-Timer aus deploy/ohrganize-backup.timer macht genau das)
 *
 * Der Nutzdatenbestand liegt in VIER Objekten, ein Backup ist nur mit allen
 * vollständig:
 *   1. ohrganize.db  Datenbank (WAL-Modus!), verschlüsselt
 *   2. storage/      die Datei-Blobs (Verträge, Bescheinigungen, Fotos …), verschlüsselt
 *   3. data.key      Schlüssel zu 1 und 2 (db/encryption.ts). OHNE IHN IST DIE
 *                    SICHERUNG NICHT LESBAR. Verweist data.key auf eine Datei
 *                    außerhalb des Datenverzeichnisses ("extern:"), enthält
 *                    die Sicherung nur den Verweis: Dann ist sie für sich
 *                    genommen unlesbar, und die Schlüsseldatei muss getrennt
 *                    aufbewahrt werden.
 *   4. secret.key    JWT-/Signatur-Secret
 * Dazu, falls vorhanden, lizenz.ohrganize — die signierte Lizenzdatei. Sie ist
 * kein Nutzdatum (der Anbieter kann sie neu ausstellen), aber ohne sie steht
 * ein zurückgespielter Server im Nur-Lese-Betrieb, bis jemand sie wieder
 * einspielt. Fehlt sie im Quellverzeichnis (Testphase), gibt es keine Warnung.
 *
 * Warum nicht einfach `cp ohrganize.db`: Die Datenbank läuft im WAL-Modus. Eine
 * nackte Dateikopie ohne `-wal` ist KEIN gültiges Backup — die jüngsten
 * Transaktionen fehlen, und eine Kopie während eines laufenden Schreibvorgangs
 * kann sogar in sich inkonsistent sein. Dieses Skript schreibt deshalb im
 * laufenden Betrieb einen konsistenten Stand heraus (`VACUUM INTO`, siehe
 * copyDatabaseTo in db/encryption.ts); die Kopie trägt denselben Schlüssel
 * wie die Quelle.
 *
 * Warum secret.key mitgesichert wird: Ohne die Datei erzeugt
 * `loadOrCreateSecret()` (config.ts) beim ersten Start still ein neues Secret.
 * Nach einem Restore wären dann alle Sitzungen ungültig und alle bereits
 * ausgestellten signierten Download-Links tot — ohne dass irgendwo ein Fehler
 * auftaucht. Deshalb gehört sie ins Backup (und das Backup damit auf ein
 * ebenso geschütztes Medium wie die Datenbank selbst).
 *
 * Ausnahme: Liegt der Schlüssel außerhalb des Datenverzeichnisses, bleibt
 * secret.key draußen. Mit ihr ließen sich Sitzungen für den laufenden Server
 * fälschen, und genau diese Sicherung soll für sich genommen nichts öffnen.
 * Nach einem Restore melden sich dann alle neu an.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VARIANT, VARIANT_MARKER } from '@variant-manifest';
import { config } from '../config.js';
import { getDb, closeDb } from '../db/db.js';
import { DATA_KEY_FILE, copyDatabaseTo, openDatabase, readDataKey } from '../db/encryption.js';
import { STORAGE_CONVERSION_DIR, storageEncryptionState } from '../core/fileCrypto.js';
import { directorySize, formatBytes } from './toolkit.js';
import { errorText } from '../core/errorText.js';

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
          'Gesichert werden ohrganize.db (konsistente Kopie), storage/, data.key, secret.key und, falls vorhanden, lizenz.ohrganize.',
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
 * Kundenschluessel, wenn dieses Datenverzeichnis zu einer Hosting-Instanz
 * gehoert: /var/lib/ohrganize/<kunde> (bzw. derselbe Aufbau unter einem
 * anderen Wurzelverzeichnis). Erkannt wird er daran, dass das ELTERNverzeichnis
 * "ohrganize" heisst und der Ordner selbst wie ein Kundenschluessel aussieht.
 * Beim Einzelkunden ist das Datenverzeichnis selbst "ohrganize" und die
 * Funktion liefert null. Hosting gibt es nur unter Linux: Unter Windows heisst
 * das Datenverzeichnis C:\\ProgramData\\oHRganize\\data, und ein Vergleich
 * ohne Gross/Klein hielt es fuer die Instanz "data" (das MANIFEST nannte dann
 * ein bash-Skript statt der PowerShell-Schritte).
 */
function instanceKey(): string | null {
  if (process.platform === 'win32') return null;
  const dir = path.resolve(config.dataDir);
  const self = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  if (parent !== 'ohrganize') return null;
  return /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(self) ? self : null;
}

const STORAGE_LABELS = {
  empty: 'keine Dateien',
  encrypted: 'verschlüsselt',
  mixed: 'TEILWEISE unverschlüsselt',
  plaintext: 'unverschlüsselt',
} as const;

/** Was diese Sicherung tatsächlich enthält; die Restore-Schritte nennen nur das. */
interface BackupContents {
  dataKey: boolean;
  /** Pfad der Schlüsseldatei, wenn data.key nur auf sie verweist. */
  externalKeyFile: string | null;
  secretKey: boolean;
  license: boolean;
}

/**
 * Restore-Schritte für das MANIFEST, plattformabhängig und passend zum
 * Inhalt dieser Sicherung.
 *
 * Das Skript selbst läuft auf beiden Systemen unverändert (reines Node), die
 * Anleitung daneben tat es nicht: Sie nannte fest systemctl, chown und
 * /var/lib/ohrganize. Auf einem Windows-Server erklärte die Sicherung damit
 * einen Weg, den es dort nicht gibt — und zwar genau in dem Moment, in dem
 * jemand unter Druck davorsteht. Aus demselben Grund nennt sie keine Datei,
 * die sie nicht enthält: Ein `cp` auf eine fehlende Datei bricht mitten im
 * Restore mit einer Fehlermeldung ab.
 */
function restoreSteps(contents: BackupContents): string[] {
  const keyNote = contents.externalKeyFile
    ? [`  Zuerst die Schlüsseldatei wieder ablegen: ${contents.externalKeyFile}`, '']
    : [];
  // Mehrkunden-Hosting: Das Datenverzeichnis endet auf /var/lib/ohrganize/<kunde>.
  // Dort sind die pauschalen Zeilen unten falsch (sie nennen das gemeinsame
  // Verzeichnis und stoppen den Dienst OHNE Instanznamen, also gar keinen).
  // Provision.sh kennt den ganzen Ablauf inklusive Rechten und Neustart;
  // genau darauf wird hier verwiesen statt Zeilen anzubieten, die im Ernstfall
  // die falsche Instanz treffen.
  const instance = instanceKey();
  if (instance) {
    return [
      ...keyNote,
      `  ohrganize-provision.sh restore ${instance} <dieser Ordner>`,
      '',
      '  (Das Skript stoppt die Instanz, sichert den alten Stand weg, spielt',
      '   Datenbank, storage/, data.key, secret.key und die Lizenzdatei ein,',
      '   soweit vorhanden, zieht die Rechte nach und startet die Instanz wieder.)',
    ];
  }
  if (process.platform === 'win32') {
    const target = 'C:\\ProgramData\\oHRganize\\data';
    return [
      ...keyNote,
      '  nssm stop oHRganize',
      `  Rename-Item ${target} data.alt`,
      `  New-Item -ItemType Directory ${target}`,
      `  Copy-Item ohrganize.db, storage -Destination ${target} -Recurse`,
      ...(contents.dataKey ? [`  Copy-Item data.key -Destination ${target}`] : []),
      ...(contents.secretKey ? [`  Copy-Item secret.key -Destination ${target}`] : []),
      ...(contents.license ? [`  Copy-Item lizenz.ohrganize -Destination ${target}`] : []),
      '  powershell -File <Programmverzeichnis>\\deploy\\windows\\harden-data-dir.ps1',
      '  nssm start oHRganize',
    ];
  }
  return [
    ...keyNote,
    '  systemctl stop ohrganize-backend',
    '  mv /var/lib/ohrganize /var/lib/ohrganize.alt',
    '  install -d -o ohrganize -g ohrganize -m 0700 /var/lib/ohrganize',
    '  cp -a ohrganize.db storage /var/lib/ohrganize/',
    ...(contents.dataKey ? ['  cp -a data.key /var/lib/ohrganize/'] : []),
    ...(contents.secretKey ? ['  cp -a secret.key /var/lib/ohrganize/'] : []),
    ...(contents.license ? ['  cp -a lizenz.ohrganize /var/lib/ohrganize/'] : []),
    '  chown -R ohrganize:ohrganize /var/lib/ohrganize && chmod -R go-rwx /var/lib/ohrganize',
    '  systemctl start ohrganize-backend',
  ];
}

/**
 * Prüft die frisch geschriebene Kopie, bevor sie als gültige Sicherung gilt:
 * Ein Backup, das man erst im Ernstfall zum ersten Mal öffnet, ist keins.
 */
function verifyBackup(dbFile: string): {
  integrity: string;
  fileRows: number;
  userRows: number;
  pages: number;
  encrypted: boolean;
} {
  // Geöffnet mit dem Schlüssel des QUELL-Datenverzeichnisses: Die Kopie trägt
  // denselben, und genau das wird hier mitgeprüft.
  const { db: copy, encrypted } = openDatabase(dbFile, {
    dataDir: config.dataDir,
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = copy.pragma('integrity_check', { simple: true }) as string;
    const pages = copy.pragma('page_count', { simple: true }) as number;
    const fileRows = (copy.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
    const userRows = (copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    return { integrity, fileRows, userRows, pages, encrypted };
  } finally {
    copy.close();
    // Vorsorglich: Eine Kopie im WAL-Modus legte schon beim Öffnen zum Prüfen
    // leere -wal/-shm-Dateien daneben an (VACUUM INTO schreibt heute im
    // Journalmodus DELETE). Sie müssen weg: Das Backup soll aus
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
    // 1. Datenbank ZUERST (VACUUM INTO, konsistent im laufenden Betrieb)
    // ---------------------------------------------------------------
    // Die Reihenfolge DB → storage ist zwingend, nicht Geschmack:
    // core/files.ts schreibt den Blob VOR dem Datensatz. Wer zuerst storage/
    // kopiert und danach die Datenbank, erwischt Datensätze, deren Blob beim
    // Kopieren noch nicht existierte — beim Restore fehlt die Datei
    // ("Dateiinhalt fehlt im Storage"). Andersherum entsteht schlimmstenfalls
    // ein Blob ohne Datensatz: unbenutzter Speicherplatz, kein Datenverlust.
    const dbTarget = path.join(tmpDir, 'ohrganize.db');
    log(`Sichere Datenbank … (${config.dbPath})`);
    // Die LAUFENDE Datenbank prüfen: VACUUM INTO baut die Kopie aus den
    // Zeilen neu auf, ihre Prüfung unten sieht deshalb keine Schäden der
    // Quelle mehr (verlorene Seiten, falsche Freiliste). Mit der früheren
    // Seitenkopie fiel das auf, und Zeilen auf verlorenen Seiten fehlten nicht
    // still in der Sicherung.
    const live = getDb();
    const liveCheck = live.pragma('quick_check', { simple: true });
    if (liveCheck !== 'ok') {
      throw new Error(`Die laufende Datenbank besteht die Prüfung nicht (${String(liveCheck)}). Es wurde keine Sicherung geschrieben.`);
    }
    copyDatabaseTo(live, dbTarget);
    // Sofort freigeben: Danach braucht die Sicherung die Datenbank nicht mehr,
    // und eine offene Verbindung hielte eine Umstellung beim Dienststart auf
    // (db/encryption.ts), solange storage/ kopiert wird.
    closeDb();
    fs.chmodSync(dbTarget, 0o600);

    const check = verifyBackup(dbTarget);
    log(`  ${check.pages} Seiten geschrieben, ${formatBytes(fs.statSync(dbTarget).size)}${check.encrypted ? ', verschlüsselt' : ''}`);
    if (check.integrity !== 'ok') {
      throw new Error(`Integritätsprüfung der Sicherung fehlgeschlagen: ${check.integrity}`);
    }
    log(`  Integritätsprüfung ok · ${check.userRows} Konten · ${check.fileRows} Dateieinträge`);

    // ---------------------------------------------------------------
    // 2. Danach die Datei-Blobs
    // ---------------------------------------------------------------
    const storageTarget = path.join(tmpDir, 'storage');
    const storage = directorySize(config.storageDir);
    log(`Sichere Dateien … (${storage.files} Dateien, ${formatBytes(storage.bytes)})`);
    fs.mkdirSync(storageTarget, { mode: 0o700 });
    if (fs.existsSync(config.storageDir)) {
      // Ohne das Arbeitsverzeichnis der Umstellung: Dort liegen nur halb
      // geschriebene Zwischendateien, die beim naechsten Start verworfen werden.
      // Zeitstempel erhalten: storageEncryptionState unten zählt eine leere oder
      // abgeschnittene Datei nur dann nicht als beschädigt, wenn sie jünger als
      // UPLOAD_IN_FLIGHT_MS ist. Ohne preserveTimestamps trüge unter Linux jede
      // Kopie die Uhrzeit des Kopierens, und das MANIFEST nennte nie eine
      // beschädigte Datei (unter Windows erhält CopyFile die Zeit ohnehin).
      fs.cpSync(config.storageDir, storageTarget, {
        recursive: true,
        preserveTimestamps: true,
        filter: (source) => path.basename(source) !== STORAGE_CONVERSION_DIR,
      });
    }

    // Tatsaechlicher Stand der gesicherten Dateien (nicht: ob data.key existiert).
    const storageState = storageEncryptionState(storageTarget);

    // ---------------------------------------------------------------
    // 3. Secret (ohne das sind nach dem Restore alle Sitzungen und
    //    Download-Links tot — siehe Kopfkommentar)
    // ---------------------------------------------------------------
    // 3a. Schlüssel der Verschlüsselung. data.key wird so kopiert, wie sie
    //     im Datenverzeichnis liegt: als Schlüssel oder als Verweis auf eine
    //     Datei außerhalb (dann ist diese Sicherung für sich genommen
    //     unlesbar, und das ist die Absicht).
    // Ist data.key unbrauchbar, kann die Datenbank nur im Klartext vorliegen
    // (sonst hätte sie sich oben nicht öffnen lassen). Die Sicherung läuft
    // dann ohne Schlüssel weiter, statt jede Nacht abzubrechen.
    let dataKey: ReturnType<typeof readDataKey> = null;
    try {
      dataKey = readDataKey(config.dataDir);
    } catch (err) {
      console.warn(`Warnung: data.key ist unbrauchbar und wird nicht gesichert (${errorText(err)}).`);
    }
    const keyOutside = dataKey?.external === true;
    if (dataKey) {
      const keyTarget = path.join(tmpDir, DATA_KEY_FILE);
      fs.copyFileSync(config.dataKeyPath, keyTarget);
      fs.chmodSync(keyTarget, 0o600);
      log(keyOutside ? 'Sichere data.key (nur der Verweis, der Schlüssel liegt außerhalb) …' : 'Sichere data.key …');
    }

    const secretSource = path.join(config.dataDir, 'secret.key');
    const hasSecret = !keyOutside && fs.existsSync(secretSource);
    if (keyOutside) {
      log('secret.key bleibt draußen (der Schlüssel liegt außerhalb des Datenverzeichnisses).');
    } else if (fs.existsSync(secretSource)) {
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

    // ---------------------------------------------------------------
    // 4. Lizenzdatei — falls vorhanden. Kein Nutzdatum, aber ohne sie steht
    //    der zurückgespielte Server im Nur-Lese-Betrieb (siehe Kopfkommentar).
    // ---------------------------------------------------------------
    const licenseSource = config.licensePath;
    const licenseName = path.basename(licenseSource);
    const hasLicense = fs.existsSync(licenseSource);
    if (hasLicense) {
      const licenseTarget = path.join(tmpDir, licenseName);
      fs.copyFileSync(licenseSource, licenseTarget);
      fs.chmodSync(licenseTarget, 0o600);
      log(`Sichere ${licenseName} …`);
    }

    // Kurzprotokoll neben den Daten: Wer im Ernstfall vor dem Backup steht,
    // soll die Restore-Schritte nicht erst im Repository suchen müssen.
    const manifest = [
      'oHRganize — Datensicherung',
      `Erstellt:            ${started.toISOString()}`,
      `Quelle:              ${config.dataDir}`,
      `Variante:            ${VARIANT.id} (${VARIANT.label}) ${VARIANT_MARKER}`,
      `Rechner:             ${process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'unbekannt'}`,
      `Datenbankseiten:     ${check.pages}`,
      `Integritätsprüfung:  ${check.integrity}`,
      `Konten:              ${check.userRows}`,
      `Dateieinträge (DB):  ${check.fileRows}`,
      `Dateien (storage/):  ${storage.files} (${formatBytes(storage.bytes)})`,
      '',
      'Inhalt:',
      `  ohrganize.db  Datenbank (konsistenter Stand, kein -wal nötig${check.encrypted ? ', verschlüsselt' : ''})`,
      `  storage/      Datei-Blobs (${STORAGE_LABELS[storageState.state]}${storageState.damaged > 0 ? `, ${storageState.damaged} abgeschnitten und nicht lesbar` : ''})`,
      ...(dataKey === null
        ? []
        : keyOutside
          ? [
              `  data.key      NUR DER VERWEIS auf den Schlüssel: ${dataKey.file}`,
              '                Diese Sicherung ist ohne jene Datei NICHT LESBAR. Sie muss getrennt',
              '                gesichert sein und vor dem Restore wieder an dieser Stelle liegen.',
              '  (secret.key ist nicht enthalten: Nach dem Restore melden sich alle neu an.)',
            ]
          : [
              ...(check.encrypted || storageState.state === 'encrypted' || storageState.state === 'mixed'
                ? [
                    '  data.key      Schlüssel zu Datenbank und storage/. Ohne sie ist die Sicherung nicht lesbar;',
                    '                wer sie zusammen mit der Sicherung hat, kann alles lesen.',
                  ]
                : [
                    '  data.key      Schlüssel für die Verschlüsselung; dieser Stand ist noch NICHT verschlüsselt',
                    '                (Umstellung beim Start gescheitert oder noch nicht gelaufen).',
                  ]),
            ]),
      ...(keyOutside ? [] : ['  secret.key    JWT-/Signatur-Secret']),
      hasLicense
        ? `  ${licenseName}  Signierte Lizenzdatei (ohne sie: Nur-Lese-Betrieb nach dem Restore)`
        : `  (keine ${licenseName} vorhanden — Testphase oder noch nicht eingespielt)`,
      '',
      'Lizenzdatei nach dem Restore erneut ablegen (provision.sh lizenz <kunde> <datei>),',
      'wenn seit dieser Sicherung eine neuere eingespielt wurde: Der Dateiwaechter des',
      'Servers prueft keine Monotonie, ein alter Stand bringt also still die alte Datei',
      'zurueck. Die Monotonie greift nur beim Einspielen ueber die Oberflaeche.',
      '',
      'Restore (Dienst muss gestoppt sein; Programm derselben Variante wie oben einsetzen):',
      ...restoreSteps({
        dataKey: dataKey !== null,
        externalKeyFile: keyOutside && dataKey ? dataKey.file : null,
        secretKey: hasSecret,
        license: hasLicense,
      }),
      '',
      'Achtung: Vorhandene .db-wal/.db-shm des alten Standes NICHT mitkopieren.',
      'Ausführliche Fassung: docs/inbetriebnahme.md, Abschnitt "Restore-Probe".',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.txt'), `${manifest}\n`, { mode: 0o600 });

    fs.renameSync(tmpDir, finalDir);
    const total = directorySize(finalDir);
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
