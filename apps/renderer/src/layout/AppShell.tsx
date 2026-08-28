import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Search } from 'lucide-react';
import { NAV_SECTIONS } from './nav';
import { useAuth } from '../auth/AuthContext';
import { Avatar } from '../components/ui';
import { CommandPalette } from '../components/CommandPalette';
import logo from '../assets/logo.png';

export function AppShell() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Tastaturkürzel (früher im nativen Menü): globale Suche, Modul-Navigation,
  // Ansicht. Da es kein natives Menü mehr gibt, hier im Renderer registriert.
  useEffect(() => {
    const NAV_KEYS: Record<string, string> = {
      '1': '/dashboard',
      '2': '/personal/mitarbeitende',
      '3': '/abwesenheit/kalender',
      '4': '/leistung/ziele',
      '5': '/verguetung/gehaelter',
      '6': '/kommunikation/ankuendigungen',
      '7': '/recruiting/pipeline',
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (mod && NAV_KEYS[e.key]) {
        e.preventDefault();
        navigate(NAV_KEYS[e.key]);
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        navigate('/einstellungen');
        return;
      }
      // Ansicht-Shortcuts an den Main-Prozess (nur Electron).
      const appApi = window.hrmonic?.app;
      if (mod && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        appApi?.zoom(0.5);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        appApi?.zoom(-0.5);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        appApi?.zoom(0);
      } else if (e.key === 'F11') {
        e.preventDefault();
        appApi?.toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="shell">
      <aside className="sidebar no-select">
        <div className="sidebar__brand">
          <img src={logo} alt="HRMONIC Logo" />
          <span className="sidebar__brand-name">
            HR<span>MONIC</span>
          </span>
        </div>
        <button className="sidebar__search" onClick={() => setPaletteOpen(true)}>
          <Search size={15} />
          <span style={{ flex: 1, textAlign: 'left' }}>Suchen …</span>
          <kbd>Strg K</kbd>
        </button>
        <nav className="sidebar__nav">
          {/* Gesperrte Bereiche werden gar nicht erst angeboten. Ein leerer
              Abschnitt entfällt samt Überschrift, sonst bliebe eine sinnlose
              Zwischenzeile stehen. Die eigentliche Sperre sitzt im Backend. */}
          {NAV_SECTIONS.map((section, i) => {
            const items = section.items.filter((item) =>
              item.area ? can(item.area) : section.area ? can(section.area) : true,
            );
            if (items.length === 0) return null;
            return (
              <div key={i}>
                {section.title && <div className="sidebar__section">{section.title}</div>}
                {items.map((item) => (
                  <NavLink key={item.path} to={item.path} className="sidebar__link">
                    <item.icon size={17} />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          <Avatar name={user?.name ?? '?'} size={32} />
          <div className="sidebar__user">
            <div className="sidebar__user-name">{user?.name}</div>
            <div className="sidebar__user-role">HR-Administration</div>
          </div>
          <button
            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
            onClick={logout}
            title="Abmelden"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="page">
          {/* Key = Pfad: löst die Einblend-Animation bei jedem Seitenwechsel aus. */}
          <div className="page-enter" key={location.pathname}>
            <Outlet />
          </div>
        </div>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
