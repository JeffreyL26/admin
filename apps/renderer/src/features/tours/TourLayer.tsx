import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { Tooltip } from '../../components/Tooltip';
import { t, type CopyKey } from './copy';
import { TOURS, tourColor, type TourDef } from './registry';
import { tourActions, useTourState, type TourState, type TourStatus } from './store';

const BLOB_W = 288;
const BLOB_H = 150;
const GAP = 16;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/** Gefundenes Ziel samt Fenstergroesse: Aendert sich nur das Fenster, rechnet die Blase neu. */
interface Found {
  name: string;
  box: Box;
  vw: number;
  vh: number;
}

const sameFound = (a: Found | null, b: Found | null) =>
  a === b || (!!a && !!b && a.name === b.name && a.vw === b.vw && a.vh === b.vh && sameBox(a.box, b.box));

/**
 * Sucht das Ziel einer Blase im DOM (`data-tour`), probiert die Namen der Reihe
 * nach und meldet, welcher gefunden wurde. Gemessen wird bei jeder DOM-Aenderung
 * (MutationObserver, auf ein Bild begrenzt), bei Scroll und Resize, dazu einmal pro
 * Sekunde fuer Verschiebungen ohne DOM-Aenderung (Animationen). Im verdeckten
 * Fenster ruht die Messung. Liegt das Ziel ausserhalb des Fensters, wird es einmal
 * pro Erscheinen in die Mitte gerollt.
 *
 * Verdeckte Ziele zaehlen nicht: Ist ein Dialog offen, gelten nur Ziele IN ihm;
 * ein Knopf dahinter bekaeme sonst Ring und Blase mitten ueber den Dialog. Dasselbe
 * gilt, solange der Einrichtungs-Assistent offen ist.
 */
