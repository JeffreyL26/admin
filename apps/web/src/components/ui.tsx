import React from 'react';
import { ABSENCE_STATUS_LABELS, type AbsenceRequestStatus } from '@hrmonic/shared';

/** Flache Sektionskarte des Portals (Hairline statt Schatten). */
export function Card({
  title,
  actions,
  flush,
  children,
}: {
  title?: string;
  actions?: React.ReactNode;
  /** Ohne Innenabstand (für Tabellen/Listen). */
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="pt-card">
      {(title || actions) && (
        <header className="pt-card__header">
          {title && <span className="pt-label">{title}</span>}
          {actions}
        </header>
      )}
      {flush ? children : <div className="pt-card__body">{children}</div>}
    </section>
  );
}

export function Field({
  label,
  required,
  error,
  hint,
  span2,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  span2?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`pt-field${span2 ? ' span-2' : ''}`}>
      <span className="pt-field__label">
        {label}
        {required && <span className="req"> *</span>}
      </span>
      {children}
      {error ? (
        <span className="pt-field__error">{error}</span>
      ) : hint ? (
        <span className="pt-field__hint">{hint}</span>
      ) : null}
    </label>
  );
}

const STATUS_TONES: Record<AbsenceRequestStatus, string> = {
  beantragt: 'warning',
  genehmigt: 'success',
  abgelehnt: 'danger',
  storniert: 'neutral',
};

/** Statusanzeige eines Antrags: Punkt plus Text, Farbwelt wie die Desktop-App. */
export function StatusChip({ status }: { status: AbsenceRequestStatus }) {
  return (
    <span className={`pt-chip pt-chip--${STATUS_TONES[status] ?? 'neutral'}`}>
      <span className="pt-chip__dot" />
      {ABSENCE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** Skeleton-Platzhalter während des Ladens. */
export function Skeleton({
  width,
  height = 14,
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
}) {
  return <span className="pt-skeleton" style={{ width: width ?? '100%', height, ...style }} />;
}

/** Skeleton-Block für Listen: n Zeilen mit variierender Breite. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row">
          <Skeleton width={9} height={9} style={{ borderRadius: '50%' }} />
          <Skeleton width={`${62 - (i % 3) * 14}%`} />
          <Skeleton width={56} style={{ marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="pt-empty">
      <p style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{title}</p>
      {hint && <p style={{ marginTop: 6 }}>{hint}</p>}
    </div>
  );
}
