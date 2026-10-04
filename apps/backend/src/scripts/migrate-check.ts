/**
 * Probelauf der Migrationen auf einer KOPIE, vor einem Update.
 *
 *   node apps/backend/dist/migrate-check.cjs --db /var/lib/ohrganize/musterfirma/ohrganize.db
 *
 * Beantwortet die Frage, die sich vor jedem Update stellt: Laeuft das Schema
 * dieser Kundendatenbank durch die Migrationen des neuen Programms? Bisher
 * war die Antwort "wir sehen es beim Start", und wenn nicht, stand der Dienst.
 *
 * Der Lauf fasst die Kundendatenbank NICHT an: `VACUUM INTO` schreibt einen
 * konsistenten Stand in ein temporaeres Verzeichnis (dieselbe Technik wie die
 * Sicherung, copyDatabaseTo in db/encryption.ts), und migriert wird
 * ausschliesslich die Kopie. Danach wird sie geloescht. Ein verschluesselter
 * Bestand ergibt eine Kopie mit demselben Schluessel (data.key neben der
 * Datenbank); im temporaeren Verzeichnis liegt also kein Klartext.
 *
 * Exit 0: alles gut (auch, wenn nichts ausstand). Exit 1: eine Migration
 * scheitert ODER die Datenbank kommt von einer neueren Version.
 *
 * Kein Import von config.ts (siehe toolkit.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateDatabase } from '../db/migrateDatabase.js';
import { copyDatabaseTo, openDatabase } from '../db/encryption.js';
import { fail, formatBytes, parseArgs, refuseRoot, tempDir, variantBanner } from './toolkit.js';
import { errorText } from '../core/errorText.js';

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

// Ein async main() aus der Zeit von `db.backup()`; der Lauf selbst ist
// inzwischen synchron.
async function main(): Promise<number> {
  // Schluessel der Kopie ist der der Quelle: data.key liegt neben der Datenbank.
  const dataDir = path.dirname(dbPath);
  const work = tempDir('ohrganize-migrate-check-');
  const copyPath = path.join(work, 'probe.db');
  try {
    // openDatabase wirft (fehlender oder falscher Schluessel); der catch unten
    // meldet es und raeumt das Arbeitsverzeichnis auf.
    const source = openDatabase(dbPath, { dataDir, readonly: true, fileMustExist: true }).db;
    try {
      copyDatabaseTo(source, copyPath);
    } finally {
      source.close();
    }
    console.log(`  Kopie:  ${copyPath} (${formatBytes(fs.statSync(copyPath).size)})`);

    const copy = openDatabase(copyPath, { dataDir, fileMustExist: true }).db;
    try {
      // Ohne VACUUM: Die Kopie wird gleich geloescht, und ein VACUUM kostete eine
      // zweite volle Kopie (siehe MigrateOptions.vacuum).
      const applied = migrateDatabase(copy, { vacuum: false });
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
    console.error(`  ${errorText(err)}`);
    return 1;
  } finally {
    // Samt eventueller Hilfsdateien (-journal) der Kopie.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
