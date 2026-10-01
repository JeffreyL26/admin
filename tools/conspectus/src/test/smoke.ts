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
import { addDaysIso, todayIsoLocal } from '@ohrganize/shared';
import type { ReportImport } from '../commands/instanz.js';

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `: ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

/** Konsolenausgabe eines Befehls als Text. */
function captureLog(fn: () => void): string {
  const zeilen: string[] = [];
  const log = console.log;
  console.log = (...teile: unknown[]) => {
    zeilen.push(teile.join(' '));
  };
  try {
    fn();
  } finally {
    console.log = log;
  }
  return zeilen.join('\n');
}

function throwsWith(fn: () => void, part: string): boolean {
  try {
    fn();
  } catch (err) {
    return (err as Error).message.includes(part);
  }
  return false;
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
  const { taken } = berichtUebernehmen(bericht);
  check('Bericht uebernommen', taken.includes('musterfirma'), taken);
  const nachBericht = db.prepare('SELECT * FROM instanzen WHERE id = ?').get('musterfirma') as {
    license_format: number | null;
    version: string | null;
    aktive_profile: number | null;
  };
  check('license_format im Register', nachBericht.license_format === 2, nachBericht.license_format);
  check('Version im Register', nachBericht.version === '1.0.0', nachBericht.version);
  check('Platzzahl im Register', nachBericht.aktive_profile === 27, nachBericht.aktive_profile);

  // --- Bericht als Datei, wie ein Windows-Server sie liefert -----------------
  // `node status.cjs --json > bericht.json` in Windows PowerShell 5.1 schreibt
  // UTF-16 LE mit BOM; readFileSync(..., 'utf8') gaebe daraus kein JSON.
  const { berichtCommand } = await import('../commands/status.js');
  const berichtDatei = path.join(dir, 'bericht-utf16.json');
  const einzel = JSON.stringify({ ...bericht[0].instanz, version: '1.1.0' });
  fs.writeFileSync(berichtDatei, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(einzel, 'utf16le')]));
  berichtCommand('importieren', parseArgs([berichtDatei, '--instanz', 'musterfirma']));
  const nachDatei = db.prepare('SELECT version FROM instanzen WHERE id = ?').get('musterfirma') as { version: string | null };
  check('Bericht aus UTF-16-Datei uebernommen', nachDatei.version === '1.1.0', nachDatei.version);

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
  // Eine Jahreslizenz ist in 30 Tagen nicht faellig; mit grossem Fenster
  // (verlaengert: bis zu zwei Jahre) muss die Restlaufzeit positiv sein (frueher stand dort "noch -364 Tage").
  check('check: Jahreslizenz nicht in 30 Tagen faellig', !befunde.some((b) => /laeuft am .* ab/.test(b.text)), befunde.map((b) => b.text));
  const weit = sammleBefunde(800).filter((b) => /laeuft am .* ab/.test(b.text));
  check('check: Resttage positiv', weit.length > 0 && weit.every((b) => /noch [1-9][0-9]* Tage/.test(b.text)), weit.map((b) => b.text));

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
  const { releaseCommand, neuestesRelease } = await import('../commands/release.js');
  releaseCommand('erfassen', parseArgs([manifest]));
  const release = db.prepare('SELECT * FROM releases WHERE id = ?').get('de-vollversion-1.1.0') as
    | { signatur_geprueft: number; kanal: string }
    | undefined;
  check('Release erfasst', release !== undefined);
  check('Ohne Signatur als ungeprueft vermerkt', release?.signatur_geprueft === 0, release?.signatur_geprueft);

  // --- Versionsvergleich ----------------------------------------------------
  // Absichtlich absteigend eingetragen: Ohne Sortierung gewaenne die
  // Einfuegereihenfolge, als Text gewaenne 1.9.0.
  const insertRelease = db.prepare('INSERT INTO releases (id, version, kanal, variante) VALUES (?, ?, ?, ?)');
  insertRelease.run('de-vollversion-1.10.0', '1.10.0', 'stable', 'de-vollversion');
  insertRelease.run('de-vollversion-1.9.0', '1.9.0', 'stable', 'de-vollversion');
  insertRelease.run('de-vollversion-1.11.0-beta.2', '1.11.0-beta.2', 'beta', 'de-vollversion');
  const neuestesStable = neuestesRelease('de-vollversion', false)?.version;
  check('Juengstes Release numerisch bestimmt', neuestesStable === '1.10.0', neuestesStable);
  const releaseListe = captureLog(() => releaseCommand('liste', parseArgs([])));
  const pos190 = releaseListe.indexOf('de-vollversion-1.9.0 ');
  check('release liste nach Version sortiert', pos190 >= 0 && pos190 < releaseListe.indexOf('de-vollversion-1.10.0 '), releaseListe);

  const versionHint = (id: string): string | undefined =>
    sammleBefunde(30).find((b) => b.was === id && b.text.startsWith('Laeuft auf'))?.text;
  const setVersion = (version: string, kanal: string | null): void => {
    db.prepare("UPDATE instanzen SET version = ?, kanal = ? WHERE id = 'musterfirma'").run(version, kanal);
  };
  setVersion('1.10.0', 'stable');
  check('Instanz auf dem juengsten Release ohne Versionshinweis', versionHint('musterfirma') === undefined);
  setVersion('1.11.0', 'stable');
  check('Instanz neuer als das juengste Release ohne Versionshinweis', versionHint('musterfirma') === undefined);
  setVersion('1.9.0', 'stable');
  check('Instanz auf 1.9.0 gilt als veraltet', versionHint('musterfirma')?.includes('1.10.0') === true, versionHint('musterfirma'));
  // Der Einzelbericht von status.cjs nennt keinen Kanal: Er folgt aus der Version.
  setVersion('1.11.0-beta.1', null);
  const betaHinweis = versionHint('musterfirma');
  check('Beta ohne Kanal wird mit den Betas verglichen', betaHinweis?.includes('beta-Release ist 1.11.0-beta.2') === true, betaHinweis);
  // Auch das fertige Release loest eine Beta ab.
  insertRelease.run('de-vollversion-1.11.0', '1.11.0', 'stable', 'de-vollversion');
  setVersion('1.11.0-beta.2', 'beta');
  const fertigHinweis = versionHint('musterfirma');
  check('Beta wird mit dem fertigen Release verglichen', fertigHinweis?.includes('stable-Release ist 1.11.0') === true, fertigHinweis);
  setVersion('1.9.0', '');
  check('Leerer Kanal verschluckt den Versionshinweis nicht', versionHint('musterfirma') !== undefined);
  berichtUebernehmen([{ kunde: 'musterfirma', kanal: '', version_health: '', instanz: null }]);
  const nachLeerem = db.prepare("SELECT version FROM instanzen WHERE id = 'musterfirma'").get() as { version: string | null };
  check('Leere Health-Felder ueberschreiben die Version nicht', nachLeerem.version === '1.9.0', nachLeerem.version);

  // --- Ausgestellte und laufende Lizenz -------------------------------------
  const { currentLicense, instanceLicenses } = await import('../licenses.js');
  const heute = todayIsoLocal();
  const finding = (id: string, teil: string): string | undefined =>
    sammleBefunde(30).find((b) => b.was === id && b.text.includes(teil))?.text;
  const installedOn = (licenseId: string): string | null =>
    (db.prepare('SELECT eingespielt_am FROM lizenzen WHERE license_id = ?').get(licenseId) as { eingespielt_am: string | null })
      .eingespielt_am;
  const running = (id: string): string | undefined => instanceLicenses().get(id)?.running.license_id;

  // Sammelbericht (status.cjs unter `instanz`) meldet die ausgestellte Lizenz.
  // Gelesen in einer Zeitzone, deren Datum gerade vom UTC-Datum abweicht: Der
  // Vermerk muss dem lokalen Kalendertag folgen, nicht SQLites date('now').
  const mfAktuell = currentLicense('musterfirma')!;
  check('Vor dem Bericht: Befund nicht eingespielt', finding('musterfirma', 'nicht als eingespielt') !== undefined);
  // Zurueck nur per Zuweisung: Loeschen der Variable setzt Nodes Zeitzone nicht zurueck.
  const tzVorher = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = new Date().getUTCHours() >= 12 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
  const lokalerTag = todayIsoLocal();
  berichtUebernehmen([
    { kunde: 'musterfirma', instanz: { license: { state: 'valid', license_id: mfAktuell.license_id } } },
  ]);
  process.env.TZ = tzVorher;
  check(
    'Bericht mit Lizenznummer vermerkt eingespielt und laufend (lokaler Tag)',
    finding('musterfirma', 'nicht als eingespielt') === undefined &&
      running('musterfirma') === mfAktuell.license_id &&
      installedOn(mfAktuell.license_id) === lokalerTag &&
      lokalerTag !== new Date().toISOString().slice(0, 10),
    { am: installedOn(mfAktuell.license_id), lokalerTag },
  );

  // Kunden-Server: Platzaenderung am selben Tag, gleiches Ende.
  instanzCommand('anlegen', parseArgs(['sitz-ag', '--kunde', 'musterfirma', '--variante', 'de-vollversion']));
  const sitzInstallation = 'c'.repeat(32);
  berichtUebernehmen({ installation_id: sitzInstallation, license_format: 2, version: '1.10.0' }, 'sitz-ag');
  const issueSitz = (...extra: string[]) => {
    lizenzCommand('ausstellen', parseArgs(['--instanz', 'sitz-ag', '--kid', kid, ...extra]));
    return currentLicense('sitz-ag')!;
  };
  const sitzA = issueSitz('--until', '1j', '--seats', '50');
  const sitzB = issueSitz('--until', '1j', '--seats', '80');
  const kurzB = sitzB.license_id.slice(0, 8);
  check('check nennt die zuletzt ausgestellte Lizenz', finding('sitz-ag', 'nicht als eingespielt')?.includes(kurzB) === true);
  // Am selben Tag entscheidet der Ausstellzeitpunkt, nicht die rowid.
  const setIssuedAt = (licenseId: string, um: string | null): void => {
    db.prepare('UPDATE lizenzen SET ausgestellt_um = ? WHERE license_id = ?').run(um, licenseId);
  };
  setIssuedAt(sitzA.license_id, '9999-12-31T00:00:00.000Z');
  check('Ausstellzeitpunkt entscheidet am selben Tag', currentLicense('sitz-ag')?.license_id === sitzA.license_id);
  setIssuedAt(sitzA.license_id, sitzA.ausgestellt_um);

  // Berichte, die erkennbar zu einer anderen Instanz gehoeren, werden abgelehnt.
  const licenseReport = (felder: Record<string, unknown>) => ({
    generated_at: new Date().toISOString(),
    installation_id: sitzInstallation,
    customer_id: 'musterfirma',
    state: 'valid',
    seats_used: 12,
    max_users: 80,
    server_version: '1.10.0',
    license_format: 2,
    ...felder,
  });
  const isRejected = (result: ReportImport, part: string): boolean =>
    result.taken.length === 0 && result.rejected.some((r) => r.reason.includes(part));
  check(
    'Bericht mit fremder Installations-ID wird abgelehnt',
    isRejected(berichtUebernehmen(licenseReport({ installation_id: 'f'.repeat(32) }), 'sitz-ag'), '--neue-installation'),
  );
  check(
    'Bericht mit der Lizenz einer anderen Instanz wird abgelehnt',
    isRejected(berichtUebernehmen(licenseReport({ license_id: mfAktuell.license_id }), 'sitz-ag'), 'gehoert zur Instanz'),
  );
  check(
    'Bericht eines anderen Kunden wird abgelehnt',
    isRejected(berichtUebernehmen(licenseReport({ customer_id: 'fremd', license_id: null }), 'sitz-ag'), 'Kunden'),
  );
  const sitzBinding = (): string | null =>
    (db.prepare("SELECT installation_id FROM instanzen WHERE id = 'sitz-ag'").get() as { installation_id: string | null })
      .installation_id;
  check('Abgelehnte Berichte aendern nichts', sitzBinding() === sitzInstallation && running('sitz-ag') !== mfAktuell.license_id);
  // Beim Import mit --instanz kann es die falsche Datei gewesen sein: Fehler ja, Dauerbefund nein.
  check('Abgelehnter Einzelbericht hinterlaesst keinen Befund', finding('sitz-ag', 'abgelehnt') === undefined);
  check(
    'Bestaetigung fuer eine andere Instanz gilt nicht',
    isRejected(
      berichtUebernehmen(licenseReport({ installation_id: 'f'.repeat(32) }), 'sitz-ag', { newInstallation: 'musterfirma' }),
      '--neue-installation sitz-ag',
    ),
  );

  // Sammelbericht eines Hosts: --neue-installation gilt nur fuer die genannte Instanz.
  const { importHostReport, statusCommand } = await import('../commands/status.js');
  // Vor dem ssh-Aufruf geprueft: Sonst versuchte der Test hz1.example.net zu erreichen.
  check(
    'status --neue-installation ohne Instanz bricht vor ssh ab',
    throwsWith(() => statusCommand(parseArgs(['--host', 'hz1', '--neue-installation'])), 'nennt die Instanz'),
  );
  const hostReport = [
    { kunde: 'sitz-ag', instanz: { installation_id: 'f'.repeat(32), version: '1.10.0' } },
    { kunde: 'musterfirma', instanz: { installation_id: 'd'.repeat(32), version: '9.9.9' } },
  ];
  check(
    '--neue-installation ohne Instanz wird abgewiesen',
    throwsWith(() => importHostReport(hostReport, parseArgs(['--host', 'hz1', '--neue-installation'])), 'nennt die Instanz'),
  );
  let hostImport: ReportImport | undefined;
  captureLog(() => {
    hostImport = importHostReport(hostReport, parseArgs(['--host', 'hz1', '--neue-installation', 'sitz-ag']));
  });
  const mfVersion = (db.prepare("SELECT version FROM instanzen WHERE id = 'musterfirma'").get() as { version: string | null }).version;
  check(
    'Hostbericht: Bestaetigung nur fuer die genannte Instanz',
    hostImport?.taken.join() === 'sitz-ag' &&
      hostImport.rejected.some((r) => r.id === 'musterfirma') &&
      sitzBinding() === 'f'.repeat(32) &&
      mfVersion !== '9.9.9' &&
      finding('sitz-ag', 'abgelehnt') === undefined &&
      finding('musterfirma', 'abgelehnt') !== undefined,
    hostImport,
  );
  // Ein Eintrag ohne Kennung (status.cjs fehlte) weist nichts nach und hebt den Befund nicht auf.
  captureLog(() => importHostReport([{ kunde: 'musterfirma', instanz: null }], parseArgs(['--host', 'hz1'])));
  check('Bericht ohne Kennung hebt den Ablehnungsbefund nicht auf', finding('musterfirma', 'abgelehnt') !== undefined);
  captureLog(() => importHostReport([{ kunde: 'musterfirma', instanz: { installation_id: installation } }], parseArgs(['--host', 'hz1'])));
  check('Passender Bericht hebt den Ablehnungsbefund auf', finding('musterfirma', 'abgelehnt') === undefined);
  captureLog(() => importHostReport([hostReport[1]], parseArgs(['--host', 'hz1'])));
  instanzCommand('id', parseArgs(['musterfirma', installation]));
  check('instanz id hebt den Ablehnungsbefund auf', finding('musterfirma', 'abgelehnt') === undefined);
  instanzCommand('id', parseArgs(['sitz-ag', sitzInstallation]));

  // Lizenzbericht der Desktop-App: alles auf oberster Ebene.
  const ausLizenzbericht = berichtUebernehmen(licenseReport({ license_id: sitzB.license_id }), 'sitz-ag');
  const sitzNach = db.prepare("SELECT lizenz_zustand, aktive_profile FROM instanzen WHERE id = 'sitz-ag'").get() as {
    lizenz_zustand: string | null;
    aktive_profile: number | null;
  };
  check(
    'Lizenzbericht setzt den Vermerk',
    ausLizenzbericht.taken.includes('sitz-ag') &&
      installedOn(sitzB.license_id) === heute &&
      running('sitz-ag') === sitzB.license_id &&
      finding('sitz-ag', 'nicht als eingespielt') === undefined,
    { ausLizenzbericht, am: installedOn(sitzB.license_id) },
  );
  check('Lizenzbericht liefert Zustand und Platzzahl', sitzNach.lizenz_zustand === 'valid' && sitzNach.aktive_profile === 12, sitzNach);
  check(
    'Zweites Nachtragen bricht ab statt eine aeltere Lizenz zu vermerken',
    throwsWith(() => lizenzCommand('eingespielt', parseArgs(['sitz-ag'])), 'bereits') && installedOn(sitzA.license_id) === null,
  );

  // Spaeter ausgestellt und kuerzer: Bis sie eingespielt ist, laeuft B weiter.
  const sitzC = issueSitz('--until', '20t');
  const kurzC = sitzC.license_id.slice(0, 8);
  check(
    'Nicht eingespielte Lizenz loest keine Ablaufwarnung aus',
    finding('sitz-ag', 'laeuft am') === undefined && finding('sitz-ag', 'nicht als eingespielt')?.includes(kurzC) === true,
    sammleBefunde(30).filter((b) => b.was === 'sitz-ag'),
  );
  // Ausstellung auf gestern, damit ein --am ungleich heute zulaessig ist.
  const gestern = addDaysIso(heute, -1);
  db.prepare("UPDATE lizenzen SET ausgestellt_am = ? WHERE instanz_id = 'sitz-ag'").run(gestern);
  const markByHand = (...extra: string[]) => () => lizenzCommand('eingespielt', parseArgs(['sitz-ag', ...extra]));
  check('--am mit unmoeglichem Datum wird abgewiesen', throwsWith(markByHand('--am', '2026-02-31'), 'Kalendertag'));
  check('--am ohne Wert wird abgewiesen', throwsWith(markByHand('--am'), 'Aufruf'));
  check('Datum ohne --am wird abgewiesen', throwsWith(markByHand(gestern), 'Aufruf'));
  check('--am vor der Ausstellung wird abgewiesen', throwsWith(markByHand('--am', addDaysIso(gestern, -1)), 'ausserhalb'));
  check('--am in der Zukunft wird abgewiesen', throwsWith(markByHand('--am', addDaysIso(heute, 1)), 'ausserhalb'));
  check('Abgewiesene Aufrufe vermerken nichts', installedOn(sitzC.license_id) === null);
  markByHand(`--am=${gestern}`)();
  check(
    'Nachtragen vermerkt das Datum aus --am= und macht die Lizenz laufend',
    installedOn(sitzC.license_id) === gestern && running('sitz-ag') === sitzC.license_id,
    installedOn(sitzC.license_id),
  );
  check('Ablaufwarnung fuer die laufende, kuerzere Lizenz', finding('sitz-ag', `laeuft am ${sitzC.gueltig_bis} ab`) !== undefined);

  // Restore: Die Instanz meldet wieder B, obwohl C eingespielt war.
  berichtUebernehmen({ installation_id: sitzInstallation, license: { license_id: sitzB.license_id } }, 'sitz-ag');
  check('Restore auf eine aeltere Lizenz wird gemeldet', finding('sitz-ag', 'Restore')?.includes(kurzC) === true);
  check('Ablauf folgt nach dem Restore der gemeldeten Lizenz', finding('sitz-ag', 'laeuft am') === undefined);
  markByHand()();
  check('Erneutes Einspielen von Hand macht C wieder laufend', finding('sitz-ag', 'Restore') === undefined && running('sitz-ag') === sitzC.license_id);
  // Register von vor `laufende_lizenz`: Laufend ist die zuletzt eingespielte
  // (C); eine aeltere eingespielte laesst sich trotzdem als laufend vermerken.
  db.prepare("UPDATE instanzen SET laufende_lizenz = NULL WHERE id = 'sitz-ag'").run();
  const sitzB8 = sitzB.license_id.slice(0, 8);
  markByHand('--lizenz', sitzB8)();
  check('Aeltere Lizenz ohne laufende_lizenz wieder als laufend vermerkbar', running('sitz-ag') === sitzB.license_id);
  check('Zweiter Vermerk derselben laufenden Lizenz bricht ab', throwsWith(markByHand('--lizenz', sitzB8), 'bereits'));
  markByHand()();
  check('Danach wieder C laufend', running('sitz-ag') === sitzC.license_id);

  // bericht importieren: --neue-installation bestaetigt nur die --instanz.
  const sitzBerichtDatei = path.join(dir, 'sitz-bericht.json');
  fs.writeFileSync(sitzBerichtDatei, JSON.stringify({ installation_id: sitzInstallation, version: '1.10.0' }));
  check(
    '--neue-installation vor dem Dateinamen verschluckt ihn nicht still',
    throwsWith(
      () => berichtCommand('importieren', parseArgs(['--neue-installation', sitzBerichtDatei, '--instanz', 'sitz-ag'])),
      'nach dem Dateinamen',
    ),
  );
  check(
    '--neue-installation fuer eine andere als die --instanz wird abgewiesen',
    throwsWith(
      () => berichtCommand('importieren', parseArgs([sitzBerichtDatei, '--neue-installation', 'kurz-ag', '--instanz', 'sitz-ag'])),
      'nicht "kurz-ag"',
    ),
  );
  check(
    '--neue-installation ohne --instanz wird abgewiesen',
    throwsWith(() => berichtCommand('importieren', parseArgs([sitzBerichtDatei, '--neue-installation'])), 'braucht --instanz'),
  );
  // Neue Installation: Die neue ID wird uebernommen, und check meldet, dass die
  // Lizenzen noch an die alte gebunden sind.
  const neueId = '9'.repeat(32);
  fs.writeFileSync(sitzBerichtDatei, JSON.stringify({ installation_id: neueId, version: '1.10.0' }));
  check(
    'Neue Installations-ID ohne Bestaetigung wird abgewiesen',
    throwsWith(() => berichtCommand('importieren', parseArgs([sitzBerichtDatei, '--instanz', 'sitz-ag'])), '--neue-installation'),
  );
  captureLog(() => berichtCommand('importieren', parseArgs([sitzBerichtDatei, '--instanz', 'sitz-ag', '--neue-installation', 'sitz-ag'])));
  check(
    '--neue-installation mit dem Schluessel der --instanz uebernimmt die neue ID',
    sitzBinding() === neueId && finding('sitz-ag', 'gebunden')?.includes(sitzC.license_id.slice(0, 8)) === true,
    sammleBefunde(30).filter((b) => b.was === 'sitz-ag'),
  );
  check(
    'Ohne passende Lizenz raet der Befund zu einer neuen',
    finding('sitz-ag', 'gebunden')?.includes('neue ausstellen') === true,
  );
  // Ist die passende schon ausgestellt, fehlt nur das Einspielen.
  const sitzNeu = issueSitz('--until', '1j');
  check(
    'Mit passender ausgestellter Lizenz raet der Befund zum Einspielen',
    finding('sitz-ag', 'gebunden')?.includes(`die ausgestellte ${sitzNeu.license_id.slice(0, 8)} einspielen lassen`) === true,
    sammleBefunde(30).filter((b) => b.was === 'sitz-ag'),
  );
  lizenzCommand('zurueckziehen', parseArgs([sitzNeu.license_id.slice(0, 8)]));
  instanzCommand('id', parseArgs(['sitz-ag', sitzInstallation]));
  check('Passende Bindung: kein Befund', finding('sitz-ag', 'gebunden') === undefined);

  // Sammelbericht mit --instanz: nur der Eintrag dieser Instanz zaehlt.
  const auswahl = berichtUebernehmen(
    [
      { kunde: 'sitz-ag', instanz: { version: '1.10.0' } },
      { kunde: 'musterfirma', instanz: { installation_id: 'd'.repeat(32), version: '9.9.9' } },
    ],
    'sitz-ag',
  );
  check(
    '--instanz waehlt im Sammelbericht aus',
    auswahl.taken.join() === 'sitz-ag' && sitzBinding() === sitzInstallation,
    auswahl,
  );
  const sammelDatei = path.join(dir, 'sammel.json');
  fs.writeFileSync(sammelDatei, JSON.stringify([{ kunde: 'musterfirma', instanz: { version: '1.9.0' } }]));
  check(
    '--instanz ohne Eintrag im Sammelbericht nennt die enthaltenen',
    throwsWith(() => berichtCommand('importieren', parseArgs([sammelDatei, '--instanz', 'sitz-ag'])), 'enthalten: musterfirma'),
  );

  // --- Nie eingespielte Evaluation, zurueckziehen ---------------------------
  instanzCommand('anlegen', parseArgs(['pilot-ag', '--kunde', 'musterfirma', '--variante', 'de-vollversion']));
  instanzCommand('id', parseArgs(['pilot-ag', '1'.repeat(32)]));
  lizenzCommand('ausstellen', parseArgs(['--instanz', 'pilot-ag', '--until', 'unbefristet', '--kid', kid, '--v1']));
  const pilotU = currentLicense('pilot-ag')!;
  lizenzCommand('eingespielt', parseArgs(['pilot-ag']));
  lizenzCommand('ausstellen', parseArgs(['--instanz', 'pilot-ag', '--until', '3t', '--kind', 'evaluation', '--kid', kid, '--v1']));
  const pilotE = currentLicense('pilot-ag')!;
  check(
    'Nie eingespielte Evaluation: keine Ablaufwarnung, aber Hinweis',
    finding('pilot-ag', 'laeuft am') === undefined && finding('pilot-ag', 'nicht als eingespielt')?.includes(pilotE.license_id.slice(0, 8)) === true,
    sammleBefunde(30).filter((b) => b.was === 'pilot-ag'),
  );
  const pilotE8 = pilotE.license_id.slice(0, 8);
  check('Hinweis nennt den Aufruf zum Zurueckziehen samt Nummer', finding('pilot-ag', `lizenz zurueckziehen ${pilotE8}`) !== undefined);
  lizenzCommand('zurueckziehen', parseArgs([pilotE8]));
  check(
    'Zurueckgezogene Lizenz zaehlt nicht mehr',
    currentLicense('pilot-ag')?.license_id === pilotU.license_id && finding('pilot-ag', 'nicht als eingespielt') === undefined,
  );
  check('Zweites Zurueckziehen bricht ab', throwsWith(() => lizenzCommand('zurueckziehen', parseArgs([pilotE.license_id])), 'bereits'));
  check(
    'Eingespielte Lizenz laesst sich nicht zurueckziehen',
    throwsWith(() => lizenzCommand('zurueckziehen', parseArgs([pilotU.license_id.slice(0, 8)])), 'bleibt im Bestand'),
  );
  check('lizenz liste zeigt den Rueckzug', captureLog(() => lizenzCommand('liste', parseArgs([]))).includes(`zurueckgezogen ${heute}`));

  // Alles zurueckgezogen, die Instanz meldet die Datei trotzdem.
  instanzCommand('anlegen', parseArgs(['geist-ag', '--kunde', 'musterfirma', '--variante', 'de-vollversion']));
  instanzCommand('id', parseArgs(['geist-ag', '2'.repeat(32)]));
  lizenzCommand('ausstellen', parseArgs(['--instanz', 'geist-ag', '--until', '1j', '--kid', kid, '--v1']));
  const geist = currentLicense('geist-ag')!;
  lizenzCommand('zurueckziehen', parseArgs([geist.license_id.slice(0, 8)]));
  berichtUebernehmen({ installation_id: '2'.repeat(32), license: { license_id: geist.license_id } }, 'geist-ag');
  check(
    'Gemeldete zurueckgezogene Lizenz ohne gueltige: Befund statt "keine Lizenz"',
    finding('geist-ag', 'zurueckgezogene')?.includes('nicht ausgestellt') === true && finding('geist-ag', 'Keine Lizenz') === undefined,
    sammleBefunde(30).filter((b) => b.was === 'geist-ag'),
  );

  // --- Aelterer Bericht nach einem neueren ----------------------------------
  // Keine Zeitstempel-Ordnung: Es gilt der zuletzt eingelesene Bericht, und
  // check zeigt, wenn das eine aeltere Lizenz ist. Der Kunde hat L1, dann L2
  // eingespielt und beide Lizenzberichte geschickt; sie werden verkehrt herum
  // eingelesen.
  instanzCommand('anlegen', parseArgs(['spaet-ag', '--kunde', 'musterfirma', '--variante', 'de-vollversion']));
  instanzCommand('id', parseArgs(['spaet-ag', '3'.repeat(32)]));
  lizenzCommand('ausstellen', parseArgs(['--instanz', 'spaet-ag', '--until', '1j', '--kid', kid, '--v1']));
  const spaet1 = currentLicense('spaet-ag')!;
  lizenzCommand('ausstellen', parseArgs(['--instanz', 'spaet-ag', '--until', '20t', '--kid', kid, '--v1']));
  const spaet2 = currentLicense('spaet-ag')!;
  db.prepare("UPDATE lizenzen SET ausgestellt_am = ? WHERE instanz_id = 'spaet-ag'").run(addDaysIso(heute, -10));
  const spaetBericht = (tage: number, licenseId: string) =>
    berichtUebernehmen(
      {
        generated_at: `${addDaysIso(heute, tage)}T12:00:00.000Z`,
        installation_id: '3'.repeat(32),
        license_id: licenseId,
        customer_id: 'musterfirma',
        state: 'valid',
        server_version: '1.10.0',
        license_format: 1,
      },
      'spaet-ag',
    );
  spaetBericht(-2, spaet2.license_id);
  check(
    'Neuerer Bericht: L2 laeuft, eingespielt am Tag des Berichts',
    running('spaet-ag') === spaet2.license_id && installedOn(spaet2.license_id) === addDaysIso(heute, -2),
    installedOn(spaet2.license_id),
  );
  const alterBericht = spaetBericht(-5, spaet1.license_id);
  const nachAltem = sammleBefunde(30).filter((b) => b.was === 'spaet-ag').map((b) => b.text);
  check(
    'Aelterer Bericht danach eingelesen: check meldet die Abweichung',
    alterBericht.taken.includes('spaet-ag') &&
      running('spaet-ag') === spaet1.license_id &&
      nachAltem.some((t) => t.includes('Restore') && t.includes(spaet2.license_id.slice(0, 8))) &&
      installedOn(spaet1.license_id) === addDaysIso(heute, -5),
    nachAltem,
  );
  check(
    'Ablaufwarnung folgt dabei der gemeldeten Lizenz',
    !nachAltem.some((t) => t.includes(`laeuft am ${spaet2.gueltig_bis}`)),
    nachAltem,
  );
  spaetBericht(-2, spaet2.license_id);
  const nachNeuem = sammleBefunde(30).filter((b) => b.was === 'spaet-ag').map((b) => b.text);
  check(
    'Neueren Bericht noch einmal eingelesen: Abweichung weg',
    running('spaet-ag') === spaet2.license_id &&
      !nachNeuem.some((t) => t.includes('Restore')) &&
      nachNeuem.some((t) => t.includes(`laeuft am ${spaet2.gueltig_bis}`)),
    nachNeuem,
  );
  const { reportDay } = await import('../licenses.js');
  check(
    'Berichtstag: aus generated_at, hoechstens heute, sonst null',
    reportDay('2999-01-01T12:00:00.000Z') === heute && reportDay('kein Datum') === null && reportDay(null) === null,
  );

  // --- Ungebunden, faellig nach Verlaengerung -------------------------------
  instanzCommand('anlegen', parseArgs(['kurz-ag', '--kunde', 'musterfirma', '--variante', 'de-vollversion']));
  instanzCommand('id', parseArgs(['kurz-ag', 'e'.repeat(32)]));
  const kurz = ['--instanz', 'kurz-ag', '--until', '10t', '--kid', kid, '--v1', '--ungebunden'];
  check(
    '--ungebunden mit --installation wird abgewiesen',
    throwsWith(() => lizenzCommand('ausstellen', parseArgs([...kurz, '--installation', 'f'.repeat(32)])), 'schliessen sich aus'),
  );
  lizenzCommand('ausstellen', parseArgs(kurz));
  check('--ungebunden trotz bekannter Installations-ID', currentLicense('kurz-ag')?.installation_id === null);
  check('Ungebundene Lizenz wird als nicht eingespielt gemeldet', finding('kurz-ag', 'nicht als eingespielt') !== undefined);
  const dueList = (): string => captureLog(() => lizenzCommand('faellig', parseArgs(['--tage', '45'])));
  check('faellig nennt die bald ablaufende Lizenz', dueList().includes('kurz-ag'));
  lizenzCommand('eingespielt', parseArgs(['kurz-ag']));
  const kurzLaufend = currentLicense('kurz-ag')!;
  lizenzCommand('verlaengern', parseArgs(['--instanz', 'kurz-ag', '--until', '1j']));
  const nachVerlaengern = dueList();
  check(
    'Nicht eingespielte Verlaengerung: faellig und check warnen weiter',
    /kurz-ag.*Nachfolge/.test(nachVerlaengern) && finding('kurz-ag', `laeuft am ${kurzLaufend.gueltig_bis} ab`) !== undefined,
    nachVerlaengern,
  );
  lizenzCommand('eingespielt', parseArgs(['kurz-ag']));
  check(
    'Eingespielte Verlaengerung: nicht mehr faellig',
    !dueList().includes('kurz-ag') && finding('kurz-ag', 'laeuft am') === undefined,
    dueList(),
  );

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
