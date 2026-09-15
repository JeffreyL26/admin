/**
 * Instanzen: eine laufende Installation eines Kunden.
 *
 * Die `installation_id` ist der Schluessel, an den eine gebundene Lizenz
 * haengt. Sie kommt NICHT aus dem Register, sondern aus der Installation
 * selbst (`provision.sh id <kunde>` bzw. `status.cjs --json`) und wird hier
 * nur festgehalten. Deshalb gibt es `instanz bericht`: den Bericht einer
 * Installation einlesen, statt Zahlen abzutippen.
 */
import type { Args } from '../args.js';
import { required } from '../args.js';
import { openRegister } from '../db.js';
import { assertKey, kundeMuss } from './kunde.js';
import { hostMuss } from './host.js';

export interface InstanzRow {
  id: string;
  kunde_id: string;
  host_id: string | null;
  art: string;
  variante: string;
  domain: string | null;
  installation_id: string | null;
  version: string | null;
  kanal: string | null;
  license_format: number | null;
  lizenz_zustand: string | null;
  aktive_profile: number | null;
  zuletzt_gesehen: string | null;
  notiz: string | null;
  angelegt_am: string;
}

const VARIANT_PATTERN = /^[a-z]{2}-[a-z][a-z0-9-]{0,31}$/;
const INSTALLATION_PATTERN = /^[0-9a-f]{32}$/;

