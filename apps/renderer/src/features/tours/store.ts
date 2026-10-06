import { useSyncExternalStore } from 'react';
import { readJson, subscribeTo, writeJson } from '../../lib/localStore';
import { TOURS } from './registry';
import { announceSkip } from './skipEvent';

/**
 * Stand der Seiten-Einfuehrungen auf diesem Geraet. Gebunden wie der Stand des
 * Einrichtungs-Assistenten an Installation UND Konto (features/setup/store.ts,
 * Begruendung dort). Je Einfuehrung: laeuft, erledigt oder uebersprungen, dazu
 * die abgehakten Schritte (Index in `registry.ts`).
 */
export type TourStatus = 'active' | 'done' | 'skipped';
export interface TourState {
  status: TourStatus;
  done: number[];
  /** Schrittzahl beim Abschluss (eingeschraenkte Konten sehen weniger Schritte). */
  total?: number;
}
type Persisted = Record<string, TourState>;

const EVENT = 'ohrganize:tours';
const storageKey = (key: string) => `ohrganize.tours.${key}`;

/** Nicht gespeichert: sichtbare Schrittzahl je Einfuehrung fuer das aktuelle Konto. */
const limits: Record<string, number> = {};

let activeKey: string | null = null;
let tours: Persisted = {};
let snapshot: { tours: Persisted; bound: boolean } = { tours, bound: false };

function load(key: string): Persisted {
  const parsed = readJson<Persisted>(storageKey(key));
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Persisted = {};
  for (const tour of TOURS) {
    const s = parsed[tour.id];
    if (!s) continue;
    // Schritte zaehlen nur der Reihe nach: Aus aelteren Staenden bleibt nur der
    // zusammenhaengende Anfang uebrig (0, 1, 2 ...), eine uebersprungene Luecke
    // und alles dahinter fallen weg. "Erledigt" ohne alle Schritte wird wieder "laeuft".
    const raw = Array.isArray(s.done) ? s.done.filter((i) => Number.isInteger(i)) : [];
    let n = 0;
    while (raw.includes(n) && n < tour.steps.length) n++;
    const done = Array.from({ length: n }, (_, i) => i);
    let status: TourStatus = s.status === 'done' || s.status === 'skipped' ? s.status : 'active';
    if (status === 'done' && n < (typeof s.total === 'number' ? s.total : tour.steps.length)) status = 'active';
    out[tour.id] = status === 'done' && typeof s.total === 'number' ? { status, done, total: s.total } : { status, done };
  }
  return out;
}

function commit(next: Persisted): void {
  tours = next;
  if (activeKey !== null) writeJson(storageKey(activeKey), tours);
  snapshot = { tours, bound: activeKey !== null };
  window.dispatchEvent(new Event(EVENT));
}

export function bindToursKey(key: string | null): void {
  if (key === activeKey) return;
  activeKey = key;
  tours = key === null ? {} : load(key);
  // Das Limit gehoert zum Konto: bis TourLayer es neu setzt, gilt keins.
  for (const id of Object.keys(limits)) delete limits[id];
  snapshot = { tours, bound: key !== null };
  window.dispatchEvent(new Event(EVENT));
}

const subscribe = subscribeTo(EVENT);

export function useTourState() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export const tourActions = {
  /** Anzahl der Schritte, die dieses Konto sehen kann (registry.ts#visibleStepCount). */
  setLimit: (id: string, n: number) => {
    limits[id] = n;
    // Sank das Limit unter den Stand (Recht entzogen), ist die Einfuehrung damit abgeschlossen.
    const cur = tours[id];
    if (cur && cur.status === 'active' && n > 0 && cur.done.length >= n) {
      commit({ ...tours, [id]: { status: 'done', done: cur.done.slice(0, n), total: n } });
    }
  },
  start: (id: string) => commit({ ...tours, [id]: { status: 'active', done: [] } }),
  /** Beendet ohne Abschluss. Zeigt die Meldung zur Dokumentation. */
  skip: (id: string) => {
    const cur = tours[id];
    commit({ ...tours, [id]: { status: 'skipped', done: cur?.done ?? [] } });
    announceSkip();
  },
  /**
   * Ereignis der Seite. Zaehlt nur, wenn es der Schritt ist, der DRAN ist: Wer
   * anderswo klickt als die Blase sagt, fuellt die Leiste nicht. `done` ist
   * deshalb immer der zusammenhaengende Anfang der Schritte.
   */
  event: (name: string) => {
    let next = tours;
    for (const tour of TOURS) {
      const cur = next[tour.id];
      if (!cur || cur.status !== 'active') continue;
      const total = limits[tour.id] ?? tour.steps.length;
      const index = cur.done.length;
      if (index >= total) continue;
      // Der Schritt, der dran ist, zaehlt immer; ein spaeterer nur, wenn er `catchUp` traegt.
      let hit = tour.steps[index]?.event === name ? index : -1;
      if (hit < 0) hit = tour.steps.findIndex((s, i) => i > index && i < total && s.catchUp === true && s.event === name);
      if (hit < 0) continue;
      const done = Array.from({ length: hit + 1 }, (_, i) => i);
      next = {
        ...next,
        [tour.id]: done.length >= total ? { status: 'done', done, total } : { status: 'active', done },
      };
    }
    if (next !== tours) commit(next);
  },
};
