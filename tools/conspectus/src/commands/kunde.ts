/** Kunden anlegen, aendern, auflisten. */
import type { Args } from '../args.js';
import { required } from '../args.js';
import { openRegister } from '../db.js';

export interface KundeRow {
  id: string;
  name: string;
  kontakt: string | null;
  email: string | null;
  notiz: string | null;
  angelegt_am: string;
}

const KEY_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export function assertKey(key: string, was: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `"${key}" ist kein gueltiger ${was}. Erlaubt sind Kleinbuchstaben, Ziffern und ` +
        'Bindestriche (nicht am Anfang oder Ende), hoechstens 40 Zeichen. ' +
        'Derselbe Schluessel wird auf dem Server zu einem DNS-Label und einem Verzeichnisnamen.',
    );
  }
}

export function kundeCommand(sub: string, args: Args): void {
  const { db } = openRegister();
  switch (sub) {
    case 'anlegen': {
      const id = args.positional[0] ?? required(args, 'id', 'Beispiel: conspectus kunde anlegen musterfirma --name "Musterfirma GmbH"');
      assertKey(id, 'Kundenschluessel');
      const name = args.values.name ?? id;
      db.prepare('INSERT INTO kunden (id, name, kontakt, email, notiz) VALUES (?, ?, ?, ?, ?)').run(
        id,
        name,
        args.values.kontakt ?? null,
        args.values.email ?? null,
        args.values.notiz ?? null,
      );
      console.log(`Kunde "${id}" (${name}) angelegt.`);
      return;
    }
    case 'aendern': {
      const id = args.positional[0] ?? required(args, 'id', 'Aufruf: conspectus kunde aendern <id> --name ...');
      const felder = ['name', 'kontakt', 'email', 'notiz'].filter((f) => args.values[f] !== undefined);
      if (felder.length === 0) throw new Error('Keine Aenderung uebergeben (--name, --kontakt, --email, --notiz).');
      const info = db
        .prepare(`UPDATE kunden SET ${felder.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...felder.map((f) => args.values[f]), id);
      if (info.changes === 0) throw new Error(`Kunde "${id}" ist nicht im Register.`);
      console.log(`Kunde "${id}" geaendert (${felder.join(', ')}).`);
      return;
    }
    case 'liste':
    case undefined:
    case '': {
      const rows = db.prepare('SELECT * FROM kunden ORDER BY id').all() as KundeRow[];
      if (rows.length === 0) {
        console.log('Noch kein Kunde im Register.');
        return;
      }
      console.log(['SCHLUESSEL'.padEnd(20), 'NAME'.padEnd(34), 'KONTAKT'].join(' '));
      for (const r of rows) {
        console.log([r.id.padEnd(20), r.name.padEnd(34), r.kontakt ?? r.email ?? ''].join(' '));
      }
      return;
    }
    default:
      throw new Error(`Unbekannter Unterbefehl "kunde ${sub}". Bekannt: anlegen, aendern, liste.`);
  }
}

export function kundeMuss(id: string): KundeRow {
  const { db } = openRegister();
  const row = db.prepare('SELECT * FROM kunden WHERE id = ?').get(id) as KundeRow | undefined;
  if (!row) throw new Error(`Kunde "${id}" ist nicht im Register (conspectus kunde anlegen ${id}).`);
  return row;
}
