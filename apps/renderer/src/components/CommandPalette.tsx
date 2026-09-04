import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, FileText, Megaphone, Search, User } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { NAV_SECTIONS } from '../layout/nav';
import { Avatar } from './ui';
import { useDebounced } from './useDebounced';

/**
 * Globale Befehlspalette (Strg+K): Navigation zu jedem Menüpunkt plus Suche
 * über Mitarbeitende, Dokumente (FTS) und Ankündigungen — von überall aus.
 */

interface PaletteItem {
  key: string;
  group: 'Navigation' | 'Mitarbeiter' | 'Dokumente' | 'Ankündigungen';
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
  to: string;
}

// Der wirksame Rechtebereich eines Eintrags kommt wie in der Sidebar aus dem
// Eintrag selbst oder ersatzweise aus seinem Abschnitt.
const NAV_ITEMS = NAV_SECTIONS.flatMap((s) =>
  s.items.map((i) => ({ ...i, section: s.title ?? '', area: i.area ?? s.area })),
);

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // 220 ms statt des 250-ms-Standards des gemeinsamen Hooks: Die Palette
  // behält ihr bisheriges, etwas knapperes Delay bei.
  const q = useDebounced(query.trim(), 220);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  const { data: employees } = useQuery({
    queryKey: ['palette', 'employees', q],
    queryFn: () =>
      api.get<{ employees: { id: number; first_name: string; last_name: string; job_title: string | null }[] }>(
        `/api/employees?fields=lite&search=${encodeURIComponent(q)}`,
      ),
    // Rechte-Gate wie beim Backend-Hook: Ohne Lesenrecht antwortete die Suche
    // ohnehin nur mit 403 — die Abfrage gar nicht erst starten.
    enabled: open && q.length >= 2 && can('personal'),
    select: (d) => d.employees.slice(0, 6),
  });
  const { data: documents } = useQuery({
    queryKey: ['palette', 'documents', q],
    queryFn: () =>
      api.get<{ documents: { id: number; title: string; category: string; first_name?: string | null; last_name?: string | null }[] }>(
        `/api/documents?search=${encodeURIComponent(q)}`,
      ),
    enabled: open && q.length >= 2 && can('personal'),
    select: (d) => d.documents.slice(0, 5),
  });
  const { data: announcements } = useQuery({
    queryKey: ['palette', 'announcements'],
    queryFn: () =>
      api.get<{ announcements: { id: number; title: string }[] }>('/api/communication/announcements'),
    enabled: open && q.length >= 2 && can('kommunikation'),
    select: (d) => d.announcements,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const lower = q.toLowerCase();
    const result: PaletteItem[] = [];
    // Dieselbe Regel wie in der Sidebar (AppShell): Gesperrte Bereiche werden
    // gar nicht erst angeboten — sonst führte die Palette geradewegs auf
    // Seiten, deren Abfragen allesamt in 403 laufen.
    const allowedNav = NAV_ITEMS.filter((n) => (n.area ? can(n.area) : true));
    const navMatches = q
      ? allowedNav.filter((n) => n.label.toLowerCase().includes(lower) || n.section.toLowerCase().includes(lower))
      : allowedNav;
    for (const n of navMatches.slice(0, q ? 5 : 8)) {
      result.push({
        key: `nav-${n.path}`,
        group: 'Navigation',
        label: n.label,
        sublabel: n.section || undefined,
        icon: <n.icon size={16} />,
        to: n.path,
      });
    }
    for (const e of employees ?? []) {
      result.push({
        key: `emp-${e.id}`,
        group: 'Mitarbeiter',
        label: `${e.first_name} ${e.last_name}`,
        sublabel: e.job_title ?? undefined,
        icon: <Avatar name={`${e.first_name} ${e.last_name}`} size={22} />,
        to: `/personal/mitarbeitende/${e.id}`,
      });
    }
    for (const d of documents ?? []) {
      result.push({
        key: `doc-${d.id}`,
        group: 'Dokumente',
        label: d.title,
        sublabel: [d.category, [d.first_name, d.last_name].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
        icon: <FileText size={16} />,
        to: '/personal/dokumente',
      });
    }
    for (const a of (announcements ?? []).filter((a) => a.title.toLowerCase().includes(lower)).slice(0, 4)) {
      result.push({
        key: `ann-${a.id}`,
        group: 'Ankündigungen',
        label: a.title,
        icon: <Megaphone size={16} />,
        to: '/kommunikation/ankuendigungen',
      });
    }
    return result;
  }, [q, employees, documents, announcements, can]);

  const clamped = Math.min(selected, Math.max(0, items.length - 1));

  const activate = useCallback(
    (item: PaletteItem) => {
      onClose();
      navigate(item.to);
    },
    [navigate, onClose],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, items.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      }
      if (e.key === 'Enter' && items[clamped]) {
        e.preventDefault();
        activate(items[clamped]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items, clamped, activate, onClose]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${clamped}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [clamped]);

  if (!open) return null;

  let lastGroup: string | null = null;
  return createPortal(
    <div
      className="hm-overlay"
      style={{ alignItems: 'flex-start', paddingTop: '12vh' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="hm-modal" style={{ width: 'min(640px, calc(100vw - 48px))' }} role="dialog">
        <div
          className="row"
          style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', gap: 12 }}
        >
          <Search size={18} color="var(--text-muted)" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            placeholder="Suchen: Seiten, Mitarbeitende, Dokumente, Ankündigungen …"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              font: 'inherit',
              fontSize: 'var(--text-md)',
              color: 'var(--text-primary)',
            }}
          />
          <kbd
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              padding: '2px 7px',
              fontFamily: 'inherit',
            }}
          >
            Esc
          </kbd>
        </div>
        <div ref={listRef} style={{ maxHeight: 420, overflowY: 'auto', padding: '8px 8px 10px' }}>
          {items.length === 0 && (
            <p style={{ padding: '22px 14px', color: 'var(--text-muted)', textAlign: 'center' }}>
              {q.length >= 2 ? 'Keine Treffer.' : 'Tippen zum Suchen oder wählen'}
            </p>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <React.Fragment key={item.key}>
                {header && (
                  <div
                    style={{
                      fontSize: 'var(--text-xs)',
                      fontWeight: 650,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--text-muted)',
                      padding: '10px 12px 4px',
                    }}
                  >
                    {header}
                  </div>
                )}
                <button
                  data-index={i}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => activate(item)}
                  className="row"
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    font: 'inherit',
                    border: 'none',
                    cursor: 'pointer',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: i === clamped ? 'var(--blue-50)' : 'transparent',
                    color: 'var(--text-primary)',
                  }}
                >
                  <span style={{ color: 'var(--brand-primary)', display: 'inline-flex', width: 22, justifyContent: 'center' }}>
                    {item.icon}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 550, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.label}
                    </span>
                    {item.sublabel && (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{item.sublabel}</span>
                    )}
                  </span>
                  {i === clamped && <CornerDownLeft size={14} color="var(--text-muted)" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
