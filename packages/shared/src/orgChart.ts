import type { OrgChartParentSource } from './employees.js';

/**
 * Datenmodell und Layout des Personen-Organigramms, ohne DOM und ohne
 * Abhängigkeiten. Liegt hier, weil Desktop-App (`GET /api/org/chart`) und
 * Portal (`GET /api/me/org-chart`) dieselbe Geometrie zeichnen sollen; die
 * Karten selbst rendert jeder Client mit seinen eigenen Bausteinen.
 *
 * Generisch über die Person: Die Verwaltung bekommt Kontaktdaten und
 * Personalnummer, das Portal nur, was Kolleg:innen ohnehin sehen dürfen.
 */

/** Mindestfelder, die Baum, Layout und Suche brauchen. */
export interface OrgChartBasePerson {
  id: number;
  first_name: string;
  last_name: string;
  job_title: string | null;
  department_id: number | null;
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
  parent_id: number | null;
  parent_source: OrgChartParentSource | null;
}

/** Kartenmaße und Abstände in CSS-Pixeln bei Zoom 1. */
export const ORG_CARD_W = 236;
export const ORG_CARD_H = 118;
/** Abstand zwischen Geschwister-Teilbäumen. */
export const ORG_H_GAP = 26;
/** Abstand zwischen zwei Ebenen; die waagerechte Sammelleitung liegt in der Mitte. */
export const ORG_V_GAP = 72;
/** Abstand zwischen gestapelten Blattkarten. */
export const ORG_STACK_GAP = 12;
/** Einzug gestapelter Blätter; links davon läuft die senkrechte Leitung. */
export const ORG_STACK_INDENT = 34;
/**
 * Ab so vielen Blättern (Personen ohne eigene Berichtende) unter einer Person
 * stehen sie untereinander statt nebeneinander. Acht Karten in einer Reihe
 * wären breiter als jeder Bildschirm; ein Stapel bleibt im Blick.
 */
export const ORG_STACK_FROM = 4;
/** Anzahl der Kategoriefarben --org-1 … --org-N in tokens.css. */
export const ORG_TONE_COUNT = 6;

export interface OrgNode<P extends OrgChartBasePerson = OrgChartBasePerson> {
  person: P;
  parent: OrgNode<P> | null;
  children: OrgNode<P>[];
  /** Tiefe im vollständigen Baum, Wurzel = 0. */
  depth: number;
  /** Direkt Berichtende. */
  reportCount: number;
  /** Alle Berichtenden unterhalb, über alle Ebenen. */
  totalReports: number;
}

export interface OrgModel<P extends OrgChartBasePerson = OrgChartBasePerson> {
  roots: OrgNode<P>[];
  byId: Map<number, OrgNode<P>>;
  /** Abteilungs-ID → Farbstufe 1…ORG_TONE_COUNT, nach Abteilungsnamen vergeben. */
  toneByDepartment: Map<number, number>;
  departments: { id: number; name: string }[];
  maxDepth: number;
}

export function orgFullName(person: OrgChartBasePerson): string {
  return `${person.first_name} ${person.last_name}`;
}

export function orgInitials(person: OrgChartBasePerson): string {
  return `${person.first_name[0] ?? ''}${person.last_name[0] ?? ''}`.toUpperCase();
}

function compareNames(a: OrgNode, b: OrgNode): number {
  return (
    a.person.last_name.localeCompare(b.person.last_name, 'de') ||
    a.person.first_name.localeCompare(b.person.first_name, 'de') ||
    a.person.id - b.person.id
  );
}

/**
 * Baum aus `parent_id`. Kinder stehen sortiert: erst, wer selbst Berichtende
 * hat, dann die Blätter, jeweils alphabetisch. So liegen die Zweige links und
 * die Blätter bilden rechts den Stapel (siehe layoutOrg).
 */
