/**
 * Organigramm des Portals (GET /api/me/org-tree).
 *
 * Herkunft der Darstellung: Tab „Organigramm" aus
 * `apps/renderer/src/features/employees/OrgPage.tsx` der Desktop-App. Übernommen
 * sind Geometrie, Kastenaufbau, Bézier-Kanten und die Auflösung der Themefarben
 * über `getComputedStyle`. Weggelassen ist alles HR-Eigene: kein Bearbeiten der
 * Struktur, kein SVG-Export, keine Standorte — Mitarbeitende schauen hier nur.
 * Hinzugekommen sind die Team-Zeilen unter jedem Kasten, die Hervorhebung der
 * eigenen Abteilung und die Bedienung per Finger.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrgTreeNode } from '@hrmonic/shared';
import { useMyOrgTree, useMyProfile } from '../api/hooks';
import { Card, EmptyState, LoadError, Skeleton } from '../components/ui';
import { useOrgChartColors, type OrgChartColors } from '../features/org/chartColors';
import {
  TEAM_ROW_H,
  TEAM_SHELF_GAP,
  withTeamShelves,
  type OrgPlacement,
} from '../features/org/chartLayout';
import { IconFit, IconZoomIn, IconZoomOut } from '../features/org/icons';
import { clipText, initials, layoutTree, NODE_H, NODE_W, V_GAP } from '../features/org/layoutTree';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
/** Rand um das eingepasste Diagramm; oben etwas mehr für die Plakette „Ihre Abteilung". */
const FIT_PADDING = 40;
const FIT_PADDING_TOP = 28;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

interface View {
  x: number;
  y: number;
  k: number;
}

/**
 * Ausgangspunkt einer Zeigergeste. Bei einem Finger wird nur verschoben, bei
 * zweien zusätzlich gezoomt — beide Fälle rechnen gegen den Zustand, den die
 * Ansicht beim Aufsetzen des Fingers hatte.
 */
type Gesture =
  | { kind: 'pan'; px: number; py: number; ox: number; oy: number }
  | { kind: 'pinch'; distance: number; mx: number; my: number; view: View };

/**
 * Die eigene Abteilung im Baum finden.
 *
 * `MeProfile` liefert bewusst nur `department_name`, keine ID — der Abgleich
 * läuft deshalb über den Namen. Der erste Treffer gewinnt; bei zwei gleich
 * benannten Abteilungen wäre auch für den Menschen nicht entscheidbar, welche
 * gemeint ist.
 */
function findDepartmentByName(nodes: OrgTreeNode[], name: string): number | null {
  for (const node of nodes) {
    if (node.name.trim() === name) return node.id;
    const inChildren = findDepartmentByName(node.children, name);
    if (inChildren !== null) return inChildren;
  }
  return null;
}

