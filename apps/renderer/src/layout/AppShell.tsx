import React, { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { NAV_SECTIONS } from './nav';
import { useAuth } from '../auth/AuthContext';
import { Avatar } from '../components/ui';
import logo from '../assets/logo.png';

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Navigation aus dem nativen Electron-Menü (Ctrl+1…6, Datei → Neu …).
  useEffect(() => {
    return window.hrmonic?.onMenuNavigate?.((route) => navigate(route));
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
        <nav className="sidebar__nav">
          {NAV_SECTIONS.map((section, i) => (
            <div key={i}>
              {section.title && <div className="sidebar__section">{section.title}</div>}
              {section.items.map((item) => (
                <NavLink key={item.path} to={item.path} className="sidebar__link">
                  <item.icon size={17} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
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
          <Outlet />
        </div>
      </main>
    </div>
  );
}
