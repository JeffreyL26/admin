import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Auswahlfeld in App-Optik, Ersatz für das native <select>.
 *
 * WARUM: Die aufgeklappte Liste eines nativen <select> zeichnet das
 * Betriebssystem, nicht die Anwendung: Windows-Grau, Systemschrift, kein
 * Theme, keine Abrundung. In einer App mit eigener Titelleiste und vier
 * Farbschemata fällt genau dieses Element aus dem Bild. Die Liste hier ist
 * gewöhnliches HTML im Portal am <body> (wie Popover und Tooltip), also
 * themebar und von keinem `overflow: hidden` einer Karte beschnitten.
 *
 * DROP-IN: Die Optionen kommen wie gewohnt als <option>-Kinder, `value` und
 * `onChange` funktionieren wie beim nativen Element; `onChange` bekommt ein
 * Objekt mit `target.value` (immer ein String, wie im DOM). So bleiben die
 * Aufrufstellen unverändert, nur der Tag heißt anders.
 *
 * Tastatur wie nativ: Pfeile wechseln den Wert auch bei geschlossener Liste,
 * Enter/Leertaste öffnen, Escape schließt, Buchstaben springen zum nächsten
 * passenden Eintrag. ARIA: Auslöser als combobox, Liste als listbox.
 */

export interface SelectChangeEvent {
  target: { value: string };
}

interface Option {
  value: string;
  label: string;
  disabled: boolean;
}

interface Props {
  value?: string | number | null;
  onChange?: (event: SelectChangeEvent) => void;
  children?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
  name?: string;
  required?: boolean;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
  /** Mindestbreite der Liste; ohne Angabe so breit wie das Feld. */
  menuMinWidth?: number;
}

const GAP = 4;
const RAND = 8;
const MENU_MAX_HEIGHT = 320;

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Sammelt die <option>-Kinder, auch aus Arrays und Fragmenten. */
function collectOptions(children: React.ReactNode, into: Option[] = []): Option[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === 'option') {
      const props = child.props as { value?: string | number; disabled?: boolean; children?: React.ReactNode };
      const label = textOf(props.children).replace(/\s+/g, ' ').trim();
      into.push({
        value: props.value !== undefined ? String(props.value) : label,
        label,
        disabled: Boolean(props.disabled),
      });
      return;
    }
    const props = child.props as { children?: React.ReactNode };
    if (props.children !== undefined) collectOptions(props.children, into);
  });
  return into;
}

