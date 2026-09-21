import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Pipette } from 'lucide-react';
import { clamp01, hsvFromHex, hsvToHex, hsvToRgb, normalizeHex, rgbToHex, type Hsv, type Rgb } from '@ohrganize/shared';
import { Popover } from './Popover';
import { Tooltip } from './Tooltip';

/**
 * Eigener Farbwähler als Ersatz für `<input type="color">`.
 *
 * WARUM: Das Pop-up des nativen Farbfelds zeichnet Chromium außerhalb des DOM,
 * es kennt weder die Tokens noch das gewählte Theme. Dieses Panel sitzt im
 * `Popover` (Portal, `position: fixed`) und nimmt alle Farben aus den Tokens;
 * physikalisch bleiben nur die Farbfläche, die Farbtonspur und die Griffe.
 *
 * Quelle der Wahrheit ist HSV, nicht der Hex-Wert: Grau, Schwarz und Weiß
 * tragen keinen Farbton, Schwarz keine Sättigung. Würde der Zustand aus dem
 * Hex abgeleitet, spränge der Farbtonregler beim Ziehen an den Rand auf Rot.
 *
 * Beide Aufrufstellen liegen in einem Modal. Dessen Fokus-Trap und
 * Escape-Listener sehen das portalierte Panel als „draußen“, deshalb behandelt
 * das Panel Tab und Escape selbst und stoppt die Weitergabe.
 */
export interface ColorPickerProps {
  /** Aktuelle Farbe; Kurzform, fehlendes `#` und Großschreibung werden toleriert. */
  value: string;
  /** Liefert immer `#rrggbb` in Kleinbuchstaben, nur nach Nutzereingriff. */
  onChange: (hex: string) => void;
  /** Zugänglicher Name; der kompakte Auslöser hat keinen sichtbaren Text. */
  label: string;
  /** Nur Farbfeld als Auslöser (44 x 32 px) mit Tooltip. */
  compact?: boolean;
  disabled?: boolean;
  align?: 'left' | 'right';
  id?: string;
  className?: string;
  style?: React.CSSProperties;
}

interface EyeDropperApi {
  open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>;
}

const eyeDropperCtor = (): (new () => EyeDropperApi) | null =>
  'EyeDropper' in window ? (window as unknown as { EyeDropper: new () => EyeDropperApi }).EyeDropper : null;

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const PANEL_WIDTH = 276;
const FULL_HEX = /^#?[0-9a-f]{6}$/i;
const HEX_ERROR = 'Ungültig: 3 oder 6 Hex-Ziffern (0 bis 9, A bis F)';

type CloseReason = 'escape' | 'confirm' | 'trigger' | 'outside';

/**
 * Zeigerbedienung für Farbfläche und Farbtonspur: Erfassung sofort beim
 * Drücken (jeder Klick ist eine Wahl), Bewegungen je Frame gebündelt, Capture
 * hält das Ziehen auch außerhalb des Panels. Das `preventDefault` unterdrückt
 * in Chromium das implizite Fokussieren, deshalb wird explizit fokussiert.
 */
function usePointerDrag(apply: (x: number, y: number, el: HTMLElement) => void) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const drag = useRef<{ pointerId: number | null; pending: { x: number; y: number } | null; raf: number }>({
    pointerId: null,
    pending: null,
    raf: 0,
  });

  useEffect(() => () => cancelAnimationFrame(drag.current.raf), []);

  const flush = (el: HTMLElement) => {
    const d = drag.current;
    if (d.raf) {
      cancelAnimationFrame(d.raf);
      d.raf = 0;
    }
    if (d.pending) {
      const p = d.pending;
      d.pending = null;
      applyRef.current(p.x, p.y, el);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    drag.current.pointerId = e.pointerId;
    applyRef.current(e.clientX, e.clientY, el);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d.pointerId !== e.pointerId) return;
    d.pending = { x: e.clientX, y: e.clientY };
    if (!d.raf) {
      const el = e.currentTarget;
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        flush(el);
      });
    }
  };
  const end = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d.pointerId !== e.pointerId) return;
    flush(e.currentTarget);
    d.pointerId = null;
  };

  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end };
}

const CHANNELS: { key: keyof Rgb; name: string; short: string }[] = [
  { key: 'r', name: 'Rot', short: 'R' },
  { key: 'g', name: 'Grün', short: 'G' },
  { key: 'b', name: 'Blau', short: 'B' },
];

