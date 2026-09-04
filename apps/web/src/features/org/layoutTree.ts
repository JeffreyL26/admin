/**
 * Baum-Layout des Organigramms.
 *
 * Herkunft: portiert aus `apps/renderer/src/features/employees/OrgPage.tsx`
 * (Desktop-App, Tab „Organigramm"). Ein app-übergreifender Import ist nicht
 * möglich — die beiden Vite-Apps teilen ausschließlich `packages/shared`, und
 * dort gehört UI-naher Layoutcode bewusst nicht hin. Die Geometrie ist 1:1
 * übernommen, damit Portal und Desktop-App dasselbe Bild zeigen; ergänzt wurde
 * nur die Zwischenspeicherung der Teilbaumbreiten (siehe unten).
 */
import type { OrgTreeNode } from '@ohrganize/shared';

export const NODE_W = 216;
export const NODE_H = 88;
export const H_GAP = 28;
export const V_GAP = 76;

export interface LaidOutNode {
  node: OrgTreeNode;
  x: number;
  y: number;
}

export interface OrgLayout {
  nodes: LaidOutNode[];
  edges: [LaidOutNode, LaidOutNode][];
  width: number;
  height: number;
}

/**
 * Ordnet die Abteilungen ebenenweise an: jeder Knoten sitzt mittig über seinen
 * Kindern, Geschwister liegen nebeneinander.
 */
export function layoutTree(roots: OrgTreeNode[]): OrgLayout {
  const nodes: LaidOutNode[] = [];
  const edges: [LaidOutNode, LaidOutNode][] = [];
  let maxDepth = 0;

  // Die Breite eines Teilbaums wird beim Platzieren mehrfach abgefragt (für den
  // Knoten selbst und erneut je Geschwisterkind). Ohne Zwischenspeicher wächst
  // das quadratisch mit der Tiefe — die Map hält es linear.
  const widths = new Map<number, number>();
  const subtreeWidth = (n: OrgTreeNode): number => {
    const cached = widths.get(n.id);
    if (cached !== undefined) return cached;
    const width =
      n.children.length === 0
        ? NODE_W + H_GAP
        : Math.max(NODE_W + H_GAP, n.children.reduce((acc, c) => acc + subtreeWidth(c), 0));
    widths.set(n.id, width);
    return width;
  };

  const place = (n: OrgTreeNode, left: number, depth: number): LaidOutNode => {
    maxDepth = Math.max(maxDepth, depth);
    const width = subtreeWidth(n);
    const self: LaidOutNode = {
      node: n,
      x: left + width / 2 - NODE_W / 2,
      y: depth * (NODE_H + V_GAP),
    };
    nodes.push(self);
    let childLeft = left;
    for (const child of n.children) {
      const childNode = place(child, childLeft, depth + 1);
      edges.push([self, childNode]);
      childLeft += subtreeWidth(child);
    }
    return self;
  };

  let left = 0;
  for (const root of roots) {
    place(root, left, 0);
    left += subtreeWidth(root);
  }

  return {
    nodes,
    edges,
    width: Math.max(left, NODE_W + H_GAP),
    height: (maxDepth + 1) * (NODE_H + V_GAP),
  };
}

/** Kürzt einen Text auf `max` Zeichen — SVG kennt kein `text-overflow`. */
export function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Initialen der Leitung für die Kreisplakette; ohne Leitung ein Fragezeichen. */
export function initials(name: string | null): string {
  if (!name) return '?';
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}
