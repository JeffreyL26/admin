import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Auswahlfeld in Portal-Optik, Ersatz für das native <select>.
 *
 * Spiegel von `apps/renderer/src/components/Select.tsx`: Die aufgeklappte
 * Liste eines nativen <select> zeichnet das Betriebssystem, nicht die
 * Anwendung; hier ist sie gewöhnliches HTML im Portal am <body>, themebar und
 * von keinem `overflow: hidden` beschnitten. Optionen kommen als
 * <option>-Kinder, `onChange` liefert `target.value` als String.
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
  required?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
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

function collectOptions(children: React.ReactNode, into: Option[] = []): Option[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === 'option') {
      const props = child.props as { value?: string | number; disabled?: boolean; children?: React.ReactNode };
      const label = textOf(props.children).replace(/\s+/g, ' ').trim();
      into.push({ value: props.value !== undefined ? String(props.value) : label, label, disabled: Boolean(props.disabled) });
      return;
    }
    const props = child.props as { children?: React.ReactNode };
    if (props.children !== undefined) collectOptions(props.children, into);
  });
  return into;
}

export function Select({ value, onChange, children, disabled, className, style, id, required, ...aria }: Props) {
  const options = useMemo(() => collectOptions(children), [children]);
  const current = value === null || value === undefined ? '' : String(value);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === current));
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

  const enabledIndexes = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [options]);
  const step = (from: number, dir: 1 | -1): number => {
    if (enabledIndexes.length === 0) return from;
    const at = enabledIndexes.indexOf(from);
    if (at === -1) return dir === 1 ? enabledIndexes[0]! : enabledIndexes[enabledIndexes.length - 1]!;
    return enabledIndexes[Math.min(enabledIndexes.length - 1, Math.max(0, at + dir))]!;
  };
  const jumpByText = (key: string): number | null => {
    const now = Date.now();
    const prev = typeahead.current;
    const text = (now - prev.at < 600 ? prev.text : '') + key.toLowerCase();
    typeahead.current = { text, at: now };
    const start = open ? active : selectedIndex;
    const single = text.length > 1 && text.split('').every((c) => c === text[0]);
    const needle = single ? text[0]! : text;
    const order = [...enabledIndexes.filter((i) => i > start), ...enabledIndexes.filter((i) => i <= start)];
    for (const i of order) if (options[i]!.label.toLowerCase().startsWith(needle)) return i;
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
    const width = r.width;
    const left = Math.max(RAND, Math.min(r.left, window.innerWidth - width - RAND));
    const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, flip ? above : below));
    setPos({ top: flip ? Math.max(RAND, r.top - GAP - Math.min(height, maxHeight)) : r.bottom + GAP, left, width, maxHeight });
  }, []);

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
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
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

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onButtonKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) return openMenu();
      const next = step(selectedIndex, e.key === 'ArrowDown' ? 1 : -1);
      if (options[next]) emit(options[next]!.value);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const idx = jumpByText(e.key);
      if (idx !== null) emit(options[idx]!.value);
    }
  };

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => step(a, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const option = options[active];
      if (option && !option.disabled) emit(option.value);
      closeMenu();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      closeMenu(false);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const idx = jumpByText(e.key);
      if (idx !== null) setActive(idx);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        className={`pt-select pt-select--btn${className ? ` ${className.replace(/\bpt-select\b/g, '').trim()}` : ''}`}
        style={style}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-required={required || undefined}
        aria-label={aria['aria-label']}
        aria-invalid={aria['aria-invalid']}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onButtonKey}
      >
        <span className="pt-select__value">{selected?.label ?? ''}</span>
        <svg className="pt-select__chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className="pt-select-menu"
            aria-activedescendant={`${listId}-${active}`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: pos?.width,
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
                className={`pt-select-option${i === active ? ' is-active' : ''}${i === selectedIndex ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}
                onMouseMove={() => !option.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (option.disabled) return;
                  emit(option.value);
                  closeMenu();
                }}
              >
                <span className="pt-select-option__label">{option.label || ' '}</span>
                {i === selectedIndex && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
