import {
  LayoutDashboard, Users, Network, FolderOpen, CalendarDays, Send, Stethoscope,
  ListChecks, Target, ClipboardCheck, Grid3x3, GraduationCap, MessagesSquare,
  Wallet, Calculator, Gift, Receipt, FileBadge, BookUser, Megaphone, BarChart3,
  FileText, Contact, Settings, Briefcase, KanbanSquare, UserSearch, CalendarClock,
  LineChart, FileStack, UserPlus, ShieldCheck, KeyRound, UsersRound, Gauge, SlidersHorizontal,
  FilePenLine, BadgeCheck, User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  AREA_MODULES, hasFeature, moduleEnabled, pathAllowedByFeatures, type AdminArea, type ModuleKey,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Abweichender Rechtebereich, wenn ein Eintrag nicht zu seinem Abschnitt passt. */
  area?: AdminArea;
  /**
   * Nur für freigeschaltete Führungskräfte sichtbar — unabhängig von jedem
   * Rechtebereich (GET /api/leadership/me/status). Durchgesetzt wird der
   * Zugriff im Backend (modules/leadership, requireLeader).
   */
  leaderOnly?: boolean;
  /**
   * Feature-Schluessel, den die Lizenz freischalten muss (packages/shared
   * features.ts). Zusaetzlich greift die Registry ueber navPaths; beide
   * Wege filtern nur die Anzeige, gesperrt wird im Backend.
   */
  feature?: string;
  /**
   * Nur bei exaktem Pfad aktiv. Nötig, wenn ein Eintrag Unterseiten hat, die
   * selbst in der Seitenleiste stehen (/einstellungen → /einstellungen/lizenz):
   * NavLink markiert sonst beide, weil es Präfixe als aktiv wertet.
   */
  end?: boolean;
}

export interface NavSection {
  /** Stabiler Schlüssel; die Reihenfolge der Seitenleiste wird darüber gespeichert (layout/sidebarConfig.ts). */
  key: string;
  title: string | null;
  items: NavItem[];
  /**
   * Rechtebereich des Abschnitts. Ohne Angabe immer sichtbar (Dashboard).
   * Die Sichtbarkeit ist reine Bequemlichkeit — durchgesetzt wird der Zugriff
   * ausschließlich im Backend (core/permissions.ts).
   */
  area?: AdminArea;
}

/** Modul eines Abschnitts: das seines Rechtebereichs; ohne Bereich immer vorhanden. */
function sectionModule(section: NavSection): ModuleKey | null {
  return section.area ? AREA_MODULES[section.area] : null;
}

/** Modul eines Eintrags: das seines Rechtebereichs, sonst das des Abschnitts. */
function itemModule(section: NavSection, item: NavItem): ModuleKey | null {
  if (item.area) return AREA_MODULES[item.area] ?? sectionModule(section);
  return sectionModule(section);
}

/**
 * Sicht der Variante: Abschnitte und Eintraege von Modulen, die dieser Build
 * nicht enthaelt, fallen weg (Seitenleiste, Palette, Kuerzel, Einstellungen
 * zur Seitenleiste arbeiten alle auf NAV_SECTIONS). Ein Abschnitt ohne
 * verbleibende Eintraege entfaellt ganz.
 */
export function navSectionsForVariant(sections: NavSection[], modules: readonly ModuleKey[]): NavSection[] {
  const variant = { modules };
  return sections
    .filter((s) => moduleEnabled(variant, sectionModule(s)))
    .map((s) => ({ ...s, items: s.items.filter((i) => moduleEnabled(variant, itemModule(s, i))) }))
    .filter((s) => s.items.length > 0);
}

/**
 * Sichtbar mit dieser Feature-Menge? Prueft den expliziten `feature`-Schluessel
 * des Eintrags UND die Registry (navPaths in packages/shared features.ts).
 * null = alles an. Reine Anzeige; gesperrt wird im Backend.
 */
export function navItemAllowedByFeatures(
  item: Pick<NavItem, 'path' | 'feature'>,
  features: readonly string[] | null,
): boolean {
  if (item.feature && !hasFeature(features, item.feature)) return false;
  return pathAllowedByFeatures(item.path, features);
}

/**
 * Navigations- und Routen-Kontrakt: Die Fachmodule implementieren exakt diese
 * Pfade in features/<modul>/routes.tsx. Neue Seiten = neuer Eintrag hier.
 */
