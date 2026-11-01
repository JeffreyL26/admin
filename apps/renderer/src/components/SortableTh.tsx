import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { SortState } from '@ohrganize/shared';

/**
 * Klickbarer Spaltenkopf. Ein Klick sortiert nach der Spalte, ein zweiter
 * kehrt die Richtung um (Regel `nextSort` in @ohrganize/shared). Der Pfeil
 * zeigt die aktive Spalte, die übrigen tragen ein blasses Doppelpfeil-Zeichen,
 * damit erkennbar ist, dass sie sortierbar sind.
 */
export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
  style,
}: {
  label: React.ReactNode;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={className}
      style={style}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`hm-th-sort${active ? ' hm-th-sort--active' : ''}`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <Icon size={12} aria-hidden="true" />
      </button>
    </th>
  );
}
