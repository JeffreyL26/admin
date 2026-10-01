/**
 * Lizenzen ausstellen, verlaengern, als eingespielt vermerken, zurueckziehen,
 * faellige finden, einspielen.
 *
 * Der Ausstell-Baustein ist derselbe wie im schlanken Werkzeug
 * (`core/licenseIssue.ts`); hier kommt dazu, was nur mit Register geht:
 *
 *   - Kunde, Instanz, Variante und Installations-ID werden NACHGESCHLAGEN
 *     statt eingetippt. Eine an die falsche Installation gebundene Lizenz ist
 *     beim Kunden sofort unbrauchbar, und der Tippfehler faellt erst dort auf.
 *   - Die Ausgabe (Land x Edition) kommt aus der Instanz. Eine v2-Datei mit
 *     fremder Ausgabe lehnt der Server ab; das hier zu pruefen kostet nichts.
 *   - v2 wird nur ausgestellt, wenn die Instanz v2 LESEN kann. Geprueft wird
 *     die Faehigkeit (`license_format` aus Health und Lizenzbericht), nicht
 *     die Versionsnummer: Es gibt keine Mindestserverversion.
 *   - Jede ausgestellte Datei landet im Register, nicht nur die aktuelle.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LICENSE_FILE_NAME,
  addDaysIso,
  formatDate,
  todayIsoLocal,
  type LicenseBilling,
  type LicenseInterval,
  type LicensePayload,
} from '@ohrganize/shared';
import { isIsoDay, issueLicense, LicenseIssueError } from '@ohrganize/backend/core/licenseIssue';
import type { Args } from '../args.js';
import { required } from '../args.js';
import { ConspectusError, openRegister } from '../db.js';
import { defaultKid, loadPrivateKey } from '../keys.js';
import { currentLicense, expiringLicense, findLicense, instanceLicenses, markInstalled, type LizenzRow } from '../licenses.js';
import { kundeMuss } from './kunde.js';
import { instanzMuss, type InstanzRow } from './instanz.js';
import { hostMuss } from './host.js';
import { copyToRemote, runRemote } from '../ssh.js';

/** LICENSE_MAX_DATE aus shared; hier nur zum Erkennen "unbefristet". */
const MAX_DATE = '2999-12-31';

function variantParts(variante: string): { country: string; edition: string } {
  const m = /^([a-z]{2})-(.+)$/.exec(variante);
  if (!m) throw new ConspectusError(`"${variante}" ist keine Variantenkennung (<land>-<edition>).`);
  return { country: m[1].toUpperCase(), edition: m[2] };
}

/**
 * Darf fuer diese Instanz eine v2-Datei entstehen? Geprueft wird die
 * FAEHIGKEIT (`license_format >= 2`), nicht die Versionsnummer. Ist nichts
 * bekannt, wird gefragt statt geraten: Eine v2-Datei auf einem v1-Server
 * bedeutet Nur-Lese-Betrieb beim Kunden.
 */
function assertV2Possible(instanz: InstanzRow, erzwingen: boolean): void {
  if (erzwingen) return;
  if (instanz.license_format !== null && instanz.license_format >= 2) return;
  throw new ConspectusError(
    `Fuer die Instanz "${instanz.id}" ist nicht belegt, dass sie Lizenzen der Fassung 2 liest.\n` +
      (instanz.license_format === null
        ? (instanz.zuletzt_gesehen === null
            ? 'Es liegt noch kein Bericht vor. Einlesen mit:\n'
            : `Der letzte Bericht (${instanz.zuletzt_gesehen}) nennt kein license_format: Der Server ist aelter ` +
              'als Lizenz v2, oder der Bericht stammt aus einem aelteren status.cjs. Neu einlesen mit:\n') +
          `  conspectus bericht importieren <datei.json> --instanz ${instanz.id}\n` +
          '(die Datei kommt aus `provision.sh status --json` bzw. `status.cjs --json`)'
        : `Der letzte Bericht meldet license_format ${instanz.license_format}.`) +
      '\nErst den Server aktualisieren, dann die Datei ausstellen (Server vor Datei).\n' +
      'Bewusst trotzdem ausstellen: --v2-erzwingen',
  );
}

