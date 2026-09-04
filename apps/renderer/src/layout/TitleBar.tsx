import React, { useEffect, useRef, useState } from 'react';
import {
  Info, Maximize2, Minus, PanelsTopLeft, RefreshCw, Square, Copy as CopyIcon,
  BookOpen, ZoomIn, ZoomOut, Expand, X,
} from 'lucide-react';
import { IS_ELECTRON } from '../api/client';
import { Modal } from '../components/Modal';
import logo from '../assets/logo.png';

const isMac = window.ohrganize?.platform === 'darwin';
const DOCS_URL = 'https://ohrganize.de/docs';

/**
 * Eigene, zur UI passende Titelleiste — ersetzt das native Windows-Menü.
 * Links ein schlankes App-Menü, die Mitte ist Drag-Region, rechts die
 * Fenster-Controls (nur Electron, nicht macOS — dort übernehmen die Ampeln).
 */
export function TitleBar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const w = window.ohrganize?.window;
    if (!w) return;
    void w.isMaximized().then(setMaximized);
    return w.onMaximizeChange(setMaximized);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const act = {
    reload: () => (window.ohrganize?.app?.reload ? window.ohrganize.app.reload() : window.location.reload()),
    zoom: (d: number) => window.ohrganize?.app?.zoom(d),
    fullscreen: () => window.ohrganize?.app?.toggleFullscreen(),
    devtools: () => window.ohrganize?.app?.toggleDevTools(),
    docs: () =>
      window.ohrganize?.app?.openExternal
        ? window.ohrganize.app.openExternal(DOCS_URL)
        : window.open(DOCS_URL, '_blank'),
  };

  const run = (fn: () => void) => () => {
    fn();
    setMenuOpen(false);
  };

  return (
    <header className={`titlebar${isMac ? ' titlebar--mac' : ''}`}>
      <div className="titlebar__left" ref={menuRef}>
        <button
          className={`titlebar__menu-btn${menuOpen ? ' is-open' : ''}`}
          onClick={() => setMenuOpen((o) => !o)}
          title="Menü"
        >
          <PanelsTopLeft size={15} />
          <span>Menü</span>
        </button>
        {menuOpen && (
          <div className="titlebar__menu" role="menu">
            <MenuItem icon={<RefreshCw size={15} />} label="Neu laden" hint="Strg R" onClick={run(act.reload)} />
            <div className="titlebar__sep" />
            <MenuItem icon={<ZoomIn size={15} />} label="Vergrößern" hint="Strg +" onClick={run(() => act.zoom(0.5))} />
            <MenuItem icon={<ZoomOut size={15} />} label="Verkleinern" hint="Strg −" onClick={run(() => act.zoom(-0.5))} />
            <MenuItem icon={<Square size={13} />} label="Standardgröße" hint="Strg 0" onClick={run(() => act.zoom(0))} />
            <MenuItem icon={<Expand size={15} />} label="Vollbild" hint="F11" onClick={run(act.fullscreen)} />
            <div className="titlebar__sep" />
            <MenuItem icon={<BookOpen size={15} />} label="Dokumentation" onClick={run(act.docs)} />
            <MenuItem icon={<Info size={15} />} label="Über oHRganize" onClick={run(() => setAboutOpen(true))} />
            {import.meta.env.DEV && (
              <>
                <div className="titlebar__sep" />
                <MenuItem icon={<CopyIcon size={15} />} label="Entwicklertools" onClick={run(act.devtools)} />
              </>
            )}
          </div>
        )}
      </div>

      <div className="titlebar__drag">
        <span className="titlebar__wordmark">
          o<span>HR</span>ganize
        </span>
      </div>

      {IS_ELECTRON && !isMac ? (
        <div className="titlebar__controls">
          <button className="titlebar__control" onClick={() => window.ohrganize?.window?.minimize()} title="Minimieren" aria-label="Minimieren">
            <Minus size={16} />
          </button>
          <button
            className="titlebar__control"
            onClick={() => window.ohrganize?.window?.toggleMaximize()}
            title={maximized ? 'Wiederherstellen' : 'Maximieren'}
            aria-label={maximized ? 'Wiederherstellen' : 'Maximieren'}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button className="titlebar__control titlebar__control--close" onClick={() => window.ohrganize?.window?.close()} title="Schließen" aria-label="Schließen">
            <X size={16} />
          </button>
        </div>
      ) : (
        <div className="titlebar__spacer" />
      )}

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </header>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button className="titlebar__menu-item" role="menuitem" onClick={onClick}>
      <span className="titlebar__menu-icon">{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <kbd className="titlebar__menu-hint">{hint}</kbd>}
    </button>
  );
}

/** Zwei überlappende Rechtecke als "Wiederherstellen"-Symbol. */
function Copy({ size }: { size: number }) {
  return (
    <svg width={size + 3} height={size + 3} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.4" />
      <path d="M5.4 3.2V2.2a1.2 1.2 0 0 1 1.2-1.2h6a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2h-1" />
    </svg>
  );
}

function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const version = window.ohrganize?.appVersion ?? '1.0.0';
  return (
    <Modal title="Über oHRganize" open={open} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '8px 0 4px' }}>
        <img src={logo} alt="oHRganize" style={{ width: 96 }} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)' }}>oHRganize</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            HR-Verwaltung für den deutschsprachigen Markt
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="hm-badge hm-badge--blue">Version {version}</span>
          <span className="hm-badge hm-badge--neutral">Desktop</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', margin: 0 }}>
          © {new Date().getFullYear()} oHRganize
        </p>
      </div>
    </Modal>
  );
}
