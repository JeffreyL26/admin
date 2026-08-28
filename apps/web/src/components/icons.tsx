/**
 * Inline-Icons des Portals.
 *
 * Warum eigene SVG statt einer Bibliothek: `apps/web` soll ohne zusätzliche
 * npm-Abhängigkeit auskommen (die Desktop-App nutzt lucide-react, das Portal
 * bewusst nicht). Die Pfade sind an denselben lucide-Icons orientiert, damit
 * Sidebar und Desktop-App optisch zusammengehören — gleiches 24er-Raster,
 * gleiche Strichstärke, runde Enden.
 *
 * Alle Icons zeichnen in `currentColor` und tragen `aria-hidden`: sie
 * begleiten immer einen Text, ein eigener Name wäre doppelt vorgelesen.
 */
import type { ReactNode } from 'react';

export interface IconProps {
  /** Kantenlänge in px; die Sidebar nutzt 17 wie die Desktop-App. */
  size?: number;
  className?: string;
}

function Svg({ size = 17, className, children }: IconProps & { children: ReactNode }) {
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
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Übersicht — Kachelraster (lucide: layout-dashboard). */
export function IconOverview(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Svg>
  );
}

/** Anträge — Papierflieger (lucide: send). */
export function IconRequests(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21.5 2.5 10.5 13.5" />
      <path d="M21.5 2.5 14.5 21.5l-4-8-8-4Z" />
    </Svg>
  );
}

/** Krankmeldung — Stethoskop (lucide: stethoscope). */
export function IconSickNote(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3v6a5 5 0 0 0 10 0V3" />
      <path d="M4.5 3h3" />
      <path d="M14.5 3h3" />
      <path d="M11 14v1.5a4 4 0 0 0 8 0V13" />
      <circle cx="19" cy="11" r="2" />
    </Svg>
  );
}

/** Kalender — Monatsblatt mit Tagespunkten (lucide: calendar-days). */
export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
    </Svg>
  );
}

/** Gehalt — Geldschein (lucide: banknote). */
export function IconSalary(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01" />
      <path d="M18 12h.01" />
    </Svg>
  );
}

/** Dokumente — beschriebenes Blatt mit Eselsohr (lucide: file-text). */
export function IconDocuments(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </Svg>
  );
}

/** Organigramm — Knoten mit zwei Kindern (lucide: network). */
export function IconOrg(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <path d="M12 8v5" />
      <path d="M5 16v-2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2" />
    </Svg>
  );
}

/** Profil — Person (lucide: user-round). */
export function IconProfile(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Svg>
  );
}

/** Menü öffnen — Hamburger der mobilen Topbar (lucide: menu). */
export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </Svg>
  );
}

/** Menü schließen (lucide: x). */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </Svg>
  );
}

/** Abmelden — Tür mit Pfeil (lucide: log-out). */
export function IconLogout(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </Svg>
  );
}
