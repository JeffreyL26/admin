import React from 'react';
import { Select } from '../../components/Select';

/** Angebotene Jahre: das nächste bis zehn zurück. Ältere über „Alle Jahre“ oder freie Datumsfelder. */
const YEARS_BACK = 10;

/**
 * Jahresauswahl der Abwesenheitslisten (alle Anträge, Krankmeldungen).
 *
 * Die Seiten zeigen als Vorgabe das laufende Jahr, weil die vollständige
 * Historie bei großer Belegschaft sechsstellig ist. Ausgeblendet wird nichts:
 * „Alle Jahre“ öffnet die ganze Historie wieder. `value` null heißt alle
 * Jahre; `custom` zeigt „Eigener Zeitraum“, wenn frei gesetzte Datumsfelder
 * kein ganzes Kalenderjahr ergeben.
 */
export function YearSelect({
  value,
  onChange,
  custom = false,
  style,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (year: number | null) => void;
  custom?: boolean;
  style?: React.CSSProperties;
  'aria-label'?: string;
}) {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current + 1; y >= current - YEARS_BACK; y--) years.push(y);
  if (value !== null && !years.includes(value)) {
    years.push(value);
    years.sort((a, b) => b - a);
  }
  return (
    <Select
      className="hm-select"
      style={style}
      aria-label={ariaLabel}
      value={custom ? 'eigen' : (value ?? 'alle')}
      onChange={(e) => {
        if (e.target.value === 'alle') onChange(null);
        else if (e.target.value !== 'eigen') onChange(Number(e.target.value));
      }}
    >
      {custom && (
        <option value="eigen" disabled>
          Eigener Zeitraum
        </option>
      )}
      <option value="alle">Alle Jahre</option>
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </Select>
  );
}
