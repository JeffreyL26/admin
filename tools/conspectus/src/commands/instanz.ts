/**
 * Instanzen: eine laufende Installation eines Kunden.
 *
 * Die `installation_id` ist der Schluessel, an den eine gebundene Lizenz
 * haengt. Sie kommt NICHT aus dem Register, sondern aus der Installation
 * selbst (`provision.sh id <kunde>` bzw. `status.cjs --json`) und wird hier
 * nur festgehalten. Deshalb gibt es `instanz bericht`: den Bericht einer
 * Installation einlesen, statt Zahlen abzutippen.
 */
import { channelOf, todayIsoLocal } from '@ohrganize/shared';
import type { Args } from '../args.js';
import { required } from '../args.js';
import { openRegister } from '../db.js';
import { markInstalled, reportDay } from '../licenses.js';
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
  laufende_lizenz: string | null;
  bericht_abgelehnt_am: string | null;
  bericht_abgelehnt_grund: string | null;
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
      // Die Kennung ist jetzt ausdruecklich gesetzt: Ein Ablehnungsvermerk gilt
      // als erledigt; besteht der Widerspruch weiter, setzt ihn der naechste
      // Hostbericht neu.
      const info = db
        .prepare(
          'UPDATE instanzen SET installation_id = ?, bericht_abgelehnt_am = NULL, bericht_abgelehnt_grund = NULL WHERE id = ?',
        )
        .run(wert, id);
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

/** Nicht-leere Zeichenkette oder null: provision.sh schreibt "" fuer alles, was Health nicht beantwortet. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface ReportImport {
  taken: string[];
  rejected: { id: string; reason: string }[];
}

/**
 * Bericht einer Installation einlesen: die JSON-Ausgabe von
 * `status.cjs --json`, `provision.sh status --json` oder der Lizenzbericht
 * der Desktop-App. Damit wandern Installations-ID, Version, Kanal,
 * Lizenzzustand und Platzzahl ins Register, ohne dass jemand sie abtippt (und
 * dabei eine Ziffer verdreht); die gemeldete Lizenznummer gilt als laufend
 * und eingespielt.
 *
 * Ein Bericht, der erkennbar zu einer anderen Instanz gehoert (andere
 * Installations-ID, Lizenz oder Kundennummer einer anderen Instanz), wird
 * abgelehnt statt uebernommen: Sonst banden die naechsten Lizenzen an eine
 * fremde Installation. Vermerkt wird die Ablehnung nur bei einem Hostbericht,
 * der die Instanz selbst nennt (`kunde`); bei einem Import mit --instanz kann
 * es ebenso gut die falsche Datei gewesen sein, dort genuegt der Fehler.
 * Aufgehoben wird der Vermerk nur von einem Bericht, der sich ausweist
 * (Installations-ID, Lizenz oder Kunde). Eine neue Installation (frische
 * Datenbank) bestaetigt `newInstallation` mit dem Schluessel genau dieser
 * Instanz.
 *
 * Es gilt der zuletzt eingelesene Bericht. Wird ein aelterer nach einem
 * neueren eingelesen, zeigt `check` die Abweichung ("Restore?"); der neuere
 * noch einmal eingelesen behebt sie.
 */
