/**
 * Rollout: ein erfasstes Release auf Hosts ausrollen.
 *
 * Die eigentliche Arbeit macht `ohrganize-update.sh` auf dem Host (Pruefsumme,
 * Signatur, Ausgabe, Migrations-Probelauf, Instanz fuer Instanz umstellen,
 * Ruecknahme bei Fehler). conspectus schickt das Archiv hin, ruft das Skript
 * auf und schreibt mit, was dabei herauskam. Bewusst KEINE zweite
 * Umstelllogik hier: Sie muesste dieselben Faelle behandeln und waere die
 * naechste Stelle, die auseinanderlaeuft.
 *
 * `--probelauf` reicht `--probelauf` durch: Der Host prueft alles und stellt
 * nichts um.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../args.js';
import { ConspectusError, openRegister } from '../db.js';
import { copyToRemote, runRemote, type HostTarget } from '../ssh.js';
import { hostMuss, type HostRow } from './host.js';
import { releaseMuss } from './release.js';
import type { InstanzRow } from './instanz.js';

interface ManifestArtifact {
  file: string;
  sha256: string;
  bytes: number;
}

/** Das Server-Archiv aus den Artefakten des Manifests. */
function archivPfad(manifestFile: string, artefakte: string | null): string {
  const list = (JSON.parse(artefakte ?? '[]') as ManifestArtifact[]).filter((a) =>
    a.file.startsWith('ohrganize-server-'),
  );
  if (list.length === 0) {
    throw new ConspectusError('Im Manifest steht kein Server-Archiv (ohrganize-server-*.zip).');
  }
  const datei = path.join(path.dirname(manifestFile), list[0].file);
  if (!fs.existsSync(datei)) {
    throw new ConspectusError(`${datei} liegt nicht neben dem Manifest. Release-Verzeichnis vollstaendig?`);
  }
  return datei;
}

