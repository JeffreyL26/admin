import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRightLeft, Check, X } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { Tooltip } from '../../components/Tooltip';
import { t, type CopyKey } from './copy';
import { TOURS, stepPage, tourAt, tourColor, visibleStepCount, type TourDef, type TourStepDef } from './registry';
import { consumeRestored, tourActions, useTourState, type TourState, type TourStatus } from './store';

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
  /** Sichtbarer Teil des Ziels (abgeschnitten von Scrollbereichen und Fenster). */
  box: Box;
  /** Volle Hoehe des Ziels, auch was weggescrollt ist: entscheidet, ob es als gross gilt. */
  fullHeight: number;
  vw: number;
  vh: number;
  /** Liegt das Ziel in einem Dialog: dessen Rand, innerhalb dessen die Blase bleibt. */
  clip: Box | null;
  /** Linke Kante des Schliessen-X im Dialog (0 ohne Dialog): Eine Blase oben rechts bleibt links davon. */
  clipClose: number;
  /** Linke Kante des ersten Knopfs der Dialog-Fusszeile (0 ohne): Links davon ist die Fusszeile frei. */
  clipFooter: number;
  /**
   * Ziel liegt im DOM, ist aber ganz weggescrollt: in welcher Richtung es liegt. `box` ist dann der
   * Bereich, in dem es sichtbar wuerde; die Blase sagt, wohin man scrollen muss.
   */
  offscreen: 'up' | 'down' | 'side' | null;
  /** Obere Kante von Leiste, Wechselhinweis und Launcher: darunter steht keine Blase. */
  zone: number;
}

