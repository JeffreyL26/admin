import { useState } from 'react';
import { applyTheme, getTheme, THEMES, type ThemeName } from '../design/theme';
import { Card } from './ui';

/**
 * Farbschema-Wahl wie in den Einstellungen der Desktop-App: dieselben vier
 * Themes (Hell/Dunkel/Rosé/Silber), gleiche Vorschau [Fläche, Sidebar, Akzent],
 * Persistenz pro Gerät (localStorage 'hrmonic.theme').
 */
export function ThemeCard() {
  const [active, setActive] = useState<ThemeName>(() => getTheme());

  return (
    <Card title="Darstellung">
      <div className="pt-theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.name}
            type="button"
            className={`pt-theme${active === t.name ? ' pt-theme--active' : ''}`}
            aria-pressed={active === t.name}
            onClick={() => {
              applyTheme(t.name);
              setActive(t.name);
            }}
          >
            <span className="pt-theme__swatch" aria-hidden="true" style={{ background: t.swatch[0] }}>
              <span className="swatch-side" style={{ background: t.swatch[1] }} />
              <span className="swatch-accent" style={{ background: t.swatch[2] }} />
            </span>
            <span className="pt-theme__label">{t.label}</span>
            <span className="pt-theme__desc">{t.description}</span>
          </button>
        ))}
      </div>
      <p className="pt-field__hint" style={{ marginTop: 12 }}>
        Gilt für dieses Gerät. Die Desktop-App der HR-Administration kennt dieselben Farbschemata.
      </p>
    </Card>
  );
}
