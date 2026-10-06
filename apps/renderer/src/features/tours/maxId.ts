/**
 * Ziel der Seiten-Einfuehrungen ist meist der zuletzt angelegte Eintrag: die
 * hoechste `id`. `keep` schliesst Eintraege aus, die als Ziel nicht taugen.
 */
export function maxId<T extends { id: number }>(items: T[] | undefined, keep?: (item: T) => boolean): number | null {
  let max: number | null = null;
  for (const item of items ?? []) {
    if (keep && !keep(item)) continue;
    if (max === null || item.id > max) max = item.id;
  }
  return max;
}
