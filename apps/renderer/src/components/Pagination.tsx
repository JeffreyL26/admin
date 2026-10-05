import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { LOCALE } from '../lib/locale';

/**
 * Seitenumschalter unter langen, serverseitig geblätterten Listen (alle
 * Anträge, Dokumentablage). Die Liste lädt nur die gezeigte Seite; Filter und
 * Suche wirken im Backend über alle Seiten, `total` kommt von dort.
 *
 * `page` zählt ab 0, angezeigt wird ab 1. Erste, vorige, nächste und letzte
 * Seite per Knopf, jede andere über das Eingabefeld (Enter oder Verlassen des
 * Felds). Nach dem Blättern rückt die Karte, in der die Liste steht, an den
 * Anfang, sonst stünde man am Ende der neuen Seite. Passt alles auf eine
 * Seite, rendert die Komponente nichts.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  label = 'Einträge',
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /** Was gezählt wird, im Plural (z. B. „Anträge“). */
  label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1 && page === 0) return null;

  const first = total === 0 ? 0 : Math.min(total, page * pageSize + 1);
  const last = Math.min(total, (page + 1) * pageSize);
  const go = (next: number) => {
    const clamped = Math.min(pageCount - 1, Math.max(0, next));
    if (clamped === page) return;
    onChange(clamped);
    navRef.current?.closest('.hm-card')?.scrollIntoView({ block: 'start' });
  };
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (Number.isInteger(n) && n >= 1) go(n - 1);
  };
  const fmt = (n: number) => n.toLocaleString(LOCALE);

  return (
    <nav className="hm-pagination" aria-label="Seiten" ref={navRef}>
      <span className="hm-pagination__info">
        {label} {fmt(first)} bis {fmt(last)} von {fmt(total)}
      </span>
      <span className="hm-pagination__controls">
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label="Erste Seite"
          disabled={page === 0}
          onClick={() => go(0)}
        >
          <ChevronsLeft size={16} />
        </button>
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label="Vorige Seite"
          disabled={page === 0}
          onClick={() => go(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="hm-pagination__pages">
          Seite
          <input
            className="hm-input hm-pagination__input"
            inputMode="numeric"
            aria-label={`Seite (1 bis ${pageCount})`}
            value={draft ?? String(page + 1)}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setDraft(null);
            }}
          />
          von {fmt(pageCount)}
        </span>
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label="Nächste Seite"
          disabled={page >= pageCount - 1}
          onClick={() => go(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label="Letzte Seite"
          disabled={page >= pageCount - 1}
          onClick={() => go(pageCount - 1)}
        >
          <ChevronsRight size={16} />
        </button>
      </span>
    </nav>
  );
}

/** Antwort einer geblätterten Route (core/paging.ts im Backend). */
export interface PageResult {
  total: number;
  /** Tatsächlicher Beginn der gelieferten Seite (bei focus_id vom Server bestimmt). */
  offset: number;
  /** Zeilen auf der gelieferten Seite. */
  rows: number;
}

/**
 * Seitenzustand einer geblätterten Liste. `focusId` ist eine per Adresse
 * angesprungene Zeile (lib/focusRow.ts): Die Abfrage schickt sie als
 * `focus_id`, der Server liefert die Seite, auf der sie steht, und `settle`
 * übernimmt deren Nummer für die Anzeige. Die Abfrage bleibt dabei dieselbe,
 * bis jemand blättert oder filtert (`go`, `reset`): Ein Wechsel auf
 * `offset` holte sonst genau die Seite ein zweites Mal, die gerade kam.
 * Filterwechsel rufen `reset` (zurück auf Seite 1).
 *
 * `settle` gehört in einen Effekt des Aufrufers auf jede FRISCHE Antwort
 * (nicht auf keepPreviousData-Platzhalter). Er fängt außerdem eine
 * geschrumpfte Liste ab: Steht man hinter der letzten Seite (etwa nach dem
 * Stornieren unter einem Statusfilter), geht es auf die letzte vorhandene.
 */
export function usePageState(pageSize: number, focusId: number | null = null) {
  const [page, setPage] = useState(0);
  const [locate, setLocate] = useState<number | null>(focusId);
  return {
    page,
    pageSize,
    /** Parameter der Abfrage. */
    query:
      locate === null
        ? { limit: pageSize, offset: page * pageSize, focus_id: null }
        : { limit: pageSize, offset: 0, focus_id: locate },
    go: (next: number) => {
      setPage(next);
      setLocate(null);
    },
    reset: () => {
      setPage(0);
      setLocate(null);
    },
    settle: (result: PageResult) => {
      if (locate !== null) {
        const located = Math.floor(result.offset / pageSize);
        // Seite 1 nach einer schon übernommenen späteren: Die Zeile passt
        // nicht mehr (gelöscht, Status geändert), der Server fiel auf
        // `offset` 0 zurück. Dann bleibt die bisherige Seite stehen.
        if (located === 0 && page > 0) setLocate(null);
        else setPage(located);
        return;
      }
      if (result.rows === 0 && result.total > 0 && page > 0) {
        setPage(Math.ceil(result.total / pageSize) - 1);
      }
    },
  };
}
