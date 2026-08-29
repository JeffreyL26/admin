import type { FastifyInstance } from 'fastify';
import { startServer } from './server.js';
import { config } from './config.js';
import { getDb, closeDb } from './db/db.js';

/**
 * CLI-Einstieg (Standalone-Betrieb, gebündelt nach dist/cli.cjs).
 * Die Desktop-App startet das Backend NICHT hierüber, sondern über
 * startServer() aus dist/server.cjs — Signal-Handling gehört deshalb hierher
 * und nicht in server.ts.
 */

let shuttingDown = false;

/**
 * Geordnetes Herunterfahren. systemd schickt beim `stop`/`restart` SIGTERM,
 * ein Terminal Strg+C schickt SIGINT.
 *
 * Warum das nötig ist: Die Datenbank läuft im WAL-Modus (db/db.ts). Ohne
 * Checkpoint bleiben die zuletzt geschriebenen Transaktionen in
 * `hrmonic.db-wal` liegen. Wer dann nur `hrmonic.db` kopiert (Backup-Agent,
 * VM-Snapshot, Umzug auf neue Hardware), sichert einen veralteten Stand und
 * merkt es erst beim Restore. `wal_checkpoint(TRUNCATE)` schreibt alles zurück
 * und leert die -wal-Datei; danach ist `hrmonic.db` für sich genommen
 * vollständig. (Das ersetzt kein Backup — dafür src/scripts/backup.ts.)
 */
async function shutdown(signal: string, app: FastifyInstance): Promise<void> {
  if (shuttingDown) return; // zweites Signal (z. B. doppeltes Strg+C) ignorieren
  shuttingDown = true;
  console.log(`${signal} empfangen — HRMONIC Backend wird beendet …`);

  // Notbremse: Hängt ein laufender Request, blockiert app.close() bis systemd
  // nach TimeoutStopSec hart mit SIGKILL nachsetzt — dann liefe der Checkpoint
  // nie. Lieber selbst abbrechen und wenigstens die Datenbank sauber schließen.
  const forceExit = setTimeout(() => {
    console.error('Herunterfahren dauert zu lange — harter Abbruch ohne WAL-Checkpoint.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await app.close();
  } catch (err) {
    console.error('Fehler beim Schließen des Servers:', err);
  }

  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
    closeDb();
  } catch (err) {
    console.error('Fehler beim WAL-Checkpoint:', err);
    process.exit(1);
  }

  clearTimeout(forceExit);
  console.log('HRMONIC Backend beendet.');
  process.exit(0);
}

startServer()
  .then(({ app, port }) => {
    console.log(`HRMONIC Backend läuft auf http://${config.host}:${port}`);
    console.log(`Datenverzeichnis: ${config.dataDir}`);

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        void shutdown(signal, app);
      });
    }
  })
  .catch((err) => {
    console.error('Backend-Start fehlgeschlagen:', err);
    process.exit(1);
  });