const sameFound = (a: Found | null, b: Found | null) =>
  a === b || (!!a && !!b && a.name === b.name && a.clipClose === b.clipClose && a.clipFooter === b.clipFooter &&a.offscreen === b.offscreen && a.fullHeight === b.fullHeight && a.vw === b.vw && a.vh === b.vh && a.zone === b.zone && sameBox(a.box, b.box) && sameBox(a.clip, b.clip));

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
  const key = names.join('|');

  useEffect(() => {
    // Neuer Schritt: alter Treffer weg. Gerollt wird einmal je Ziel (und wieder nach einer Groessenaenderung
    // des Fensters): Ein neues Ziel, auch innerhalb des Schritts, wird geholt; eines, das man selbst
    // weggescrollt hat, nicht zurueck. Neu ist ein Ziel, wenn das Element wechselt und das alte noch im
    // Seiteninhalt haengt (anderes Feld, neuester Eintrag). Baut React es nur neu auf (Reiterwechsel: altes
    // Element weg, gleicher Name und gleiche Art), ist es dasselbe; aendert sich nur sein Inhalt, ebenso.
    setFound(null);
    let last: { el: HTMLElement; name: string } | null = null;
    // Solange die Einfuehrung selbst rollt, ist das Ziel unterwegs: kein Hinweis "Scrollen Sie ...".
    let autoScrollUntil = 0;
    const autoScroll = (el: HTMLElement, opts: ScrollIntoViewOptions) => {
      autoScrollUntil = performance.now() + 900;
      el.scrollIntoView({ ...opts, behavior: 'smooth' });
    };
    const find = (): Found | null => {
      if (document.querySelector('.hm-setup__panel')) return null;
      const modal = document.querySelector('.hm-modal');
      let zone = window.innerHeight;
      // Im Dialog liegen Leiste und Launcher unter dem Overlay, die Blase darf ueber ihnen stehen.
      if (!modal) {
        for (const el of document.querySelectorAll('.hm-tour-bar, .hm-tour-notice, .hm-setup-launcher')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) zone = Math.min(zone, Math.round(r.top) - 8);
        }
      }
      for (const name of names) {
        if (!name) continue;
        for (const el of document.querySelectorAll<HTMLElement>(`[data-tour~="${name}"]`)) {
          if (modal && !modal.contains(el)) continue;
          const raw = el.getBoundingClientRect();
          if (raw.width <= 0 || raw.height <= 0) continue;
          const area = viewArea(el);
          const r = intersect(raw, area);
          // Bereich ohne Flaeche (Container oeffnet sich gerade): noch nichts zu zeigen, Scrollen hilft nicht.
          if (area.width < 1 || area.height < 1) return null;
          const fresh =
            !last ||
            (el !== last.el && (last.el.isConnected || last.name !== name || last.el.tagName !== el.tagName));
          last = { el, name };
          if (fresh) {
            if (!r || raw.top < 0 || raw.bottom > zone) {
              // Hinter der Leiste zaehlt wie ausserhalb des Fensters.
              autoScroll(el, { block: 'center', inline: 'nearest' });
            } else if (r.width < raw.width * 0.6 || (r.height < raw.height * 0.6 && raw.height <= window.innerHeight * 0.5)) {
              // Groesstenteils abgeschnitten (breite Tabelle, Feld am Rand des Dialogs): bis an den Rand nachrollen.
              // Grosse Ziele (Formulare, Karten) nicht: Sie passen ohnehin nicht ganz hinein.
              autoScroll(el, { block: 'nearest', inline: 'nearest' });
            }
          }
          if (!r && performance.now() < autoScrollUntil) return null;
          // Ganz weggescrollt: kein Ersatzziel (dessen Text stimmte dann nicht), sondern der Hinweis, wohin.
          const offscreen = r ? null : raw.bottom <= area.top ? 'up' : raw.top >= area.top + area.height ? 'down' : 'side';
          const m = modal?.getBoundingClientRect();
          const close = modal?.querySelector('.hm-modal__header button')?.getBoundingClientRect();
          const footer = modal?.querySelector('.hm-modal__footer button')?.getBoundingClientRect();
          return {
            name,
            zone,
            clip: m ? roundBox(m) : null,
            clipClose: close ? Math.round(close.left) : 0,
            clipFooter: footer ? Math.round(footer.left) : 0,
            offscreen,
            box: roundBox(r ?? area),
            fullHeight: Math.round(raw.height),
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
    const onResize = () => {
      last = null;
      schedule();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', schedule, true);
    // Seiten und Dialoge blenden mit Versatz ein (Animation, keine Transition); ihr Ende aendert das DOM
    // nicht, verschiebt aber das Ziel. Transitionen (Hover) bleiben aussen vor, sie feuern bei jeder Mausbewegung.
    const motion = ['animationend', 'animationcancel'] as const;
    motion.forEach((e) => document.addEventListener(e, schedule, true));
    // Wieder sichtbar: sofort neu messen, nicht erst mit dem naechsten Takt.
    document.addEventListener('visibilitychange', schedule);
    return () => {
      observer.disconnect();
      window.clearInterval(iv);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', schedule, true);
      motion.forEach((e) => document.removeEventListener(e, schedule, true));
      document.removeEventListener('visibilitychange', schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return found;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Bereich, in dem ein Element sichtbar sein kann: Schnitt aller Vorfahren, die ihren Ueberlauf abschneiden, mit dem Fenster. */
function viewArea(el: HTMLElement): Box {
  let left = 0;
  let top = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    if (s.overflowX !== 'visible') {
      left = Math.max(left, pr.left);
      right = Math.min(right, pr.right);
    }
    if (s.overflowY !== 'visible') {
      top = Math.max(top, pr.top);
      bottom = Math.min(bottom, pr.bottom);
    }
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Schnitt von Element und Sichtbereich; null, wenn nichts davon zu sehen ist. */
function intersect(r: DOMRect, a: Box): Box | null {
  const left = Math.max(r.left, a.left);
  const top = Math.max(r.top, a.top);
  const right = Math.min(r.right, a.left + a.width);
  const bottom = Math.min(r.bottom, a.top + a.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

const roundBox = (b: Box): Box => ({
  left: Math.round(b.left),
  top: Math.round(b.top),
  width: Math.round(b.width),
  height: Math.round(b.height),
});

/**
 * Seiten-Einfuehrungen: Beim ersten Besuch einer Seite startet ihre Einfuehrung.
 * Pro Seite eine eigene Leiste unten rechts, kleine Blasen am Ziel, am Ende
 * fliegt der Haken in die Fenstermitte. Texte in copy.ts, Schritte in registry.ts.
 */
export function TourLayer() {
  const { pathname, search } = useLocation();
  const { can, user } = useAuth();
  const { tours, bound } = useTourState();
  const navigate = useNavigate();
  const tour = tourAt(pathname);
  const state = tour ? tours[tour.id] : undefined;
  // Welches Recht gebraucht wird, steht je Einfuehrung (`minRight`): Reine Leserechte genuegen
  // nur dort, wo die Schritte nichts anlegen.
  const total = tour ? visibleStepCount(tour, can) : 0;
  const entryPath = tour?.path ?? '';

  // Sichtbare Schrittzahl je Einfuehrung fuer dieses Konto (vor dem Start, vor Ereignissen).
  useEffect(() => {
    for (const x of TOURS) tourActions.setLimit(x.id, visibleStepCount(x, can));
  }, [can, bound, user?.id]);

  // Erster Besuch: starten, aber nur auf der Einstiegsseite. Erst, wenn der Stand
  // dieser Installation geladen ist. Auf einer weiteren Seite laeuft ein Stand nur weiter.
  useEffect(() => {
    if (tour && bound && !state && pathname.startsWith(entryPath) && total > 0) {
      tourActions.start(tour.id);
      tour.initial?.(search).forEach(tourActions.event);
    }
  }, [tour, bound, state, total, search, pathname, entryPath]);

  // Seitenwechsel: Gehoert der naechste Schritt zu einer anderen Seite als der gerade
  // erledigte und man steht noch dort, wechselt die Ansicht nach kurzer Pause (Meldung
  // und Fuellen des Segments bleiben sichtbar). Wer selbst woanders hingeht, wird nicht umgeleitet.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const seen = useRef<{ id: string; n: number } | null>(null);
  const [enterFor, setEnterFor] = useState<{ id: string; index: number } | null>(null);
  const doneCount = state?.status === 'active' ? state.done.length : -1;
  useEffect(() => {
    if (!tour || doneCount < 0) {
      seen.current = null;
      return;
    }
    const before = seen.current;
    seen.current = { id: tour.id, n: doneCount };
    if (!before || before.id !== tour.id || doneCount <= before.n) return;
    const from = stepPage(tour, tour.steps[doneCount - 1]);
    const next = tour.steps[doneCount];
    if (!next || doneCount >= total) return;
    const to = stepPage(tour, next);
    if (to.path === from.path) return;
    const timer = window.setTimeout(() => {
      if (!pathRef.current.startsWith(from.path)) return;
      setEnterFor({ id: tour.id, index: doneCount });
      navigate(to.path);
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour?.id, doneCount]);

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
      if (
        prev.current?.id === tour.id &&
        prev.current.status === 'active' &&
        state.status === 'done' &&
        !consumeRestored(tour.id) &&
        lastCheck.current
      ) {
        setFinale({ from: lastCheck.current, label: t(`${tour.id}.finale` as CopyKey) });
      }
      prev.current = { id: tour.id, status: state.status };
    } else {
      prev.current = null;
    }
  }, [tour, state]);

  // Ohne sichtbaren Schritt (Recht entzogen, alle sichtbaren erledigt) bleibt die Leiste weg;
  // der Stand bleibt "laeuft" und geht weiter, sobald die Rechte zurueck sind.
  const active = tour && state?.status === 'active' && state.done.length < total ? { tour, state } : null;
  const nextIndex = active ? active.tour.steps.findIndex((_, i) => !active.state.done.includes(i)) : -1;
  const nextStep = active && nextIndex >= 0 && nextIndex < total ? active.tour.steps[nextIndex] : undefined;
  const nextPage = active && nextStep ? stepPage(active.tour, nextStep) : undefined;
  const onPage = !!nextPage && pathname.startsWith(nextPage.path);

  // Der Wechselhinweis gilt nur fuer den Schritt, auf den automatisch gewechselt wurde, und
  // nur bis man die Seite verlaesst oder der Schritt vorbei ist: Kein zweites Mal beim Zurueckkehren.
  const wasOnPage = useRef(false);
  useEffect(() => {
    if (enterFor && (!active || active.tour.id !== enterFor.id || nextIndex !== enterFor.index)) {
      setEnterFor(null);
    } else if (enterFor && wasOnPage.current && !onPage) {
      setEnterFor(null);
    }
    wasOnPage.current = onPage;
  }, [enterFor, active, nextIndex, onPage]);

  return (
    <>
      {active && (
        <TourBar
          tour={active.tour}
          state={active.state}
          total={total}
          goto={nextPage && !onPage ? { key: nextPage.key, path: nextPage.path } : undefined}
        />
      )}
      {active && nextStep && onPage && <TourBlob tour={active.tour} index={nextIndex} step={nextStep} />}
      {active && nextStep && onPage && nextStep.enter && enterFor?.id === active.tour.id && enterFor.index === nextIndex && (
        <TourEnterNotice key={`${active.tour.id}-${nextIndex}`} tour={active.tour} index={nextIndex} />
      )}
      {finale && <TourFinale from={finale.from} label={finale.label} onDone={() => setFinale(null)} />}
    </>
  );
}

function TourBar({
  tour,
  state,
  total,
  goto,
}: {
  tour: TourDef;
  state: TourState;
  total: number;
  goto?: { key: string; path: string };
}) {
  const navigate = useNavigate();
  return (
    <div className="hm-tour-bar" role="status" aria-live="polite">
      <span className="hm-tour__check" aria-hidden="true">
        <Check size={14} strokeWidth={3} />
      </span>
      <span className="hm-tour-bar__segs" aria-hidden="true">
        {tour.steps.slice(0, total).map((_, i) => (
          <i
            key={i}
            className={state.done.includes(i) ? 'is-on' : ''}
            style={{ '--seg': tourColor(i).bg } as React.CSSProperties}
          />
        ))}
      </span>
      <span className="hm-tour-bar__label">
        {t('bar.label', { title: t(`${tour.id}.title` as CopyKey), done: state.done.length, total })}
      </span>
      {goto && (
        <button type="button" className="hm-tour-bar__goto" onClick={() => navigate(goto.path)}>
          {t('bar.goto', { page: t(`${tour.id}.page.${goto.key}` as CopyKey) })}
        </button>
      )}
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

function TourBlob({ tour, index, step }: { tour: TourDef; index: number; step: TourStepDef }) {
  // Reihenfolge zaehlt: Ohne Daten steht der Hinweis vor dem Reiter-Ziel.
  const found = useTarget([step.target, step.emptyTarget, step.altTarget]);
  // Echte Hoehe der Blase (Texte sind unterschiedlich lang); bis zur ersten Messung der Schaetzwert.
  const blobRef = useRef<HTMLDivElement>(null);
  const [blobH, setBlobH] = useState(BLOB_H);
  useLayoutEffect(() => {
    const h = blobRef.current?.offsetHeight;
    if (h && h !== blobH) setBlobH(h);
  });
  if (!found) return null;

  const color = tourColor(index);
  const n = index + 1;
  const kind: 'main' | 'empty' | 'alt' =
    found.name === step.target ? 'main' : found.name === step.emptyTarget ? 'empty' : 'alt';
  const base = `${tour.id}.step${n}`;
  const { box, vw, vh, clip, zone } = found;
  const cx = box.left + box.width / 2;
  // `anchor: 'bottom'` markiert ein Formular, das den Dialog fuellt: gross unabhaengig von der Fensterhoehe,
  // und der Ring umfasst den ganzen Dialog. Sonst entscheidet die volle Hoehe, nicht der gerade sichtbare Teil.
  const dialogForm = !!clip && step.anchor === 'bottom';
  const tall = dialogForm || found.fullHeight > vh * 0.5;
  const ring = dialogForm && clip ? clip : box;
  // `left` gilt nur fuer das eigentliche Ziel; ein Ersatzziel (Knopf auf der Seite) steht normal.
  const placement = step.placement === 'left' && kind !== 'main' ? undefined : step.placement;

  const pos: React.CSSProperties = {};
  let arrow: number | null = null;
  let side: number | null = null;
  let up = false;
  // Ziel im Dialog: Die Blase bleibt innerhalb des Dialogs und haengt nicht ueber seinen Rand.
  const minLeft = clip ? Math.max(12, clip.left + 12) : 12;
  const maxLeft = Math.max(minLeft, (clip ? Math.min(vw, clip.left + clip.width - 12) : vw - 12) - BLOB_W);
  pos.left = clamp(cx - BLOB_W / 2, minLeft, maxLeft);
  if (placement === 'left' && !tall && box.left - GAP - BLOB_W >= 12) {
    // Links neben dem Ziel, auch ausserhalb des Dialogs: So bleibt frei, was darunter steht.
    pos.left = box.left - GAP - BLOB_W;
    pos.top = clamp(box.top + box.height / 2 - blobH / 2, 12, Math.max(12, vh - blobH - 12));
    side = clamp(box.top + box.height / 2 - (pos.top as number), 22, Math.max(22, blobH - 22));
  } else if (placement === 'left' && !tall && clip && box.top - 6 - blobH >= 12) {
    // Links kein Platz (schmales Fenster): rechts im Dialog, endet ueber der Zeile des Ziels (dort steht
    // rechts oft ein Zaehler) und bleibt links vom Schliessen-X. Ohne Zeiger; der Ring zeigt, worum es geht.
    const right = found.clipClose ? found.clipClose - 8 : clip.left + clip.width - 12;
    pos.left = clamp(right - BLOB_W, minLeft, maxLeft);
    pos.bottom = vh - box.top + 6;
  } else if (tall) {
    // Grosses Ziel (Karte): Blase innen, ohne Zeiger. `anchor: 'bottom'` im Dialog: unten
    // rechts ueber der Fusszeile, fuer Formulare mit leerer rechter Spalte.
    if (clip && step.anchor === 'bottom') pos.bottom = vh - Math.min(box.top + box.height, clip.top + clip.height - 84) + 12;
    else pos.top = Math.max(12, box.top) + 56;
    pos.left = clamp(box.left + box.width - BLOB_W - 16, minLeft, maxLeft);
  } else if (
    box.top - GAP - blobH > 12 &&
    (placement === 'above' || box.top + box.height + GAP + blobH > zone)
  ) {
    up = true;
    pos.bottom = vh - box.top + GAP;
    arrow = clamp(cx - (pos.left as number), 22, BLOB_W - 22);
  } else if (box.top + box.height + GAP + blobH > zone) {
    // Weder darueber noch darunter ist Platz (schmales Fenster): Blase ueber der Leiste, ohne Zeiger.
    pos.top = Math.max(12, zone - blobH);
  } else {
    pos.top = box.top + box.height + GAP;
    arrow = clamp(cx - (pos.left as number), 22, BLOB_W - 22);
  }

  const vars = { '--c': color.bg, '--cn': color.on } as React.CSSProperties;

  if (found.offscreen) {
    // Ziel weggescrollt: kein Ring, die Blase steht am Rand des Bereichs, hinter dem es liegt, und zeigt dorthin.
    // Im Dialog nach oben: in der freien Mitte seiner Kopfzeile, ohne Zeiger; so deckt der Hinweis keine Eingabe ab.
    const dir = found.offscreen;
    const offPos: React.CSSProperties = { left: clamp(cx - BLOB_W / 2, minLeft, maxLeft) };
    let pointer = dir !== 'side';
    if (dir === 'up' && clip && box.top - blobH - 2 >= clip.top + 4) {
      offPos.top = box.top - blobH - 2;
      pointer = false;
    } else if (dir === 'up') offPos.top = box.top + 12;
    else if (
      dir === 'down' &&
      clip &&
      found.clipFooter &&
      minLeft + BLOB_W <= found.clipFooter - 8 &&
      box.top + box.height + 2 + blobH <= clip.top + clip.height - 4
    ) {
      // Gegenstueck zur Kopfzeile: in der freien linken Haelfte der Fusszeile, ohne Zeiger.
      offPos.left = minLeft;
      offPos.top = box.top + box.height + 2;
      pointer = false;
    } else if (dir === 'down') offPos.bottom = vh - Math.min(box.top + box.height, zone) + 12;
    else offPos.top = clamp(box.top + box.height / 2 - blobH / 2, 12, Math.max(12, vh - blobH - 12));
    return (
      <div
        key={`${index}-off`}
        ref={blobRef}
        className={`hm-tour-blob${dir === 'down' ? ' is-up' : ''}`}
        style={{ ...vars, ...offPos, width: BLOB_W, ['--ax' as string]: `${BLOB_W / 2}px` }}
        data-arrow={pointer ? 'yes' : 'none'}
        role="note"
      >
        <p className="hm-tour-blob__title hm-tour-blob__title--compact">
          <span className="hm-tour-blob__n">{n}</span>
          {t(`blob.offscreen.${dir}`)}
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        className="hm-tour-ring"
        style={{ ...vars, left: ring.left - 4, top: ring.top - 4, width: ring.width + 8, height: ring.height + 8 }}
        aria-hidden="true"
      />
      <div
        key={`${index}-${found.name}`}
        ref={blobRef}
        className={`hm-tour-blob${up ? ' is-up' : ''}${side !== null ? ' is-left' : ''}`}
        style={{
          ...vars,
          ...pos,
          width: BLOB_W,
          ['--ax' as string]: arrow === null ? undefined : `${arrow}px`,
          ['--ay' as string]: side === null ? undefined : `${side}px`,
        }}
        data-arrow={arrow === null && side === null ? 'none' : 'yes'}
        role="note"
      >
        <p className="hm-tour-blob__title">
          <span className="hm-tour-blob__n">{n}</span>
          {t(`${base}.title` as CopyKey)}
        </p>
        {kind === 'empty' ? (
          <p className="hm-tour-blob__todo">{t(`${base}.empty` as CopyKey)}</p>
        ) : kind === 'alt' ? (
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

/** Wechselhinweis nach dem automatischen Seitenwechsel: ca. 9 s, X, oder bis der Schritt erledigt ist. */
function TourEnterNotice({ tour, index }: { tour: TourDef; index: number }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setOpen(false), 9000);
    return () => window.clearTimeout(timer);
  }, []);
  if (!open) return null;
  const color = tourColor(index);
  return (
    <div
      className="hm-tour-notice"
      style={{ '--c': color.bg, '--cn': color.on } as React.CSSProperties}
      role="status"
      aria-live="polite"
    >
      <span className="hm-tour-blob__n">
        <ArrowRightLeft size={12} strokeWidth={2.5} />
      </span>
      <p>{t(`${tour.id}.step${index + 1}.enter` as CopyKey)}</p>
      <Tooltip content={<div className="hm-tooltip__title">{t('notice.close')}</div>}>
        <button type="button" className="hm-tour-bar__skip hm-tour-notice__close" aria-label={t('notice.close')} onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </Tooltip>
    </div>
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
