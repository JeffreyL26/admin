/**
 * Theme-Verwaltung: setzt data-theme auf <html> und persistiert die Wahl.
 * Die Farbwerte selbst leben ausschließlich in tokens.css.
 */
export type ThemeName = 'light' | 'dark' | 'rose' | 'silver';

export interface ThemeMeta {
  name: ThemeName;
  label: string;
  description: string;
  /** Vorschaufarben für die Auswahl-Kachel: [Fläche, Sidebar, Akzent] */
  swatch: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  {
    name: 'light',
    label: 'Hell',
    description: 'Der freundliche Standard in Markenblau',
    swatch: ['#f3f6fb', '#0f2f5f', '#0864c6'],
  },
  {
    name: 'dark',
    label: 'Dunkel',
    description: 'Tiefes Nachtblau — angenehm bei wenig Licht',
    swatch: ['#0c1830', '#0a1c38', '#3b8fe4'],
  },
  {
    name: 'rose',
    label: 'Rosé',
    description: 'Weiche Pastelltöne mit warmem Pink',
    swatch: ['#fbf4f8', '#8e4270', '#d4548f'],
  },
  {
    name: 'silver',
    label: 'Silber',
    description: 'Edles Graphit und Silber, ganz ohne Buntes',
    swatch: ['#f3f4f6', '#2c3342', '#64708a'],
  },
];

const STORAGE_KEY = 'ohrganize.theme';

export function getTheme(): ThemeName {
  const stored = localStorage.getItem(STORAGE_KEY);
  return THEMES.some((t) => t.name === stored) ? (stored as ThemeName) : 'light';
}

export function applyTheme(theme: ThemeName): void {
  if (theme === 'light') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  localStorage.setItem(STORAGE_KEY, theme);
}

/** Beim App-Start aufrufen (vor dem ersten Render). */
export function initTheme(): void {
  applyTheme(getTheme());
}
