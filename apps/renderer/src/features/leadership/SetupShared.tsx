import React, { useMemo } from 'react';
import { Info, X } from 'lucide-react';
import { useLeadershipLookup } from './api';

/**
 * Kleine Bausteine, die sich die Reiter der Einrichtung teilen. Bewusst
 * getrennt von SetupPage.tsx: Die Reiter importieren von hier, SetupPage
 * importiert die Reiter — ein Zirkel wäre sonst unvermeidlich.
 */

/** Erklärkasten (Muster RolesPage/TypesPage). Farben ausschließlich über Tokens. */
export function SetupNote({
  tone = 'info',
  icon,
  onDismiss,
  children,
}: {
  tone?: 'info' | 'warning';
  icon?: React.ReactNode;
  /** Optional schließbar — für einmalige Hinweise wie Server-Warnungen. */
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const accent = tone === 'warning' ? 'var(--warning)' : 'var(--info)';
  return (
    <div
      className="lead-note"
      style={{
        borderLeftColor: accent,
        background: tone === 'warning' ? 'var(--warning-bg)' : 'var(--info-bg)',
      }}
      role={tone === 'warning' ? 'status' : undefined}
    >
      <span style={{ color: accent, flexShrink: 0, marginTop: 1 }} aria-hidden="true">
        {icon ?? <Info size={15} />}
      </span>
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && (
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label="Hinweis schließen"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Meldung eines Fehlers für den Toast — Server-Text (ApiRequestError) hat Vorrang. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Mitarbeitenden-Auswahl mit Ausschlussliste. Der allgemeine EmployeeSelect
 * kennt keinen Filter; hier müssen bereits freigeschaltete Personen (bzw. die
 * Führungskraft selbst) aus der Liste bleiben, sonst bietet die Oberfläche
 * an, was der Server ohnehin ablehnt. Nur aktive Mitarbeitende — dieselbe
 * Regel wie in grantLeader.
 */
export function SetupEmployeeSelect({
  value,
  onChange,
  exclude,
  disabled,
  emptyLabel = '— Person auswählen —',
  autoFocus,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  exclude?: Set<number>;
  disabled?: boolean;
  emptyLabel?: string;
  autoFocus?: boolean;
}) {
  // Eigener Lookup im Bereich fuehrung — /api/employees hinge an `personal`,
  // und ein reines Einrichtungs-Konto sähe dann eine leere Liste.
  const employees = useLeadershipLookup().data?.employees;
  const options = useMemo(() => {
    const list = (employees ?? []).filter((e) => !exclude?.has(e.id));
    return [...list].sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'de'),
    );
  }, [employees, exclude]);
  return (
    <select
      className="hm-select"
      value={value ?? ''}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">{emptyLabel}</option>
      {options.map((e) => (
        <option key={e.id} value={e.id}>
          {e.last_name}, {e.first_name}
          {e.job_title ? ` · ${e.job_title}` : ''}
        </option>
      ))}
    </select>
  );
}

/** „3 Personen“ / „1 Person“ — für Zählungen in Tabellen und Zusammenfassungen. */
export function personCount(n: number): string {
  return `${n} ${n === 1 ? 'Person' : 'Personen'}`;
}
