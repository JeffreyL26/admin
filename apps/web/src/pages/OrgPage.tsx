/**
 * Organigramm des Portals (GET /api/me/org-chart): jede aktive Kollegin und
 * jeder Kollege als Karte entlang der Berichtslinie, die eigene Karte ist
 * markiert und beim Öffnen zentriert.
 *
 * Herkunft: `apps/renderer/src/features/employees/OrgChart.tsx` der
 * Desktop-App. Baum, Layout und Suche kommen aus `@ohrganize/shared`
 * (orgChart.ts), damit beide Clients dasselbe Bild zeichnen. Weggelassen
 * ist alles HR-Eigene: keine Kontaktdaten, keine Personalakte, kein
 * SVG-Export. Hinzugekommen ist die Bedienung per Finger (ein Finger
 * verschiebt, zwei Finger zoomen) und die Detailspalte als Bogen von unten
 * auf schmalen Bildschirmen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ORG_CARD_H as CARD_H,
  ORG_CARD_W as CARD_W,
  buildOrgModel,
  layoutOrg,
  orgAncestorsOf,
  orgDefaultExpanded,
  orgEdgePath,
  orgFullName,
  orgInitials,
  orgIsWithin,
  orgPersonMatches,
  orgToggleExpanded,
  orgToneOf,
  type MeOrgChartPerson,
  type MeOrgChartResponse,
  type OrgModel,
  type OrgNode,
} from '@ohrganize/shared';
import { API_BASE } from '../api/client';
import { useMyOrgChart } from '../api/hooks';
import { Card, EmptyState, LoadError, Skeleton } from '../components/ui';
import { IconClose } from '../components/icons';
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconFit,
  IconFocus,
  IconLocate,
  IconPin,
  IconSearch,
  IconZoomIn,
  IconZoomOut,
} from '../features/org/icons';

type Person = MeOrgChartPerson;
type Node = OrgNode<Person>;
type Model = OrgModel<Person>;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const FIT_PAD = 40;
const PANEL_W = 300;
const MAX_RESULTS = 8;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

interface View {
  x: number;
  y: number;
  k: number;
}

/**
 * Ausgangspunkt einer Zeigergeste. Bei einem Finger wird nur verschoben, bei
 * zweien zusätzlich gezoomt; beide Fälle rechnen gegen den Zustand, den die
 * Ansicht beim Aufsetzen des Fingers hatte.
 */
type Gesture =
  | { kind: 'pan'; px: number; py: number; ox: number; oy: number; moved: boolean }
  | { kind: 'pinch'; distance: number; mx: number; my: number; view: View };

/** Abteilung, „Ohne Abteilung“, die eigene Karte („Ich“) oder kein Filter. */
type DepartmentFilter = number | 'none' | 'self' | null;

function toneStyle(tone: number): CSSProperties {
  return { '--orgc-accent': tone > 0 ? `var(--org-${tone})` : 'var(--gray-400)' } as CSSProperties;
}

/** Schmale Bildschirme: Die Detailspalte liegt dann unten statt rechts. */
function panelBeside(el: HTMLElement): boolean {
  return el.clientWidth >= 720;
}

export function OrgPage() {
  const { data, isLoading, isError, error } = useMyOrgChart();
  return (
    <>
      <header className="portal-page-header">
        <h1 className="portal-title">Organigramm</h1>
        <p className="portal-subtitle">So sind Sie aufgestellt.</p>
      </header>
      {isError ? (
        <LoadError error={error} />
      ) : isLoading || !data ? (
        <Card title="Organigramm" flush>
          <ChartSkeleton />
        </Card>
      ) : data.people.length === 0 ? (
        <Card title="Organigramm">
          <EmptyState
            title="Noch sind keine Einträge im System."
            hint="Sobald die Personalabteilung Mitarbeitende angelegt hat, erscheint hier das Organigramm."
          />
        </Card>
      ) : (
        <OrgChartView data={data} />
      )}
    </>
  );
}

