import React from 'react';
import type { TooltipProps } from 'recharts';
import { LOCALE } from '../lib/locale';

/**
 * Inhalt fuer den Recharts-Tooltip in der Optik von `Tooltip.tsx`: Farben aus
 * `--tooltip-bg`/`--tooltip-text`, Titel plus eine Zeile je Reihe. Der
 * Recharts-Standard mischt einen weissen Kasten mit der Textfarbe des Themes,
 * im Dunkel-Theme ist die Beschriftung dann unlesbar.
 *
 * Einsatz: `<Tooltip content={<ChartTooltip />} />` im Diagramm.
 */
export function ChartTooltip({ active, payload, label }: TooltipProps<number | string, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => !p.hide);
  return (
    <div className="hm-chart-tooltip" role="presentation">
      {label !== undefined && label !== '' && <div className="hm-tooltip__title">{String(label)}</div>}
      {rows.map((p, i) => (
        <div className="hm-tooltip__line" key={p.dataKey?.toString() ?? i}>
          {p.name ?? p.dataKey} · {typeof p.value === 'number' ? p.value.toLocaleString(LOCALE) : String(p.value ?? '')}
          {p.unit ? ` ${p.unit}` : ''}
        </div>
      ))}
    </div>
  );
}
