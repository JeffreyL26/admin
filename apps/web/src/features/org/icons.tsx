/**
 * Icons der Diagrammsteuerung (Verkleinern / Vergrößern / Einpassen).
 *
 * Bewusst hier und nicht in `components/icons.tsx`: die geteilte Icon-Datei
 * gehört einem anderen Arbeitspaket, und diese drei Zeichen braucht
 * ausschließlich das Organigramm. Stil ist identisch zur geteilten Datei —
 * 24er-Raster, `currentColor`, Strichstärke 2, runde Enden — damit sie sich
 * nicht von der übrigen Oberfläche abheben.
 *
 * `aria-hidden`, weil jeder Knopf zusätzlich ein `aria-label` mit Klartext trägt.
 */
import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Verkleinern — Lupe mit Minus (lucide: zoom-out). */
export function IconZoomOut() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
      <path d="M8 11h6" />
    </Svg>
  );
}

/** Vergrößern — Lupe mit Plus (lucide: zoom-in). */
export function IconZoomIn() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
    </Svg>
  );
}

/** Einpassen — vier Ecken nach außen (lucide: maximize-2). */
export function IconFit() {
  return (
    <Svg>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </Svg>
  );
}
