import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { Popover } from './Popover';
import { keepTabInPanel, useLabelClickGuard } from './panelKeys';

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
 * Weil das Panel damit außerhalb eines Modals liegt, dessen Fokusfalle und
 * Escape es als „draußen“ sähen, behandelt es Tab und Escape selbst und
 * stoppt die Weitergabe (panelKeys.ts, wie ColorPicker).
 *
 * Leere Auswahl bedeutet als Filter immer „kein Filter“, nicht „nichts anzeigen“.
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
  /** Breite in Pixeln oder als CSS-Wert (z. B. '100%' im Formular). */
  width?: number | string;
  /**
   * Als Formularfeld statt als Filter: gewählte Einträge namentlich statt
   * „2 ausgewählt“, Auslöser wie das Auswahlfeld (.hm-select), ohne die
   * Hervorhebung des aktiven Filters.
   */
  field?: boolean;
  /** Zugänglicher Name der Liste; ohne Angabe `allLabel` (bei Filtern ihr Name). */
  label?: string;
  /** Höchstzahl wählbarer Einträge; danach sind die übrigen gesperrt. */
  max?: number;
}

export function MultiSelect<T extends string | number>({
  allLabel,
  options,
  value,
  onChange,
  searchable = false,
  width = 180,
  field = false,
  label: name = allLabel,
  max,
}: Props<T>) {
  const [open, setOpenState] = useState(false);
  const [term, setTerm] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(false);
  const setOpen = (next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  };

  useEffect(() => {
    if (open && searchable) {
      // Nach dem Positionieren fokussieren, sonst springt die Seite.
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    if (!open) setTerm('');
  }, [open, searchable]);

  // Steht das Feld in einem <label> (Field): Klick auf die Beschriftung bei
  // offener Liste nicht gleich wieder öffnen (panelKeys.ts).
  const labelGuard = useLabelClickGuard(buttonRef, open);

  const shown = useMemo(() => {
    if (!term.trim()) return options;
    const t = term.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(t));
  }, [options, term]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const full = max !== undefined && value.length >= max;

  const toggle = (v: T) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else if (!full) next.add(v);
    onChange([...next]);
  };

  const onTriggerClick = () => {
    if (labelGuard.swallow()) return;
    setOpen(!openRef.current);
  };

  const closeToTrigger = () => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
      return;
    }
    if (e.key === 'Tab') keepTabInPanel(e, panelRef.current);
  };

  const optionLabel = (v: T) => options.find((o) => o.value === v)?.label;
  const caption =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (optionLabel(value[0]!) ?? '1 ausgewählt')
        : field
          ? value.map((v) => optionLabel(v) ?? String(v)).join(', ')
          : `${value.length} ausgewählt`;

  const clear =
    value.length > 0 ? (
      <span
        className="hm-multi__clear"
        role="button"
        tabIndex={0}
        aria-label={`${name}: Auswahl aufheben`}
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
    ) : null;

  return (
    <div className="hm-multi" style={{ width }}>
      <button
        ref={buttonRef}
        type="button"
        className={
          field
            ? 'hm-select hm-select--btn'
            : `hm-multi__button${value.length ? ' hm-multi__button--active' : ''}`
        }
        onClick={onTriggerClick}
        onPointerDown={labelGuard.triggerProps.onPointerDown}
        onKeyDown={(e) => {
          labelGuard.triggerProps.onKeyDown();
          // Escape schließt nur die Liste, nicht ein umgebendes Modal.
          if (e.key === 'Escape' && openRef.current) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={field ? 'hm-select__value' : 'hm-multi__label'}>{caption}</span>
        {clear}
        <ChevronDown
          size={field ? 15 : 14}
          className={field ? 'hm-select__chev' : 'hm-multi__chevron'}
          aria-hidden="true"
        />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        minWidth={typeof width === 'number' ? width : undefined}
      >
        {/* Gruppe echter Kontrollkästchen statt listbox/option mit nachgebautem
            Haken: Der Browser zeichnet und positioniert die Marke selbst
            (accent-color), sie ist tastaturbedienbar und Screenreader nennen
            den Zustand ohne aria-Nachhilfe. */}
        <div ref={panelRef} role="group" aria-label={name} onKeyDown={onPanelKeyDown}>
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
                  <label
                    key={String(o.value)}
                    className={`hm-multi__option${on ? ' hm-multi__option--on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && full}
                      onChange={() => toggle(o.value)}
                    />
                    <span className="hm-multi__text">{o.label}</span>
                    {o.hint !== undefined && <span className="hm-multi__hint">{o.hint}</span>}
                  </label>
                );
              })
            )}
          </div>
          {full && <div className="hm-multi__empty">Höchstens {max} auswählbar</div>}
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
