import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Search } from 'lucide-react';
import { pathAllowedByFeatures, type AdminArea } from '@ohrganize/shared';
import { useSidebarSections } from './sidebarConfig';
import { navItemAllowedByFeatures } from './nav';
import { LicenseBanner } from './LicenseBanner';
import { SessionEndBanner } from './SessionEndBanner';
import { AUTH_ME_KEY, useAuth } from '../auth/AuthContext';
import { Avatar } from '../components/ui';
import { CommandPalette } from '../components/CommandPalette';
import { Tooltip } from '../components/Tooltip';
import { useLeaderStatus } from '../features/leadership/api';
import { SetupProvider, useSpotlightPath } from '../features/setup/SetupProvider';
import { SetupLayer } from '../features/setup/SetupAssistant';
import { TourLayer } from '../features/tours/TourLayer';
import { SkipNoticeBridge } from '../features/tours/SkipNoticeBridge';
import { t } from '../features/setup/copy';
import logo from '../assets/logo.png';

/** Der Einrichtungs-Assistent hält seinen Stand für die ganze Shell (Dialog, Seitenleiste). */
export function AppShell() {
  return (
    <SetupProvider>
      <Shell />
    </SetupProvider>
  );
}

function Shell() {
  const spotlight = useSpotlightPath();
  // Der hervorgehobene Eintrag kann unter dem sichtbaren Teil der Seitenleiste liegen.
  useEffect(() => {
    if (spotlight) document.querySelector('.sidebar__link--spotlight')?.scrollIntoView({ block: 'nearest' });
  }, [spotlight]);
  const { user, logout, can, features } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Eigene Rechte bei jedem Menüwechsel abgleichen, wie die Seitendaten beim Wechsel neu laden
  // (Prinzip 3): Der Auth-Kontext bleibt gemountet und lädt sonst nur bei Fokus. Nur wenn der
  // Stand älter als die staleTime ist, und ein laufender Abruf wird mitgenutzt.
  useEffect(() => {
    void queryClient.refetchQueries({ queryKey: AUTH_ME_KEY, stale: true }, { cancelRefetch: false });
  }, [location.pathname, queryClient]);
  // Führungsfunktion: sichtbar nur für freigeschaltete Personalprofile —
  // unabhängig von der Admin-Rolle (Details in features/leadership/api.ts).
  const isLeader = useLeaderStatus().data?.is_leader === true;
  // Reihenfolge der Abschnitte ist eine Arbeitsplatz-Einstellung
  // (Einstellungen → Seitenleiste); Dashboard und System stehen fest.
  const sections = useSidebarSections();

  // Tastaturkürzel (früher im nativen Menü): globale Suche, Modul-Navigation,
  // Ansicht. Da es kein natives Menü mehr gibt, hier im Renderer registriert.
  useEffect(() => {
    // Die Ziele tragen ihren Rechtebereich, damit die Kürzel derselben Regel
    // folgen wie die Sidebar: Gesperrte Bereiche werden auch per Tastatur
    // nicht angeboten — sonst landete man auf Seiten, deren Abfragen allesamt
    // in 403 laufen. Die eigentliche Sperre sitzt im Backend.
    const NAV_KEYS: Record<string, { path: string; area?: AdminArea }> = {
      '1': { path: '/dashboard' },
      '2': { path: '/personal/mitarbeitende', area: 'personal' },
      '3': { path: '/abwesenheit/kalender', area: 'abwesenheit' },
      '4': { path: '/leistung/ziele', area: 'leistung' },
      '5': { path: '/verguetung/gehaelter', area: 'verguetung' },
      '6': { path: '/kommunikation/ankuendigungen', area: 'kommunikation' },
      '7': { path: '/recruiting/pipeline', area: 'recruiting' },
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      const target = mod ? NAV_KEYS[e.key] : undefined;
      if (target && !pathAllowedByFeatures(target.path, features)) return;
      if (target) {
        e.preventDefault();
        if (!target.area || can(target.area)) navigate(target.path);
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        if (can('einstellungen')) navigate('/einstellungen');
        return;
      }
      // Ansicht-Shortcuts an den Main-Prozess (nur Electron).
      const appApi = window.ohrganize?.app;
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
  }, [navigate, can]);

  return (
    <div className="shell">
      <aside className="sidebar no-select">
        <div className="sidebar__brand">
          <img src={logo} alt="oHRganize Logo" />
          <span className="sidebar__brand-name">
            o<span>HR</span>ganize
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
          {sections.map((section) => {
            const items = section.items.filter(
              (item) =>
                navItemAllowedByFeatures(item, features) &&
                (item.leaderOnly
                  ? isLeader
                  : item.area
                    ? can(item.area)
                    : section.area
                      ? can(section.area)
                      : true),
            );
            if (items.length === 0) return null;
            return (
              <div key={section.key}>
                {section.title && <div className="sidebar__section">{section.title}</div>}
                {items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={`sidebar__link${spotlight === item.path ? ' sidebar__link--spotlight' : ''}`}
                    end={item.end}
                  >
                    <item.icon size={17} />
                    {item.label}
                    {/* Einrichtungs-Assistent: zeigt, wo der laufende Schritt später zu finden ist. */}
                    {spotlight === item.path && (
                      <span className="sidebar__spot">{t('frame.spotlight.badge')}</span>
                    )}
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
          <Tooltip content={<div className="hm-tooltip__title">Abmelden</div>}>
            <button
              className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
              onClick={logout}
              aria-label="Abmelden"
            >
              <LogOut size={16} />
            </button>
          </Tooltip>
        </div>
      </aside>
      <main className="main hm-setup-host">
        {/* Lizenzhinweise sitzen über dem scrollenden Seitenbereich, damit sie
            auf jeder Seite stehen bleiben (Zustand aus dem Auth-Kontext). */}
        <LicenseBanner />
        <SessionEndBanner />
        <div className="page">
          {/* Key = Pfad: löst die Einblend-Animation bei jedem Seitenwechsel aus. */}
          <div className="page-enter" key={location.pathname}>
            <Outlet />
          </div>
        </div>
        <SetupLayer />
      </main>
      <TourLayer />
      <SkipNoticeBridge />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