export function OrgPage() {
  const { data, isLoading, isError, error } = useMyOrgTree();
  const { data: profile } = useMyProfile();
  const colors = useOrgChartColors();

  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);

  // Zeigergesten laufen über Refs: sie ändern sich mehrmals pro Frame und
  // dürfen deshalb kein Rendern auslösen.
  const viewRef = useRef(view);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  /** Sobald selbst gezoomt/verschoben wurde, passt die Seite nicht mehr von allein ein. */
  const adjusted = useRef(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const layout = useMemo(
    () => (data && data.tree.length > 0 ? withTeamShelves(layoutTree(data.tree)) : null),
    [data],
  );

  const ownDepartmentId = useMemo(() => {
    const name = profile?.department_name?.trim();
    if (!name || !data) return null;
    return findDepartmentByName(data.tree, name);
  }, [profile?.department_name, data]);

  /** Ansicht so setzen, dass der ganze Baum sichtbar und mittig steht. */
  const fit = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !layout) return;
    const k = clampZoom(
      Math.min(
        1.15,
        (el.clientWidth - FIT_PADDING) / layout.width,
        (el.clientHeight - FIT_PADDING) / (layout.height + FIT_PADDING_TOP),
      ),
    );
    setView({
      x: (el.clientWidth - layout.width * k) / 2,
      y: Math.max(FIT_PADDING_TOP, (el.clientHeight - layout.height * k) / 2),
      k,
    });
    adjusted.current = false;
  }, [layout]);

  useEffect(() => {
    fit();
  }, [fit]);

  // Breite der Zeichenfläche ändert sich beim Aufklappen der Seitenleiste und
  // beim Drehen des Telefons — dann neu einpassen, solange niemand selbst
  // etwas verschoben hat.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!adjusted.current) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  // Rad-Zoom um den Mauszeiger. Nativer Listener, weil React `wheel` passiv
  // anbindet und `preventDefault()` dort wirkungslos bliebe.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      adjusted.current = true;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const k = clampZoom(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [layout]);

  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    adjusted.current = true;
    setView((v) => {
      const k = clampZoom(v.k * factor);
      if (!el) return { ...v, k };
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  };

  /** Zeigerpositionen relativ zur Zeichenfläche. */
  const localPoints = () => {
    const el = canvasRef.current;
    if (!el) return [];
    const rect = el.getBoundingClientRect();
    return [...pointers.current.values()].map((p) => ({ x: p.x - rect.left, y: p.y - rect.top }));
  };

  /** Geste am aktuellen Ansichtszustand neu verankern (Finger kam dazu oder ging). */
  const rearmGesture = () => {
    const points = localPoints();
    const v = viewRef.current;
    if (points.length === 1) {
      gesture.current = { kind: 'pan', px: points[0].x, py: points[0].y, ox: v.x, oy: v.y };
    } else if (points.length >= 2) {
      const [a, b] = points;
      gesture.current = {
        kind: 'pinch',
        // Mindestabstand 1, damit die Skalierung nie durch null teilt.
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        view: v,
      };
    } else {
      gesture.current = null;
    }
  };

  const endPointer = (id: number) => {
    pointers.current.delete(id);
    rearmGesture();
    if (pointers.current.size === 0) setPanning(false);
  };

  /**
   * Beim Zeigen auf einen Kasten bleiben er selbst und seine direkten Nachbarn
   * kräftig, alles andere tritt zurück — dieselbe Lesehilfe wie in der
   * Desktop-App, nur als Menge statt als Suche über alle Kanten je Knoten.
   */
  const connectedIds = useMemo(() => {
    if (hoverId === null || !layout) return null;
    const ids = new Set<number>([hoverId]);
    for (const [from, to] of layout.edges) {
      if (from.node.id === hoverId) ids.add(to.node.id);
      if (to.node.id === hoverId) ids.add(from.node.id);
    }
    return ids;
  }, [hoverId, layout]);

  const chartLabel = layout
    ? `Organigramm mit ${layout.nodes.length} Abteilungen`
    : 'Organigramm';

  const unassignedHint =
    data && data.unassigned_count > 0
      ? data.unassigned_count === 1
        ? '1 Mitarbeiter:in ohne Abteilung'
        : `${data.unassigned_count} Mitarbeitende ohne Abteilung`
      : null;

  return (
    <>
      <header className="portal-page-header">
        <h1 className="portal-title">Organigramm</h1>
        <p className="portal-subtitle">Die Abteilungen und Teams des Unternehmens auf einen Blick.</p>
      </header>

      {isError ? (
        <LoadError error={error} />
      ) : (
        <Card
          title="Abteilungsstruktur"
          flush
          actions={
            <span className="pt-org-hint">Ziehen zum Verschieben · Mausrad oder zwei Finger zum Zoomen</span>
          }
        >
          {isLoading || !data ? (
            <ChartSkeleton />
          ) : !layout ? (
            // Ohne Abteilungen ist auch die Zeichenfläche sinnlos — dann steht
            // der Hinweis auf Nichtzugeordnete direkt unter dem Leerzustand.
            <div className="pt-card__body">
              <EmptyState
                title="Noch keine Abteilungen hinterlegt"
                hint="Sobald die Personalabteilung die Struktur des Unternehmens angelegt hat, erscheint sie hier."
              />
              {unassignedHint && (
                <p style={{ marginTop: 14, textAlign: 'center', color: 'var(--text-muted)' }}>
                  {unassignedHint}
                </p>
              )}
            </div>
          ) : (
            <>
              <div
                ref={canvasRef}
                className={`pt-org-canvas${panning ? ' pt-org-canvas--panning' : ''}`}
                onPointerDown={(e) => {
                  canvasRef.current?.setPointerCapture(e.pointerId);
                  pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                  rearmGesture();
                  setPanning(true);
                }}
                onPointerMove={(e) => {
                  if (!pointers.current.has(e.pointerId)) return;
                  pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                  const active = gesture.current;
                  if (!active) return;
                  const points = localPoints();
                  adjusted.current = true;
                  if (active.kind === 'pan' && points.length === 1) {
                    setView((v) => ({
                      ...v,
                      x: active.ox + (points[0].x - active.px),
                      y: active.oy + (points[0].y - active.py),
                    }));
                  } else if (active.kind === 'pinch' && points.length >= 2) {
                    const [a, b] = points;
                    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
                    const k = clampZoom(active.view.k * (distance / active.distance));
                    // Der Punkt unter der Fingermitte bleibt liegen; wandert die
                    // Mitte, wandert das Diagramm mit — Zoomen und Verschieben
                    // in einer Rechnung.
                    const mx = (a.x + b.x) / 2;
                    const my = (a.y + b.y) / 2;
                    setView({
                      k,
                      x: mx - ((active.mx - active.view.x) / active.view.k) * k,
                      y: my - ((active.my - active.view.y) / active.view.k) * k,
                    });
                  }
                }}
                onPointerUp={(e) => endPointer(e.pointerId)}
                onPointerCancel={(e) => endPointer(e.pointerId)}
                onLostPointerCapture={(e) => endPointer(e.pointerId)}
              >
                <svg
                  width="100%"
                  height="100%"
                  role="img"
                  aria-label={chartLabel}
                  style={{ display: 'block', fontFamily: 'var(--font-sans)' }}
                >
                  <defs>
                    <filter id="pt-org-shadow" x="-30%" y="-30%" width="160%" height="160%">
                      <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#0a1a2e" floodOpacity="0.14" />
                    </filter>
                  </defs>
                  <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
                    {layout.edges.map(([from, to], i) => {
                      const hot = hoverId !== null && (from.node.id === hoverId || to.node.id === hoverId);
                      const fromX = from.x + NODE_W / 2;
                      const fromY = from.y + NODE_H + from.shelfHeight;
                      const toX = to.x + NODE_W / 2;
                      return (
                        <path
                          key={i}
                          d={`M ${fromX} ${fromY} C ${fromX} ${fromY + V_GAP / 2}, ${toX} ${to.y - V_GAP / 2}, ${toX} ${to.y}`}
                          fill="none"
                          stroke={hot ? colors.accent : colors.edge}
                          strokeWidth={hot ? 2.5 : 1.5}
                          opacity={hoverId !== null && !hot ? 0.35 : 1}
                        />
                      );
                    })}
                    {layout.nodes.map((placement, i) => (
                      <DepartmentBox
                        key={placement.node.id}
                        placement={placement}
                        colors={colors}
                        own={placement.node.id === ownDepartmentId}
                        hovered={hoverId === placement.node.id}
                        dimmed={connectedIds !== null && !connectedIds.has(placement.node.id)}
                        index={i}
                        onHover={setHoverId}
                      />
                    ))}
                  </g>
                </svg>

                <div
                  className="pt-org-zoom"
                  // Ohne das startet der Klick auf einen Knopf zugleich eine
                  // Verschiebegeste auf der Fläche darunter.
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="pt-org-btn"
                    onClick={() => zoomBy(1 / 1.25)}
                    disabled={view.k <= MIN_ZOOM + 0.001}
                    aria-label="Verkleinern"
                    title="Verkleinern"
                  >
                    <IconZoomOut />
                  </button>
                  <span className="pt-org-zoom__value">{Math.round(view.k * 100)} %</span>
                  <button
                    type="button"
                    className="pt-org-btn"
                    onClick={() => zoomBy(1.25)}
                    disabled={view.k >= MAX_ZOOM - 0.001}
                    aria-label="Vergrößern"
                    title="Vergrößern"
                  >
                    <IconZoomIn />
                  </button>
                  <button
                    type="button"
                    className="pt-org-btn"
                    onClick={fit}
                    aria-label="Ansicht zurücksetzen"
                    title="Ansicht zurücksetzen"
                  >
                    <IconFit />
                  </button>
                </div>
              </div>

              <div className="pt-org-foot">
                {ownDepartmentId !== null ? (
                  <span className="pt-org-legend">
                    <span className="pt-org-legend__swatch" aria-hidden="true" />
                    Ihre Abteilung: {profile?.department_name}
                  </span>
                ) : (
                  <span>Ziehen zum Verschieben, Knöpfe rechts unten zum Zoomen.</span>
                )}
                {unassignedHint && <span>{unassignedHint}</span>}
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ein Abteilungskasten samt Team-Zeilen darunter.
// ---------------------------------------------------------------------------

function DepartmentBox({
  placement,
  colors,
  own,
  hovered,
  dimmed,
  index,
  onHover,
}: {
  placement: OrgPlacement;
  colors: OrgChartColors;
  own: boolean;
  hovered: boolean;
  dimmed: boolean;
  index: number;
  onHover: (id: number | null) => void;
}) {
  const { node, x, y, visibleTeams, hiddenTeams } = placement;
  const highlighted = own || hovered;

  return (
    <g
      className="pt-org-node"
      // Gestaffelter Einblendlauf wie in der Desktop-App, aber gedeckelt:
      // bei vielen Abteilungen soll die letzte nicht Sekunden später kommen.
      style={{ animationDelay: `${Math.min(index, 18) * 28}ms` }}
      opacity={dimmed ? 0.45 : 1}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
    >
      <title>
        {`${node.name} — ${node.head_name ?? 'Leitung offen'}; ${node.total_employee_count} Mitarbeitende` +
          ` (davon ${node.employee_count} direkt)` +
          (node.teams.length > 0 ? `, ${node.teams.length} Teams` : '')}
      </title>

      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={14}
        fill={own ? colors.ownSurface : colors.surface}
        stroke={highlighted ? colors.accent : colors.border}
        strokeWidth={highlighted ? 2 : 1}
        filter="url(#pt-org-shadow)"
      />
      <rect x={x} y={y} width={5} height={NODE_H} rx={2.5} fill={colors.accent} />

      <circle cx={x + 34} cy={y + NODE_H / 2} r={17} fill={colors.accentSoft} />
      <text
        x={x + 34}
        y={y + NODE_H / 2 + 4.5}
        fontSize={12}
        fontWeight={700}
        fill={colors.accentText}
        textAnchor="middle"
      >
        {initials(node.head_name)}
      </text>

      <text x={x + 62} y={y + 28} fontSize={13.5} fontWeight={700} fill={colors.text}>
        {clipText(node.name, 19)}
      </text>
      <text x={x + 62} y={y + 47} fontSize={11} fill={colors.muted}>
        {node.head_name ? clipText(node.head_name, 22) : 'Leitung offen'}
      </text>
      <text x={x + 62} y={y + 66} fontSize={11} fill={colors.muted}>
        {node.total_employee_count === 1 ? '1 Mitarbeiter:in' : `${node.total_employee_count} Mitarbeitende`}
      </text>

      {own && (
        <>
          <rect
            x={x + NODE_W - 98}
            y={y - 10}
            width={88}
            height={20}
            rx={10}
            fill={colors.accentSoft}
            stroke={colors.accent}
            strokeWidth={1}
          />
          <text
            x={x + NODE_W - 54}
            y={y + 4}
            fontSize={10}
            fontWeight={700}
            fill={colors.accentText}
            textAnchor="middle"
          >
            Ihre Abteilung
          </text>
        </>
      )}

      {visibleTeams.map((team, i) => {
        const rowY = y + NODE_H + TEAM_SHELF_GAP + i * TEAM_ROW_H;
        return (
          <g key={team.id}>
            <rect
              x={x + 18}
              y={rowY}
              width={NODE_W - 36}
              height={TEAM_ROW_H - 3}
              rx={7}
              fill={colors.shelf}
              stroke={colors.border}
              strokeWidth={0.75}
            />
            <text x={x + 27} y={rowY + 10} fontSize={10} fill={colors.text}>
              {clipText(team.name, 22)}
            </text>
            <text x={x + NODE_W - 27} y={rowY + 10} fontSize={10} fill={colors.muted} textAnchor="end">
              {team.employee_count}
            </text>
          </g>
        );
      })}
      {hiddenTeams > 0 && (
        <text
          x={x + NODE_W / 2}
          y={y + NODE_H + TEAM_SHELF_GAP + visibleTeams.length * TEAM_ROW_H + 10}
          fontSize={10}
          fill={colors.muted}
          textAnchor="middle"
        >
          {`+ ${hiddenTeams} weitere Teams`}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Ladezustand: angedeutete Kästen statt Drehrad.
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  return (
    <div className="pt-org-canvas pt-org-canvas--loading" aria-hidden="true">
      <div className="pt-org-skeleton">
        <Skeleton width={200} height={72} style={{ borderRadius: 14 }} />
        <div className="pt-org-skeleton__row">
          <Skeleton width={160} height={64} style={{ borderRadius: 14 }} />
          <Skeleton width={160} height={64} style={{ borderRadius: 14 }} />
          <Skeleton width={160} height={64} style={{ borderRadius: 14 }} />
        </div>
      </div>
    </div>
  );
}