export function instanzCommand(sub: string, args: Args): void {
  const { db } = openRegister();
  switch (sub) {
    case 'anlegen': {
      const id = args.positional[0] ?? required(args, 'id', 'Beispiel: conspectus instanz anlegen musterfirma --kunde musterfirma --variante de-vollversion');
      assertKey(id, 'Instanzschluessel');
      const kunde = kundeMuss(args.values.kunde ?? id);
      const variante = required(args, 'variante', 'Beispiel: --variante de-vollversion');
      if (!VARIANT_PATTERN.test(variante)) {
        throw new Error(`"${variante}" ist keine Variantenkennung (<land>-<edition>, Kleinbuchstaben).`);
      }
      const host = args.values.host ? hostMuss(args.values.host) : null;
      const art = args.values.art ?? (host ? 'hosting' : 'kunde-server');
      if (!['hosting', 'kunde-server', 'einzelplatz'].includes(art)) {
        throw new Error(`"${art}" ist keine bekannte Art (hosting, kunde-server, einzelplatz).`);
      }
      const domain =
        args.values.domain ?? (host?.basis_domain ? `${id}.${host.basis_domain}` : null);
      db.prepare(
        `INSERT INTO instanzen (id, kunde_id, host_id, art, variante, domain, installation_id, notiz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, kunde.id, host?.id ?? null, art, variante, domain, args.values.installation ?? null, args.values.notiz ?? null);
      console.log(`Instanz "${id}" fuer Kunde "${kunde.id}" angelegt (${art}, ${variante}${domain ? `, ${domain}` : ''}).`);
      return;
    }
    case 'id': {
      // Installations-ID nachtragen, wenn sie erst nach der Erstinbetriebnahme
      // feststeht (sie entsteht mit der Datenbank, nicht mit dem Vertrag).
      const id = args.positional[0] ?? required(args, 'instanz', 'Aufruf: conspectus instanz id <instanz> <32 hex>');
      const wert = (args.positional[1] ?? args.values.wert ?? '').trim().toLowerCase();
      if (!INSTALLATION_PATTERN.test(wert)) {
        throw new Error('Die Installations-ID besteht aus genau 32 Hex-Zeichen (provision.sh id <kunde>).');
      }
      const info = db.prepare('UPDATE instanzen SET installation_id = ? WHERE id = ?').run(wert, id);
      if (info.changes === 0) throw new Error(`Instanz "${id}" ist nicht im Register.`);
      console.log(`Instanz "${id}": Installations-ID gesetzt.`);
      return;
    }
    case 'liste':
    case undefined:
    case '': {
      const rows = db
        .prepare('SELECT * FROM instanzen ORDER BY kunde_id, id')
        .all() as InstanzRow[];
      if (rows.length === 0) {
        console.log('Noch keine Instanz im Register.');
        return;
      }
      console.log(
        ['INSTANZ'.padEnd(18), 'KUNDE'.padEnd(16), 'HOST'.padEnd(10), 'AUSGABE'.padEnd(16), 'VERSION'.padEnd(14), 'LIZENZ'].join(' '),
      );
      for (const r of rows) {
        console.log(
          [
            r.id.padEnd(18),
            r.kunde_id.padEnd(16),
            (r.host_id ?? '-').padEnd(10),
            r.variante.padEnd(16),
            (r.version ?? '-').padEnd(14),
            r.lizenz_zustand ?? '-',
          ].join(' '),
        );
      }
      return;
    }
    default:
      throw new Error(`Unbekannter Unterbefehl "instanz ${sub}". Bekannt: anlegen, id, liste.`);
  }
}

export function instanzMuss(id: string): InstanzRow {
  const { db } = openRegister();
  const row = db.prepare('SELECT * FROM instanzen WHERE id = ?').get(id) as InstanzRow | undefined;
  if (!row) throw new Error(`Instanz "${id}" ist nicht im Register (conspectus instanz anlegen ${id} ...).`);
  return row;
}

/**
 * Bericht einer Installation einlesen: die JSON-Ausgabe von
 * `status.cjs --json` bzw. `provision.sh status --json`. Damit wandern
 * Installations-ID, Version, Kanal, Lizenzzustand und Platzzahl ins
 * Register, ohne dass jemand sie abtippt (und dabei eine Ziffer verdreht).
 */
export function berichtUebernehmen(json: unknown, instanzId?: string): string[] {
  const { db } = openRegister();
  const eintraege = Array.isArray(json) ? json : [json];
  const uebernommen: string[] = [];
  for (const eintrag of eintraege) {
    const e = eintrag as Record<string, unknown>;
    // Zwei Formen: der Sammelbericht von provision.sh (kunde + instanz) und
    // die Einzelausgabe von status.cjs.
    const inner = (e.instanz as Record<string, unknown> | null | undefined) ?? e;
    const id = instanzId ?? (typeof e.kunde === 'string' ? e.kunde : undefined);
    if (!id) continue;
    const row = db.prepare('SELECT id FROM instanzen WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) continue;
    const license = (inner.license ?? {}) as Record<string, unknown>;
    const counts = (inner.counts ?? {}) as Record<string, unknown>;
    const variant = (inner.variant ?? {}) as Record<string, unknown>;
    db.prepare(
      `UPDATE instanzen SET
         installation_id = COALESCE(?, installation_id),
         version = COALESCE(?, version),
         kanal = COALESCE(?, kanal),
         variante = COALESCE(?, variante),
         lizenz_zustand = COALESCE(?, lizenz_zustand),
         aktive_profile = COALESCE(?, aktive_profile),
         license_format = COALESCE(?, license_format),
         zuletzt_gesehen = datetime('now')
       WHERE id = ?`,
    ).run(
      typeof inner.installation_id === 'string' ? inner.installation_id : null,
      typeof inner.version === 'string' ? inner.version : (typeof e.version_health === 'string' ? e.version_health : null),
      typeof e.kanal === 'string' ? e.kanal : null,
      typeof variant.id === 'string' ? variant.id : null,
      typeof license.state === 'string' ? license.state : null,
      typeof counts.employees_active === 'number' ? counts.employees_active : null,
      typeof inner.license_format === 'number'
        ? inner.license_format
        : typeof e.license_format_health === 'number'
          ? e.license_format_health
          : null,
      id,
    );
    uebernommen.push(id);
  }
  return uebernommen;
}