export function berichtUebernehmen(
  json: unknown,
  instanzId?: string,
  options: { newInstallation?: string } = {},
): ReportImport {
  const { db } = openRegister();
  const eintraege = Array.isArray(json) ? json : [json];
  const result: ReportImport = { taken: [], rejected: [] };
  for (const eintrag of eintraege) {
    const e = eintrag as Record<string, unknown>;
    // Drei Formen: der Sammelbericht von provision.sh (kunde + instanz), die
    // Einzelausgabe von status.cjs und der Lizenzbericht (GET
    // /api/license/report, alles auf oberster Ebene).
    const inner = (e.instanz as Record<string, unknown> | null | undefined) ?? e;
    // Ein Sammelbericht nennt den Kunden je Eintrag; --instanz waehlt dort
    // einen aus, statt alle Eintraege auf eine Instanz zu schreiben.
    const fromHost = text(e.kunde) !== null;
    const id = text(e.kunde) ?? instanzId;
    if (!id || (instanzId && id !== instanzId)) continue;
    const row = db.prepare('SELECT id, kunde_id, installation_id FROM instanzen WHERE id = ?').get(id) as
      | { id: string; kunde_id: string; installation_id: string | null }
      | undefined;
    if (!row) continue;
    const license = (inner.license ?? {}) as Record<string, unknown>;
    const counts = (inner.counts ?? {}) as Record<string, unknown>;
    const variant = (inner.variant ?? {}) as Record<string, unknown>;
    const version = text(inner.version) ?? text(e.version_health) ?? text(inner.server_version);
    const licenseId = text(license.license_id) ?? text(inner.license_id);
    const installation = text(inner.installation_id);
    const customerId = text(inner.customer_id);
    const reason = foreignReportReason(row, installation, licenseId, customerId, options.newInstallation === row.id);
    if (reason) {
      if (fromHost) {
        db.prepare('UPDATE instanzen SET bericht_abgelehnt_am = ?, bericht_abgelehnt_grund = ? WHERE id = ?').run(
          todayIsoLocal(),
          reason,
          id,
        );
      }
      result.rejected.push({ id, reason });
      continue;
    }
    const ausgewiesen = installation !== null || licenseId !== null || customerId !== null ? 1 : 0;
    db.prepare(
      `UPDATE instanzen SET
         installation_id = COALESCE(?, installation_id),
         version = COALESCE(?, version),
         kanal = COALESCE(?, kanal),
         variante = COALESCE(?, variante),
         lizenz_zustand = COALESCE(?, lizenz_zustand),
         aktive_profile = COALESCE(?, aktive_profile),
         license_format = COALESCE(?, license_format),
         bericht_abgelehnt_am = CASE WHEN ? = 1 THEN NULL ELSE bericht_abgelehnt_am END,
         bericht_abgelehnt_grund = CASE WHEN ? = 1 THEN NULL ELSE bericht_abgelehnt_grund END,
         zuletzt_gesehen = datetime('now')
       WHERE id = ?`,
    ).run(
      installation,
      version,
      text(e.kanal) ?? (version ? channelOf(version) : null),
      text(variant.id),
      text(license.state) ?? text(inner.state),
      typeof counts.employees_active === 'number'
        ? counts.employees_active
        : typeof inner.seats_used === 'number'
          ? inner.seats_used
          : null,
      typeof inner.license_format === 'number'
        ? inner.license_format
        : typeof e.license_format_health === 'number'
          ? e.license_format_health
          : null,
      ausgewiesen,
      ausgewiesen,
      id,
    );
    // Die Instanz nennt die Nummer der Datei, die bei ihr liegt: Das ist der
    // Beleg, dass eine verschickte Lizenz (Kunden-Server) eingespielt wurde,
    // und nach einem Restore der Hinweis, dass wieder eine alte laeuft.
    // Eingespielt spaetestens am Tag des Berichts (Lizenzbericht), sonst heute.
    if (licenseId) markInstalled(id, licenseId, reportDay(text(inner.generated_at)) ?? undefined);
    result.taken.push(id);
  }
  return result;
}

/** Grund, warum ein Bericht nicht zu dieser Instanz passt, oder null. */
function foreignReportReason(
  row: { id: string; kunde_id: string; installation_id: string | null },
  installation: string | null,
  licenseId: string | null,
  customerId: string | null,
  newInstallation: boolean,
): string | null {
  const { db } = openRegister();
  const license = licenseId
    ? (db.prepare('SELECT instanz_id FROM lizenzen WHERE license_id = ?').get(licenseId) as { instanz_id: string | null } | undefined)
    : undefined;
  if (license && license.instanz_id !== row.id) {
    return `Die gemeldete Lizenz ${(licenseId as string).slice(0, 8)} gehoert zur Instanz "${license.instanz_id ?? '-'}".`;
  }
  if (!license && customerId && customerId !== row.kunde_id) {
    return `Der Bericht gehoert zum Kunden "${customerId}", die Instanz zu "${row.kunde_id}".`;
  }
  if (installation && row.installation_id && installation !== row.installation_id && !newInstallation) {
    return (
      `Der Bericht meldet die Installations-ID ${installation}, im Register steht ${row.installation_id}. ` +
      `Ist es eine neue Installation (frische Datenbank), mit --neue-installation ${row.id} bestaetigen.`
    );
  }
  return null;
}