export function rolloutCommand(sub: string, args: Args): void {
  const { db } = openRegister();

  if (sub === 'liste' || sub === undefined || sub === '') {
    const rows = db
      .prepare(
        `SELECT r.*, i.kunde_id FROM rollouts r
         LEFT JOIN instanzen i ON i.id = r.instanz_id
         ORDER BY r.begonnen_am DESC LIMIT 50`,
      )
      .all() as (Record<string, unknown> & { id: number })[];
    if (rows.length === 0) {
      console.log('Noch kein Rollout im Register.');
      return;
    }
    console.log(['BEGONNEN'.padEnd(20), 'RELEASE'.padEnd(28), 'ZIEL'.padEnd(18), 'ZUSTAND'].join(' '));
    for (const r of rows) {
      console.log(
        [
          String(r.begonnen_am).padEnd(20),
          String(r.release_id).padEnd(28),
          String(r.instanz_id ?? r.host_id ?? '-').padEnd(18),
          String(r.zustand),
        ].join(' '),
      );
    }
    return;
  }

  if (sub !== 'starten') {
    throw new ConspectusError(`Unbekannter Unterbefehl "rollout ${sub}". Bekannt: starten, liste.`);
  }

  const releaseId = args.values.release ?? args.positional[0];
  if (!releaseId) {
    throw new ConspectusError(
      'Aufruf: conspectus rollout starten --release <variante-version> [--host <host> | --kunde <instanz>] [--probelauf]',
    );
  }
  const release = releaseMuss(releaseId);
  if (!release.manifest) throw new ConspectusError(`Zu ${release.id} ist kein Manifest im Register.`);
  if (!release.signatur_geprueft && !args.flags.has('ohne-signatur')) {
    throw new ConspectusError(
      `Die Signatur von ${release.id} ist nicht geprueft. Ein ungeprueftes Release wird nicht ausgerollt.\n` +
        'Erneut erfassen (conspectus release erfassen <release.json>) oder bewusst uebergehen: --ohne-signatur',
    );
  }
  const archiv = archivPfad(release.manifest, release.artefakte);
  const probelauf = args.flags.has('probelauf');

  // Ziel bestimmen: ein Host (alle passenden Instanzen darauf) oder genau eine
  // Instanz. Instanzen anderer Ausgaben laesst update.sh ohnehin stehen.
  let hosts: HostRow[];
  let nurInstanz: InstanzRow | null = null;
  if (args.values.kunde) {
    const instanz = db.prepare('SELECT * FROM instanzen WHERE id = ?').get(args.values.kunde) as
      | InstanzRow
      | undefined;
    if (!instanz) throw new ConspectusError(`Instanz "${args.values.kunde}" ist nicht im Register.`);
    if (!instanz.host_id) throw new ConspectusError(`Instanz "${instanz.id}" hat keinen Host im Register.`);
    nurInstanz = instanz;
    hosts = [hostMuss(instanz.host_id)];
  } else if (args.values.host) {
    hosts = [hostMuss(args.values.host)];
  } else {
    // Alle Hosts, auf denen eine Instanz dieser Ausgabe liegt.
    hosts = db
      .prepare(
        `SELECT DISTINCT h.* FROM hosts h
         JOIN instanzen i ON i.host_id = h.id
         WHERE i.variante = ?
         ORDER BY h.id`,
      )
      .all(release.variante) as HostRow[];
    if (hosts.length === 0) {
      throw new ConspectusError(`Kein Host mit einer Instanz der Ausgabe "${release.variante}" im Register.`);
    }
  }

  for (const host of hosts) {
    console.log(`== ${host.id} (${host.adresse})`);
    const eintrag = db
      .prepare(
        `INSERT INTO rollouts (release_id, instanz_id, host_id, zustand)
         VALUES (?, ?, ?, ?)`,
      )
      .run(release.id, nurInstanz?.id ?? null, host.id, probelauf ? 'probelauf' : 'laeuft');
    const rolloutId = Number(eintrag.lastInsertRowid);
    const protokoll: string[] = [];
    try {
      const remote = `/tmp/${path.basename(archiv)}`;
      console.log(`  Kopiere ${path.basename(archiv)}`);
      const scp = copyToRemote(host as HostTarget, archiv, remote);
      protokoll.push(scp.stdout, scp.stderr);
      if (scp.code !== 0) throw new ConspectusError(`scp fehlgeschlagen: ${scp.stderr.trim() || scp.code}`);

      // Pruefsumme mitschicken, sonst kann update.sh sie nicht pruefen.
      const summe = `${archiv}.sha256`;
      if (fs.existsSync(summe)) copyToRemote(host as HostTarget, summe, `${remote}.sha256`);
      const manifestZiel = `/tmp/release.json`;
      copyToRemote(host as HostTarget, release.manifest, manifestZiel);
      if (fs.existsSync(`${release.manifest}.sig`)) {
        copyToRemote(host as HostTarget, `${release.manifest}.sig`, `${manifestZiel}.sig`);
      }

      const befehl = ['/opt/ohrganize/deploy/ohrganize-update.sh', 'update', remote];
      if (nurInstanz) befehl.push('--kunde', nurInstanz.id);
      if (probelauf) befehl.push('--probelauf');
      console.log(`  ${befehl.join(' ')}`);
      const res = runRemote(host as HostTarget, befehl);
      process.stdout.write(res.stdout);
      protokoll.push(res.stdout, res.stderr);
      if (res.code !== 0) throw new ConspectusError(`update.sh endete mit Status ${res.code}`);

      db.prepare(
        "UPDATE rollouts SET zustand = ?, beendet_am = datetime('now'), protokoll = ? WHERE id = ?",
      ).run(probelauf ? 'probelauf' : 'fertig', protokoll.join('\n').slice(-20000), rolloutId);
      console.log(`  ${probelauf ? 'Probelauf' : 'Rollout'} auf ${host.id} abgeschlossen.`);
    } catch (err) {
      db.prepare(
        "UPDATE rollouts SET zustand = 'fehlgeschlagen', beendet_am = datetime('now'), protokoll = ? WHERE id = ?",
      ).run(`${protokoll.join('\n')}\n${(err as Error).message}`.slice(-20000), rolloutId);
      console.error(`  FEHLER auf ${host.id}: ${(err as Error).message}`);
      // Mit dem naechsten Host weitermachen: Ein Problem auf einem Server
      // haelt die anderen nicht auf (dieselbe Regel wie in update.sh je Instanz).
    }
  }

  console.log('\nZustand nachsehen: conspectus rollout liste');
}
