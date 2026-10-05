import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, ChevronDown, ChevronRight, ChevronUp, Download, Focus, FoldVertical, Hash, LocateFixed,
  Mail, MapPin, Maximize2, Network, Phone, Search, SquareArrowOutUpRight, UnfoldVertical, Users, X,
  ZoomIn, ZoomOut,
} from 'lucide-react';
import {
  EMPLOYEE_TYPE_LABELS,
  PHOTO_THUMB_EDGE,
  formatDate,
  formatSeniority,
  type OrgChartPerson,
  type OrgChartResponse,
} from '@ohrganize/shared';
import { Badge, Card, EmptyState, Spinner } from '../../components/ui';
import { Tooltip } from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
import { useOrgChart, useOrgChartOriginals, usePhotoUrl } from './api';
import { avatarFileId, useAvatarPhoto } from './avatarPhoto';
import { TYPE_TONES } from './EmployeeListPage';
import {
  ORG_CARD_H as CARD_H,
  ORG_CARD_W as CARD_W,
  ORG_TONE_COUNT as TONE_COUNT,
  orgAncestorsOf as ancestorsOf,
  buildOrgModel,
  orgDefaultExpanded as defaultExpanded,
  orgEdgePath as edgePath,
  orgFullName as fullName,
  orgInitials as initialsOf,
  orgIsWithin as isWithin,
  layoutOrg,
  orgPersonMatches as personMatches,
  orgToggleExpanded,
  type OrgLayout as OrgLayoutOf,
  type OrgModel as OrgModelOf,
  type OrgNode as OrgNodeOf,
} from '@ohrganize/shared';

type OrgNode = OrgNodeOf<OrgChartPerson>;
type OrgModel = OrgModelOf<OrgChartPerson>;
type OrgLayout = OrgLayoutOf<OrgChartPerson>;

/**
 * Personen-Organigramm nach Berichtslinie (GET /api/org/chart).
 *
 * Aufbau wie in gängigen HR-Suiten: je Person eine Karte mit Foto, Titel,
 * Abteilung und Standort, darunter die Berichtenden zum Auf- und Zuklappen.
 * Die Karten sind HTML auf einer verschieb- und zoombaren Fläche (CSS-
 * Transform), die Verbindungslinien ein SVG darunter. HTML statt SVG-Text,
 * weil Fotos, Textkürzung, Tastaturfokus und die Themes damit ohne Umwege
 * funktionieren; der SVG-Export zeichnet die Karten getrennt nach (buildSvg).
 *
 * Bedienung: Suche springt zur Person und wählt sie aus, Klick öffnet die
 * Detailspalte, Doppelklick oder „Bereich fokussieren" zeigt nur den Teilbaum
 * (Brotkrumen führen zurück), Überfahren hebt die Linie bis zur Spitze hervor.
 * Ein Klick auf eine Abteilung in der Legende blendet alle anderen ab.
 */

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const FIT_PAD = 48;
const PANEL_W = 320;
const MAX_RESULTS = 8;

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Kantenlänge des Kartenfotos in CSS-Pixeln, wie `.orgc-card__avatar` (components.css). */
const CARD_AVATAR_PX = 46;

interface View {
  x: number;
  y: number;
  k: number;
}

type DepartmentFilter = number | 'none' | null;

/**
 * Gerätepixel je CSS-Pixel, einschließlich App-Zoom (Strg+ ändert in Chromium
 * auch devicePixelRatio). Folgt Wechseln: anderer Bildschirm, Zoomstufe.
 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [dpr]);
  return dpr;
}

/**
 * Karten, die gerade (auch teilweise) im Bild sind. Nur gebraucht, wenn das
 * Vorschaubild für die Kartenfotos nicht reicht: Dann holen genau diese
 * Karten das Original, nicht jede Karte, die schon einmal sichtbar war.
 */
function cardsInView(layout: OrgLayout, view: View, el: HTMLElement | null): Set<number> {
  const ids = new Set<number>();
  if (!el) return ids;
  for (const placed of layout.nodes) {
    const left = placed.x * view.k + view.x;
    const top = placed.y * view.k + view.y;
    const inside =
      left + CARD_W * view.k > 0 && left < el.clientWidth && top + CARD_H * view.k > 0 && top < el.clientHeight;
    if (inside) ids.add(placed.node.person.id);
  }
  return ids;
}

