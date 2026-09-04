/**
 * Team-Leisten unter den Abteilungskästen.
 *
 * `layoutTree` (portiert aus der Desktop-App) ordnet ausschließlich die
 * Abteilungen an — dort hängen die Teams nur als Zahl im Kasten. Das Portal
 * zeigt sie kompakt darunter, und dafür braucht jede Ebene zusätzliche Höhe:
 * ohne sie liefe die Verbindungslinie zur Unterabteilung mitten durch die
 * Team-Zeilen.
 *
 * Deshalb wird das fertige Layout hier nachbearbeitet statt `layoutTree`
 * verändert: die Geometrie der Kästen bleibt exakt die der Desktop-App
 * (Portal und HR-Ansicht sollen dasselbe Bild zeigen), und jede Ebene wird nur
 * um die höchste Team-Leiste dieser Ebene nach unten geschoben. Der senkrechte
 * Abstand zwischen Leistenunterkante und der nächsten Ebene bleibt damit
 * mindestens `V_GAP`.
 */
import type { OrgTreeNode } from '@ohrganize/shared';
import { NODE_H, V_GAP, type LaidOutNode, type OrgLayout } from './layoutTree';

/** Höhe einer Team-Zeile. */
export const TEAM_ROW_H = 17;
/** Luft zwischen Kastenunterkante und erster Team-Zeile. */
export const TEAM_SHELF_GAP = 8;
/** Mehr Teams werden zu „+N weitere" zusammengefasst — der Kasten soll nicht wuchern. */
export const MAX_VISIBLE_TEAMS = 3;

type Team = OrgTreeNode['teams'][number];

export interface OrgPlacement extends LaidOutNode {
  /** Höhe der Team-Leiste unter dem Kasten; 0 ohne Teams. */
  shelfHeight: number;
  visibleTeams: Team[];
  /** Anzahl der nicht einzeln gezeigten Teams. */
  hiddenTeams: number;
}

export interface OrgChartLayout {
  nodes: OrgPlacement[];
  edges: [OrgPlacement, OrgPlacement][];
  width: number;
  height: number;
}

function shelfHeightOf(teams: Team[]): number {
  if (teams.length === 0) return 0;
  const rows = Math.min(teams.length, MAX_VISIBLE_TEAMS) + (teams.length > MAX_VISIBLE_TEAMS ? 1 : 0);
  return TEAM_SHELF_GAP + rows * TEAM_ROW_H;
}

export function withTeamShelves(layout: OrgLayout): OrgChartLayout {
  const rowStride = NODE_H + V_GAP;
  // `layoutTree` setzt y = Tiefe * rowStride — die Ebene lässt sich daraus
  // zurückrechnen, ohne den Baum ein zweites Mal zu durchlaufen.
  const depthOf = (node: LaidOutNode) => Math.round(node.y / rowStride);

  const extraPerDepth = new Map<number, number>();
  for (const placed of layout.nodes) {
    const depth = depthOf(placed);
    const height = shelfHeightOf(placed.node.teams);
    extraPerDepth.set(depth, Math.max(extraPerDepth.get(depth) ?? 0, height));
  }

  // Eine Ebene erbt den Zuschlag aller Ebenen über ihr.
  const offsetPerDepth = new Map<number, number>();
  let running = 0;
  const depths = [...extraPerDepth.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    offsetPerDepth.set(depth, running);
    running += extraPerDepth.get(depth) ?? 0;
  }

  const byOriginal = new Map<LaidOutNode, OrgPlacement>();
  const nodes = layout.nodes.map((placed) => {
    const teams = placed.node.teams;
    const placement: OrgPlacement = {
      node: placed.node,
      x: placed.x,
      y: placed.y + (offsetPerDepth.get(depthOf(placed)) ?? 0),
      shelfHeight: shelfHeightOf(teams),
      visibleTeams: teams.slice(0, MAX_VISIBLE_TEAMS),
      hiddenTeams: Math.max(0, teams.length - MAX_VISIBLE_TEAMS),
    };
    byOriginal.set(placed, placement);
    return placement;
  });

  const edges = layout.edges.map(([from, to]): [OrgPlacement, OrgPlacement] => [
    byOriginal.get(from) as OrgPlacement,
    byOriginal.get(to) as OrgPlacement,
  ]);

  return { nodes, edges, width: layout.width, height: layout.height + running };
}
