#!/usr/bin/env node
/**
 * conspectus - Register und Werkzeug des ANBIETERS.
 *
 * Es beantwortet die Fragen, die zwischen Vertrag und Server liegen: Welcher
 * Kunde hat welche Instanz, in welcher Ausgabe, mit welcher Lizenz bis wann,
 * auf welchem Release, und was ist offen? Ausgestellt wird mit demselben
 * Baustein wie im schlanken Werkzeug (`npm run lizenz`), damit eine hier
 * erzeugte Datei genau das ist, was der Server akzeptiert.
 *
 * Das Register (SQLite) liegt AUSSERHALB des Repositories, der Pfad steht in
 * OHRGANIZE_CONSPECTUS_DIR und ist Pflicht. Der private Lizenzschluessel liegt
 * daneben und ist mit OHRGANIZE_LICENSE_PASSPHRASE geschuetzt.
 *
 *   npm run conspectus -- --help
 *
 * Laeuft nie auf einem Kundensystem: Es ist kein Teil eines Bundles und
 * greift ueber ssh auf die Hosts zu, nicht umgekehrt.
 */
import { parseArgs } from './args.js';
import { ConspectusError } from './db.js';
import { kundeCommand } from './commands/kunde.js';
import { hostCommand } from './commands/host.js';
import { instanzCommand } from './commands/instanz.js';
import { lizenzCommand } from './commands/lizenz.js';
import { releaseCommand } from './commands/release.js';
import { rolloutCommand } from './commands/rollout.js';
import { berichtCommand, statusCommand } from './commands/status.js';
import { checkCommand } from './commands/check.js';
import { htmlCommand, uebersichtCommand } from './commands/uebersicht.js';
import { csvImportCommand, zahlungCommand } from './commands/csvImport.js';

// `npm run conspectus` startet im Workspace tools/conspectus; Dateipfade in
// den Argumenten meint der Aufrufer aber relativ zu SEINEM Verzeichnis. npm
// nennt es in INIT_CWD.
if (process.env.INIT_CWD && process.env.INIT_CWD !== process.cwd()) {
  try {
    process.chdir(process.env.INIT_CWD);
  } catch {
    // Verzeichnis nicht mehr erreichbar: dann gilt das Arbeitsverzeichnis von npm.
  }
}

const HILFE = `conspectus - Register und Werkzeug des Anbieters

  kunde anlegen <id> --name "..." [--kontakt ... --email ... --notiz ...]
  kunde aendern <id> [--name ... --kontakt ... --email ... --notiz ...]
  kunde liste

  host anlegen <id> --adresse <host> [--benutzer root --port 22 --basis-domain ohrganize.com]
                                     [--schluessel <privater-ssh-schluessel>]
  host liste

  instanz anlegen <id> --kunde <kunde> --variante de-vollversion
                       [--host <host>] [--art hosting|kunde-server|einzelplatz]
                       [--domain ...] [--installation <32 hex>]
  instanz id <id> <32 hex>            Installations-ID nachtragen
  instanz liste

  lizenz ausstellen --instanz <instanz> --until 1j|3t|2027-12-31|unbefristet
                    [--kind standard|evaluation] [--seats 50]
                    [--billing kostenfrei|abo|kauf|individuell] [--interval monatlich|jaehrlich]
                    [--label "..."] [--headline "..."] [--feature kunde.x.y ...]
                    [--notice "Rechnung ..."] [--grace 14] [--warn 30]
                    [--kid <kid>] [--key <datei>] [--v1] [--v2-erzwingen]
                    [--ungebunden] [--einspielen]
  lizenz verlaengern --instanz <instanz> --until 1j
  lizenz eingespielt <instanz> [--am 2026-10-01]   von Hand vermerken (Kunden-Server)
  lizenz faellig [--tage 45]
  lizenz liste

  release erfassen <pfad/release.json> [--signers <allowed_signers>]
  release liste

  rollout starten --release <variante-version> [--host <host> | --kunde <instanz>]
                  [--probelauf] [--ohne-signatur]
  rollout liste

  status --host <host> | --instanz <instanz> [--json]
  bericht importieren <datei.json> [--instanz <instanz>]

  check [--tage 30]
  uebersicht
  html [--out <datei.html>]

  csv-import kunden <datei.csv>       Spalten: id;name[;kontakt;email;notiz]
  csv-import zahlungen <datei.csv>    Spalten: kunde;datum;betrag[;waehrung;beleg;text]
  zahlung <kunde> --betrag 1190,00 [--datum ... --beleg ...]

Umgebung:
  OHRGANIZE_CONSPECTUS_DIR     Register (Pflicht, ausserhalb des Repos)
  OHRGANIZE_LICENSE_PASSPHRASE Passphrase des privaten Lizenzschluessels

Doku: docs/betrieb-anbieter.md
`;

function main(argv: string[]): void {
  const befehl = argv[0];
  if (!befehl || befehl === '--help' || befehl === '-h' || befehl === 'hilfe') {
    console.log(HILFE);
    return;
  }
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
  // Der Unterbefehl ist verbraucht, wenn er keine Option war.
  const rest = parseArgs(sub ? argv.slice(2) : argv.slice(1));

  switch (befehl) {
    case 'kunde':
      return kundeCommand(sub, rest);
    case 'host':
      return hostCommand(sub, rest);
    case 'instanz':
      return instanzCommand(sub, rest);
    case 'lizenz':
      return lizenzCommand(sub, rest);
    case 'release':
      return releaseCommand(sub, rest);
    case 'rollout':
      return rolloutCommand(sub, rest);
    case 'status':
      return statusCommand(parseArgs(argv.slice(1)));
    case 'bericht':
      return berichtCommand(sub, rest);
    case 'check':
      return checkCommand(parseArgs(argv.slice(1)));
    case 'uebersicht':
      return uebersichtCommand();
    case 'html':
      return htmlCommand(parseArgs(argv.slice(1)));
    case 'csv-import':
      return csvImportCommand(sub, rest);
    case 'zahlung':
      return zahlungCommand(parseArgs(argv.slice(1)));
    default:
      console.error(`Unbekannter Befehl: ${befehl}\n`);
      console.error(HILFE);
      process.exit(1);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof ConspectusError || err instanceof Error) {
    console.error(`\nFehler: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
