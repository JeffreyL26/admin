import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV = [
  { to: '/', label: 'Übersicht', end: true },
  { to: '/antraege', label: 'Anträge' },
  { to: '/krankmeldung', label: 'Krankmeldung' },
  { to: '/profil', label: 'Profil' },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function PortalShell() {
  const { user, logout } = useAuth();

  return (
    <div>
      <header className="portal-header">
        <div className="portal-header__inner">
          <div className="portal-brand">
            <img src="/logo.png" alt="" aria-hidden="true" />
            <span className="portal-brand__name">
              HR<span>MONIC</span>
            </span>
          </div>
          <nav className="portal-nav" aria-label="Hauptnavigation">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `portal-nav__link${isActive ? ' portal-nav__link--active' : ''}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="portal-user">
            {user && (
              <>
                <span className="portal-user__name">{user.name}</span>
                <span className="portal-user__initials" aria-hidden="true">
                  {initials(user.name)}
                </span>
                <button type="button" className="portal-user__logout" onClick={logout}>
                  Abmelden
                </button>
              </>
            )}
          </div>
        </div>
      </header>
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
  );
}