function useTarget(names: (string | undefined)[]): Found | null {
  const [found, setFound] = useState<Found | null>(null);
  const scrolled = useRef(false);
  const key = names.join('|');

  useEffect(() => {
    // Neuer Schritt: alter Treffer weg, Rollen wieder erlaubt.
    scrolled.current = false;
    setFound(null);
    const find = (): Found | null => {
      if (document.querySelector('.hm-setup__panel')) return null;
      const modal = document.querySelector('.hm-modal');
      for (const name of names) {
        if (!name) continue;
        for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
          if (modal && !modal.contains(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if ((r.top < 0 || r.bottom > window.innerHeight) && !scrolled.current) {
            scrolled.current = true;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
          return {
            name,
            box: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
            vw: window.innerWidth,
            vh: window.innerHeight,
          };
        }
      }
      return null;
    };
    // Der Updater bleibt rein: Gemessen (und gerollt) wird davor.
    const tick = () => {
      if (document.hidden) return;
      const next = find();
      if (!next) scrolled.current = false;
      setFound((prev) => (sameFound(prev, next) ? prev : next));
    };
    let raf = 0;
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          tick();
        });
      }
    };
    tick();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    const iv = window.setInterval(tick, 1000);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // Wieder sichtbar: sofort neu messen, nicht erst mit dem naechsten Takt.
    document.addEventListener('visibilitychange', schedule);
    return () => {
      observer.disconnect();
      window.clearInterval(iv);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return found;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Seiten-Einfuehrungen: Beim ersten Besuch einer Seite startet ihre Einfuehrung.
 * Pro Seite eine eigene Leiste unten rechts, kleine Blasen am Ziel, am Ende
 * fliegt der Haken in die Fenstermitte. Texte in copy.ts, Schritte in registry.ts.
 */
export function TourLayer() {
  const { pathname, search } = useLocation();
  const { can } = useAuth();
  const { tours, bound } = useTourState();
  const tour = TOURS.find((x) => pathname.startsWith(x.path)) ?? null;
  const state = tour ? tours[tour.id] : undefined;

  // Erster Besuch: starten. Erst, wenn der Stand dieser Installation geladen ist.
  useEffect(() => {
    if (tour && bound && !state && can(tour.area)) {
      tourActions.start(tour.id);
      tour.initial?.(search).forEach(tourActions.event);
    }
  }, [tour, bound, state, can, search]);

  // Haken fliegt: Position des Hakens in der Leiste merken, solange sie steht.
  const lastCheck = useRef<Box | null>(null);
  const prev = useRef<{ id: string; status: TourStatus } | null>(null);
  const [finale, setFinale] = useState<{ from: Box; label: string } | null>(null);

  const barShown = !!tour && state?.status === 'active';
  // Solange die Leiste steht, ihren Haken im Blick behalten: Launcher, Fenstergroesse
  // und Fortschritt verschieben sie, das Finale startet von der letzten Messung.
  useLayoutEffect(() => {
    if (!barShown) return;
    const measure = () => {
      const el = document.querySelector('.hm-tour-bar .hm-tour__check');
      if (!el) return;
      const r = el.getBoundingClientRect();
      lastCheck.current = { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    measure();
    const iv = window.setInterval(measure, 500);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('resize', measure);
    };
  }, [barShown]);

  useEffect(() => {
    if (tour && state) {
      if (prev.current?.id === tour.id && prev.current.status === 'active' && state.status === 'done' && lastCheck.current) {
        setFinale({ from: lastCheck.current, label: t(`${tour.id}.finale` as CopyKey) });
      }
      prev.current = { id: tour.id, status: state.status };
    } else {
      prev.current = null;
    }
  }, [tour, state]);

  const active = tour && state?.status === 'active' ? { tour, state } : null;
  return (
    <>
      {active && <TourBar tour={active.tour} state={active.state} />}
      {active && <TourBlob tour={active.tour} state={active.state} />}
      {finale && <TourFinale from={finale.from} label={finale.label} onDone={() => setFinale(null)} />}
    </>
  );
}

function TourBar({ tour, state }: { tour: TourDef; state: TourState }) {
  return (
    <div className="hm-tour-bar" role="status" aria-live="polite">
      <span className="hm-tour__check" aria-hidden="true">
        <Check size={14} strokeWidth={3} />
      </span>
      <span className="hm-tour-bar__segs" aria-hidden="true">
        {tour.steps.map((_, i) => (
          <i
            key={i}
            className={state.done.includes(i) ? 'is-on' : ''}
            style={{ '--seg': tourColor(i).bg } as React.CSSProperties}
          />
        ))}
      </span>
      <span className="hm-tour-bar__label">
        {t('bar.label', { title: t(`${tour.id}.title` as CopyKey), done: state.done.length, total: tour.steps.length })}
      </span>
      <Tooltip content={<div className="hm-tooltip__title">{t('bar.skip')}</div>}>
        <button
          type="button"
          className="hm-tour-bar__skip"
          aria-label={t('bar.skip.aria')}
          onClick={() => tourActions.skip(tour.id)}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

function TourBlob({ tour, state }: { tour: TourDef; state: TourState }) {
  const index = tour.steps.findIndex((_, i) => !state.done.includes(i));
  const step = tour.steps[index];
  const found = useTarget([step?.target, step?.altTarget]);
  if (!step || !found) return null;

  const color = tourColor(index);
  const n = index + 1;
  const usesAlt = found.name !== step.target;
  const base = `${tour.id}.step${n}`;
  const { box, vw, vh } = found;
  const cx = box.left + box.width / 2;
  const tall = box.height > vh * 0.5;

  const pos: React.CSSProperties = {};
  let arrow: number | null = null;
  let up = false;
  pos.left = clamp(cx - BLOB_W / 2, 12, Math.max(12, vw - BLOB_W - 12));
  if (tall) {
    // Grosses Ziel (Karte): Blase innen oben, ohne Zeiger.
    pos.top = Math.max(12, box.top) + 56;
    pos.left = clamp(box.left + box.width - BLOB_W - 16, 12, Math.max(12, vw - BLOB_W - 12));
  } else if (
    box.top - GAP - BLOB_H > 12 &&
    (step.placement === 'above' || box.top + box.height + GAP + BLOB_H > vh)
  ) {
    up = true;
    pos.bottom = vh - box.top + GAP;
    arrow = clamp(cx - (pos.left as number), 22, BLOB_W - 22);
  } else {
    pos.top = box.top + box.height + GAP;
    arrow = clamp(cx - (pos.left as number), 22, BLOB_W - 22);
  }

  const vars = { '--c': color.bg, '--cn': color.on } as React.CSSProperties;
  return (
    <>
      <div
        className="hm-tour-ring"
        style={{ ...vars, left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }}
        aria-hidden="true"
      />
      <div
        key={`${index}-${found.name}`}
        className={`hm-tour-blob${up ? ' is-up' : ''}`}
        style={{ ...vars, ...pos, width: BLOB_W, ['--ax' as string]: arrow === null ? undefined : `${arrow}px` }}
        data-arrow={arrow === null ? 'none' : 'yes'}
        role="note"
      >
        <p className="hm-tour-blob__title">
          <span className="hm-tour-blob__n">{n}</span>
          {t(`${base}.title` as CopyKey)}
        </p>
        {usesAlt ? (
          <p className="hm-tour-blob__todo">{t(`${base}.alt` as CopyKey)}</p>
        ) : (
          <>
            <p className="hm-tour-blob__text">{t(`${base}.text` as CopyKey)}</p>
            <p className="hm-tour-blob__todo">{t(`${base}.todo` as CopyKey)}</p>
          </>
        )}
      </div>
    </>
  );
}

/** Der Haken loest sich von der Leiste, fliegt in die Fenstermitte und leuchtet auf. */
function TourFinale({ from, label, onDone }: { from: Box; label: string; onDone: () => void }) {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState<'start' | 'fly' | 'glow'>(reduce ? 'glow' : 'start');

  useEffect(() => {
    const timers: number[] = [];
    if (!reduce) {
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('fly')));
      timers.push(window.setTimeout(() => setPhase('glow'), 950));
      timers.push(window.setTimeout(onDone, 950 + 2800));
      return () => {
        cancelAnimationFrame(raf);
        timers.forEach(clearTimeout);
      };
    }
    timers.push(window.setTimeout(onDone, 2800));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startX = from.left + from.width / 2;
  const startY = from.top + from.height / 2;
  const atStart = phase === 'start';
  return (
    <div className="hm-tour-finale" aria-live="polite">
      <span
        className={`hm-tour__check hm-tour-finale__check${phase === 'glow' ? ' is-glow' : ''}`}
        style={{
          left: atStart ? startX : window.innerWidth / 2,
          top: atStart ? startY : window.innerHeight / 2,
          transform: `translate(-50%, -50%) scale(${atStart ? 1 : 3})`,
        }}
      >
        <Check size={14} strokeWidth={3} />
      </span>
      {phase === 'glow' && (
        <span className="hm-tour-finale__label" style={{ left: window.innerWidth / 2, top: window.innerHeight / 2 + 62 }}>
          {label}
        </span>
      )}
    </div>
  );
}