function OrgChartView({ data }: { data: MeOrgChartResponse }) {
  const model = useMemo(() => buildOrgModel(data), [data]);
  const self = model.byId.get(data.self_id) ?? null;

  const [focusId, setFocusId] = useState<number | null>(null);
  const focusNode = focusId !== null ? (model.byId.get(focusId) ?? null) : null;
  const roots = useMemo(() => (focusNode ? [focusNode] : model.roots), [focusNode, model]);
  // Beim Öffnen sind die Ebenen bis zur eigenen Karte aufgeklappt.
  const [expanded, setExpanded] = useState(() => {
    const set = orgDefaultExpanded(model.roots);
    if (self) for (const a of orgAncestorsOf(self)) set.add(a.person.id);
    return set;
  });
  const layout = useMemo(() => layoutOrg(roots, (n) => expanded.has(n.person.id)), [roots, expanded]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selectedNode = selectedId !== null ? (model.byId.get(selectedId) ?? null) : null;
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilter>(null);

  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [smooth, setSmooth] = useState(false);
  const [panning, setPanning] = useState(false);
  const [pending, setPending] = useState<{ center?: number; fit?: boolean; ensure?: number; fitIds?: number[] } | null>(
    null,
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const touched = useRef(false);

  // ------------------------------------------------------------ Ansicht --
  const fit = useCallback(
    (animate: boolean, readable = false) => {
      const el = canvasRef.current;
      if (!el) return;
      const kFit = clampZoom(
        Math.min(1, (el.clientWidth - FIT_PAD) / layout.width, (el.clientHeight - FIT_PAD) / layout.height),
      );
      const k = readable ? clampZoom(Math.max(kFit, 0.65)) : kFit;
      setSmooth(animate);
      const root = layout.nodes[0];
      if (k > kFit + 1e-6 && root) {
        setView({ k, x: el.clientWidth / 2 - (root.x + CARD_W / 2) * k, y: 24 });
        return;
      }
      setView({
        k,
        x: (el.clientWidth - layout.width * k) / 2,
        y: Math.max(24, (el.clientHeight - layout.height * k) / 2),
      });
    },
    [layout],
  );
  const fitRef = useRef(fit);
  fitRef.current = fit;

  /**
   * Passt die Ansicht auf eine Kartenmenge ein (Abteilungsfilter, „Ich“): Der
   * umschließende Kasten kommt mittig ins Bild, so groß wie möglich, nie über
   * 100 %. Eine offene Detailspalte (rechts oder unten) bleibt frei.
   */
  const fitTo = useCallback(
    (ids: ReadonlySet<number>, panelOpen: boolean) => {
      const el = canvasRef.current;
      if (!el) return;
      const placed = layout.nodes.filter((n) => ids.has(n.node.person.id));
      if (placed.length === 0) return;
      const minX = Math.min(...placed.map((p) => p.x));
      const maxX = Math.max(...placed.map((p) => p.x + CARD_W));
      const minY = Math.min(...placed.map((p) => p.y));
      const maxY = Math.max(...placed.map((p) => p.y + CARD_H));
      const boxW = maxX - minX;
      const boxH = maxY - minY;
      const beside = panelOpen && panelBeside(el);
      const width = el.clientWidth - (beside ? PANEL_W + 20 : 0);
      const height = el.clientHeight - (panelOpen && !beside ? el.clientHeight * 0.45 : 0);
      const k = clampZoom(Math.min(1, (width - FIT_PAD) / boxW, (height - FIT_PAD) / boxH));
      setSmooth(true);
      setView({ k, x: width / 2 - (minX + boxW / 2) * k, y: height / 2 - (minY + boxH / 2) * k });
    },
    [layout],
  );

  const centerOn = useCallback(
    (id: number, panelOpen: boolean) => {
      const el = canvasRef.current;
      const placed = layout.byId.get(id);
      if (!el || !placed) return;
      setSmooth(true);
      setView((v) => {
        const k = v.k < 0.7 ? 0.85 : v.k;
        const beside = panelOpen && panelBeside(el);
        const width = el.clientWidth - (beside ? PANEL_W + 20 : 0);
        const height = el.clientHeight - (panelOpen && !beside ? el.clientHeight * 0.45 : 0);
        return { k, x: width / 2 - (placed.x + CARD_W / 2) * k, y: height / 2 - (placed.y + CARD_H / 2) * k };
      });
    },
    [layout],
  );

  const ensureVisible = useCallback(
    (id: number, panelOpen: boolean) => {
      const el = canvasRef.current;
      const placed = layout.byId.get(id);
      if (!el || !placed) return;
      setSmooth(true);
      setView((v) => {
        const margin = 20;
        const beside = panelOpen && panelBeside(el);
        const left = placed.x * v.k + v.x;
        const top = placed.y * v.k + v.y;
        const right = left + CARD_W * v.k;
        const bottom = top + CARD_H * v.k;
        const maxX = el.clientWidth - (beside ? PANEL_W + 20 : 0) - margin;
        const maxY = el.clientHeight - (panelOpen && !beside ? el.clientHeight * 0.45 : 0) - margin;
        let dx = 0;
        let dy = 0;
        if (left < margin) dx = margin - left;
        else if (right > maxX) dx = maxX - right;
        if (top < margin) dy = margin - top;
        else if (bottom > maxY) dy = maxY - bottom;
        return dx === 0 && dy === 0 ? v : { ...v, x: v.x + dx, y: v.y + dy };
      });
    },
    [layout],
  );

  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    if (!el) return;
    touched.current = true;
    setSmooth(true);
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => {
      const k = clampZoom(v.k * factor);
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  };

  // Erstes Bild: die eigene Karte in der Mitte, sonst die Spitze.
  useEffect(() => {
    if (self) {
      fitRef.current(false, true);
      setPending({ center: self.person.id });
    } else {
      fitRef.current(false, true);
    }
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!touched.current) fitRef.current(false, true);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      setSmooth(false);
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const k = clampZoom(v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (pending.fit) fit(true, true);
    if (pending.fitIds) fitTo(new Set(pending.fitIds), selectedId !== null);
    if (pending.center !== undefined && layout.byId.has(pending.center)) centerOn(pending.center, selectedId !== null);
    if (pending.ensure !== undefined) ensureVisible(pending.ensure, selectedId !== null);
    setPending(null);
  }, [pending, layout, fit, fitTo, centerOn, ensureVisible, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) setSearchOpen(false);
      else if (selectedId !== null) setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchOpen, selectedId]);

  // ------------------------------------------------------------ Gesten --
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
      const p = points[0]!;
      gesture.current = { kind: 'pan', px: p.x, py: p.y, ox: v.x, oy: v.y, moved: false };
    } else if (points.length >= 2) {
      const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current = {
        kind: 'pinch',
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
    const active = gesture.current;
    if (active && (active.kind === 'pinch' || active.moved)) suppressClick.current = true;
    pointers.current.delete(id);
    rearmGesture();
    if (pointers.current.size === 0) setPanning(false);
  };

  // ------------------------------------------------------------ Aktionen --
  const reveal = useCallback(
    (id: number) => {
      const node = model.byId.get(id);
      if (!node) return;
      if (focusNode && !orgIsWithin(node, focusNode)) setFocusId(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const ancestor of orgAncestorsOf(node)) next.add(ancestor.person.id);
        return next;
      });
      setSelectedId(id);
      setSearchOpen(false);
      setQuery('');
      touched.current = true;
      setPending({ center: id });
    },
    [model, focusNode],
  );

  const focusOn = useCallback(
    (id: number | null) => {
      setFocusId(id);
      if (id !== null) {
        const node = model.byId.get(id);
        if (node) setExpanded((prev) => new Set([...prev, ...orgDefaultExpanded([node])]));
      }
      touched.current = false;
      setPending({ fit: true });
    },
    [model],
  );

  const toggle = useCallback(
    (id: number) => {
      const node = model.byId.get(id);
      if (node) setExpanded((prev) => orgToggleExpanded(prev, node));
    },
    [model],
  );

  const select = useCallback((id: number) => {
    setSelectedId(id);
    setSearchOpen(false);
    setPending({ ensure: id });
  }, []);

  /**
   * Filter setzen: alle anderen dimmen, die Betroffenen aufklappen (ein
   * zugeklappter Zweig zeigte sie sonst gar nicht) und die Ansicht auf genau
   * diese Karten einpassen — bei „Ich“ auf die eigene. Ohne Filter wieder alles.
   */
  const applyFilter = useCallback(
    (key: DepartmentFilter) => {
      setDepartmentFilter(key);
      if (key === null) {
        touched.current = false;
        setPending({ fit: true });
        return;
      }
      const members =
        key === 'self'
          ? data.people.filter((p) => p.id === data.self_id)
          : data.people.filter((p) => (key === 'none' ? p.department_id === null : p.department_id === key));
      const nodes = members.map((p) => model.byId.get(p.id)).filter((n): n is Node => n !== undefined);
      if (focusNode && nodes.some((n) => !orgIsWithin(n, focusNode))) setFocusId(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const node of nodes) for (const ancestor of orgAncestorsOf(node)) next.add(ancestor.person.id);
        return next;
      });
      touched.current = true;
      setPending({ fitIds: members.map((p) => p.id) });
    },
    [data, model, focusNode],
  );

  // ---------------------------------------------------------- Ableitungen --
  const hoverNode = hoverId !== null ? (model.byId.get(hoverId) ?? null) : null;
  const activeNode = hoverNode ?? selectedNode;
  const pathIds = useMemo(() => {
    const ids = new Set<number>();
    if (activeNode) {
      ids.add(activeNode.person.id);
      for (const ancestor of orgAncestorsOf(activeNode)) ids.add(ancestor.person.id);
    }
    return ids;
  }, [activeNode]);

  const trimmed = query.trim();
  const hits = useMemo(
    () => (trimmed ? data.people.filter((p) => orgPersonMatches(p, trimmed)) : []),
    [data, trimmed],
  );
  const hitIds = useMemo(() => new Set(hits.map((p) => p.id)), [hits]);

  const legend = useMemo(() => {
    const counts = new Map<number | null, number>();
    for (const p of data.people) counts.set(p.department_id, (counts.get(p.department_id) ?? 0) + 1);
    const items = model.departments
      .filter((d) => counts.has(d.id))
      .map((d) => ({ key: d.id as number | 'none', name: d.name, count: counts.get(d.id) ?? 0, tone: model.toneByDepartment.get(d.id) ?? 0 }));
    if (counts.has(null)) items.push({ key: 'none', name: 'Ohne Abteilung', count: counts.get(null) ?? 0, tone: 0 });
    return items;
  }, [data, model]);

  const isDimmed = (person: Person): boolean => {
    if (trimmed && !hitIds.has(person.id)) return true;
    if (departmentFilter === null) return false;
    if (departmentFilter === 'self') return person.id !== data.self_id;
    return departmentFilter === 'none' ? person.department_id !== null : person.department_id !== departmentFilter;
  };

  const crumbs = focusNode ? [...orgAncestorsOf(focusNode), focusNode] : [];

  return (
    <Card title="Organigramm nach Berichtslinie" flush>
      <div className="pt-orgc">
        <div className="pt-orgc__toolbar">
          <div className="pt-orgc__search">
            <span className="pt-orgc__search-icon">
              <IconSearch />
            </span>
            <input
              className="pt-input"
              type="search"
              placeholder="Name, Titel oder Abteilung"
              aria-label="Im Organigramm suchen"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits[0]) reveal(hits[0].id);
              }}
            />
            {searchOpen && trimmed && (
              <div className="pt-orgc__results" role="listbox" aria-label="Suchtreffer">
                {hits.length === 0 && <div className="pt-orgc__result-empty">Keine Treffer</div>}
                {hits.slice(0, MAX_RESULTS).map((p) => (
                  <button key={p.id} type="button" role="option" aria-selected={false} className="pt-orgc__result" onClick={() => reveal(p.id)}>
                    <PersonAvatar person={p} size={28} />
                    <span style={{ minWidth: 0 }}>
                      <span className="pt-orgc__result-name">{orgFullName(p)}</span>
                      <span className="pt-orgc__result-sub">{[p.job_title, p.department_name].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                ))}
                {hits.length > MAX_RESULTS && (
                  <div className="pt-orgc__result-empty">{hits.length - MAX_RESULTS} weitere Treffer, Suche eingrenzen</div>
                )}
              </div>
            )}
          </div>
          <div className="pt-orgc__legend" aria-label="Filter">
            {self && (
              <button
                type="button"
                className={`pt-orgc__chip pt-orgc__chip--self${departmentFilter === 'self' ? ' is-active' : ''}`}
                aria-pressed={departmentFilter === 'self'}
                onClick={() => applyFilter(departmentFilter === 'self' ? null : 'self')}
              >
                <IconLocate />
                Ich
              </button>
            )}
            {legend.map((item) => {
              const active = departmentFilter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`pt-orgc__chip${active ? ' is-active' : ''}`}
                  style={toneStyle(item.tone)}
                  aria-pressed={active}
                  onClick={() => applyFilter(active ? null : item.key)}
                >
                  <span className="pt-orgc-dot" aria-hidden="true" />
                  {item.name}
                  <span className="pt-orgc__chip-count">{item.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="pt-orgc__stage">
          <div
            ref={canvasRef}
            className={`pt-orgc__canvas${panning ? ' is-panning' : ''}`}
            onPointerDown={(e) => {
              setSearchOpen(false);
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              rearmGesture();
            }}
            onPointerMove={(e) => {
              if (!pointers.current.has(e.pointerId)) return;
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              const active = gesture.current;
              if (!active) return;
              const points = localPoints();
              if (active.kind === 'pan' && points.length === 1) {
                const p = points[0]!;
                const dx = p.x - active.px;
                const dy = p.y - active.py;
                if (!active.moved) {
                  if (Math.hypot(dx, dy) < 4) return;
                  // Erst ab hier ist es ein Ziehen: Die Zeigererfassung würde
                  // sonst jeden einfachen Tipp auf eine Karte auf die Fläche umlenken.
                  active.moved = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setPanning(true);
                  setSmooth(false);
                  touched.current = true;
                }
                setView((v) => ({ ...v, x: active.ox + dx, y: active.oy + dy }));
              } else if (active.kind === 'pinch' && points.length >= 2) {
                const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
                touched.current = true;
                setSmooth(false);
                const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
                const k = clampZoom(active.view.k * (distance / active.distance));
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
            onClick={(e) => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            <div
              className={`pt-orgc__world${smooth ? ' is-smooth' : ''}`}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
            >
              <svg className="pt-orgc__edges" width={layout.width} height={layout.height} aria-hidden="true">
                {layout.edges.map((edge) => {
                  const fromId = edge.from.node.person.id;
                  const toId = edge.to.node.person.id;
                  const hot = pathIds.has(fromId) && pathIds.has(toId);
                  const faint = hoverNode !== null && !hot;
                  const d = orgEdgePath(edge);
                  return (
                    <path
                      key={`${fromId}-${toId}`}
                      className={`pt-orgc__edge${edge.derived ? ' is-derived' : ''}${hot ? ' is-hot' : ''}${faint ? ' is-faint' : ''}`}
                      d={d}
                      style={{ d: `path("${d}")` } as CSSProperties}
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((placed) => {
                const id = placed.node.person.id;
                return (
                  <PersonCard
                    key={id}
                    node={placed.node}
                    x={placed.x}
                    y={placed.y}
                    tone={orgToneOf(model, placed.node.person)}
                    self={id === data.self_id}
                    selected={selectedId === id}
                    onPath={pathIds.has(id) && activeNode !== null && activeNode.person.id !== id}
                    hit={hitIds.has(id)}
                    dim={isDimmed(placed.node.person)}
                    open={expanded.has(id)}
                    onSelect={(pid) => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      select(pid);
                    }}
                    onToggle={toggle}
                    onFocus={focusOn}
                    onKeyboardFocus={(pid) => setPending({ ensure: pid })}
                    onHover={setHoverId}
                  />
                );
              })}
            </div>

            {crumbs.length > 0 && (
              <nav className="pt-orgc__overlay pt-orgc__crumbs" aria-label="Fokus" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className="pt-orgc__crumb" onClick={() => focusOn(null)}>
                  Alle
                </button>
                {crumbs.map((node, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <span key={node.person.id} className="pt-orgc__crumb-wrap">
                      <span className="pt-orgc__crumb-sep">
                        <IconChevronRight />
                      </span>
                      <button
                        type="button"
                        className={`pt-orgc__crumb${last ? ' is-current' : ''}`}
                        aria-current={last ? 'location' : undefined}
                        onClick={() => !last && focusOn(node.person.id)}
                      >
                        {orgFullName(node.person)}
                      </button>
                    </span>
                  );
                })}
              </nav>
            )}

            <div className="pt-orgc__overlay pt-org-zoom" onPointerDown={(e) => e.stopPropagation()}>
              <button type="button" className="pt-org-btn" onClick={() => zoomBy(1 / 1.25)} disabled={view.k <= MIN_ZOOM + 0.001} aria-label="Verkleinern">
                <IconZoomOut />
              </button>
              <span className="pt-org-zoom__value">{Math.round(view.k * 100)} %</span>
              <button type="button" className="pt-org-btn" onClick={() => zoomBy(1.25)} disabled={view.k >= MAX_ZOOM - 0.001} aria-label="Vergrößern">
                <IconZoomIn />
              </button>
              <button
                type="button"
                className="pt-org-btn"
                onClick={() => {
                  touched.current = false;
                  fit(true);
                }}
                aria-label="Alles einpassen"
              >
                <IconFit />
              </button>
              {self && (
                <button type="button" className="pt-org-btn" onClick={() => reveal(self.person.id)} aria-label="Zu meiner Karte">
                  <IconLocate />
                </button>
              )}
            </div>
          </div>

          {selectedNode && (
            <PersonPanel
              node={selectedNode}
              model={model}
              selfId={data.self_id}
              onClose={() => setSelectedId(null)}
              onSelect={reveal}
              onFocus={focusOn}
            />
          )}
        </div>

        <div className="pt-org-foot">
          <span>
            {model.byId.size} Kolleg:innen · {legend.filter((l) => l.key !== 'none').length} Abteilungen · {model.maxDepth + 1} Ebenen
          </span>
          <span className="pt-org-hint">Ziehen verschiebt · Mausrad oder zwei Finger zoomen · Doppeltipp fokussiert</span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

interface PersonCardProps {
  node: Node;
  x: number;
  y: number;
  tone: number;
  self: boolean;
  selected: boolean;
  onPath: boolean;
  hit: boolean;
  dim: boolean;
  open: boolean;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
  onFocus: (id: number) => void;
  onKeyboardFocus: (id: number) => void;
  onHover: (id: number | null) => void;
}

function PersonCard({
  node, x, y, tone, self, selected, onPath, hit, dim, open, onSelect, onToggle, onFocus, onKeyboardFocus, onHover,
}: PersonCardProps) {
  const { person } = node;
  const className = [
    'pt-orgc-card',
    self && 'is-self',
    selected && 'is-selected',
    onPath && 'is-path',
    hit && 'is-hit',
    dim && 'is-dim',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-label={`${orgFullName(person)}${person.job_title ? `, ${person.job_title}` : ''}${self ? ' (Sie)' : ''}`}
      aria-pressed={selected}
      style={{ left: x, top: y, width: CARD_W, height: CARD_H, ...toneStyle(tone) }}
      // Kein Fokus per Zeiger: Der Browser scrollte sonst beim Tipp jede
      // teilweise verdeckte Karte ins Bild und verschöbe die Fläche unter dem
      // eigenen Transform weg. Tastaturfokus (Tab) bleibt möglich.
      onMouseDown={(e) => e.preventDefault()}
      onFocus={() => onKeyboardFocus(person.id)}
      onClick={() => onSelect(person.id)}
      onDoubleClick={(e) => {
        e.preventDefault();
        if (node.children.length > 0) onFocus(person.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(person.id);
        }
      }}
      onMouseEnter={() => onHover(person.id)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="pt-orgc-card__accent" aria-hidden="true" />
      {self && <span className="pt-orgc-card__me">Sie</span>}
      <div className="pt-orgc-card__body">
        <PersonAvatar person={person} size={46} />
        <div className="pt-orgc-card__text">
          <div className="pt-orgc-card__name">{orgFullName(person)}</div>
          <div className="pt-orgc-card__title">{person.job_title ?? ' '}</div>
          <div className="pt-orgc-card__dept">
            <span className="pt-orgc-dot" aria-hidden="true" />
            <span className="pt-orgc-card__dept-text">
              {[person.department_name ?? 'Ohne Abteilung', person.team_name].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
      </div>
      <div className="pt-orgc-card__foot">
        <span className="pt-orgc-card__loc">
          {person.location_name ? (
            <>
              <IconPin /> {person.location_name}
            </>
          ) : (
            <span className="pt-orgc-card__loc--none">Kein Standort</span>
          )}
        </span>
        {node.reportCount > 0 && (
          <button
            type="button"
            className={`pt-orgc-card__chip${open ? ' is-open' : ''}`}
            aria-expanded={open}
            aria-label={open ? `Berichtende zuklappen (${node.reportCount})` : `Berichtende aufklappen (${node.reportCount})`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(person.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {open ? <IconChevronUp /> : <IconChevronDown />}
            {node.reportCount}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Foto oder Initialen. Das Bild lädt direkt über den signierten Link (60 s
 * gültig, siehe core/files.ts); scheitert der Abruf, bleiben die Initialen.
 */
function PersonAvatar({ person, size }: { person: Person; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = person.photo_url && !failed ? `${API_BASE}${person.photo_url}` : null;
  return (
    <span className="pt-orgc-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : orgInitials(person)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detailspalte
// ---------------------------------------------------------------------------

function PersonPanel({
  node,
  model,
  selfId,
  onClose,
  onSelect,
  onFocus,
}: {
  node: Node;
  model: Model;
  selfId: number;
  onClose: () => void;
  onSelect: (id: number) => void;
  onFocus: (id: number) => void;
}) {
  const { person } = node;
  const parent = node.parent;
  const source = person.parent_source;
  return (
    <aside className="pt-orgc__panel" aria-label={`Details zu ${orgFullName(person)}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="pt-orgc__panel-head">
        <PersonAvatar person={person} size={52} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pt-orgc__panel-name">
            {orgFullName(person)}
            {person.id === selfId && <span className="pt-orgc__panel-me">Sie</span>}
          </div>
          <div className="pt-orgc__panel-title">{person.job_title ?? '—'}</div>
          <div className="pt-orgc__panel-tags">
            {person.department_name && (
              <span className="pt-orgc__dept-badge" style={toneStyle(orgToneOf(model, person))}>
                <span className="pt-orgc-dot" aria-hidden="true" />
                {person.department_name}
              </span>
            )}
            {person.team_name && <span className="pt-chip pt-chip--neutral">Team {person.team_name}</span>}
          </div>
        </div>
        <button type="button" className="pt-org-btn" aria-label="Details schließen" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="pt-orgc__panel-body">
        <section>
          <div className="pt-orgc__section-title">Standort</div>
          <div className="pt-orgc__fact">
            <IconPin />
            <span>{person.location_name ?? 'Kein Standort hinterlegt'}</span>
          </div>
        </section>

        <section>
          <div className="pt-orgc__section-title">Berichtet an</div>
          {parent ? (
            <>
              <PersonRow person={parent.person} onClick={() => onSelect(parent.person.id)} />
              {source && source !== 'manager' && (
                <div className="pt-orgc__derived">
                  Abgeleitet aus der {source === 'team_lead' ? 'Teamleitung' : 'Abteilungsleitung'}; es ist keine
                  direkte Führungskraft hinterlegt.
                </div>
              )}
            </>
          ) : (
            <div className="pt-orgc__muted">Spitze der Berichtslinie.</div>
          )}
        </section>

        <section>
          <div className="pt-orgc__section-title">Direkt Berichtende · {node.reportCount}</div>
          {node.children.length === 0 ? (
            <div className="pt-orgc__muted">Keine direkt Berichtenden.</div>
          ) : (
            <div className="stack" style={{ gap: 2 }}>
              {node.children.map((child) => (
                <PersonRow
                  key={child.person.id}
                  person={child.person}
                  sub={child.reportCount > 0 ? `${child.reportCount} Berichtende` : undefined}
                  onClick={() => onSelect(child.person.id)}
                />
              ))}
            </div>
          )}
          {node.totalReports > node.reportCount && (
            <div className="pt-orgc__muted" style={{ marginTop: 8 }}>
              {node.totalReports} Personen insgesamt unterhalb.
            </div>
          )}
        </section>
      </div>

      {node.children.length > 0 && (
        <div className="pt-orgc__panel-foot">
          <button type="button" className="pt-btn pt-btn--secondary pt-btn--sm" onClick={() => onFocus(person.id)}>
            <IconFocus /> Bereich fokussieren
          </button>
        </div>
      )}
    </aside>
  );
}

function PersonRow({ person, sub, onClick }: { person: Person; sub?: string; onClick: () => void }) {
  return (
    <button type="button" className="pt-orgc__person-row" onClick={onClick}>
      <PersonAvatar person={person} size={30} />
      <span style={{ minWidth: 0 }}>
        <span className="pt-orgc__person-row-name">{orgFullName(person)}</span>
        <span className="pt-orgc__person-row-sub">{[person.job_title, sub].filter(Boolean).join(' · ') || ' '}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ladezustand: angedeutete Karten statt Drehrad.
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  return (
    <div className="pt-orgc__canvas pt-orgc__canvas--loading" aria-hidden="true">
      <div className="pt-org-skeleton">
        <Skeleton width={220} height={100} style={{ borderRadius: 14 }} />
        <div className="pt-org-skeleton__row">
          <Skeleton width={200} height={100} style={{ borderRadius: 14 }} />
          <Skeleton width={200} height={100} style={{ borderRadius: 14 }} />
          <Skeleton width={200} height={100} style={{ borderRadius: 14 }} />
        </div>
      </div>
    </div>
  );
}