export function buildOrgModel<P extends OrgChartBasePerson>(data: {
  people: P[];
  departments: { id: number; name: string }[];
}): OrgModel<P> {
  const byId = new Map<number, OrgNode<P>>();
  for (const person of data.people) {
    byId.set(person.id, { person, parent: null, children: [], depth: 0, reportCount: 0, totalReports: 0 });
  }
  const roots: OrgNode<P>[] = [];
  for (const node of byId.values()) {
    const parent = node.person.parent_id !== null ? byId.get(node.person.parent_id) : undefined;
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  let maxDepth = 0;
  const finish = (node: OrgNode<P>, depth: number): number => {
    node.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    node.children.sort(
      (a, b) => Number(b.children.length > 0) - Number(a.children.length > 0) || compareNames(a, b),
    );
    node.reportCount = node.children.length;
    node.totalReports = node.children.reduce((sum, child) => sum + 1 + finish(child, depth + 1), 0);
    return node.totalReports;
  };
  roots.sort(compareNames);
  for (const root of roots) finish(root, 0);

  const toneByDepartment = new Map<number, number>();
  data.departments.forEach((d, i) => toneByDepartment.set(d.id, (i % ORG_TONE_COUNT) + 1));

  return { roots, byId, toneByDepartment, departments: data.departments, maxDepth };
}

/** Farbstufe einer Person (0 = ohne Abteilung). */
export function orgToneOf(model: OrgModel, person: OrgChartBasePerson): number {
  return person.department_id !== null ? (model.toneByDepartment.get(person.department_id) ?? 0) : 0;
}

/** Vorfahren von der Wurzel bis zum direkten Vorgesetzten. */
export function orgAncestorsOf<P extends OrgChartBasePerson>(node: OrgNode<P>): OrgNode<P>[] {
  const line: OrgNode<P>[] = [];
  for (let cursor = node.parent; cursor; cursor = cursor.parent) line.unshift(cursor);
  return line;
}

export function orgIsWithin(node: OrgNode, root: OrgNode): boolean {
  for (let cursor: OrgNode | null = node; cursor; cursor = cursor.parent) {
    if (cursor === root) return true;
  }
  return false;
}

/**
 * Ausgangszustand: Wurzel und ihre direkten Berichtenden sind aufgeklappt,
 * drei Ebenen sind also sichtbar. Alles darunter holt man sich per Klick,
 * sonst wäre ein Betrieb mit 200 Personen beim Öffnen ein unlesbares Feld.
 */
export function orgDefaultExpanded(roots: OrgNode[]): Set<number> {
  const expanded = new Set<number>();
  const visit = (node: OrgNode, level: number) => {
    if (level >= 2 || node.children.length === 0) return;
    expanded.add(node.person.id);
    node.children.forEach((child) => visit(child, level + 1));
  };
  roots.forEach((root) => visit(root, 0));
  return expanded;
}

/** Zuklappen nimmt alle Ebenen darunter mit; Aufklappen zeigt nur die direkten Berichtenden. */
export function orgToggleExpanded(expanded: Set<number>, node: OrgNode): Set<number> {
  const next = new Set(expanded);
  if (!next.has(node.person.id)) {
    next.add(node.person.id);
    return next;
  }
  const collapse = (n: OrgNode) => {
    next.delete(n.person.id);
    n.children.forEach(collapse);
  };
  collapse(node);
  return next;
}

export interface OrgPlacedNode<P extends OrgChartBasePerson = OrgChartBasePerson> {
  node: OrgNode<P>;
  x: number;
  y: number;
  /** Blatt im senkrechten Stapel unter dem Vorgesetzten. */
  stacked: boolean;
}

export interface OrgPlacedEdge<P extends OrgChartBasePerson = OrgChartBasePerson> {
  from: OrgPlacedNode<P>;
  to: OrgPlacedNode<P>;
  stacked: boolean;
  /** Linie stammt nicht aus dem Feld „Vorgesetzte:r", sondern aus Team- oder Abteilungsleitung. */
  derived: boolean;
}

export interface OrgLayout<P extends OrgChartBasePerson = OrgChartBasePerson> {
  nodes: OrgPlacedNode<P>[];
  edges: OrgPlacedEdge<P>[];
  byId: Map<number, OrgPlacedNode<P>>;
  width: number;
  height: number;
}

/**
 * Ordnet die sichtbaren Karten an: jede Person mittig über ihren Berichtenden,
 * Zweige nebeneinander, viele Blätter als Stapel rechts davon. Zugeklappte
 * Personen zeigen keine Berichtenden, zählen aber mit voller Kartenbreite.
 */
export function layoutOrg<P extends OrgChartBasePerson>(
  roots: OrgNode<P>[],
  isExpanded: (node: OrgNode<P>) => boolean,
): OrgLayout<P> {
  const parts = (node: OrgNode<P>): { row: OrgNode<P>[]; stack: OrgNode<P>[] } => {
    if (!isExpanded(node)) return { row: [], stack: [] };
    const leaves = node.children.filter((c) => c.children.length === 0);
    const stack = leaves.length >= ORG_STACK_FROM ? leaves : [];
    const row = stack.length > 0 ? node.children.filter((c) => c.children.length > 0) : node.children;
    return { row, stack };
  };

  // Breiten werden für den Knoten und erneut je Geschwister abgefragt; ohne
  // Zwischenspeicher wüchse das quadratisch mit der Tiefe.
  const widths = new Map<number, number>();
  const itemWidths = (node: OrgNode<P>): number[] => {
    const { row, stack } = parts(node);
    const items = row.map(blockWidth);
    if (stack.length > 0) items.push(ORG_CARD_W + ORG_STACK_INDENT);
    return items;
  };
  const innerWidth = (items: number[]): number =>
    items.reduce((sum, w) => sum + w, 0) + ORG_H_GAP * Math.max(0, items.length - 1);
  const blockWidth = (node: OrgNode<P>): number => {
    const cached = widths.get(node.person.id);
    if (cached !== undefined) return cached;
    const width = Math.max(ORG_CARD_W, innerWidth(itemWidths(node)));
    widths.set(node.person.id, width);
    return width;
  };

  const nodes: OrgPlacedNode<P>[] = [];
  const edges: OrgPlacedEdge<P>[] = [];
  const byId = new Map<number, OrgPlacedNode<P>>();
  let height = 0;
  const rowY = (depth: number) => depth * (ORG_CARD_H + ORG_V_GAP);
  const register = (placed: OrgPlacedNode<P>) => {
    nodes.push(placed);
    byId.set(placed.node.person.id, placed);
    height = Math.max(height, placed.y + ORG_CARD_H);
  };

  const place = (node: OrgNode<P>, left: number, depth: number): OrgPlacedNode<P> => {
    const width = blockWidth(node);
    const self: OrgPlacedNode<P> = { node, x: left + (width - ORG_CARD_W) / 2, y: rowY(depth), stacked: false };
    register(self);
    const { row, stack } = parts(node);
    const items = itemWidths(node);
    let cursor = left + (width - innerWidth(items)) / 2;
    row.forEach((child, i) => {
      const placed = place(child, cursor, depth + 1);
      edges.push({ from: self, to: placed, stacked: false, derived: child.person.parent_source !== 'manager' });
      cursor += (items[i] ?? ORG_CARD_W) + ORG_H_GAP;
    });
    stack.forEach((leaf, i) => {
      const placed: OrgPlacedNode<P> = {
        node: leaf,
        x: cursor + ORG_STACK_INDENT,
        y: rowY(depth + 1) + i * (ORG_CARD_H + ORG_STACK_GAP),
        stacked: true,
      };
      register(placed);
      edges.push({ from: self, to: placed, stacked: true, derived: leaf.person.parent_source !== 'manager' });
    });
    return self;
  };

  let left = 0;
  for (const root of roots) {
    place(root, left, 0);
    left += blockWidth(root) + ORG_H_GAP * 2;
  }
  const width = roots.length > 0 ? left - ORG_H_GAP * 2 : 0;
  return { nodes, edges, byId, width: Math.max(width, ORG_CARD_W), height: Math.max(height, ORG_CARD_H) };
}

/**
 * Pfad einer Verbindungslinie mit abgerundeten Ecken. Beide Formen (Reihe und
 * Stapel) behalten je eine feste Befehlsfolge; der Browser kann den Pfad so
 * beim Umlayouten weich überblenden (CSS-Übergang auf `d`).
 */
export function orgEdgePath(edge: OrgPlacedEdge): string {
  const { from, to } = edge;
  const x0 = from.x + ORG_CARD_W / 2;
  const y0 = from.y + ORG_CARD_H;
  const busY = y0 + ORG_V_GAP / 2;
  if (!edge.stacked) {
    const x1 = to.x + ORG_CARD_W / 2;
    const dir = x1 >= x0 ? 1 : -1;
    const r = Math.min(10, Math.abs(x1 - x0) / 2);
    return [
      `M ${x0} ${y0}`,
      `L ${x0} ${busY - r}`,
      `Q ${x0} ${busY} ${x0 + dir * r} ${busY}`,
      `L ${x1 - dir * r} ${busY}`,
      `Q ${x1} ${busY} ${x1} ${busY + r}`,
      `L ${x1} ${to.y}`,
    ].join(' ');
  }
  const spineX = to.x - ORG_STACK_INDENT / 2;
  const midY = to.y + ORG_CARD_H / 2;
  const dir = spineX >= x0 ? 1 : -1;
  const r = Math.min(10, Math.abs(spineX - x0) / 2);
  return [
    `M ${x0} ${y0}`,
    `L ${x0} ${busY - r}`,
    `Q ${x0} ${busY} ${x0 + dir * r} ${busY}`,
    `L ${spineX - dir * r} ${busY}`,
    `Q ${spineX} ${busY} ${spineX} ${busY + r}`,
    `L ${spineX} ${midY - 10}`,
    `Q ${spineX} ${midY} ${spineX + 10} ${midY}`,
    `L ${to.x} ${midY}`,
  ].join(' ');
}

/** Jeder Suchbegriff muss in Name, Titel, Abteilung, Team, Standort oder Personalnummer vorkommen. */
export function orgPersonMatches(
  person: OrgChartBasePerson & { personnel_number?: string | null },
  query: string,
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return false;
  const haystack = [
    orgFullName(person),
    person.job_title,
    person.department_name,
    person.team_name,
    person.location_name,
    person.personnel_number,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}
