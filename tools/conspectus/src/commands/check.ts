/**
 * Was ist offen? Die Fragen, die man sonst einmal im Monat vergisst.
 *
 * Arbeitet ausschliesslich auf dem Register, ohne Netzzugriff: So laeuft der
 * Befehl auch dann, wenn ein Host gerade nicht erreichbar ist, und die
 * Antworten sind sofort da. Damit sie stimmen, gehoert vorher ein
 * `conspectus status --host ...` bzw. `bericht importieren` dazu.
 */
import { todayIsoLocal, daysBetweenIso } from '@ohrganize/shared';
import type { Args } from '../args.js';
import { openRegister } from '../db.js';
import { neuestesRelease } from './release.js';
import type { InstanzRow } from './instanz.js';
import type { LizenzRow } from './lizenz.js';

interface Befund {
  schwere: 'hoch' | 'mittel' | 'hinweis';
  was: string;
  text: string;
}

export function sammleBefunde(tage = 30): Befund[] {
  const { db } = openRegister();
  const heute = todayIsoLocal();
  const befunde: Befund[] = [];

  const instanzen = db.prepare('SELECT * FROM instanzen ORDER BY id').all() as InstanzRow[];
  const lizenzen = db.prepare('SELECT * FROM lizenzen').all() as LizenzRow[];

  // Juengste Lizenz je Instanz: Eine laengst abgeloeste Datei sagt nichts.
  const juengste = new Map<string, LizenzRow>();
  for (const l of lizenzen) {
    if (!l.instanz_id) continue;
    const bisher = juengste.get(l.instanz_id);
    if (!bisher || l.gueltig_bis > bisher.gueltig_bis) juengste.set(l.instanz_id, l);
  }

  for (const i of instanzen) {
    const l = juengste.get(i.id);
    if (!l) {
      befunde.push({
        schwere: 'hoch',
        was: i.id,
        text: 'Keine Lizenz ausgestellt. Nach der Testphase faellt die Instanz in den Nur-Lese-Betrieb.',
      });
    } else if (l.unbefristet === 0) {
      if (l.gueltig_bis < heute) {
        befunde.push({ schwere: 'hoch', was: i.id, text: `Lizenz seit ${l.gueltig_bis} abgelaufen.` });
      } else {
        const rest = daysBetweenIso(l.gueltig_bis, heute);
        if (rest <= tage) {
          befunde.push({
            schwere: 'mittel',
            was: i.id,
            text: `Lizenz laeuft am ${l.gueltig_bis} ab (noch ${rest} Tage).`,
          });
        }
      }
    }

    if (l && l.eingespielt_am === null && l.installation_id !== null) {
      befunde.push({
        schwere: 'mittel',
        was: i.id,
        text: `Lizenz ${l.license_id.slice(0, 8)} ist ausgestellt, aber nicht als eingespielt vermerkt.`,
      });
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

    // Version gegen das juengste Release des eigenen Kanals.
    const kanal = i.kanal ?? 'stable';
    const neu = neuestesRelease(i.variante, kanal);
    if (neu && i.version && i.version !== neu.version) {
      befunde.push({
        schwere: 'hinweis',
        was: i.id,
        text: `Laeuft auf ${i.version}, juengstes ${kanal}-Release ist ${neu.version}.`,
      });
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