export function Select({
  value,
  onChange,
  children,
  disabled,
  className,
  style,
  id,
  name,
  required,
  autoFocus,
  menuMinWidth,
  ...aria
}: Props) {
  const options = useMemo(() => collectOptions(children), [children]);
  const current = value === null || value === undefined ? '' : String(value);
  // Wie das native Element: Passt der Wert zu keiner Option, steht die erste da.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );
  const selected = options[selectedIndex];

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const listId = useId();

  const emit = useCallback(
    (next: string) => {
      if (next !== current) onChange?.({ target: { value: next } });
    },
    [current, onChange],
  );

  const enabledIndexes = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [options],
  );

  /** Nächster wählbarer Eintrag ab `from` in Richtung `dir`. */
  const step = (from: number, dir: 1 | -1): number => {
    if (enabledIndexes.length === 0) return from;
    const pos = enabledIndexes.indexOf(from);
    if (pos === -1) return dir === 1 ? enabledIndexes[0]! : enabledIndexes[enabledIndexes.length - 1]!;
    const next = Math.min(enabledIndexes.length - 1, Math.max(0, pos + dir));
    return enabledIndexes[next]!;
  };

  const jumpByText = (key: string): number | null => {
    const now = Date.now();
    const prev = typeahead.current;
    const text = (now - prev.at < 600 ? prev.text : '') + key.toLowerCase();
    typeahead.current = { text, at: now };
    const start = open ? active : selectedIndex;
    // Bei wiederholtem gleichen Buchstaben zyklisch weiterspringen.
    const single = text.length > 1 && text.split('').every((c) => c === text[0]);
    const needle = single ? text[0]! : text;
    const order = [...enabledIndexes.filter((i) => i > start), ...enabledIndexes.filter((i) => i <= start)];
    for (const i of order) {
      if (options[i]!.label.toLowerCase().startsWith(needle)) return i;
    }
    return null;
  };

  const measure = useCallback(() => {
    const anchor = buttonRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const height = Math.min(MENU_MAX_HEIGHT, listRef.current?.scrollHeight ?? MENU_MAX_HEIGHT) + 12;
    const below = window.innerHeight - r.bottom - GAP - RAND;
    const above = r.top - GAP - RAND;
    const flip = height > below && above > below;
    const width = Math.max(r.width, menuMinWidth ?? 0);
    const left = Math.max(RAND, Math.min(r.left, window.innerWidth - width - RAND));
    const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, flip ? above : below));
    setPos({ top: flip ? Math.max(RAND, r.top - GAP - Math.min(height, maxHeight)) : r.bottom + GAP, left, width, maxHeight });
  }, [menuMinWidth]);

  // Nach einer Tastenauswahl in der Liste erhält der Knopf den Fokus zurück,
  // während dieselbe Taste noch gedrückt ist; das Keyup/Keypress landet dann
  // auf dem Knopf und würde die Liste sofort wieder öffnen. Kurze Sperre.
  const reopenGuard = useRef(0);
  const guarded = () => Date.now() < reopenGuard.current;

  const openMenu = () => {
    if (guarded()) return;
    if (disabled || options.length === 0) return;
    setActive(selected && !selected.disabled ? selectedIndex : step(-1, 1));
    setOpen(true);
  };
  const closeMenu = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) {
      reopenGuard.current = Date.now() + 200;
      buttonRef.current?.focus();
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [open, measure, options]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (listRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      closeMenu(false);
    };
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      measure();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', measure);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  // Fokus erst, wenn die Liste positioniert und sichtbar ist: Ein Element mit
  // visibility: hidden nimmt keinen Fokus an, die Tastatur bliebe am Knopf.
  const positioned = pos !== null;
  useEffect(() => {
    if (open && positioned) listRef.current?.focus({ preventScroll: true });
  }, [open, positioned]);

  // Markierten Eintrag im Sichtfenster halten.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onButtonKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (e.altKey) {
          openMenu();
          return;
        }
        const next = step(selectedIndex, e.key === 'ArrowDown' ? 1 : -1);
        if (options[next]) emit(options[next]!.value);
        return;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        openMenu();
        return;
      case 'Home':
      case 'End': {
        e.preventDefault();
        const idx = e.key === 'Home' ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1];
        if (idx !== undefined) emit(options[idx]!.value);
        return;
      }
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const idx = jumpByText(e.key);
          if (idx !== null) emit(options[idx]!.value);
        }
    }
  };

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => step(a, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => step(a, -1));
        return;
      case 'Home':
        e.preventDefault();
        if (enabledIndexes[0] !== undefined) setActive(enabledIndexes[0]);
        return;
      case 'End':
        e.preventDefault();
        if (enabledIndexes.length) setActive(enabledIndexes[enabledIndexes.length - 1]!);
        return;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const option = options[active];
        if (option && !option.disabled) emit(option.value);
        closeMenu();
        return;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return;
      case 'Tab':
        closeMenu(false);
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          const idx = jumpByText(e.key);
          if (idx !== null) setActive(idx);
        }
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        name={name}
        className={`hm-select hm-select--btn${className ? ` ${className.replace(/\bhm-select\b/g, '').trim()}` : ''}`}
        style={style}
        disabled={disabled}
        autoFocus={autoFocus}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-required={required || undefined}
        aria-label={aria['aria-label']}
        aria-labelledby={aria['aria-labelledby']}
        aria-invalid={aria['aria-invalid']}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onButtonKey}
      >
        <span className="hm-select__value">{selected?.label ?? ''}</span>
        <ChevronDown size={15} className="hm-select__chev" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className="hm-select-menu"
            aria-activedescendant={`${listId}-${active}`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              minWidth: pos?.width,
              maxWidth: `calc(100vw - ${2 * RAND}px)`,
              maxHeight: pos?.maxHeight,
              visibility: pos ? 'visible' : 'hidden',
            }}
            onKeyDown={onListKey}
          >
            {options.map((option, i) => (
              <div
                key={`${option.value}-${i}`}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === selectedIndex}
                aria-disabled={option.disabled || undefined}
                className={`hm-select-option${i === active ? ' is-active' : ''}${i === selectedIndex ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}
                onMouseMove={() => !option.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (option.disabled) return;
                  emit(option.value);
                  closeMenu();
                }}
              >
                <span className="hm-select-option__label">{option.label || ' '}</span>
                {i === selectedIndex && <Check size={14} className="hm-select-option__check" aria-hidden="true" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
