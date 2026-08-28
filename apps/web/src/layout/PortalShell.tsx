import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  IconCalendar,
  IconClose,
  IconDocuments,
  IconLogout,
  IconMenu,
  IconOrg,
  IconOverview,
  IconProfile,
  IconRequests,
  IconSalary,
  IconSickNote,
  type IconProps,
} from '../components/icons';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<IconProps>;
  /** Nur die Übersicht braucht `end` — sonst wäre "/" immer aktiv. */
  end?: boolean;
}

interface NavSection {
  title: string | null;
  items: NavItem[];
}

/**
 * Navigations-Kontrakt des Portals. Die Reihenfolge ist verbindlich; die
 * Gruppenüberschriften folgen der Desktop-Sidebar.
 *
 * `/antraege` steht bewusst OHNE `end`: die Unterseite `/antraege/neu` soll den
 * Eintrag markiert lassen.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [{ to: '/', label: 'Übersicht', icon: IconOverview, end: true }],
  },
  {
    title: 'Abwesenheit',
    items: [
      { to: '/antraege', label: 'Anträge', icon: IconRequests },
      { to: '/krankmeldung', label: 'Krankmeldung', icon: IconSickNote },
      { to: '/kalender', label: 'Kalender', icon: IconCalendar },
    ],
  },
  {
    title: 'Meine Daten',
    items: [
      { to: '/gehalt', label: 'Gehalt', icon: IconSalary },
      { to: '/dokumente', label: 'Dokumente', icon: IconDocuments },
    ],
  },
  {
    title: 'Unternehmen',
    items: [{ to: '/organigramm', label: 'Organigramm', icon: IconOrg }],
  },
  {
    title: 'Konto',
    items: [{ to: '/profil', label: 'Profil', icon: IconProfile }],
  },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function Wordmark() {
  return (
    <span className="portal-brand__name">
      HR<span>MONIC</span>
    </span>
  );
}

export function PortalShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  // Nur unter 900px relevant: darüber liegt die Leiste ohnehin fest im Layout
  // und CSS blendet Overlay, Topbar und Schließen-Knopf aus.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Routenwechsel schließt den Drawer — sonst verdeckte er die eben
  // angesteuerte Seite.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape schließt; der Fokus kehrt zum Hamburger zurück, damit die
  // Tastaturbedienung nicht im unsichtbaren Panel hängen bleibt.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        burgerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Beim Öffnen in das Panel springen, damit die nächste Tab-Taste bei der
  // Navigation landet und nicht hinter dem Overlay.
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);

  return (
    <div className="portal-shell">
      {drawerOpen && (
        <button
          type="button"
          className="portal-overlay"
          aria-label="Navigation schließen"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <aside
        id="portal-navigation"
        className={`portal-sidebar${drawerOpen ? ' portal-sidebar--open' : ''}`}
        aria-label="Portalnavigation"
      >
        <div className="portal-brand">
          <img src="/logo.png" alt="" aria-hidden="true" />
          <Wordmark />
          <button
            type="button"
            ref={closeRef}
            className="portal-sidebar__close"
            aria-label="Navigation schließen"
            onClick={() => {
              setDrawerOpen(false);
              burgerRef.current?.focus();
            }}
          >
            <IconClose size={18} />
          </button>
        </div>

        <nav className="portal-nav" aria-label="Hauptnavigation">
          {NAV_SECTIONS.map((section, i) => (
            <div key={section.title ?? `section-${i}`}>
              {section.title && <div className="portal-nav__section">{section.title}</div>}
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `portal-nav__link${isActive ? ' portal-nav__link--active' : ''}`
                  }
                >
                  <item.icon size={17} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {user && (
          <div className="portal-user">
            <span className="portal-user__initials" aria-hidden="true">
              {initials(user.name)}
            </span>
            <div className="portal-user__text">
              <div className="portal-user__name">{user.name}</div>
              <div className="portal-user__role">Mitarbeitenden-Portal</div>
            </div>
            <button
              type="button"
              className="portal-user__logout"
              onClick={logout}
              aria-label="Abmelden"
              title="Abmelden"
            >
              <IconLogout size={16} />
            </button>
          </div>
        )}
      </aside>

      <div className="portal-content">
        {/* Nur unter 900px sichtbar (CSS): dort ersetzt sie die Seitenleiste. */}
        <div className="portal-topbar">
          <button
            type="button"
            ref={burgerRef}
            className="portal-topbar__burger"
            aria-label="Navigation öffnen"
            aria-expanded={drawerOpen}
            aria-controls="portal-navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <IconMenu size={20} />
          </button>
          <div className="portal-brand">
            <img src="/logo.png" alt="" aria-hidden="true" />
            <Wordmark />
          </div>
        </div>

        <main className="portal-main">
          <Outlet />
        </main>

        <footer className="portal-footer">
          <div className="portal-footer__inner">
            <span>HRMONIC Mitarbeitenden-Portal</span>
            <span>Fragen? Wenden Sie sich an Ihre Personalabteilung.</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
