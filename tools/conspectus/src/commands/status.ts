/**
 * Zustand einer Instanz oder eines ganzen Hosts abfragen.
 *
 * Gefragt wird die Installation selbst (`provision.sh status --json` ueber
 * ssh), nicht das Register: Das Register weiss, was sein soll, die Instanz
 * weiss, was ist. Das Ergebnis wandert anschliessend ins Register
 * (Installations-ID, Version, Kanal, Lizenzzustand, Platzzahl), damit
 * `check` und `uebersicht` ohne Netzzugriff arbeiten koennen.
 */
import fs from 'node:fs';
import type { Args } from '../args.js';
import { ConspectusError } from '../db.js';
import { runRemote, type HostTarget } from '../ssh.js';
import { readTextFile } from '../textfile.js';
import { hostMuss } from './host.js';
import { berichtUebernehmen, instanzMuss, type ReportImport } from './instanz.js';

export function statusCommand(args: Args): void {
  const hostId = args.values.host;
  const instanzId = args.values.instanz ?? args.positional[0];
  if (!hostId && !instanzId) {
    throw new ConspectusError('Aufruf: conspectus status --host <host> | --instanz <instanz>');
  }
  assertNewInstallationNamed(args);
  const host = hostId
    ? hostMuss(hostId)
    : hostMuss(instanzMuss(instanzId as string).host_id ?? '');
  const res = runRemote(host as HostTarget, [
    '/opt/ohrganize/deploy/ohrganize-provision.sh',
    'status',
    '--json',
  ]);
  if (res.code !== 0) {
    throw new ConspectusError(`status auf ${host.id} fehlgeschlagen: ${res.stderr.trim() || res.code}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new ConspectusError(`Die Antwort von ${host.id} ist kein JSON:\n${res.stdout.slice(0, 500)}`);
  }
  importHostReport(json, args);
}

/**
 * Sammelbericht eines Hosts ins Register uebernehmen und anzeigen. Eine neue
 * Installation bestaetigt `--neue-installation <instanz>` fuer genau diese
 * Instanz, nicht fuer alle des Hosts.
 */
export function importHostReport(json: unknown, args: Args): ReportImport {
  assertNewInstallationNamed(args);
  const result = berichtUebernehmen(json, undefined, { newInstallation: args.values['neue-installation'] });
  if (args.flags.has('json')) {
    console.log(JSON.stringify(json, null, 2));
  } else {
    zeigeBericht(json, args.values.instanz ?? args.positional[0]);
  }
  console.log(
    result.taken.length > 0
      ? `\nIns Register uebernommen: ${result.taken.join(', ')}`
      : result.rejected.length > 0
        ? '\nNichts ins Register uebernommen.'
        : '\nKeine der gemeldeten Instanzen steht im Register (conspectus instanz anlegen ...).',
  );
  printRejected(result.rejected);
  return result;
}

function assertNewInstallationNamed(args: Args): void {
  if (args.flags.has('neue-installation')) {
    throw new ConspectusError('--neue-installation nennt die Instanz: --neue-installation <instanz>');
  }
}

function printRejected(rejected: ReportImport['rejected']): void {
  for (const r of rejected) console.warn(`Achtung: Bericht fuer "${r.id}" NICHT uebernommen. ${r.reason}`);
}

function zeigeBericht(json: unknown, nur?: string): void {
  const list = Array.isArray(json) ? json : [json];
  for (const eintrag of list) {
    const e = eintrag as Record<string, unknown>;
    const name = typeof e.kunde === 'string' ? e.kunde : '(unbenannt)';
    if (nur && name !== nur) continue;
    const inner = (e.instanz as Record<string, unknown> | null) ?? {};
    const license = (inner.license ?? {}) as Record<string, unknown>;
    const counts = (inner.counts ?? {}) as Record<string, unknown>;
    console.log(`== ${name} (${e.domain ?? '-'})`);
    console.log(`   Dienst      ${e.dienst} auf Port ${e.port}`);
    console.log(`   Release     ${e.release ?? '-'}`);
    console.log(`   Ausgabe     env=${e.variante_env ?? '-'}  health=${e.variante_health ?? '-'}`);
    console.log(`   Version     ${e.version_health ?? '-'} (Kanal ${e.kanal ?? '-'})`);
    console.log(`   Installation ${inner.installation_id ?? '-'}`);
    console.log(
      `   Lizenz      ${license.state ?? '-'}${license.valid_until ? ` bis ${license.valid_until}` : ''}` +
        `${license.max_users ? `, ${license.active_users}/${license.max_users} Plaetze` : ''}`,
    );
    console.log(`   Profile     ${counts.employees_active ?? '-'} aktiv`);
    console.log('');
  }
}

/** `bericht importieren <datei.json>`: Bericht aus einer Datei einlesen. */
export function berichtCommand(sub: string, args: Args): void {
  if (sub !== 'importieren') {
    throw new ConspectusError(`Unbekannter Unterbefehl "bericht ${sub}". Bekannt: importieren.`);
  }
  const instanzId = args.values.instanz;
  // Hier eine reine Bestaetigung fuer --instanz. Ein anderer Wert ist meist
  // der verschluckte Dateiname (`--neue-installation bericht.json`) oder
  // bestaetigte still die falsche Instanz.
  const neuWert = args.values['neue-installation'];
  if (neuWert !== undefined && neuWert !== instanzId) {
    throw new ConspectusError(
      `--neue-installation bestaetigt die mit --instanz genannte Instanz (${instanzId ?? 'keine'}), nicht "${neuWert}".\n` +
        'Optionen nach dem Dateinamen angeben: conspectus bericht importieren <datei.json> --instanz <instanz> --neue-installation',
    );
  }
  const confirmed = args.flags.has('neue-installation') || neuWert !== undefined;
  if (confirmed && !instanzId) throw new ConspectusError('--neue-installation braucht --instanz <instanz>.');
  const newInstallation = confirmed ? instanzId : undefined;

  const datei = args.positional[0] ?? args.values.datei;
  if (!datei) {
    throw new ConspectusError(
      'Aufruf: conspectus bericht importieren <datei.json> [--instanz <instanz>] [--neue-installation]\n' +
        'Die Datei kommt aus `provision.sh status --json`, `status.cjs --json` oder ist der\n' +
        'Lizenzbericht der Desktop-App (Einstellungen, Lizenz, Bericht).',
    );
  }
  if (!fs.existsSync(datei)) throw new ConspectusError(`${datei} existiert nicht.`);
  let json: unknown;
  try {
    // readTextFile statt readFileSync(..., 'utf8'): Von einem Windows-Server
    // kommt die Datei per `> bericht.json` als UTF-16 oder UTF-8 mit BOM.
    json = JSON.parse(readTextFile(datei));
  } catch (err) {
    throw new ConspectusError(`${datei} ist kein gueltiges JSON: ${(err as Error).message}`);
  }
  const named = (Array.isArray(json) ? json : [json])
    .map((e) => (e as Record<string, unknown> | null)?.kunde)
    .filter((k): k is string => typeof k === 'string' && k !== '');
  if (instanzId && named.length > 0 && !named.includes(instanzId)) {
    throw new ConspectusError(
      `Der Sammelbericht enthaelt keinen Eintrag fuer "${instanzId}" (enthalten: ${named.join(', ')}).`,
    );
  }
  const { taken, rejected } = berichtUebernehmen(json, instanzId, { newInstallation });
  if (taken.length === 0) {
    if (rejected.length > 0) {
      throw new ConspectusError(rejected.map((r) => `Bericht fuer "${r.id}" nicht uebernommen. ${r.reason}`).join('\n'));
    }
    throw new ConspectusError(
      'Keine der gemeldeten Instanzen steht im Register. Bei einer Einzelausgabe von\n' +
        'status.cjs oder einem Lizenzbericht die Instanz benennen: --instanz <instanz>',
    );
  }
  console.log(`Uebernommen: ${taken.join(', ')}`);
  printRejected(rejected);
}
