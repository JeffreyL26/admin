/**
 * Smoke-Test des Registers: ein Wegwerf-Register in os.tmpdir(), ein
 * eigenes Schluesselpaar, ein Durchstich durch die Befehle, die ohne
 * Netzzugriff auskommen.
 *
 * Bewusst KEIN Test gegen einen echten Host: ssh und scp gehoeren in den
 * Durchstich auf dem Testserver (docs/betrieb-anbieter.md), nicht in einen
 * Lauf, der bei jedem `npm test` mitlaufen soll.
 *
 * Aufruf: npm test -w tools/conspectus
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLicenseText, publicKeyFrom } from '@ohrganize/backend/core/licenseCodec';
import { issueLicense } from '@ohrganize/backend/core/licenseIssue';
import { todayIsoLocal } from '@ohrganize/shared';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `: ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // --- Pfadregel zuerst: Sie ist die eine Zusage, die dieses Werkzeug macht ---
  const { registerDir, ConspectusError, openRegister, resetRegisterCache } = await import('../db.js');
  // fileURLToPath statt URL.pathname: Unter Windows liefert pathname "/C:/...",
  // und path.resolve macht daraus einen Pfad mit doppeltem Laufwerksbuchstaben.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const insideRepo = path.join(repoRoot, 'tools/conspectus/register');

  let abgelehnt: string | false = false;
  try {
    registerDir({ OHRGANIZE_CONSPECTUS_DIR: insideRepo } as NodeJS.ProcessEnv);
  } catch (err) {
    abgelehnt = err instanceof ConspectusError && err.message.includes('Repository') ? 'ja' : String(err);
  }
  check('Pfad im Repository wird abgewiesen', abgelehnt === 'ja', abgelehnt);
  check('Abgewiesener Pfad wurde nicht angelegt', !fs.existsSync(insideRepo), insideRepo);

  let abgewiesen = false;
  try {
    registerDir({} as NodeJS.ProcessEnv);
  } catch (err) {
    abgewiesen = err instanceof ConspectusError && err.message.includes('OHRGANIZE_CONSPECTUS_DIR');
  }
  check('Fehlendes OHRGANIZE_CONSPECTUS_DIR wird abgewiesen', abgewiesen);

  abgewiesen = false;
  const syncDir = path.join(os.tmpdir(), `OneDrive-conspectus-${Date.now()}`);
  try {
    registerDir({ OHRGANIZE_CONSPECTUS_DIR: syncDir } as NodeJS.ProcessEnv);
  } catch (err) {
    abgewiesen = err instanceof ConspectusError && err.message.includes('synchronisierten');
  }
  check('Synchronisierter Ordner wird abgewiesen', abgewiesen);
  fs.rmSync(syncDir, { recursive: true, force: true });

  // --- Wegwerf-Register -----------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conspectus-smoke-'));
  process.env.OHRGANIZE_CONSPECTUS_DIR = dir;
  resetRegisterCache();
  const { db } = openRegister();
  check('Register angelegt', fs.existsSync(path.join(dir, 'conspectus.db')));

  // --- Eigenes Schluesselpaar (nie das des Anbieters) -----------------------
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const kid = 'smoke';
  fs.mkdirSync(path.join(dir, 'schluessel'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'schluessel', `${kid}.pem`),
    privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    { mode: 0o600 },
  );

  // --- Kunde, Host, Instanz -------------------------------------------------
  const { kundeCommand } = await import('../commands/kunde.js');
  const { hostCommand } = await import('../commands/host.js');
  const { instanzCommand, berichtUebernehmen } = await import('../commands/instanz.js');
  const { parseArgs } = await import('../args.js');

  kundeCommand('anlegen', parseArgs(['musterfirma', '--name', 'Musterfirma GmbH', '--email', 'it@musterfirma.de']));
  hostCommand('anlegen', parseArgs(['hz1', '--adresse', 'hz1.example.net', '--basis-domain', 'ohrganize.com']));
  instanzCommand(
    'anlegen',
    parseArgs(['musterfirma', '--kunde', 'musterfirma', '--variante', 'de-vollversion', '--host', 'hz1']),
  );
  const instanz = db.prepare('SELECT * FROM instanzen WHERE id = ?').get('musterfirma') as
    | { domain: string | null; variante: string }
    | undefined;
  check('Instanz angelegt', instanz !== undefined);
  check('Domain aus der Basisdomain des Hosts', instanz?.domain === 'musterfirma.ohrganize.com', instanz?.domain);

  let schluesselFehlt = false;
  try {
    instanzCommand('id', parseArgs(['musterfirma', 'nichthex']));
  } catch {
    schluesselFehlt = true;
  }
  check('Ungueltige Installations-ID wird abgewiesen', schluesselFehlt);

  const installation = 'a'.repeat(32);
  instanzCommand('id', parseArgs(['musterfirma', installation]));

  // --- Bericht einlesen (die Faehigkeit fuer v2 kommt daher) ---------------
  const bericht = [
    {
      kunde: 'musterfirma',
      domain: 'musterfirma.ohrganize.com',
      port: 3100,
      dienst: 'active',
      release: 'de-vollversion-1.0.0',
      variante_env: 'de-vollversion',
      variante_health: 'de-vollversion',
      version_health: '1.0.0',
      kanal: 'stable',
      instanz: {
        variant: { id: 'de-vollversion' },
        version: '1.0.0',
        installation_id: installation,
        license_format: 2,
        license: { state: 'trial' },
        counts: { employees_active: 27 },
      },
    },
  ];
  const uebernommen = berichtUebernehmen(bericht);
  check('Bericht uebernommen', uebernommen.includes('musterfirma'), uebernommen);
  const nachBericht = db.prepare('SELECT * FROM instanzen WHERE id = ?').get('musterfirma') as {
    license_format: number | null;
    version: string | null;
    aktive_profile: number | null;
  };
  check('license_format im Register', nachBericht.license_format === 2, nachBericht.license_format);
  check('Version im Register', nachBericht.version === '1.0.0', nachBericht.version);
  check('Platzzahl im Register', nachBericht.aktive_profile === 27, nachBericht.aktive_profile);

  // --- Lizenz ausstellen ----------------------------------------------------
  const { lizenzCommand } = await import('../commands/lizenz.js');
  lizenzCommand(
    'ausstellen',
    parseArgs([
      '--instanz', 'musterfirma',
      '--until', '1j',
      '--kid', kid,
      '--billing', 'abo',
      '--interval', 'jaehrlich',
      '--seats', '50',
    ]),
  );
  const lizenz = db.prepare('SELECT * FROM lizenzen ORDER BY rowid DESC LIMIT 1').get() as {
    v: number;
    edition: string | null;
    land: string | null;
    installation_id: string | null;
    datei: string;
    plaetze: number | null;
  };
  check('Lizenz v2 ausgestellt', lizenz.v === 2, lizenz.v);
  check('Ausgabe aus der Instanz uebernommen', lizenz.edition === 'vollversion' && lizenz.land === 'DE', lizenz);
  check('An die Installation gebunden', lizenz.installation_id === installation, lizenz.installation_id);
  check('Plaetze uebernommen', lizenz.plaetze === 50, lizenz.plaetze);
  check('Datei geschrieben', fs.existsSync(lizenz.datei));

  // Die Datei muss der Pruefung standhalten, die der Server macht.
  const text = fs.readFileSync(lizenz.datei, 'utf8');
  const payload = verifyLicenseText(text, [{ kid, publicKey: publicKeyFrom(publicKey.export({ format: 'pem', type: 'spki' }).toString()) }]);
  check('Datei besteht die Serverpruefung', payload.customer_id === 'musterfirma', payload.customer_id);
  check('Vertragsbedingungen in der Datei', payload.terms?.billing === 'abo', payload.terms);

  // --- v2 ohne belegte Faehigkeit wird verweigert ---------------------------
  instanzCommand('anlegen', parseArgs(['alt-ag', '--kunde', 'musterfirma', '--variante', 'de-vollversion', '--host', 'hz1']));
  instanzCommand('id', parseArgs(['alt-ag', 'b'.repeat(32)]));
  let verweigert = false;
  try {
    lizenzCommand('ausstellen', parseArgs(['--instanz', 'alt-ag', '--until', '1j', '--kid', kid]));
  } catch (err) {
    verweigert = (err as Error).message.includes('Fassung 2');
  }
  check('v2 ohne belegte Faehigkeit wird verweigert', verweigert);

  // v1 geht trotzdem: Jeder Server liest sie.
  lizenzCommand('ausstellen', parseArgs(['--instanz', 'alt-ag', '--until', '1j', '--kid', kid, '--v1']));
  const v1 = db.prepare("SELECT * FROM lizenzen WHERE instanz_id = 'alt-ag'").get() as { v: number };
  check('v1 bleibt moeglich', v1.v === 1, v1.v);

  // --- Verlaengern erbt die Felder -----------------------------------------
  lizenzCommand('verlaengern', parseArgs(['--instanz', 'musterfirma', '--until', '1j']));
  const verlaengert = db
    .prepare("SELECT * FROM lizenzen WHERE instanz_id = 'musterfirma' ORDER BY rowid DESC LIMIT 1")
    .get() as { billing: string | null; plaetze: number | null; gueltig_ab: string; kid: string | null; v: number };
  check('Verlaengerung erbt Abrechnungsart', verlaengert.billing === 'abo', verlaengert.billing);
  check('Verlaengerung erbt Plaetze', verlaengert.plaetze === 50, verlaengert.plaetze);
  check('Verlaengerung erbt den Schluessel', verlaengert.kid === kid, verlaengert.kid);
  check('Verlaengerung beginnt nach dem alten Ende', verlaengert.gueltig_ab > todayIsoLocal(), verlaengert.gueltig_ab);

  // Eine v1-Lizenz bleibt beim Verlaengern v1.
  lizenzCommand('verlaengern', parseArgs(['--instanz', 'alt-ag', '--until', '1j']));
  const v1Verlaengert = db
    .prepare("SELECT * FROM lizenzen WHERE instanz_id = 'alt-ag' ORDER BY rowid DESC LIMIT 1")
    .get() as { v: number };
  check('Verlaengerung einer v1 bleibt v1', v1Verlaengert.v === 1, v1Verlaengert.v);

  // --- faellig, check, uebersicht, html ------------------------------------
  const { sammleBefunde } = await import('../commands/check.js');
  const befunde = sammleBefunde(30);
  check('check findet Befunde', befunde.length > 0, befunde.length);

  const { buildHtml } = await import('../report.js');
  const html = buildHtml();
  check('HTML nennt den Kunden', html.includes('Musterfirma GmbH'));
  check('HTML ist eine vollstaendige Seite', html.startsWith('<!doctype html>') && html.includes('</html>'));

  // --- Release erfassen (ohne Signatur: wird als ungeprueft vermerkt) -------
  const releaseDir = path.join(dir, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const manifest = path.join(releaseDir, 'release.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      product: 'ohrganize',
      version: '1.1.0',
      channel: 'stable',
      variant: { id: 'de-vollversion', country: 'DE', edition: 'vollversion', label: 'Deutschland Vollversion' },
      artifacts: [{ file: 'ohrganize-server-de-vollversion-1.1.0.zip', sha256: 'ab'.repeat(32), bytes: 1234 }],
      commit: 'deadbeef',
      built_at: new Date().toISOString(),
    }),
  );
  const { releaseCommand } = await import('../commands/release.js');
  releaseCommand('erfassen', parseArgs([manifest]));
  const release = db.prepare('SELECT * FROM releases WHERE id = ?').get('de-vollversion-1.1.0') as
    | { signatur_geprueft: number; kanal: string }
    | undefined;
  check('Release erfasst', release !== undefined);
  check('Ohne Signatur als ungeprueft vermerkt', release?.signatur_geprueft === 0, release?.signatur_geprueft);

  // --- CSV-Import -----------------------------------------------------------
  const { parseCsv, betragNachCent, csvImportCommand } = await import('../commands/csvImport.js');
  const zeilen = parseCsv('id;name\r\nbeispiel;"Beispiel; AG"\r\n');
  check('CSV liest Anfuehrungszeichen', zeilen[1]?.[1] === 'Beispiel; AG', zeilen[1]);
  check('Betrag deutsch', betragNachCent('1.190,00') === 119000, betragNachCent('1.190,00'));
  check('Betrag englisch', betragNachCent('1190.00') === 119000, betragNachCent('1190.00'));

  const csv = path.join(dir, 'kunden.csv');
  fs.writeFileSync(csv, '﻿id;name;email\nbeispiel;Beispiel AG;it@beispiel.de\n');
  csvImportCommand('kunden', parseArgs([csv]));
  check('CSV-Kunde uebernommen', db.prepare("SELECT 1 FROM kunden WHERE id = 'beispiel'").get() !== undefined);

  const zahlungen = path.join(dir, 'zahlungen.csv');
  fs.writeFileSync(zahlungen, 'kunde;datum;betrag;beleg\nbeispiel;2026-09-15;1.190,00;RE-1\n');
  csvImportCommand('zahlungen', parseArgs([zahlungen]));
  const zahlung = db.prepare("SELECT * FROM vorgaenge WHERE art = 'zahlung'").get() as
    | { betrag_cent: number }
    | undefined;
  check('Zahlung uebernommen', zahlung?.betrag_cent === 119000, zahlung?.betrag_cent);

  // --- Aufraeumen -----------------------------------------------------------
  resetRegisterCache();
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} Pruefung(en) fehlgeschlagen.`);
    process.exit(1);
  }
  console.log('\nAlle conspectus-Pruefungen bestanden.');
}

await main();
