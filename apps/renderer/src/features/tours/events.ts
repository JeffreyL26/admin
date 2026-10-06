import { tourActions } from './store';

/**
 * Eine Seite meldet, dass etwas geschehen ist ("Person geoeffnet"). Aktive
 * Einfuehrungen haken damit den passenden Schritt ab; ohne aktive Einfuehrung
 * oder ohne passenden Schritt passiert nichts. Billig genug fuer jeden Klick.
 */
export function tourEvent(name: string): void {
  tourActions.event(name);
}