export const ALL_NAV_SECTIONS: NavSection[] = [
  {
    key: 'dashboard',
    title: null,
    items: [{ path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    key: 'personal',
    title: 'Personal',
    area: 'personal',
    items: [
      { path: '/personal/mitarbeitende', label: 'Mitarbeiter', icon: Users },
      { path: '/personal/organisation', label: 'Organisation', icon: Network },
      { path: '/personal/aenderungsantraege', label: 'Änderungsanträge', icon: FilePenLine },
      { path: '/personal/dokumente', label: 'Dokumente', icon: FolderOpen },
    ],
  },
  {
    key: 'recruiting',
    title: 'Recruiting',
    area: 'recruiting',
    items: [
      { path: '/recruiting/stellen', label: 'Stellen', icon: Briefcase },
      { path: '/recruiting/pipeline', label: 'Pipeline', icon: KanbanSquare },
      { path: '/recruiting/bewerber', label: 'Bewerbungen', icon: UserSearch },
      { path: '/recruiting/interviews', label: 'Interviews', icon: CalendarClock },
      { path: '/recruiting/analyse', label: 'Analyse', icon: LineChart },
    ],
  },
  {
    key: 'abwesenheit',
    title: 'Abwesenheit',
    area: 'abwesenheit',
    items: [
      { path: '/abwesenheit/kalender', label: 'Kalender', icon: CalendarDays },
      { path: '/abwesenheit/antraege', label: 'Anträge', icon: Send },
      { path: '/abwesenheit/krankmeldungen', label: 'Krankmeldungen', icon: Stethoscope },
      { path: '/abwesenheit/arten', label: 'Abwesenheitsarten', icon: ListChecks },
    ],
  },
  {
    // Ein Abschnitt für Leistung UND Führung: Die Rechtebereiche bleiben
    // getrennt (Einträge mit `area: 'fuehrung'` prüfen ihren eigenen Bereich,
    // „Mein Team“ hängt an der Freischaltung der Person), aber fachlich gehört
    // die Bewertung durch die Führungskraft neben Gespräche und Beurteilungen.
    key: 'leistung',
    title: 'Leistung & Führung',
    area: 'leistung',
    items: [
      { path: '/fuehrung/mein-team', label: 'Mein Team', icon: UsersRound, leaderOnly: true },
      { path: '/leistung/feedback', label: 'Gespräche', icon: MessagesSquare },
      { path: '/leistung/ziele', label: 'Ziele & OKR', icon: Target },
      { path: '/leistung/beurteilungen', label: 'Beurteilungen', icon: ClipboardCheck },
      { path: '/fuehrung/report', label: 'Satisfaction-Report', icon: Gauge, area: 'fuehrung' },
      { path: '/leistung/skills', label: 'Skills & Kompetenzen', icon: Grid3x3 },
      { path: '/leistung/trainings', label: 'Trainings', icon: GraduationCap },
      { path: '/fuehrung/einrichtung', label: 'Einrichtung Bewertung', icon: SlidersHorizontal, area: 'fuehrung' },
    ],
  },
  {
    key: 'verguetung',
    title: 'Vergütung',
    area: 'verguetung',
    items: [
      { path: '/verguetung/gehaelter', label: 'Gehälter', icon: Wallet },
      { path: '/verguetung/abrechnung', label: 'Abrechnung', icon: Calculator },
      { path: '/verguetung/boni', label: 'Boni & Variable', icon: Gift },
      { path: '/verguetung/honorare', label: 'Freiberufler', icon: Receipt },
      { path: '/verguetung/bescheinigungen', label: 'Bescheinigungen', icon: FileBadge },
    ],
  },
  {
    key: 'kommunikation',
    title: 'Kommunikation',
    area: 'kommunikation',
    items: [
      { path: '/kommunikation/verzeichnis', label: 'Verzeichnis', icon: BookUser },
      { path: '/kommunikation/ankuendigungen', label: 'Ankündigungen', icon: Megaphone },
      { path: '/kommunikation/umfragen', label: 'Umfragen', icon: BarChart3 },
      { path: '/kommunikation/gespraeche', label: 'Gesprächsprotokolle', icon: FileText },
      { path: '/kommunikation/verteiler', label: 'Verteiler', icon: Contact },
    ],
  },
  {
    key: 'verwaltung',
    title: 'Verwaltung',
    area: 'verwaltung',
    items: [
      { path: '/verwaltung/vorlagen', label: 'HR-Vorlagen', icon: FileStack },
      { path: '/verwaltung/onboarding', label: 'On- & Offboarding', icon: UserPlus },
      { path: '/verwaltung/rollen', label: 'Rollen', icon: ShieldCheck },
      // Eigener Rechtebereich: Wer Vorlagen pflegen darf, soll nicht
      // automatisch auch Rechte vergeben können.
      { path: '/verwaltung/benutzer', label: 'Benutzer & Rechte', icon: KeyRound, area: 'benutzer' },
    ],
  },
  {
    // Bewusst OHNE Bereich am Abschnitt: „Konto“ (eigenes Passwort,
    // Darstellung, Seitenleiste) erreicht JEDES Admin-Konto, auch eines,
    // dessen Rolle `einstellungen: kein` hat. Die beiden anderen Eintraege
    // tragen den Bereich deshalb selbst.
    key: 'system',
    title: 'System',
    items: [
      { path: '/einstellungen', label: 'Einstellungen', icon: Settings, end: true, area: 'einstellungen' },
      // Lizenzzustand, Lizenzdatei einspielen, Lizenzbericht (features/settings/LicensePage.tsx).
      { path: '/einstellungen/lizenz', label: 'Lizenz', icon: BadgeCheck, area: 'einstellungen' },
      // Persoenliche Einstellungen des Kontos (features/settings/AccountPage.tsx).
      { path: '/einstellungen/konto', label: 'Konto', icon: User },
    ],
  },
];

/** Navigation dieser Variante: nur Module, die der Build enthaelt. */
export const NAV_SECTIONS: NavSection[] = navSectionsForVariant(ALL_NAV_SECTIONS, VARIANT.modules);
