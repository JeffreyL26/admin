/**
 * Sortierung der Tabellen in der Desktop-App (Spaltenkopf klicken, Richtung
 * wechseln, Stand je Geraet im localStorage). DOM-frei, damit die Regeln an
 * EINER Stelle stehen und ohne Browser pruefbar sind (Test
 * apps/backend/src/test/tableSortTest.ts). Serverseitig sortierte Listen
 * (Mitarbeitende) nutzen nur `nextSort` und `parseSortState`.
 */

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string = string> {
  key: K;
  dir: SortDir;
}

/** Wert einer Zelle fuer den Vergleich. Leer (null, undefined, '') steht immer am Ende. */
export type SortValue = string | number | boolean | null | undefined;

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

const isEmpty = (v: SortValue): v is null | undefined | '' => v === null || v === undefined || v === '';

/** Vergleich zweier nicht leerer Werte: Zahlen numerisch, Text nach deutscher Sortierung mit Ziffernfolgen als Zahl. */
export function compareSortValues(a: Exclude<SortValue, null | undefined>, b: Exclude<SortValue, null | undefined>): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Sortierte Kopie. Leere Werte stehen in beiden Richtungen am Ende (sonst
 * stuende bei "absteigend" ein Block ohne Angabe oben). Bei Gleichstand
 * entscheidet `tieBreak` aufsteigend, danach die bisherige Reihenfolge, damit
 * Zeilen beim Neuladen nicht springen.
 */
export function sortRows<T>(
  rows: readonly T[],
  value: (row: T) => SortValue,
  dir: SortDir,
  tieBreak?: (row: T) => SortValue,
): T[] {
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, v: value(row), t: tieBreak?.(row) }))
    .sort((a, b) => {
      const ae = isEmpty(a.v);
      const be = isEmpty(b.v);
      if (ae !== be) return ae ? 1 : -1;
      if (!ae && !be) {
        const c = compareSortValues(a.v as Exclude<SortValue, null | undefined>, b.v as Exclude<SortValue, null | undefined>);
        if (c !== 0) return sign * c;
      }
      if (tieBreak) {
        const te = isEmpty(a.t);
        const tb = isEmpty(b.t);
        if (te !== tb) return te ? 1 : -1;
        if (!te && !tb) {
          const c = compareSortValues(a.t as Exclude<SortValue, null | undefined>, b.t as Exclude<SortValue, null | undefined>);
          if (c !== 0) return c;
        }
      }
      return a.index - b.index;
    })
    .map((x) => x.row);
}

/** Klick auf einen Spaltenkopf: dieselbe Spalte kehrt die Richtung um, eine andere beginnt aufsteigend. */
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

/**
 * Gespeicherten Stand pruefen: Eine Spalte, die es nach einem Update nicht
 * mehr gibt, oder ein kaputter Eintrag faellt auf die Vorgabe zurueck.
 */
export function parseSortState<K extends string>(
  raw: unknown,
  keys: readonly K[],
  fallback: SortState<K>,
): SortState<K> {
  if (!raw || typeof raw !== 'object') return fallback;
  const { key, dir } = raw as { key?: unknown; dir?: unknown };
  if (typeof key !== 'string' || !(keys as readonly string[]).includes(key)) return fallback;
  return { key: key as K, dir: dir === 'desc' ? 'desc' : 'asc' };
}