function schreibeDatei(kundeId: string, payload: LicensePayload, text: string): string {
  const { licenseDir } = openRegister();
  const dir = path.join(licenseDir, kundeId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${payload.valid_from}_${payload.license_id.slice(0, 8)}_${LICENSE_FILE_NAME}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function merkeLizenz(payload: LicensePayload, kundeId: string, instanzId: string | null, datei: string): void {
  const { db } = openRegister();
  db.prepare(
    `INSERT INTO lizenzen (license_id, kunde_id, instanz_id, kid, v, kind, edition, land, features,
                           billing, interval, installation_id, ausgestellt_am, ausgestellt_um, gueltig_ab,
                           gueltig_bis, unbefristet, plaetze, datei, notiz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    payload.license_id,
    kundeId,
    instanzId,
    payload.kid,
    payload.v,
    payload.kind,
    payload.edition ?? null,
    payload.country ?? null,
    payload.features?.join(',') ?? null,
    payload.terms?.billing ?? null,
    payload.terms?.interval ?? null,
    payload.installation_id,
    payload.issued_at,
    new Date().toISOString(),
    payload.valid_from,
    payload.valid_until,
    payload.valid_until >= MAX_DATE ? 1 : 0,
    payload.max_users,
    datei,
    payload.notice ?? null,
  );
  db.prepare(
    "INSERT INTO vorgaenge (kunde_id, art, datum, text) VALUES (?, 'lizenz', ?, ?)",
  ).run(kundeId, payload.issued_at, `Lizenz ${payload.license_id.slice(0, 8)} bis ${payload.valid_until}`);
}

/** Datei auf den Host kopieren und dort ueber provision.sh einspielen. */
function einspielen(instanz: InstanzRow, datei: string, licenseId: string): void {
  if (!instanz.host_id) {
    throw new ConspectusError(
      `Die Instanz "${instanz.id}" hat keinen Host im Register; --einspielen geht nur im Hosting.\n` +
        'Beim Kunden-Server die Datei verschicken und dort einspielen (docs/betrieb-anbieter.md).',
    );
  }
  const host = hostMuss(instanz.host_id);
  const remote = `/tmp/${path.basename(datei)}`;
  console.log(`  Kopiere nach ${host.adresse}:${remote}`);
  const scp = copyToRemote(host, datei, remote);
  if (scp.code !== 0) throw new ConspectusError(`scp ist fehlgeschlagen: ${scp.stderr.trim() || scp.code}`);
  console.log('  Spiele ein (provision.sh lizenz)');
  const res = runRemote(host, [
    '/opt/ohrganize/deploy/ohrganize-provision.sh',
    'lizenz',
    instanz.id,
    remote,
  ]);
  process.stdout.write(res.stdout);
  if (res.code !== 0) {
    throw new ConspectusError(`Einspielen fehlgeschlagen: ${res.stderr.trim() || res.code}`);
  }
  // Die Kopie im /tmp des Servers hat nichts mehr verloren: Sie ist fuer
  // jeden lesbar, der dort eine Shell hat.
  runRemote(host, ['rm', '-f', remote]);
  markInstalled(instanz.id, licenseId);
}

export function lizenzCommand(sub: string, args: Args): void {
  const { db } = openRegister();
  switch (sub) {
    case 'ausstellen': {
      const instanzId = args.values.instanz ?? args.positional[0];
      if (!instanzId) {
        throw new ConspectusError(
          'Aufruf: conspectus lizenz ausstellen --instanz <instanz> --until 1j [--billing abo] ...',
        );
      }
      const instanz = instanzMuss(instanzId);
      const kunde = kundeMuss(args.values.kunde ?? instanz.kunde_id);
      const { country, edition } = variantParts(instanz.variante);

      const ungebunden = args.flags.has('ungebunden');
      if (ungebunden && args.values.installation) {
        throw new ConspectusError('--ungebunden und --installation schliessen sich aus.');
      }
      const installation = ungebunden ? null : (args.values.installation ?? instanz.installation_id ?? undefined);
      if (installation === undefined) {
        throw new ConspectusError(
          `Fuer die Instanz "${instanz.id}" ist keine Installations-ID im Register.\n` +
            `Holen mit \`provision.sh id ${instanz.id}\` und eintragen:\n` +
            `  conspectus instanz id ${instanz.id} <32 hex>\n` +
            'Bewusst ungebunden ausstellen: --ungebunden',
        );
      }

      const v1 = args.flags.has('v1');
      if (!v1) assertV2Possible(instanz, args.flags.has('v2-erzwingen'));

      const kid = args.values.kid ?? defaultKid();
      const key = loadPrivateKey(kid, args.values.key);
      let issued;
      try {
        issued = issueLicense(
          {
            kid,
            customer: args.values.customer ?? kunde.name,
            customerId: kunde.id,
            installationId: installation,
            until: required(args, 'until', 'Beispiel: --until 1j | 3t | 2027-12-31 | unbefristet'),
            from: args.values.from ?? null,
            seats: args.values.seats ? Number(args.values.seats) : null,
            graceDays: args.values.grace ? Number(args.values.grace) : null,
            warnDays: args.values.warn ? Number(args.values.warn) : null,
            kind: args.values.kind === 'evaluation' ? 'evaluation' : 'standard',
            notice: args.values.notice ?? null,
            // Ausgabe kommt aus der Instanz, nicht aus der Kommandozeile.
            edition: v1 ? null : edition,
            country: v1 ? null : country,
            features: args.many.feature ?? null,
            billing: (args.values.billing as LicenseBilling | undefined) ?? null,
            interval: (args.values.interval as LicenseInterval | undefined) ?? null,
            termsLabel: args.values.label ?? null,
            headline: args.values.headline ?? null,
            forceV2: !v1,
          },
          key,
        );
      } catch (err) {
        if (err instanceof LicenseIssueError) throw new ConspectusError(err.message);
        throw err;
      }

      const datei = schreibeDatei(kunde.id, issued.payload, issued.text);
      merkeLizenz(issued.payload, kunde.id, instanz.id, datei);

      const p = issued.payload;
      console.log(`Lizenz v${p.v} fuer ${kunde.name} (Instanz ${instanz.id}) ausgestellt.`);
      console.log(`  Lizenznummer   ${p.license_id}`);
      console.log(`  Gueltig        ${formatDate(p.valid_from)} bis ${p.valid_until >= MAX_DATE ? 'unbefristet' : formatDate(p.valid_until)}`);
      console.log(`  Bindung        ${p.installation_id ?? 'ungebunden'}`);
      if (p.edition) console.log(`  Ausgabe        ${p.country} ${p.edition}`);
      if (p.terms) console.log(`  Vertrag        ${p.terms.billing}${p.terms.interval ? `, ${p.terms.interval}` : ''}`);
      if (p.features?.length) console.log(`  Funktionen     ${p.features.join(', ')}`);
      console.log(`  Datei          ${datei}`);

      if (args.flags.has('einspielen')) einspielen(instanz, datei, p.license_id);
      else console.log('\nEinspielen: --einspielen (Hosting) oder Datei an den Kunden senden.');
      return;
    }

    case 'verlaengern': {
      // Verlaengern ist Ausstellen mit den Feldern der letzten Datei als
      // Vorgabe: Wer verlaengert, will genau dasselbe noch einmal, nur
      // laenger. Alles bleibt ueberschreibbar.
      const instanzId = args.values.instanz ?? args.positional[0];
      if (!instanzId) throw new ConspectusError('Aufruf: conspectus lizenz verlaengern --instanz <instanz> --until 1j');
      const instanz = instanzMuss(instanzId);
      const letzte = currentLicense(instanz.id);
      if (!letzte) {
        throw new ConspectusError(
          `Fuer "${instanz.id}" ist keine Lizenz im Register. Die erste stellt \`lizenz ausstellen\` aus.`,
        );
      }
      const geerbt: Record<string, string> = {};
      // Der Schluessel wird mitgeerbt: Eine Verlaengerung mit einem anderen
      // kid waere fuer einen Server ohne passenden Eintrag unbrauchbar.
      if (letzte.kid) geerbt.kid = letzte.kid;
      if (letzte.kind) geerbt.kind = letzte.kind;
      if (letzte.billing) geerbt.billing = letzte.billing;
      if (letzte.interval) geerbt.interval = letzte.interval;
      if (letzte.plaetze !== null) geerbt.seats = String(letzte.plaetze);
      const geerbteFeatures = letzte.features ? letzte.features.split(',').filter(Boolean) : [];
      // Die neue Laufzeit beginnt am Tag NACH dem bisherigen Ende, damit keine
      // Luecke entsteht und sich die Zeitraeume nicht ueberlappen.
      const from =
        args.values.from ??
        (letzte.unbefristet === 1 ? todayIsoLocal() : addDaysIso(letzte.gueltig_bis, 1));
      // War die letzte Datei eine v1, bleibt es dabei: Eine Verlaengerung ist
      // kein Anlass, die Fassung zu wechseln (der Server muesste v2 lesen).
      const flags = new Set(args.flags);
      if (letzte.v === 1) flags.add('v1');
      const weiter: Args = {
        positional: [],
        values: { ...geerbt, ...args.values, instanz: instanz.id, from },
        many: { ...args.many },
        flags,
      };
      if (args.many.feature === undefined && geerbteFeatures.length > 0) {
        weiter.many.feature = geerbteFeatures;
      }
      console.log(
        `Verlaengere ${instanz.id}: bisher bis ${letzte.unbefristet ? 'unbefristet' : letzte.gueltig_bis}, neue Laufzeit ab ${from}.`,
      );
      lizenzCommand('ausstellen', weiter);
      return;
    }

    case 'eingespielt': {
      const aufruf = 'Aufruf: conspectus lizenz eingespielt <instanz> [--lizenz <nummer>] [--am 2026-10-01]';
      const instanzId = args.values.instanz ?? args.positional[0];
      // Eine Option ohne Wert oder ein Datum ohne `--am` wuerde sonst still zur Vorgabe.
      if (!instanzId || args.flags.has('am') || args.flags.has('lizenz') || args.positional.length > 1) {
        throw new ConspectusError(aufruf);
      }
      const instanz = instanzMuss(instanzId);
      // Ausgestellt und laufend wie in `check`; in Registern von vor
      // `laufende_lizenz` gilt die zuletzt eingespielte als laufend.
      const lizenzen = instanceLicenses(instanz.id).get(instanz.id);
      // Vorgabe ist die ausgestellte Lizenz, dieselbe, die `check` nennt.
      const ziel = args.values.lizenz ? findLicense(args.values.lizenz, instanz.id) : lizenzen?.issued;
      if (!ziel) throw new ConspectusError(`Fuer "${instanz.id}" ist keine Lizenz im Register.`);
      const kurz = ziel.license_id.slice(0, 8);
      if (ziel.zurueckgezogen_am) {
        throw new ConspectusError(`Lizenz ${kurz} ist seit ${formatDate(ziel.zurueckgezogen_am)} zurueckgezogen.`);
      }
      if (ziel.eingespielt_am) {
        const seit = formatDate(ziel.eingespielt_am);
        if (lizenzen?.running.license_id === ziel.license_id) {
          throw new ConspectusError(`Lizenz ${kurz} (${instanz.id}) ist bereits seit ${seit} als eingespielt vermerkt.`);
        }
        // Schon einmal eingespielt, laut Register laeuft aber eine andere (Restore).
        if (args.values.am !== undefined) {
          throw new ConspectusError(`Lizenz ${kurz} ist seit ${seit} als eingespielt vermerkt; --am entfaellt.`);
        }
        markInstalled(instanz.id, ziel.license_id);
        console.log(`Lizenz ${kurz} (${instanz.id}) als wieder laufend vermerkt (eingespielt seit ${seit}).`);
        return;
      }
      const heute = todayIsoLocal();
      const am = args.values.am ?? heute;
      if (!isIsoDay(am)) throw new ConspectusError(`--am erwartet einen Kalendertag JJJJ-MM-TT (erhalten: ${am}).`);
      if (am < ziel.ausgestellt_am || am > heute) {
        throw new ConspectusError(
          `--am ${formatDate(am)} liegt ausserhalb von Ausstellung (${formatDate(ziel.ausgestellt_am)}) bis heute (${formatDate(heute)}).`,
        );
      }
      markInstalled(instanz.id, ziel.license_id, am);
      console.log(`Lizenz ${kurz} (${instanz.id}) als eingespielt am ${formatDate(am)} vermerkt.`);
      return;
    }

    case 'zurueckziehen': {
      const nummer = args.values.lizenz ?? args.positional[0];
      if (!nummer || args.flags.has('lizenz') || args.positional.length > 1) {
        throw new ConspectusError('Aufruf: conspectus lizenz zurueckziehen <lizenznummer>');
      }
      const l = findLicense(nummer);
      const kurz = l.license_id.slice(0, 8);
      if (l.zurueckgezogen_am) {
        throw new ConspectusError(`Lizenz ${kurz} ist bereits seit ${formatDate(l.zurueckgezogen_am)} zurueckgezogen.`);
      }
      // Eine eingespielte Datei liegt beim Kunden; das Register darf sie nicht wegdefinieren.
      if (l.eingespielt_am) {
        throw new ConspectusError(
          `Lizenz ${kurz} ist seit ${formatDate(l.eingespielt_am)} als eingespielt vermerkt und bleibt im Bestand.`,
        );
      }
      const heute = todayIsoLocal();
      db.transaction(() => {
        db.prepare('UPDATE lizenzen SET zurueckgezogen_am = ? WHERE license_id = ?').run(heute, l.license_id);
        db.prepare("INSERT INTO vorgaenge (kunde_id, art, datum, text) VALUES (?, 'lizenz', ?, ?)").run(
          l.kunde_id,
          heute,
          `Lizenz ${kurz} zurueckgezogen`,
        );
      })();
      console.log(`Lizenz ${kurz} (${l.instanz_id ?? '-'}) zurueckgezogen.`);
      console.log('Die Datei selbst bleibt gueltig: nicht weitergeben, beim Kunden nicht einspielen lassen.');
      return;
    }

    case 'faellig': {
      const tage = Number(args.values.tage ?? 45);
      if (!Number.isInteger(tage) || tage < 0) throw new ConspectusError('--tage erwartet eine ganze Zahl.');
      const heute = todayIsoLocal();
      const bis = addDaysIso(heute, tage);
      const kunden = new Map(
        (db.prepare('SELECT id, name FROM kunden').all() as { id: string; name: string }[]).map((k) => [k.id, k.name]),
      );
      // Faellig ist die LAUFENDE Lizenz (expiringLicense): Nach einer
      // Verlaengerung erst dann nicht mehr, wenn die neue Datei eingespielt ist.
      const liste = [...instanceLicenses().values()]
        .map((l) => ({ ...l, ende: expiringLicense(l) }))
        .filter(({ ende }) => ende.unbefristet === 0 && ende.gueltig_bis >= heute && ende.gueltig_bis <= bis)
        .sort((a, b) => a.ende.gueltig_bis.localeCompare(b.ende.gueltig_bis));
      if (liste.length === 0) {
        console.log(`Keine Lizenz laeuft in den naechsten ${tage} Tagen ab.`);
        return;
      }
      console.log(`Faellig in den naechsten ${tage} Tagen:\n`);
      console.log(['BIS'.padEnd(12), 'INSTANZ'.padEnd(18), 'KUNDE'.padEnd(28), 'ART'].join(' '));
      for (const { ende: r, issued, running } of liste) {
        const art = !issued || issued.license_id === running.license_id
          ? r.kind
          : r === running
            ? `${r.kind}, Nachfolge ${issued.license_id.slice(0, 8)} ausgestellt`
            : `${r.kind}, Instanz meldet ${running.license_id.slice(0, 8)}`;
        console.log(
          [r.gueltig_bis.padEnd(12), (r.instanz_id ?? '-').padEnd(18), (kunden.get(r.kunde_id) ?? r.kunde_id).padEnd(28), art].join(' '),
        );
      }
      return;
    }

    case 'liste':
    case undefined:
    case '': {
      const rows = db
        .prepare('SELECT * FROM lizenzen ORDER BY ausgestellt_am DESC, rowid DESC')
        .all() as LizenzRow[];
      if (rows.length === 0) {
        console.log('Noch keine Lizenz im Register.');
        return;
      }
      console.log(
        ['AUSGESTELLT'.padEnd(12), 'INSTANZ'.padEnd(18), 'V'.padEnd(3), 'ART'.padEnd(12), 'BIS'.padEnd(12), 'EINGESPIELT'].join(' '),
      );
      for (const r of rows) {
        console.log(
          [
            r.ausgestellt_am.padEnd(12),
            (r.instanz_id ?? '-').padEnd(18),
            String(r.v).padEnd(3),
            r.kind.padEnd(12),
            (r.unbefristet ? 'unbefristet' : r.gueltig_bis).padEnd(12),
            r.zurueckgezogen_am ? `zurueckgezogen ${r.zurueckgezogen_am}` : (r.eingespielt_am ?? '-'),
          ].join(' '),
        );
      }
      return;
    }

    default:
      throw new ConspectusError(
        `Unbekannter Unterbefehl "lizenz ${sub}". Bekannt: ausstellen, verlaengern, eingespielt, zurueckziehen, faellig, liste.`,
      );
  }
}
