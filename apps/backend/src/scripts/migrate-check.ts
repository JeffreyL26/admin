/**
 * Probelauf der Migrationen auf einer KOPIE, vor einem Update.
 *
 *   node apps/backend/dist/migrate-check.cjs --db /var/lib/ohrganize/musterfirma/ohrganize.db
 *
 * Beantwortet die Frage, die sich vor jedem Update stellt: Laeuft das Schema
 * dieser Kundendatenbank durch die Migrationen des neuen Programms? Bisher
 * war die Antwort "wir sehen es beim Start", und wenn nicht, stand der Dienst.
 *
 * Der Lauf fasst die Kundendatenbank NICHT an: `db.backup()` schreibt ueber
 * die Online-Backup-Schnittstelle von SQLite einen konsistenten Stand in ein
 * temporaeres Verzeichnis (dieselbe Technik wie die Sicherung), und migriert
 * wird ausschliesslich die Kopie. Danach wird sie geloescht.
 *
 * Exit 0: alles gut (auch, wenn nichts ausstand). Exit 1: eine Migration
 * scheitert ODER die Datenbank kommt von einer neueren Version.
 *
 * Kein Import von config.ts (siehe toolkit.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrateDatabase.js';
import { fail, formatBytes, parseArgs, refuseRoot, tempDir, variantBanner } from './toolkit.js';

const { values } = parseArgs(process.argv.slice(2));
refuseRoot('runuser -u ohrganize -- node /opt/ohrganize/apps/backend/dist/migrate-check.cjs --db <pfad>');
if (!values.db) fail('--db fehlt. Beispiel: --db /var/lib/ohrganize/musterfirma/ohrganize.db');
const dbPath = path.resolve(values.db);
if (!fs.existsSync(dbPath)) fail(`${dbPath} existiert nicht.`);

const bytes = fs.statSync(dbPath).size;
console.log(`${variantBanner()}`);
console.log('Migrations-Probelauf');
console.log(`  Quelle: ${dbPath} (${formatBytes(bytes)})`);
// Bei grossen Datenbanken dauert die Kopie spuerbar; ohne diesen Hinweis
// sieht der Betreiber ein stehendes Terminal und bricht ab.
console.log('  Kopiere die Datenbank (bei grossen Bestaenden dauert das einen Moment) ...');

// Ein async main(): Das Bundle ist CJS (esbuild), und dort gibt es kein
// Top-Level-await. `db.backup()` ist die einzige asynchrone Stelle.
async function main(): Promise<number> {
  const work = tempDir('ohrganize-migrate-check-');
  const copyPath = path.join(work, 'probe.db');
  try {
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(copyPath);
    } finally {
      source.close();
    }
    console.log(`  Kopie:  ${copyPath} (${formatBytes(fs.statSync(copyPath).size)})`);

    const copy = new Database(copyPath, { fileMustExist: true });
    try {
      const applied = migrateDatabase(copy);
      if (applied.length === 0) {
        console.log('  Ergebnis: keine ausstehenden Migrationen. Das Schema ist bereits aktuell.');
      } else {
        console.log(`  Ergebnis: ${applied.length} Migration(en) liefen durch:`);
        for (const name of applied) console.log(`    - ${name}`);
      }
    } finally {
      copy.close();
    }
    return 0;
  } catch (err) {
    console.error('');
    console.error('  FEHLGESCHLAGEN. Die Kundendatenbank ist unveraendert; das Update wuerde hier abbrechen.');
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    // Die Kopie erbt journal_mode=WAL, deshalb liegen -wal und -shm daneben.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
