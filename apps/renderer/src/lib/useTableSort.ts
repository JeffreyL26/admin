import { useCallback, useMemo, useState } from 'react';
import { nextSort, parseSortState, sortRows, type SortState, type SortValue } from '@ohrganize/shared';
import { readJson, writeJson } from './localStore';

/**
 * Sortierung einer Tabelle, je Gerät gespeichert
 * (`ohrganize.tableSort.<tableKey>`), wie Spaltenauswahl und Dashboard eine
 * Arbeitsplatz-Einstellung. Überlebt damit den Wechsel in eine Akte und
 * zurück ebenso wie einen Neustart der App.
 *
 * `columns` nennt je Spalte den Wert für den Vergleich; die Schlüssel sind
 * zugleich die erlaubten Werte im Speicher (eine Spalte, die es nach einem
 * Update nicht mehr gibt, fällt auf die Vorgabe zurück).
 */
export function useTableSort<T, K extends string>(
  tableKey: string,
  rows: readonly T[] | undefined,
  columns: Record<K, (row: T) => SortValue>,
  fallback: SortState<NoInfer<K>>,
  tieBreak?: (row: T) => SortValue,
) {
  const storageKey = `ohrganize.tableSort.${tableKey}`;
  const keys = useMemo(() => Object.keys(columns) as K[], [columns]);
  const [sort, setSort] = useState<SortState<K>>(() => parseSortState(readJson(storageKey), keys, fallback));

  const toggle = useCallback(
    (key: K) => {
      setSort((current) => {
        const next = nextSort(current, key);
        writeJson(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const sorted = useMemo(
    () => (rows ? sortRows(rows, columns[sort.key], sort.dir, tieBreak) : undefined),
    // columns/tieBreak sind je Seite Konstanten außerhalb der Komponente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sort],
  );

  return { sort, toggle, sorted };
}

/**
 * Dasselbe für serverseitig sortierte, geblätterte Listen: nur Stand und
 * Klickfolge, sortiert wird im Backend (`sort`/`dir`). `onToggle` läuft bei
 * jedem Klick, etwa zurück auf Seite 1.
 */
export function useServerSort<K extends string>(
  tableKey: string,
  keys: readonly K[],
  fallback: SortState<NoInfer<K>>,
  onToggle?: () => void,
) {
  const storageKey = `ohrganize.tableSort.${tableKey}`;
  const [sort, setSort] = useState<SortState<K>>(() => parseSortState(readJson(storageKey), keys, fallback));
  const toggle = (key: K) => {
    const next = nextSort(sort, key);
    setSort(next);
    writeJson(storageKey, next);
    onToggle?.();
  };
  return { sort, toggle };
}
