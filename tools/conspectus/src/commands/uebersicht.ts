/** Uebersicht auf der Konsole und als HTML-Datei. */
import fs from 'node:fs';
import path from 'node:path';
import { todayIsoLocal } from '@ohrganize/shared';
import type { Args } from '../args.js';
import { openRegister } from '../db.js';
import { expiringLicense, instanceLicenses } from '../licenses.js';
import { buildHtml } from '../report.js';
import type { InstanzRow } from './instanz.js';

export function uebersichtCommand(): void {
  const { db } = openRegister();
  const heute = todayIsoLocal();
  const kunden = (db.prepare('SELECT COUNT(*) AS n FROM kunden').get() as { n: number }).n;
  const instanzen = db
    .prepare(
      `SELECT i.*, k.name AS kunde_name FROM instanzen i
       JOIN kunden k ON k.id = i.kunde_id ORDER BY k.name, i.id`,
    )
    .all() as (InstanzRow & { kunde_name: string })[];
  const lizenzen = (db.prepare('SELECT COUNT(*) AS n FROM lizenzen').get() as { n: number }).n;
  const licenses = instanceLicenses();

  console.log(`oHRganize Anbieteruebersicht, Stand ${heute}`);
  console.log(`  ${kunden} Kunde(n), ${instanzen.length} Instanz(en), ${lizenzen} ausgestellte Lizenz(en)\n`);
  if (instanzen.length === 0) {
    console.log('Noch keine Instanz im Register.');
    return;
  }
  console.log(
    ['KUNDE'.padEnd(24), 'INSTANZ'.padEnd(18), 'AUSGABE'.padEnd(16), 'VERSION'.padEnd(14), 'LIZENZ BIS'].join(' '),
  );
  for (const i of instanzen) {
    const lic = licenses.get(i.id);
    const l = lic ? expiringLicense(lic) : undefined;
    const bis = l ? (l.unbefristet ? 'unbefristet' : l.gueltig_bis) : 'keine';
    console.log(
      [
        i.kunde_name.slice(0, 23).padEnd(24),
        i.id.padEnd(18),
        i.variante.padEnd(16),
        (i.version ?? '-').padEnd(14),
        bis,
      ].join(' '),
    );
  }
}

export function htmlCommand(args: Args): void {
  const { dir } = openRegister();
  const ziel = path.resolve(args.values.out ?? path.join(dir, 'uebersicht.html'));
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  fs.writeFileSync(ziel, buildHtml(), { mode: 0o600 });
  console.log(`Uebersicht geschrieben: ${ziel}`);
  console.log('Die Datei enthaelt Kundennamen und Hostschluessel; sie gehoert nicht in ein Repository.');
}
