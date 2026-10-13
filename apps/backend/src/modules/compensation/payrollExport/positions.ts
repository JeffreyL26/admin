/**
 * Was je Person in welche Datei kommt, an EINER Stelle: Beide Adapter
 * (lodas.ts, lug.ts) formatieren nur, was dieser Plan liefert, und der
 * Pruefbericht (check.ts) prueft genau die Lohnarten, die eine Datei
 * tatsaechlich traegt. Vorher entschieden das zwei Schleifen und eine dritte
 * Kopie im Pruefbericht, und eine Lohnart, die keine Datei enthielt, sperrte
 * trotzdem den Export.
 */
import {
  contractMonthHours,
  LODAS_FESTBEZUG_ID,
  LODAS_POSITION_KIND,
  lohnartNumberKind,
  type DatevExportKind,
  type DatevLohnartKey,
} from '@ohrganize/shared';
import type { DatevExportContext, DatevPerson } from './context.js';

/** Eine Buchung in den Bewegungsdaten. */
export type Bewegung =
  | { type: 'bruttobezug'; key: DatevLohnartKey; cents: number }
  | { type: 'nettoabzug'; key: DatevLohnartKey; cents: number }
  | { type: 'stunden'; key: 'stundenlohn'; hours: number; rateCents: number };

/** Ein Festbezug oder Nettoabzug in den LODAS-Stammdaten; 0 Cent beendet einen entfallenen. */
export type Festbezug =
  | { type: 'festbezug'; key: DatevLohnartKey; id: number; cents: number }
  | { type: 'nettoabzug'; key: DatevLohnartKey; cents: number };

/** Positionsart einer Komponente; undefined fuer eine Art, die der Export nicht kennt. */
export function positionKind(kind: string) {
  return (LODAS_POSITION_KIND as Record<string, (typeof LODAS_POSITION_KIND)[DatevLohnartKey] | undefined>)[kind];
}

/**
 * Vertragsstunden des Stundenlohns: die, mit denen der Lauf gerechnet hat
 * (Snapshot), fuer Laeufe aus aelteren Fassungen ohne Snapshot aus den
 * Wochenstunden mit derselben Regel.
 */
export function hourlyHours(p: DatevPerson): number | null {
  const hourly = p.components.find((c) => c.kind === 'stundenlohn');
  if (!hourly) return null;
  return hourly.hours ?? contractMonthHours(p.weekly_hours);
}

/**
 * Bewegungsdaten einer Person: Einmalzahlungen (Boni ueber 0), Stunden bei
 * Vertragsstunden, und nur bei „Festbezuege als Buchung“ die
 * wiederkehrenden Bezuege und Abzuege.
 */
export function bewegungenOf(ctx: DatevExportContext, p: DatevPerson): Bewegung[] {
  const out: Bewegung[] = [];
  if (ctx.settings.festbezuege === 'bewegungsdaten') {
    for (const c of p.components) {
      const kind = positionKind(c.kind);
      if (kind === 'festbezug') out.push({ type: 'bruttobezug', key: c.kind as DatevLohnartKey, cents: c.amount_cents });
      else if (kind === 'nettoabzug') out.push({ type: 'nettoabzug', key: c.kind as DatevLohnartKey, cents: c.amount_cents });
    }
  }
  const hourly = p.components.find((c) => c.kind === 'stundenlohn');
  if (hourly && ctx.settings.vertragsstunden) {
    out.push({ type: 'stunden', key: 'stundenlohn', hours: hourlyHours(p)!, rateCents: hourly.amount_cents });
  }
  for (const b of p.bonuses) {
    if (b.payout_cents > 0) out.push({ type: 'bruttobezug', key: `bonus_${b.kind}` as DatevLohnartKey, cents: b.payout_cents });
  }
  return out;
}

/**
 * Festbezuege und Nettoabzuege einer Person fuer die LODAS-Stammdaten (nur bei
 * „Festbezuege ueber die Stammdaten“). Entfallene Arten gehen mit 0 Cent
 * unter ihrer festen Kennung mit, damit LODAS sie nicht weiter zahlt.
 */
export function festbezuegeOf(ctx: DatevExportContext, p: DatevPerson): Festbezug[] {
  if (ctx.settings.festbezuege !== 'stammdaten') return [];
  const out: Festbezug[] = [];
  const add = (kind: string, cents: number) => {
    const position = positionKind(kind);
    const id = LODAS_FESTBEZUG_ID[kind as DatevLohnartKey];
    if (position === 'festbezug' && id !== undefined) out.push({ type: 'festbezug', key: kind as DatevLohnartKey, id, cents });
    else if (position === 'nettoabzug') out.push({ type: 'nettoabzug', key: kind as DatevLohnartKey, cents });
  };
  for (const c of p.components) add(c.kind, c.amount_cents);
  for (const kind of p.ended_kinds) add(kind, 0);
  return out;
}

/**
 * Lohnarten, die eine Datei tatsaechlich traegt, je Schluessel mit den
 * Dateien und der Art der Nummer (lohnartNumberKind: Nettobe-/abzugsnummer
 * oder eigene Lohnart). Lohn und Gehalt kennt nur die Bewegungsdaten.
 */
export function lohnartUsage(
  ctx: DatevExportContext,
): Map<DatevLohnartKey, { kinds: Set<DatevExportKind>; number: 'nba' | 'lohnart' }> {
  const usage = new Map<DatevLohnartKey, { kinds: Set<DatevExportKind>; number: 'nba' | 'lohnart' }>();
  const note = (key: DatevLohnartKey, kind: DatevExportKind) => {
    const entry = usage.get(key) ?? {
      kinds: new Set<DatevExportKind>(),
      number: lohnartNumberKind(key, ctx.settings.program, ctx.settings.festbezuege),
    };
    entry.kinds.add(kind);
    usage.set(key, entry);
  };
  for (const p of ctx.persons) {
    for (const b of bewegungenOf(ctx, p)) note(b.key, 'bewegungsdaten');
    if (ctx.settings.program === 'lodas') {
      for (const f of festbezuegeOf(ctx, p)) note(f.key, 'stammdaten');
    }
  }
  return usage;
}

/** Fehltage einer Person, die einen Ausfallschluessel haben (nur die gehen mit). */
export function fehltageOf(ctx: DatevExportContext, p: DatevPerson) {
  return p.absences
    .map((a) => ({ ...a, as: (ctx.settings.ausfallschluessel[String(a.type_id)] ?? '').trim() }))
    .filter((a) => a.as !== '');
}