export function ColorPicker({
  value,
  onChange,
  label,
  compact = false,
  disabled = false,
  align = 'left',
  id,
  className,
  style,
}: ColorPickerProps) {
  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const panelId = `${autoId}-panel`;
  const hexId = `${autoId}-hex`;
  const hexErrorId = `${autoId}-hex-error`;

  const [hsv, setHsv] = useState<Hsv>(() => hsvFromHex(normalizeHex(value) ?? '#000000', { h: 0, s: 0, v: 0 }));
  const hsvRef = useRef(hsv);
  // Der Hex, den der Aufrufer nach unserem Wissen hält: gesetzt beim Abgleich
  // mit dem Prop und beim Melden. Nur davon abweichende Werte werden gemeldet.
  const knownHexRef = useRef<string | null>(normalizeHex(value));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const setOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  }, []);

  const [hexDraft, setHexDraftState] = useState<string | null>(null);
  const hexDraftRef = useRef<string | null>(null);
  const setHexDraft = useCallback((next: string | null) => {
    hexDraftRef.current = next;
    setHexDraftState(next);
  }, []);
  const [hexInvalid, setHexInvalid] = useState(false);
  const [rgbDraft, setRgbDraft] = useState<(string | null)[]>([null, null, null]);
  const [announcement, setAnnouncement] = useState('');

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const pipetteRef = useRef<HTMLButtonElement>(null);
  const pickingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const labelGuardRef = useRef(false);
  const [EyeDropperCtor] = useState(eyeDropperCtor);

  useLayoutEffect(() => {
    const norm = normalizeHex(value);
    knownHexRef.current = norm;
    if (norm === null) return;
    if (hsvToHex(hsvRef.current) === norm) return;
    const next = hsvFromHex(norm, hsvRef.current);
    hsvRef.current = next;
    setHsv(next);
  }, [value]);

  const commit = useCallback((next: Hsv) => {
    if (disabledRef.current) return;
    hsvRef.current = next;
    setHsv(next);
    const hex = hsvToHex(next);
    if (hex !== knownHexRef.current) {
      knownHexRef.current = hex;
      onChangeRef.current(hex);
    }
  }, []);
  const commitHex = useCallback((hex6: string) => commit(hsvFromHex(hex6, hsvRef.current)), [commit]);

  const close = useCallback(
    (reason: CloseReason) => {
      if (pickingRef.current || !openRef.current) return;
      const draft = hexDraftRef.current;
      if (reason !== 'escape' && draft !== null) {
        const norm = normalizeHex(draft);
        if (norm) commitHex(norm);
      }
      const wasInside = panelRef.current?.contains(document.activeElement) ?? false;
      abortRef.current?.abort();
      setHexDraft(null);
      setHexInvalid(false);
      setRgbDraft([null, null, null]);
      setAnnouncement('');
      setOpen(false);
      if (wasInside || reason !== 'outside') triggerRef.current?.focus({ preventScroll: true });
    },
    [commitHex, setHexDraft, setOpen],
  );
  const onPopoverClose = useCallback(() => close('outside'), [close]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (disabled) close('escape');
  }, [disabled, close]);

  // Field ist ein <label>: Ein Klick auf die Beschriftung schließt das Panel
  // über den Außenklick des Popovers und reicht dann einen Klick an den
  // Auslöser weiter, der es sofort wieder öffnete. Der Wächter merkt sich den
  // Fall beim Drücken und lässt den Auslöser den weitergereichten Klick schlucken.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      const trigger = triggerRef.current;
      labelGuardRef.current = Boolean(
        openRef.current && trigger && target && !trigger.contains(target) && target.closest('label')?.contains(trigger),
      );
    };
    const onKey = () => {
      labelGuardRef.current = false;
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  // Fokus erst, wenn das Popover gemessen und sichtbar ist; vorher steht es
  // bei -9999 und ein unsichtbares Element nimmt keinen Fokus an. Ein Timer
  // statt requestAnimationFrame, weil der in verdeckten Fenstern nicht feuert.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => areaRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const hex = hsvToHex(hsv);
  const valid = normalizeHex(value) !== null;
  const display = valid ? hex.toUpperCase() : value;
  const rgb = hsvToRgb(hsv);

  const onTriggerClick = () => {
    if (labelGuardRef.current) {
      labelGuardRef.current = false;
      return;
    }
    if (openRef.current) close('trigger');
    else if (!disabled) setOpen(true);
  };
  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !openRef.current && !disabled) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'Escape' && openRef.current) {
      e.preventDefault();
      e.stopPropagation();
      close('escape');
    }
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.stopPropagation();
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close('escape');
      return;
    }
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      e.stopPropagation();
      close('confirm');
    }
  };
  const onPanelBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (!to) return;
    if (panelRef.current?.contains(to) || triggerRef.current?.contains(to)) return;
    close('outside');
  };

  const areaDrag = usePointerDrag((x, y, el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    commit({ h: hsvRef.current.h, s: clamp01((x - r.left) / r.width), v: 1 - clamp01((y - r.top) / r.height) });
  });
  const hueDrag = usePointerDrag((x, _y, el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    commit({ ...hsvRef.current, h: clamp01((x - r.left) / r.width) * 360 });
  });

  const onAreaKeyDown = (e: React.KeyboardEvent) => {
    const cur = hsvRef.current;
    const step = e.shiftKey ? 0.1 : 0.01;
    let next: Hsv;
    switch (e.key) {
      case 'ArrowLeft': next = { ...cur, s: clamp01(cur.s - step) }; break;
      case 'ArrowRight': next = { ...cur, s: clamp01(cur.s + step) }; break;
      case 'ArrowUp': next = { ...cur, v: clamp01(cur.v + step) }; break;
      case 'ArrowDown': next = { ...cur, v: clamp01(cur.v - step) }; break;
      case 'Home': next = { ...cur, s: 0 }; break;
      case 'End': next = { ...cur, s: 1 }; break;
      case 'PageUp': next = { ...cur, v: clamp01(cur.v + 0.1) }; break;
      case 'PageDown': next = { ...cur, v: clamp01(cur.v - 0.1) }; break;
      default: return;
    }
    e.preventDefault();
    commit(next);
  };
  const onHueKeyDown = (e: React.KeyboardEvent) => {
    const cur = hsvRef.current;
    const step = e.shiftKey ? 10 : 1;
    const clampHue = (h: number) => Math.min(360, Math.max(0, h));
    let h: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': h = clampHue(cur.h + step); break;
      case 'ArrowLeft':
      case 'ArrowDown': h = clampHue(cur.h - step); break;
      case 'PageUp': h = clampHue(cur.h + 10); break;
      case 'PageDown': h = clampHue(cur.h - 10); break;
      case 'Home': h = 0; break;
      case 'End': h = 360; break;
      default: return;
    }
    e.preventDefault();
    commit({ ...cur, h });
  };

  const onHexChange = (raw: string) => {
    setHexDraft(raw);
    setHexInvalid(false);
    setAnnouncement('');
    if (FULL_HEX.test(raw.replace(/\s+/g, ''))) commitHex(normalizeHex(raw)!);
  };
  const onHexBlur = () => {
    if (!openRef.current) return;
    const draft = hexDraftRef.current;
    if (draft !== null) {
      const norm = normalizeHex(draft);
      if (norm) commitHex(norm);
      else setAnnouncement(`Ungültiger Hex-Wert verworfen, ${display} bleibt`);
    }
    setHexDraft(null);
    setHexInvalid(false);
  };
  const onHexKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const norm = normalizeHex(hexDraftRef.current ?? '');
    if (norm) {
      commitHex(norm);
      setHexDraft(null);
      close('confirm');
    } else {
      setHexInvalid(true);
      setAnnouncement(HEX_ERROR);
    }
  };

  const setChannelDraft = (index: number, next: string | null) =>
    setRgbDraft((prev) => prev.map((d, i) => (i === index ? next : d)));
  const commitChannel = (key: keyof Rgb, n: number) => commitHex(rgbToHex({ ...hsvToRgb(hsvRef.current), [key]: n }));

  const onPipette = () => {
    if (!EyeDropperCtor) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    pickingRef.current = true;
    new EyeDropperCtor()
      .open({ signal: ctrl.signal })
      .then((res) => {
        const norm = normalizeHex(res.sRGBHex);
        if (norm) {
          commitHex(norm);
          setAnnouncement(`Farbe ${norm.toUpperCase()} übernommen`);
        }
      })
      .catch(() => {})
      .finally(() => {
        pickingRef.current = false;
        abortRef.current = null;
        pipetteRef.current?.focus({ preventScroll: true });
      });
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      id={triggerId}
      className={`hm-input hm-color${compact ? ' hm-color--compact' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={`${label}: ${display}`}
      onClick={onTriggerClick}
      onKeyDown={onTriggerKeyDown}
    >
      <span className="hm-color__swatch" style={{ background: valid ? hex : undefined }} aria-hidden="true" />
      {!compact && <span className="hm-color__hex">{display}</span>}
      {!compact && <ChevronDown size={15} className="hm-color__chev" aria-hidden="true" />}
    </button>
  );

  return (
    <span className="hm-color-wrap">
      {compact ? (
        <Tooltip
          content={
            open ? null : (
              <>
                <div className="hm-tooltip__title">{label}</div>
                <div className="hm-tooltip__line">{display}</div>
              </>
            )
          }
        >
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Popover
        open={open}
        onClose={onPopoverClose}
        anchorRef={triggerRef}
        align={align}
        minWidth={PANEL_WIDTH}
        maxWidth={PANEL_WIDTH}
      >
        <div
          id={panelId}
          ref={panelRef}
          className="hm-color-panel"
          role="dialog"
          aria-label={`${label} wählen`}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          onBlur={onPanelBlur}
        >
          <div
            ref={areaRef}
            className="hm-color-panel__area"
            role="slider"
            tabIndex={0}
            aria-roledescription="2D-Schieberegler"
            aria-label="Sättigung und Helligkeit"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.v * 100)}
            aria-valuetext={`Sättigung ${Math.round(hsv.s * 100)} %, Helligkeit ${Math.round(hsv.v * 100)} %`}
            style={{
              background: `linear-gradient(to top, #000, rgb(0 0 0 / 0)), linear-gradient(to right, #fff, rgb(255 255 255 / 0)), hsl(${hsv.h} 100% 50%)`,
            }}
            onKeyDown={onAreaKeyDown}
            {...areaDrag}
          >
            <span
              className="hm-color-panel__thumb"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
              aria-hidden="true"
            />
          </div>
          <div className="hm-color-panel__row">
            <div
              className="hm-color-panel__hue"
              role="slider"
              tabIndex={0}
              aria-label="Farbton"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(hsv.h)}
              aria-valuetext={`${Math.round(hsv.h)} Grad`}
              onKeyDown={onHueKeyDown}
              {...hueDrag}
            >
              <span
                className="hm-color-panel__thumb hm-color-panel__thumb--hue"
                style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
                aria-hidden="true"
              />
            </div>
            {EyeDropperCtor && (
              <Tooltip content="Farbe vom Bildschirm aufnehmen">
                <button
                  ref={pipetteRef}
                  type="button"
                  className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                  aria-label="Farbe vom Bildschirm aufnehmen"
                  onClick={onPipette}
                >
                  <Pipette size={15} />
                </button>
              </Tooltip>
            )}
          </div>
          <div className="hm-color-panel__row hm-color-panel__fields">
            <div className="hm-color-panel__field hm-color-panel__field--hex">
              <label htmlFor={hexId}>Hex</label>
              <input
                id={hexId}
                className="hm-input hm-color-panel__input"
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label="Hex-Wert"
                aria-invalid={hexInvalid || undefined}
                aria-describedby={hexInvalid ? hexErrorId : undefined}
                value={hexDraft ?? display}
                onFocus={() => setHexDraft(display)}
                onChange={(e) => onHexChange(e.target.value)}
                onBlur={onHexBlur}
                onKeyDown={onHexKeyDown}
              />
            </div>
            {CHANNELS.map((c, i) => {
              const fieldId = `${autoId}-${c.key}`;
              return (
                <div className="hm-color-panel__field" key={c.key}>
                  <label htmlFor={fieldId}>{c.short}</label>
                  <input
                    id={fieldId}
                    className="hm-input hm-color-panel__input"
                    type="text"
                    inputMode="numeric"
                    maxLength={3}
                    autoComplete="off"
                    aria-label={c.name}
                    role="spinbutton"
                    aria-valuemin={0}
                    aria-valuemax={255}
                    aria-valuenow={rgb[c.key]}
                    value={rgbDraft[i] ?? String(rgb[c.key])}
                    onFocus={() => setChannelDraft(i, String(rgb[c.key]))}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/\D/g, '');
                      if (raw === '') {
                        setChannelDraft(i, '');
                        return;
                      }
                      const n = Math.min(255, Number(raw));
                      setChannelDraft(i, String(n));
                      commitChannel(c.key, n);
                    }}
                    onBlur={() => setChannelDraft(i, null)}
                    onKeyDown={(e) => {
                      const cur = hsvToRgb(hsvRef.current)[c.key];
                      let n: number;
                      switch (e.key) {
                        case 'ArrowUp': n = Math.min(255, cur + (e.shiftKey ? 10 : 1)); break;
                        case 'ArrowDown': n = Math.max(0, cur - (e.shiftKey ? 10 : 1)); break;
                        case 'Home': n = 0; break;
                        case 'End': n = 255; break;
                        default: return;
                      }
                      e.preventDefault();
                      setChannelDraft(i, String(n));
                      commitChannel(c.key, n);
                    }}
                  />
                </div>
              );
            })}
          </div>
          {hexInvalid && (
            <span id={hexErrorId} className="hm-field__error hm-color-panel__error">
              {HEX_ERROR}
            </span>
          )}
          <span className="hm-sr-only" aria-live="polite">
            {announcement}
          </span>
        </div>
      </Popover>
    </span>
  );
}
