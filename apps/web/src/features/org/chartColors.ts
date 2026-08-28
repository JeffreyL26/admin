/**
 * Farbwerte des Organigramms — aufgelöst, nicht als CSS-Variable.
 *
 * Herkunft: `useChartColors` aus `apps/renderer/src/features/employees/OrgPage.tsx`
 * (Desktop-App, Tab „Organigramm").
 *
 * Warum überhaupt aufgelöst: In SVG-Präsentationsattributen (`fill`, `stroke`)
 * wird `var(--…)` nicht von allen Renderern zuverlässig ausgewertet. Deshalb
 * werden die Tokens einmal über `getComputedStyle` in konkrete Farbwerte
 * übersetzt und als gewöhnliche Strings ins SVG geschrieben.
 *
 * Ergänzung gegenüber der Desktop-Fassung: dort genügt ein `useMemo` mit leerer
 * Abhängigkeitsliste, weil das Fenster beim Themewechsel ohnehin neu aufgebaut
 * wird. Im Portal bleibt die Seite stehen — die Farbschema-Wahl sitzt unter
 * Profil → Darstellung und schaltet nur `data-theme` am <html>-Element um. Ein
 * MutationObserver auf genau dieses Attribut liest die Werte danach neu ein,
 * sonst behielte das Diagramm die Farben des vorherigen Themes.
 */
import { useEffect, useState } from 'react';

export interface OrgChartColors {
  /** Kastenfläche. */
  surface: string;
  /** Kastenrand. */
  border: string;
  /** Verbindungslinien. */
  edge: string;
  /** Akzent: Randstreifen, hervorgehobene Kanten, eigene Abteilung. */
  accent: string;
  /** Weicher Akzent: Initialenkreis und Plakette „Ihre Abteilung". */
  accentSoft: string;
  /** Schrift auf `accentSoft`. */
  accentText: string;
  /** Fläche der eigenen Abteilung. */
  ownSurface: string;
  /** Fläche der Team-Zeilen unter einem Kasten. */
  shelf: string;
  text: string;
  muted: string;
}

function readColors(): OrgChartColors {
  const styles = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--bg-surface', '#ffffff'),
    border: v('--border-strong', '#d5dce8'),
    edge: v('--gray-300', '#cdd5e2'),
    accent: v('--brand-primary', '#0864c6'),
    accentSoft: v('--blue-100', '#d9e9fa'),
    accentText: v('--blue-700', '#084a90'),
    ownSurface: v('--blue-50', '#eef5fd'),
    shelf: v('--gray-50', '#f5f7fb'),
    text: v('--text-primary', '#16202f'),
    muted: v('--text-muted', '#6b7a94'),
  };
}

export function useOrgChartColors(): OrgChartColors {
  const [colors, setColors] = useState<OrgChartColors>(readColors);

  useEffect(() => {
    const observer = new MutationObserver(() => setColors(readColors()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}
