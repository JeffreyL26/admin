/**
 * Icons des Organigramms (Zoom, Suche, Klappen, Fokus).
 *
 * Bewusst hier und nicht in `components/icons.tsx`: die geteilte Icon-Datei
 * gehört einem anderen Arbeitspaket, und diese Zeichen braucht ausschließlich
 * das Organigramm. Stil ist identisch zur geteilten Datei: 24er-Raster,
 * `currentColor`, Strichstärke 2, runde Enden.
 *
 * `aria-hidden`, weil jeder Knopf zusätzlich ein `aria-label` mit Klartext trägt.
 */
import type { ReactNode } from 'react';

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

/** Verkleinern (lucide: zoom-out). */
export function IconZoomOut() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
      <path d="M8 11h6" />
    </Svg>
  );
}

/** Vergrößern (lucide: zoom-in). */
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

/** Einpassen (lucide: maximize-2). */
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

/** Suche (lucide: search). */
export function IconSearch() {
  return (
    <Svg size={15}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Svg>
  );
}

export function IconChevronDown({ size = 13 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function IconChevronUp({ size = 13 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="m18 15-6-6-6 6" />
    </Svg>
  );
}

export function IconChevronRight({ size = 13 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  );
}

/** Eigene Karte anspringen (lucide: locate-fixed). */
export function IconLocate() {
  return (
    <Svg>
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** Bereich fokussieren (lucide: focus). */
export function IconFocus() {
  return (
    <Svg size={14}>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    </Svg>
  );
}

/** Standort (lucide: map-pin). */
export function IconPin() {
  return (
    <Svg size={12}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </Svg>
  );
}
