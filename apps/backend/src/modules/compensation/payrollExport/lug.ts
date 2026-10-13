/**
 * DATEV Lohn und Gehalt, Bewegungsdaten ueber den ASCII-Import-Assistenten
 * (Erfassen > Bewegungsdaten > Importieren). Anders als LODAS traegt die
 * Datei keine Satzbeschreibung: Das Lohnbuero legt sie einmalig im
 * Assistenten an (Trennzeichen Strichpunkt, Zahlenkomma Komma, Datum
 * TT.MM.JJJJ) mit genau den elf Spalten aus LUG_COLUMNS in dieser
 * Reihenfolge. Jede Zeile hat alle elf Felder, leere bleiben leer, kein
 * Kopf, keine Hinweise (die Warnungen stehen nur im Pruefbericht).
 *
 *   Bezug, Abzug     Personalnummer;;;Lohnart;;;Wert;;;;
 *   Stunden          Personalnummer;;;Lohnart;Stunden;;;Stundensatz;;;
 *   Fehltag          Personalnummer;TT.MM.JJJJ;Ausfallschluessel;;;1 oder 0,5;;;;;
 *
 * Der Stundensatz steht im „Abweichenden Faktor“, damit Lohn und Gehalt die
 * Stunden mit dem Satz aus oHRganize rechnet. Was in die Datei kommt,
 * entscheidet positions.ts, wie fuer LODAS. Personalstammdaten gehen hier
 * nicht mit: Der Stammdatenimport von Lohn und Gehalt ist ein eigenes,
 * maskenbasiertes Format (Ziel=LuG), das ein Personalfragebogen abdeckt.
 */
import {
  datevBetrag,
  datevDatum,
  datevStunden,
  LUG_COLUMNS,
} from '@ohrganize/shared';
import type { DatevExportContext } from './context.js';
import { encodeCp1252 } from './cp1252.js';
import { bewegungenOf, fehltageOf } from './positions.js';
import type { DatevFile, PayrollExporter } from './index.js';

function row(fields: Partial<Record<(typeof LUG_COLUMNS)[number], string>>): string {
  return LUG_COLUMNS.map((c) => fields[c] ?? '').join(';');
}

export function renderLugBewegungsdaten(ctx: DatevExportContext): string {
  const lines: string[] = [];
  const lohnart = (k: string) => (ctx.settings.lohnarten[k] ?? '').trim();
  for (const p of ctx.persons) {
    for (const b of bewegungenOf(ctx, p)) {
      if (b.type === 'stunden') {
        lines.push(
          row({
            Personalnummer: p.pnr,
            Lohnartennummer: lohnart(b.key),
            Stundenanzahl: datevStunden(b.hours),
            'Abweichender Faktor': datevBetrag(b.rateCents),
          }),
        );
      } else {
        lines.push(row({ Personalnummer: p.pnr, Lohnartennummer: lohnart(b.key), Wert: datevBetrag(b.cents) }));
      }
    }
    for (const a of fehltageOf(ctx, p)) {
      lines.push(
        row({
          Personalnummer: p.pnr,
          Kalendertag: datevDatum(a.date),
          Ausfallschluessel: a.as,
          Tagesanzahl: a.half ? '0,5' : '1',
        }),
      );
    }
  }
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

export const lugExporter: PayrollExporter = {
  id: 'lug',
  country: 'DE',
  label: 'DATEV Lohn und Gehalt',
  kinds: ['bewegungsdaten'],
  persons(_kind, ctx) {
    return ctx.persons;
  },
  render(kind, ctx): DatevFile {
    return {
      filename: `lug_${kind}_${ctx.run.month}.txt`,
      contentType: 'text/plain; charset=windows-1252',
      content: encodeCp1252(renderLugBewegungsdaten(ctx)),
    };
  },
};
