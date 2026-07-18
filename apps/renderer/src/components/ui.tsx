import React from 'react';
import { SearchX } from 'lucide-react';

/* Kleine Primitiven des Designsystems. Buttons/Inputs nutzen direkt die
   hm-*-Klassen; hier stehen die Komponenten mit etwas Verhalten. */

export function Spinner({ center = false }: { center?: boolean }) {
  const el = <div className="hm-spinner" role="status" aria-label="Lädt" />;
  return center ? (
    <div style={{ display: 'grid', placeItems: 'center', padding: 48 }}>{el}</div>
  ) : (
    el
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="hm-empty">
      {icon ?? <SearchX size={40} />}
      <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{title}</div>
      {hint && <div style={{ fontSize: 'var(--text-sm)' }}>{hint}</div>}
      {action}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'blue' | 'green' | 'yellow' | 'red' | 'navy';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={`hm-badge hm-badge--${tone}`}>{children}</span>;
}

export function Avatar({ name, size = 32, src }: { name: string; size?: number; src?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span
      className="hm-avatar"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      title={name}
    >
      {src ? <img src={src} alt={name} /> : initials}
    </span>
  );
}

export function Field({
  label,
  required,
  error,
  hint,
  children,
  span2,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  span2?: boolean;
}) {
  return (
    <label className={`hm-field${span2 ? ' span-2' : ''}`}>
      <span className="hm-field__label">
        {label} {required && <span className="req">*</span>}
      </span>
      {children}
      {hint && !error && <span className="hm-field__hint">{hint}</span>}
      {error && <span className="hm-field__error">{error}</span>}
    </label>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: React.ReactNode }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="hm-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          className={`hm-tab${active === t.key ? ' hm-tab--active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  flush,
  style,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <section className="hm-card" style={style}>
      {(title || actions) && (
        <header className="hm-card__header">
          <div className="hm-card__title">{title}</div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`hm-card__body${flush ? ' hm-card__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="hm-card hm-stat">
      <span className="hm-stat__label">
        {icon} {label}
      </span>
      <span className="hm-stat__value">{value}</span>
      {sub && <span className="hm-stat__sub">{sub}</span>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page__header">
      <div>
        <h1 className="page__title">{title}</h1>
        {subtitle && <p className="page__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page__actions">{actions}</div>}
    </div>
  );
}
