import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Popover } from './Popover';

/**
 * Auswahlfeld mit Mehrfachauswahl.
 *
 * Ein natives <select multiple> wäre die naheliegende Wahl, ist aber in der
 * Praxis unbedienbar: Man muss Strg gedrückt halten, und die Liste frisst
 * dauerhaft Platz in der Filterzeile. Deshalb ein Knopf mit ausklappbarer
 * Ankreuzliste — Auswahl bleibt sichtbar, ohne die Zeile zu sprengen.
 *
 * Die Liste hängt an einem Popover (Portal am <body>), NICHT als
 * `position: absolute` im Elternelement: Die Filterzeile steht in einer Karte
 * mit `overflow: hidden`, die ein eingebettetes Panel abschneiden würde.
 *
 * Leere Auswahl bedeutet immer „kein Filter“, nicht „nichts anzeigen“.
 */
export interface MultiSelectOption<T extends string | number> {
  value: T;
  label: string;
  /** Optionaler Zusatz rechts, z. B. Trefferzahl. */
  hint?: string;
}

interface Props<T extends string | number> {
  /** Beschriftung, solange nichts gewählt ist (z. B. „Alle Typen“). */
  allLabel: string;
  options: MultiSelectOption<T>[];
  value: T[];
  onChange: (next: T[]) => void;
  /** Suchfeld einblenden — sinnvoll ab etwa zehn Einträgen. */
  searchable?: boolean;
  width?: number;
}

export function MultiSelect<T extends string | number>({
  allLabel,
  options,
  value,
  onChange,
  searchable = false,
  width = 180,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && searchable) {
      // Nach dem Positionieren fokussieren, sonst springt die Seite.
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    if (!open) setTerm('');
  }, [open, searchable]);

  const shown = useMemo(() => {
    if (!term.trim()) return options;
    const t = term.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(t));
  }, [options, term]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  const toggle = (v: T) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next]);
  };

  const label =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? '1 ausgewählt')
        : `${value.length} ausgewählt`;

  return (
    <div className="hm-multi" style={{ width }}>
      <button
        ref={buttonRef}
        type="button"
        className={`hm-multi__button${value.length ? ' hm-multi__button--active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="hm-multi__label">{label}</span>
        {value.length > 0 && (
          <span
            className="hm-multi__clear"
            role="button"
            tabIndex={0}
            aria-label={`${allLabel}: Auswahl aufheben`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onChange([]);
              }
            }}
          >
            <X size={13} />
          </span>
        )}
        <ChevronDown size={14} className="hm-multi__chevron" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} minWidth={width}>
        <div role="listbox" aria-multiselectable="true" aria-label={allLabel}>
          {searchable && (
            <div className="hm-multi__search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Suchen …"
                aria-label="Optionen durchsuchen"
              />
            </div>
          )}
          <div className="hm-multi__list">
            {shown.length === 0 ? (
              <div className="hm-multi__empty">Kein Treffer</div>
            ) : (
              shown.map((o) => {
                const on = selectedSet.has(o.value);
                return (
                  <button
                    type="button"
                    key={String(o.value)}
                    className={`hm-multi__option${on ? ' hm-multi__option--on' : ''}`}
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(o.value)}
                  >
                    <span className="hm-multi__tick">{on && <Check size={13} />}</span>
                    <span className="hm-multi__text">{o.label}</span>
                    {o.hint !== undefined && <span className="hm-multi__hint">{o.hint}</span>}
                  </button>
                );
              })
            )}
          </div>
          {value.length > 0 && (
            <button type="button" className="hm-multi__reset" onClick={() => onChange([])}>
              Auswahl aufheben
            </button>
          )}
        </div>
      </Popover>
    </div>
  );
}
