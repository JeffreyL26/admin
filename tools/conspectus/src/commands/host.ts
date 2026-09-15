/** Hosts des Anbieters (Hosting-Server), Adresse und SSH-Zugang. */
import path from 'node:path';
import type { Args } from '../args.js';
import { required } from '../args.js';
import { openRegister } from '../db.js';
import { assertKey } from './kunde.js';
import type { HostTarget } from '../ssh.js';

export interface HostRow extends HostTarget {
  basis_domain: string | null;
  notiz: string | null;
  angelegt_am: string;
}

export function hostCommand(sub: string, args: Args): void {
  const { db } = openRegister();
  switch (sub) {
    case 'anlegen': {
      const id = args.positional[0] ?? required(args, 'id', 'Beispiel: conspectus host anlegen hz1 --adresse hz1.example.net');
      assertKey(id, 'Hostschluessel');
      const adresse = required(args, 'adresse', 'Beispiel: --adresse hz1.example.net');
      db.prepare(
        'INSERT INTO hosts (id, adresse, ssh_benutzer, ssh_port, basis_domain, notiz, ssh_schluessel) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        adresse,
        args.values.benutzer ?? 'root',
        Number(args.values.port ?? 22),
        args.values['basis-domain'] ?? null,
        args.values.notiz ?? null,
        args.values.schluessel ? path.resolve(args.values.schluessel) : null,
      );
      console.log(`Host "${id}" (${adresse}) angelegt.`);
      return;
    }
    case 'liste':
    case undefined:
    case '': {
      const rows = db.prepare('SELECT * FROM hosts ORDER BY id').all() as HostRow[];
      if (rows.length === 0) {
        console.log('Noch kein Host im Register.');
        return;
      }
      console.log(['SCHLUESSEL'.padEnd(14), 'ADRESSE'.padEnd(34), 'SSH'.padEnd(20), 'BASISDOMAIN'].join(' '));
      for (const r of rows) {
        console.log(
          [
            r.id.padEnd(14),
            r.adresse.padEnd(34),
            `${r.ssh_benutzer}@:${r.ssh_port}${r.ssh_schluessel ? ' (-i)' : ''}`.padEnd(20),
            r.basis_domain ?? '',
          ].join(' '),
        );
      }
      return;
    }
    default:
      throw new Error(`Unbekannter Unterbefehl "host ${sub}". Bekannt: anlegen, liste.`);
  }
}

export function hostMuss(id: string): HostRow {
  const { db } = openRegister();
  const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!row) throw new Error(`Host "${id}" ist nicht im Register (conspectus host anlegen ${id} --adresse ...).`);
  return row;
}