function sameIds(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Abteilungsfarbe als CSS-Variable auf dem Element; 0 = ohne Abteilung. */
function toneStyle(tone: number): React.CSSProperties {
  return { '--orgc-accent': tone > 0 ? `var(--org-${tone})` : 'var(--gray-400)' } as React.CSSProperties;
}

function toneOf(model: OrgModel, person: OrgChartPerson): number {
  return person.department_id !== null ? (model.toneByDepartment.get(person.department_id) ?? 0) : 0;
}

export function PeopleOrgChart({
  initialPersonId,
  initialDepartmentId = null,
}: {
  initialPersonId: number | null;
  initialDepartmentId?: number | null;
}) {
  const { data, isLoading } = useOrgChart();
  if (isLoading || !data) {
    return (
      <Card title="Organigramm">
        <Spinner center />
      </Card>
    );
  }
  if (data.people.length === 0) {
    return (
      <Card title="Organigramm">
        <EmptyState
          icon={<Users size={40} />}
          title="Noch keine aktiven Mitarbeitenden"
          hint="Sobald Personen angelegt sind, entsteht hier das Organigramm entlang der Berichtslinie."
        />
      </Card>
    );
  }
  return <OrgChartView data={data} initialPersonId={initialPersonId} initialDepartmentId={initialDepartmentId} />;
}

function OrgChartView({
  data,
  initialPersonId,
  initialDepartmentId,
}: {
  data: OrgChartResponse;
  initialPersonId: number | null;
  initialDepartmentId: number | null;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const model = useMemo(() => buildOrgModel(data), [data]);

  const [focusId, setFocusId] = useState<number | null>(null);
  const focusNode = focusId !== null ? (model.byId.get(focusId) ?? null) : null;
  const roots = useMemo(() => (focusNode ? [focusNode] : model.roots), [focusNode, model]);
  const [expanded, setExpanded] = useState(() => defaultExpanded(model.roots));
  const layout = useMemo(() => layoutOrg(roots, (n) => expanded.has(n.person.id)), [roots, expanded]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selectedNode = selectedId !== null ? (model.byId.get(selectedId) ?? null) : null;
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilter>(null);

  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // CSS-Übergang der Ansicht nur bei programmatischen Sprüngen (Einpassen,
  // Zentrieren, Zoomknöpfe); beim Ziehen und Rad-Zoom soll nichts nachziehen.
  const [smooth, setSmooth] = useState(false);
  const [panning, setPanning] = useState(false);
  const [pending, setPending] = useState<{ center?: number; fit?: boolean; ensure?: number; fitIds?: number[] } | null>(
    null,
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  // Nach dem Ziehen darf der ausgelöste Klick keine Karte auswählen.
  const suppressClick = useRef(false);
  // Von Hand bewegt: dann passt eine Fenstergrößenänderung nicht mehr neu ein.
  const touched = useRef(false);

  // ------------------------------------------------------------ Ansicht --
  /**
   * Einpassen. `readable` hält den Zoom bei mindestens 70 % und stellt dann
   * die Spitze mittig: Beim ersten Öffnen soll man Namen lesen können, nicht
   * ein Feld aus Briefmarken sehen. Der Knopf „Einpassen" zeigt dagegen alles.
   */
  const fit = useCallback(
    (animate: boolean, readable = false) => {
      const el = canvasRef.current;
      if (!el) return;
      const kFit = clampZoom(
        Math.min(1, (el.clientWidth - FIT_PAD) / layout.width, (el.clientHeight - FIT_PAD) / layout.height),
      );
      const k = readable ? clampZoom(Math.max(kFit, 0.7)) : kFit;
      setSmooth(animate);
      const root = layout.nodes[0];
      if (k > kFit + 1e-6 && root) {
        setView({ k, x: el.clientWidth / 2 - (root.x + CARD_W / 2) * k, y: 28 });
        return;
      }
      setView({
        k,
        x: (el.clientWidth - layout.width * k) / 2,
        y: Math.max(28, (el.clientHeight - layout.height * k) / 2),
      });
    },
    [layout],
  );
  const fitRef = useRef(fit);
  fitRef.current = fit;

  /**
   * Passt die Ansicht auf eine Kartenmenge ein (Abteilungsfilter): Der
   * umschließende Kasten der Karten kommt mittig ins Bild, so groß wie
   * möglich, aber nie über 100 %. Karten außerhalb bleiben gedimmt am Rand.
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
      const width = el.clientWidth - (panelOpen ? PANEL_W + 24 : 0);
      const k = clampZoom(Math.min(1, (width - FIT_PAD) / boxW, (el.clientHeight - FIT_PAD) / boxH));
      setSmooth(true);
      setView({
        k,
        x: width / 2 - (minX + boxW / 2) * k,
        y: el.clientHeight / 2 - (minY + boxH / 2) * k,
      });
    },
    [layout],
  );

  /** Schiebt die Ansicht gerade so weit, dass die Karte frei sichtbar ist (auch neben der Detailspalte). */
  const ensureVisible = useCallback(
    (id: number, panelOpen: boolean) => {
      const el = canvasRef.current;
      const placed = layout.byId.get(id);
      if (!el || !placed) return;
      setSmooth(true);
      setView((v) => {
        const margin = 24;
        const left = placed.x * v.k + v.x;
        const top = placed.y * v.k + v.y;
        const right = left + CARD_W * v.k;
        const bottom = top + CARD_H * v.k;
        const maxX = el.clientWidth - (panelOpen ? PANEL_W + 24 : 0) - margin;
        const maxY = el.clientHeight - margin;
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

  const centerOn = useCallback(
    (id: number, panelOpen: boolean) => {
      const el = canvasRef.current;
      const placed = layout.byId.get(id);
      if (!el || !placed) return;
      setSmooth(true);
      setView((v) => {
        // Beim Zentrieren mindestens lesbar groß, aber nie kleiner machen.
        const k = v.k < 0.75 ? 0.9 : v.k;
        const width = el.clientWidth - (panelOpen ? PANEL_W + 24 : 0);
        return {
          k,
          x: width / 2 - (placed.x + CARD_W / 2) * k,
          y: el.clientHeight / 2 - (placed.y + CARD_H / 2) * k,
        };
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

  useEffect(() => {
    fitRef.current(false, true);
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!touched.current) fitRef.current(false, true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Rad-Zoom um die Mausposition; nativer Listener, weil React `wheel` passiv
  // anbindet und preventDefault dort wirkungslos wäre.
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

  // Aufgeschobene Sprünge: erst wenn das Layout die Karte kennt, lässt sie
  // sich zentrieren (Aufklappen und Zentrieren fallen sonst in denselben Klick).
  useEffect(() => {
    if (!pending) return;
    if (pending.fit) fit(true, true);
    if (pending.fitIds) fitTo(new Set(pending.fitIds), selectedId !== null);
    if (pending.center !== undefined && layout.byId.has(pending.center)) centerOn(pending.center, true);
    if (pending.ensure !== undefined) ensureVisible(pending.ensure, selectedId !== null);
    setPending(null);
  }, [pending, layout, fit, fitTo, centerOn, ensureVisible, selectedId]);

  // ------------------------------------------------------------ Aktionen --
  const reveal = useCallback(
    (id: number) => {
      const node = model.byId.get(id);
      if (!node) return;
      if (focusNode && !isWithin(node, focusNode)) setFocusId(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const ancestor of ancestorsOf(node)) next.add(ancestor.person.id);
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
        if (node) setExpanded((prev) => new Set([...prev, ...defaultExpanded([node])]));
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

  const expandAll = () => {
    setExpanded(new Set([...model.byId.values()].filter((n) => n.children.length > 0).map((n) => n.person.id)));
    touched.current = false;
    setPending({ fit: true });
  };
  const select = useCallback((id: number) => {
    setSelectedId(id);
    setSearchOpen(false);
    setPending({ ensure: id });
  }, []);
  const collapseAll = () => {
    setExpanded(defaultExpanded(roots));
    touched.current = false;
    setPending({ fit: true });
  };

  /**
   * Abteilungsfilter setzen: alle anderen dimmen, die Mitglieder aufklappen
   * (ein zugeklappter Zweig zeigte sie sonst gar nicht) und die Ansicht auf
   * genau diese Karten einpassen. Ohne Filter wieder alles einpassen.
   */
  const applyDepartmentFilter = useCallback(
    (key: DepartmentFilter) => {
      setDepartmentFilter(key);
      if (key === null) {
        touched.current = false;
        setPending({ fit: true });
        return;
      }
      const members = data.people.filter((p) =>
        key === 'none' ? p.department_id === null : p.department_id === key,
      );
      const nodes = members.map((p) => model.byId.get(p.id)).filter((n): n is OrgNode => n !== undefined);
      if (focusNode && nodes.some((n) => !isWithin(n, focusNode))) setFocusId(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const node of nodes) for (const ancestor of ancestorsOf(node)) next.add(ancestor.person.id);
        return next;
      });
      touched.current = true;
      setPending({ fitIds: members.map((p) => p.id) });
    },
    [data, model, focusNode],
  );

  useEffect(() => {
    if (initialPersonId !== null && model.byId.has(initialPersonId)) reveal(initialPersonId);
    // Einstieg aus der Struktur: Abteilung als Filter setzen (alle anderen
    // gedimmt) und die Ansicht auf ihre Personen einpassen.
    if (initialDepartmentId !== null && model.toneByDepartment.has(initialDepartmentId)) {
      applyDepartmentFilter(initialDepartmentId);
    }
    // Nur beim ersten Anzeigen: Der Parameter beschreibt den Einstieg, nicht
    // jeden späteren Datenstand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) setSearchOpen(false);
      else if (selectedId !== null) setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchOpen, selectedId]);

  // ---------------------------------------------------------- Ableitungen --
  const hoverNode = hoverId !== null ? (model.byId.get(hoverId) ?? null) : null;
  const activeNode = hoverNode ?? selectedNode;
  const pathIds = useMemo(() => {
    const ids = new Set<number>();
    if (activeNode) {
      ids.add(activeNode.person.id);
      for (const ancestor of ancestorsOf(activeNode)) ids.add(ancestor.person.id);
    }
    return ids;
  }, [activeNode]);

  const trimmed = query.trim();
  const hits = useMemo(
    () => (trimmed ? data.people.filter((p) => personMatches(p, trimmed)) : []),
    [data, trimmed],
  );
  const hitIds = useMemo(() => new Set(hits.map((p) => p.id)), [hits]);

  // Kartenfoto in Gerätepixeln über der Kantenlänge des Vorschaubilds (etwa
  // ab devicePixelRatio 2,7 bei vollem Zoom, Rechnung an PHOTO_THUMB_EDGE):
  // Dann zeigen die Karten im Bild das Original, damit es scharf bleibt.
  const dpr = useDevicePixelRatio();
  const needsOriginal = CARD_AVATAR_PX * view.k * dpr > PHOTO_THUMB_EDGE;
  // Welche Karten im Bild sind, erst wenn die Ansicht kurz stillsteht: Beim
  // Ziehen und Rad-Zoom liefe sonst je Bewegung ein Durchlauf über alle
  // Karten, und Karten am Rand bestellten ihr Original an und wieder ab. Ein
  // unveränderter Satz bleibt dasselbe Objekt (kein Neuzeichnen).
  const [originalIds, setOriginalIds] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!needsOriginal) {
      setOriginalIds(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const next = cardsInView(layout, view, canvasRef.current);
      setOriginalIds((prev) => (prev && sameIds(prev, next) ? prev : next));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [needsOriginal, layout, view]);
  const { data: originals } = useOrgChartOriginals(needsOriginal);

  const legend = useMemo(() => {
    const counts = new Map<number | null, number>();
    for (const p of data.people) counts.set(p.department_id, (counts.get(p.department_id) ?? 0) + 1);
    const items = model.departments
      .filter((d) => counts.has(d.id))
      .map((d) => ({ key: d.id as number | 'none', name: d.name, count: counts.get(d.id) ?? 0, tone: model.toneByDepartment.get(d.id) ?? 0 }));
    if (counts.has(null)) items.push({ key: 'none', name: 'Ohne Abteilung', count: counts.get(null) ?? 0, tone: 0 });
    return items;
  }, [data, model]);

  const isDimmed = (person: OrgChartPerson): boolean => {
    if (trimmed && !hitIds.has(person.id)) return true;
    if (departmentFilter === null) return false;
    return departmentFilter === 'none' ? person.department_id !== null : person.department_id !== departmentFilter;
  };

  const exportSvg = () => {
    const blob = new Blob([buildSvg(layout, model)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'organigramm.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Organigramm als SVG exportiert');
  };

  const crumbs = focusNode ? [...ancestorsOf(focusNode), focusNode] : [];

  return (
    <Card
      title="Organigramm nach Berichtslinie"
      flush
      actions={
        <>
          <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm" onClick={expandAll}>
            <UnfoldVertical size={15} /> Alle aufklappen
          </button>
          <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm" onClick={collapseAll}>
            <FoldVertical size={15} /> Zuklappen
          </button>
          <button type="button" className="hm-btn hm-btn--secondary hm-btn--sm" onClick={exportSvg}>
            <Download size={15} /> SVG exportieren
          </button>
        </>
      }
    >
      <div className="orgc">
        <div className="orgc__toolbar">
          <div className="orgc__search">
            <Search size={15} className="orgc__search-icon" aria-hidden="true" />
            <input
              className="hm-input"
              type="search"
              placeholder="Person, Titel oder Abteilung suchen"
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
              <div className="orgc__results" role="listbox" aria-label="Suchtreffer">
                {hits.length === 0 && <div className="orgc__result-empty">Keine Treffer</div>}
                {hits.slice(0, MAX_RESULTS).map((p) => (
                  <button key={p.id} type="button" role="option" aria-selected={false} className="orgc__result" onClick={() => reveal(p.id)}>
                    <PersonAvatar person={p} size={28} />
                    <div style={{ minWidth: 0 }}>
                      <div className="orgc__result-name">{fullName(p)}</div>
                      <div className="orgc__result-sub">{[p.job_title, p.department_name].filter(Boolean).join(' · ')}</div>
                    </div>
                  </button>
                ))}
                {hits.length > MAX_RESULTS && (
                  <div className="orgc__result-empty">{hits.length - MAX_RESULTS} weitere Treffer, Suche eingrenzen</div>
                )}
              </div>
            )}
          </div>
          <div className="orgc__legend" aria-label="Abteilungen">
            {legend.map((item) => {
              const active = departmentFilter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`orgc__chip${active ? ' is-active' : ''}`}
                  style={toneStyle(item.tone)}
                  aria-pressed={active}
                  onClick={() => applyDepartmentFilter(active ? null : item.key)}
                >
                  <span className="orgc-dot" aria-hidden="true" />
                  {item.name}
                  <span className="orgc__chip-count">{item.count}</span>
                </button>
              );
            })}
          </div>
          <span className="orgc__stats">
            {model.byId.size} Personen · {legend.filter((l) => l.key !== 'none').length} Abteilungen · {model.maxDepth + 1} Ebenen
          </span>
        </div>

        <div className="orgc__stage">
          <div
            ref={canvasRef}
            className={`orgc__canvas${panning ? ' is-panning' : ''}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              setSearchOpen(false);
              drag.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.px;
              const dy = e.clientY - d.py;
              if (!d.moved) {
                if (Math.hypot(dx, dy) < 4) return;
                // Erst ab hier ist es ein Ziehen: Die Zeigererfassung würde
                // sonst jeden einfachen Klick auf eine Karte auf die Fläche umlenken.
                d.moved = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                setPanning(true);
                setSmooth(false);
                touched.current = true;
              }
              setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
            }}
            onPointerUp={() => {
              if (drag.current?.moved) suppressClick.current = true;
              drag.current = null;
              setPanning(false);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setPanning(false);
            }}
            onClick={(e) => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            <div
              className={`orgc__world${smooth ? ' is-smooth' : ''}`}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
            >
              <svg className="orgc__edges" width={layout.width} height={layout.height} aria-hidden="true">
                {layout.edges.map((edge) => {
                  const fromId = edge.from.node.person.id;
                  const toId = edge.to.node.person.id;
                  const hot = pathIds.has(fromId) && pathIds.has(toId);
                  const faint = hoverNode !== null && !hot;
                  const d = edgePath(edge);
                  return (
                    <path
                      key={`${fromId}-${toId}`}
                      className={`orgc__edge${edge.derived ? ' is-derived' : ''}${hot ? ' is-hot' : ''}${faint ? ' is-faint' : ''}`}
                      d={d}
                      style={{ d: `path("${d}")` } as React.CSSProperties}
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((placed) => {
                const id = placed.node.person.id;
                return (
                  <OrgCard
                    key={id}
                    node={placed.node}
                    x={placed.x}
                    y={placed.y}
                    tone={toneOf(model, placed.node.person)}
                    selected={selectedId === id}
                    onPath={pathIds.has(id) && activeNode !== null && activeNode.person.id !== id}
                    hit={hitIds.has(id)}
                    dim={isDimmed(placed.node.person)}
                    open={expanded.has(id)}
                    originalPhotoUrl={originalIds?.has(id) ? (originals?.[id] ?? null) : null}
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
              <nav className="orgc__overlay orgc__crumbs" aria-label="Fokus">
                <button type="button" className="orgc__crumb" onClick={() => focusOn(null)}>
                  Alle Personen
                </button>
                {crumbs.map((node, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <React.Fragment key={node.person.id}>
                      <ChevronRight size={13} className="orgc__crumb-sep" aria-hidden="true" />
                      <button
                        type="button"
                        className={`orgc__crumb${last ? ' is-current' : ''}`}
                        aria-current={last ? 'location' : undefined}
                        onClick={() => !last && focusOn(node.person.id)}
                      >
                        {fullName(node.person)}
                      </button>
                    </React.Fragment>
                  );
                })}
              </nav>
            )}

            <div className="orgc__hint">Ziehen verschiebt · Mausrad zoomt · Doppelklick fokussiert einen Bereich</div>

            <div className="orgc__overlay orgc__zoom">
              <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon" aria-label="Verkleinern" onClick={() => zoomBy(1 / 1.25)}>
                <ZoomOut size={15} />
              </button>
              <span className="orgc__zoom-value">{Math.round(view.k * 100)} %</span>
              <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon" aria-label="Vergrößern" onClick={() => zoomBy(1.25)}>
                <ZoomIn size={15} />
              </button>
              <button
                type="button"
                className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                aria-label="Einpassen"
                onClick={() => {
                  touched.current = false;
                  fit(true);
                }}
              >
                <Maximize2 size={15} />
              </button>
              <button
                type="button"
                className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                aria-label="Ausgewählte Person zentrieren"
                disabled={selectedId === null}
                onClick={() => selectedId !== null && reveal(selectedId)}
              >
                <LocateFixed size={15} />
              </button>
            </div>
          </div>

          {selectedNode && (
            <PersonPanel
              node={selectedNode}
              model={model}
              onClose={() => setSelectedId(null)}
              onSelect={reveal}
              onFocus={focusOn}
              onOpen={(id) => navigate(`/personal/mitarbeitende/${id}`)}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

interface OrgCardProps {
  node: OrgNode;
  x: number;
  y: number;
  tone: number;
  selected: boolean;
  /** Liegt auf der hervorgehobenen Linie zur Spitze (nicht die Person selbst). */
  onPath: boolean;
  hit: boolean;
  dim: boolean;
  open: boolean;
  /**
   * Signierter Link auf das Original, wenn die Karte es zeigen soll (Zoom über
   * der Grenze des Vorschaubilds, Karte im Bild); sonst null.
   */
  originalPhotoUrl: string | null;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
  onFocus: (id: number) => void;
  /** Tastaturfokus (Tab): Ansicht nachführen, damit die Karte im Bild ist. */
  onKeyboardFocus: (id: number) => void;
  onHover: (id: number | null) => void;
}

const OrgCard = React.memo(function OrgCard({
  node, x, y, tone, selected, onPath, hit, dim, open, originalPhotoUrl, onSelect, onToggle, onFocus, onKeyboardFocus,
  onHover,
}: OrgCardProps) {
  const { person } = node;
  const photo = useAvatarPhoto(person);
  // Über der Grenze des Vorschaubilds das Original nachladen; bis es da ist,
  // bleibt das Vorschaubild stehen (keine Initialen dazwischen). Der Link kommt
  // signiert aus GET /api/org/chart/originals: Selbst signiert entstünde je
  // Karte eine Audit-Zeile.
  const wantsOriginal = originalPhotoUrl !== null && person.photo_file_id !== avatarFileId(person);
  const original = usePhotoUrl(wantsOriginal ? person.photo_file_id : null, originalPhotoUrl, photo.seen);
  const src = (wantsOriginal ? original.data : undefined) ?? photo.src;
  const className = [
    'orgc-card',
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
      aria-label={`${fullName(person)}${person.job_title ? `, ${person.job_title}` : ''}`}
      aria-pressed={selected}
      style={{ left: x, top: y, width: CARD_W, height: CARD_H, ...toneStyle(tone) }}
      // Kein Fokus per Maus: Der Browser scrollte sonst beim Klick jede
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
      <span className="orgc-card__accent" aria-hidden="true" />
      <div className="orgc-card__body">
        <span ref={photo.ref} className="hm-avatar orgc-card__avatar" aria-hidden="true">
          {src ? <img src={src} alt="" /> : initialsOf(person)}
        </span>
        <div className="orgc-card__text">
          <div className="orgc-card__name">{fullName(person)}</div>
          <div className="orgc-card__title">{person.job_title ?? EMPLOYEE_TYPE_LABELS[person.employee_type]}</div>
          <div className="orgc-card__dept">
            <span className="orgc-dot" aria-hidden="true" />
            <span className="orgc-card__dept-text">
              {[person.department_name ?? 'Ohne Abteilung', person.team_name].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
      </div>
      <div className="orgc-card__foot">
        <span className="orgc-card__loc">
          {person.location_name ? (
            <>
              <MapPin size={12} aria-hidden="true" /> {person.location_name}
            </>
          ) : (
            <span className="orgc-card__loc--none">Kein Standort</span>
          )}
        </span>
        {node.reportCount > 0 && (
          <Tooltip
            content={
              <>
                <div className="hm-tooltip__title">Berichtende</div>
                <div className="hm-tooltip__line">
                  {node.reportCount} direkt · {node.totalReports} gesamt
                </div>
              </>
            }
          >
            <button
              type="button"
              className={`orgc-card__chip${open ? ' is-open' : ''}`}
              aria-expanded={open}
              aria-label={open ? 'Berichtende zuklappen' : 'Berichtende aufklappen'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(person.id);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              {node.reportCount}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
});

function PersonAvatar({ person, size }: { person: OrgChartPerson; size: number }) {
  const photo = useAvatarPhoto(person);
  return (
    <span
      ref={photo.ref}
      className="hm-avatar"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {photo.src ? <img src={photo.src} alt="" /> : initialsOf(person)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detailspalte
// ---------------------------------------------------------------------------

function PersonPanel({
  node,
  model,
  onClose,
  onSelect,
  onFocus,
  onOpen,
}: {
  node: OrgNode;
  model: OrgModel;
  onClose: () => void;
  onSelect: (id: number) => void;
  onFocus: (id: number) => void;
  onOpen: (id: number) => void;
}) {
  const { person } = node;
  const parent = node.parent;
  const source = person.parent_source;
  return (
    <aside className="orgc__panel" aria-label={`Details zu ${fullName(person)}`}>
      <div className="orgc__panel-head">
        <PersonAvatar person={person} size={56} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="orgc__panel-name">{fullName(person)}</div>
          <div className="orgc__panel-title">{person.job_title ?? '—'}</div>
          <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
            <Badge tone={TYPE_TONES[person.employee_type]}>{EMPLOYEE_TYPE_LABELS[person.employee_type]}</Badge>
            {person.department_name && (
              <span className="orgc__dept-badge" style={toneStyle(toneOf(model, person))}>
                <span className="orgc-dot" aria-hidden="true" />
                {person.department_name}
              </span>
            )}
          </div>
        </div>
        <button type="button" className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon" aria-label="Details schließen" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="orgc__panel-body">
        <section>
          <div className="orgc__section-title">Kontakt und Zuordnung</div>
          <div className="stack" style={{ gap: 8 }}>
            {person.team_name && <Fact icon={<Network size={14} />} text={`Team ${person.team_name}`} />}
            <Fact icon={<MapPin size={14} />} text={person.location_name ?? 'Kein Standort'} />
            {person.email && <Fact icon={<Mail size={14} />} text={person.email} />}
            {person.phone && <Fact icon={<Phone size={14} />} text={person.phone} />}
            <Fact
              icon={<Hash size={14} />}
              text={person.personnel_number ? `Personalnr. ${person.personnel_number}` : 'Ohne Personalnummer'}
            />
            <Fact
              icon={<CalendarDays size={14} />}
              text={
                person.hire_date
                  ? `Seit ${formatDate(person.hire_date)} · ${formatSeniority(person.hire_date)}`
                  : 'Eintritt unbekannt'
              }
            />
          </div>
        </section>

        <section>
          <div className="orgc__section-title">Berichtet an</div>
          {parent ? (
            <>
              <PersonRow person={parent.person} onClick={() => onSelect(parent.person.id)} />
              {source && source !== 'manager' && (
                <div className="orgc__derived">
                  Kein:e Vorgesetzte:r hinterlegt. Die Linie folgt der{' '}
                  {source === 'team_lead' ? 'Teamleitung' : 'Abteilungsleitung'}; gepflegt wird das Feld in der
                  Personalakte unter Beschäftigung.
                </div>
              )}
            </>
          ) : (
            <div className="orgc__muted">Spitze der Berichtslinie.</div>
          )}
        </section>

        <section>
          <div className="orgc__section-title">Direkt Berichtende · {node.reportCount}</div>
          {node.children.length === 0 ? (
            <div className="orgc__muted">Keine direkt Berichtenden.</div>
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
            <div className="orgc__muted" style={{ marginTop: 8 }}>
              {node.totalReports} Personen insgesamt unterhalb.
            </div>
          )}
        </section>
      </div>

      <div className="orgc__panel-foot">
        <button type="button" className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => onOpen(person.id)}>
          <SquareArrowOutUpRight size={14} /> Personalakte
        </button>
        {node.children.length > 0 && (
          <button type="button" className="hm-btn hm-btn--secondary hm-btn--sm" onClick={() => onFocus(person.id)}>
            <Focus size={14} /> Bereich fokussieren
          </button>
        )}
      </div>
    </aside>
  );
}

function Fact({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="orgc__fact">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function PersonRow({ person, sub, onClick }: { person: OrgChartPerson; sub?: string; onClick: () => void }) {
  return (
    <button type="button" className="orgc__person-row" onClick={onClick}>
      <PersonAvatar person={person} size={30} />
      <div style={{ minWidth: 0 }}>
        <div className="orgc__person-row-name">{fullName(person)}</div>
        <div className="orgc__person-row-sub">
          {[person.job_title, sub].filter(Boolean).join(' · ') || EMPLOYEE_TYPE_LABELS[person.employee_type]}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SVG-Export
// ---------------------------------------------------------------------------

/**
 * Zeichnet die aktuell sichtbaren Karten als eigenständiges SVG nach. Farben
 * werden aus dem aktiven Theme aufgelöst, weil die Datei ohne Stylesheet
 * geöffnet wird. Fotos bleiben außen vor (befristet signierte Links wären in
 * der Datei nach wenigen Minuten tot); an ihrer Stelle stehen die Initialen.
 */
function buildSvg(layout: OrgLayout, model: OrgModel): string {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const value = css.getPropertyValue(name).trim();
    return value && !value.startsWith('var(') ? value : fallback;
  };
  const brand = read('--brand-primary', '#0864c6');
  const colors = {
    canvas: read('--gray-25', '#fafbfe'),
    surface: read('--bg-surface', '#ffffff'),
    border: read('--border-strong', '#d5dce8'),
    edge: read('--gray-300', '#cdd5e2'),
    text: read('--text-primary', '#16202f'),
    secondary: read('--text-secondary', '#4d5b73'),
    muted: read('--text-muted', '#6b7a94'),
    rule: read('--gray-100', '#eef1f7'),
    avatarBg: read('--blue-100', '#d9e9fa'),
    avatarText: read('--blue-700', '#084a90'),
    neutral: read('--gray-400', '#9aa7bc'),
    tones: Array.from({ length: TONE_COUNT }, (_, i) => read(`--org-${i + 1}`, brand)),
  };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const pad = 32;
  const parts: string[] = [];

  for (const edge of layout.edges) {
    parts.push(
      `<path d="${edgePath(edge)}" fill="none" stroke="${colors.edge}" stroke-width="1.6"${edge.derived ? ' stroke-dasharray="5 4"' : ''}/>`,
    );
  }
  for (const { node, x, y } of layout.nodes) {
    const p = node.person;
    const tone = toneOf(model, p);
    const accent = tone > 0 ? (colors.tones[tone - 1] ?? brand) : colors.neutral;
    const title = p.job_title ?? EMPLOYEE_TYPE_LABELS[p.employee_type];
    const department = [p.department_name ?? 'Ohne Abteilung', p.team_name].filter(Boolean).join(' · ');
    const foot = [p.location_name, node.reportCount > 0 ? `${node.reportCount} Berichtende` : null]
      .filter(Boolean)
      .join(' · ');
    parts.push(
      `<g>` +
        `<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="14" fill="${colors.surface}" stroke="${colors.border}"/>` +
        `<path d="M ${x + 14} ${y} h -4 a 10 10 0 0 0 -10 10 v ${CARD_H - 20} a 10 10 0 0 0 10 10 h 4 z" fill="${accent}"/>` +
        `<circle cx="${x + 41}" cy="${y + 40}" r="23" fill="${colors.avatarBg}"/>` +
        `<text x="${x + 41}" y="${y + 46}" font-size="16" font-weight="650" fill="${colors.avatarText}" text-anchor="middle">${esc(initialsOf(p))}</text>` +
        `<text x="${x + 76}" y="${y + 30}" font-size="14" font-weight="650" fill="${colors.text}">${esc(clip(fullName(p), 20))}</text>` +
        `<text x="${x + 76}" y="${y + 48}" font-size="12" fill="${colors.secondary}">${esc(clip(title, 24))}</text>` +
        `<circle cx="${x + 80}" cy="${y + 62}" r="4" fill="${accent}"/>` +
        `<text x="${x + 89}" y="${y + 66}" font-size="11" fill="${colors.muted}">${esc(clip(department, 24))}</text>` +
        `<line x1="${x + 1}" y1="${y + CARD_H - 34}" x2="${x + CARD_W - 1}" y2="${y + CARD_H - 34}" stroke="${colors.rule}"/>` +
        `<text x="${x + 18}" y="${y + CARD_H - 13}" font-size="11" fill="${colors.muted}">${esc(clip(foot || ' ', 32))}</text>` +
        `</g>`,
    );
  }
  const width = layout.width + pad * 2;
  const height = layout.height + pad * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'Creato Display', 'Plus Jakarta Sans Variable', 'Segoe UI', system-ui, sans-serif">` +
    `<rect width="100%" height="100%" fill="${colors.canvas}"/>` +
    `<g transform="translate(${pad}, ${pad})">${parts.join('')}</g></svg>`
  );
}
