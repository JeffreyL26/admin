/**
 * Was ist offen? Die Fragen, die man sonst einmal im Monat vergisst.
 *
 * Arbeitet ausschliesslich auf dem Register, ohne Netzzugriff: So laeuft der
 * Befehl auch dann, wenn ein Host gerade nicht erreichbar ist, und die
 * Antworten sind sofort da. Damit sie stimmen, gehoert vorher ein
 * `conspectus status --host ...` bzw. `bericht importieren` dazu.
 */
import { channelOf, compareVersions, formatDate, todayIsoLocal, daysBetweenIso } from '@ohrganize/shared';
import type { Args } from '../args.js';
import { openRegister } from '../db.js';
import { instanceLicenses, type InstanceLicenses, type LizenzRow } from '../licenses.js';
import { neuestesRelease } from './release.js';
import type { InstanzRow } from './instanz.js';

interface Befund {
  schwere: 'hoch' | 'mittel' | 'hinweis';
  was: string;
  text: string;
}

export function sammleBefunde(tage = 30, licenses: Map<string, InstanceLicenses> = instanceLicenses()): Befund[] {
  const { db } = openRegister();
  const heute = todayIsoLocal();
  const befunde: Befund[] = [];

  const instanzen = db.prepare('SELECT * FROM instanzen ORDER BY id').all() as InstanzRow[];

  for (const i of instanzen) {
    if (i.bericht_abgelehnt_am) {
      befunde.push({
        schwere: 'hoch',
        was: i.id,
        text: `Bericht vom ${formatDate(i.bericht_abgelehnt_am)} abgelehnt, Register zeigt den Stand davor: ${i.bericht_abgelehnt_grund}`,
      });
    }
    const l = licenses.get(i.id);
    if (!l) {
      befunde.push({
        schwere: 'hoch',
        was: i.id,
        text: 'Keine Lizenz ausgestellt. Nach der Testphase faellt die Instanz in den Nur-Lese-Betrieb.',
      });
    } else {
      // Ablauf an der LAUFENDEN Lizenz: Eine ausgestellte, aber nicht
      // eingespielte Verlaengerung verlaengert beim Kunden nichts.
      const { issued, running } = l;
      if (running.unbefristet === 0) {
        if (running.gueltig_bis < heute) {
          befunde.push({ schwere: 'hoch', was: i.id, text: `Lizenz seit ${running.gueltig_bis} abgelaufen.` });
        } else {
          // daysBetweenIso(a, b) ist b minus a: Resttage sind bis minus heute.
          const rest = daysBetweenIso(heute, running.gueltig_bis);
          if (rest <= tage) {
            befunde.push({
              schwere: 'mittel',
              was: i.id,
              text: `Lizenz laeuft am ${running.gueltig_bis} ab (noch ${rest} Tage).`,
            });
          }
        }
      }
      if (l.unknownReported) {
        befunde.push({
          schwere: 'mittel',
          was: i.id,
          text: `Die Instanz meldet die Lizenz ${l.unknownReported.slice(0, 8)}, die fuer sie nicht im Register steht.`,
        });
      } else if (running.zurueckgezogen_am) {
        befunde.push({
          schwere: issued ? 'mittel' : 'hoch',
          was: i.id,
          text:
            `Die Instanz meldet die zurueckgezogene Lizenz ${running.license_id.slice(0, 8)}` +
            (issued ? '.' : '; eine gueltige ist nicht ausgestellt.'),
        });
      }
      // Nach einer neuen Installation (frische Datenbank) nimmt der Server keine
      // Datei der alten Installations-ID mehr an.
      const passt = (lizenz: LizenzRow | null): boolean =>
        !lizenz?.installation_id || !i.installation_id || lizenz.installation_id === i.installation_id;
      for (const lizenz of new Set([issued, running])) {
        if (lizenz && !passt(lizenz)) {
          // Ist schon eine passende ausgestellt, fehlt nur das Einspielen.
          const rat =
            issued && issued !== lizenz && passt(issued)
              ? `die ausgestellte ${issued.license_id.slice(0, 8)} einspielen lassen`
              : 'neue ausstellen';
          befunde.push({
            schwere: 'hoch',
            was: i.id,
            text:
              `Lizenz ${lizenz.license_id.slice(0, 8)} ist an die Installation ${(lizenz.installation_id as string).slice(0, 8)} ` +
              `gebunden, die Instanz hat ${(i.installation_id as string).slice(0, 8)}: Der Server nimmt sie nicht an, ${rat}.`,
          });
        }
      }
      if (issued && issued.eingespielt_am === null) {
        befunde.push({
          schwere: 'mittel',
          was: i.id,
          text:
            `Lizenz ${issued.license_id.slice(0, 8)} ist ausgestellt, aber nicht als eingespielt vermerkt ` +
            `(Bericht einlesen oder: conspectus lizenz eingespielt ${i.id}; ` +
            `nie gebraucht: conspectus lizenz zurueckziehen ${issued.license_id.slice(0, 8)}).`,
        });
      } else if (issued && running.license_id !== issued.license_id) {
        befunde.push({
          schwere: 'mittel',
          was: i.id,
          text:
            `Lizenz ${issued.license_id.slice(0, 8)} war eingespielt, die Instanz meldet aber ` +
            `${running.license_id.slice(0, 8)}: Restore beim Kunden oder ein aelterer Bericht nach einem neueren ` +
            `eingelesen? Neuesten Bericht einlesen, sonst ${issued.license_id.slice(0, 8)} erneut einspielen lassen.`,
        });
      }
    }

    if (!i.installation_id) {
      befunde.push({
        schwere: 'hinweis',
        was: i.id,
        text: 'Keine Installations-ID im Register; eine gebundene Lizenz ist so nicht ausstellbar.',
      });
    }

    if (i.lizenz_zustand === 'expired' || i.lizenz_zustand === 'grace') {
      befunde.push({
        schwere: 'hoch',
        was: i.id,
        text: `Der letzte Bericht meldet den Lizenzzustand "${i.lizenz_zustand}".`,
      });
    }

    // Eine stabile Instanz gegen das juengste stabile Release, eine Beta gegen
    // alle, denn auch das fertige Release loest sie ab. Der Kanal folgt aus der
    // Version, nicht aus der Spalte: Der Einzelbericht von status.cjs nennt keinen.
    if (i.version) {
      const neu = neuestesRelease(i.variante, channelOf(i.version) === 'beta');
      if (neu && compareVersions(i.version, neu.version) < 0) {
        befunde.push({
          schwere: 'hinweis',
          was: i.id,
          text: `Laeuft auf ${i.version}, juengstes ${neu.kanal}-Release ist ${neu.version}.`,
        });
      }
    }

    if (i.zuletzt_gesehen === null) {
      befunde.push({
        schwere: 'hinweis',
        was: i.id,
        text: 'Noch kein Bericht eingelesen (conspectus status --host ... oder bericht importieren).',
      });
    }
  }

  const offeneRollouts = db
    .prepare("SELECT * FROM rollouts WHERE zustand IN ('offen', 'laeuft', 'fehlgeschlagen') ORDER BY begonnen_am")
    .all() as { id: number; release_id: string; zustand: string; host_id: string | null }[];
  for (const r of offeneRollouts) {
    befunde.push({
      schwere: r.zustand === 'fehlgeschlagen' ? 'hoch' : 'mittel',
      was: `rollout ${r.id}`,
      text: `${r.release_id} auf ${r.host_id ?? '?'}: ${r.zustand}.`,
    });
  }

  const ungeprueft = db
    .prepare('SELECT id FROM releases WHERE signatur_geprueft = 0')
    .all() as { id: string }[];
  for (const r of ungeprueft) {
    befunde.push({ schwere: 'hinweis', was: r.id, text: 'Release ohne geprüfte Signatur erfasst.' });
  }

  return befunde;
}

export function checkCommand(args: Args): void {
  const tage = Number(args.values.tage ?? 30);
  const befunde = sammleBefunde(tage);
  if (befunde.length === 0) {
    console.log('Kein Befund.');
    return;
  }
  const reihenfolge = { hoch: 0, mittel: 1, hinweis: 2 } as const;
  befunde.sort((a, b) => reihenfolge[a.schwere] - reihenfolge[b.schwere] || a.was.localeCompare(b.was));
  for (const b of befunde) {
    const marke = b.schwere === 'hoch' ? 'HOCH  ' : b.schwere === 'mittel' ? 'MITTEL' : 'hinweis';
    console.log(`${marke}  ${b.was.padEnd(20)} ${b.text}`);
  }
  console.log(`\n${befunde.length} Befund(e).`);
}
