import {
  LayoutDashboard, Users, Network, FolderOpen, CalendarDays, Send, Stethoscope,
  ListChecks, Target, ClipboardCheck, Grid3x3, GraduationCap, MessagesSquare,
  Wallet, Calculator, Gift, Receipt, FileBadge, BookUser, Megaphone, BarChart3,
  FileText, Radio, Settings, Briefcase, KanbanSquare, UserSearch, CalendarClock,
  LineChart, FileStack, UserPlus, ShieldCheck, KeyRound, UsersRound, Gauge, SlidersHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdminArea } from '@ohrganize/shared';

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
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
  /**
   * Rechtebereich des Abschnitts. Ohne Angabe immer sichtbar (Dashboard).
   * Die Sichtbarkeit ist reine Bequemlichkeit — durchgesetzt wird der Zugriff
   * ausschließlich im Backend (core/permissions.ts).
   */
  area?: AdminArea;
}

/**
 * Navigations- und Routen-Kontrakt: Die Fachmodule implementieren exakt diese
 * Pfade in features/<modul>/routes.tsx. Neue Seiten = neuer Eintrag hier.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [{ path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Personal',
    area: 'personal',
    items: [
      { path: '/personal/mitarbeitende', label: 'Mitarbeiter', icon: Users },
      { path: '/personal/organisation', label: 'Organisation', icon: Network },
      { path: '/personal/dokumente', label: 'Dokumente', icon: FolderOpen },
    ],
  },
  {
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
    title: 'Leistung',
    area: 'leistung',
    items: [
      { path: '/leistung/ziele', label: 'Ziele & OKR', icon: Target },
      { path: '/leistung/beurteilungen', label: 'Beurteilungen', icon: ClipboardCheck },
      { path: '/leistung/skills', label: 'Skills & Kompetenzen', icon: Grid3x3 },
      { path: '/leistung/trainings', label: 'Trainings', icon: GraduationCap },
      { path: '/leistung/feedback', label: 'Feedback-Zyklen', icon: MessagesSquare },
    ],
  },
  {
    title: 'Führung',
    area: 'fuehrung',
    items: [
      // „Mein Team“ hängt an der Freischaltung der Person, nicht am Bereich:
      // Eine Führungskraft ohne HR-Rechte sieht genau diesen einen Eintrag.
      { path: '/fuehrung/mein-team', label: 'Mein Team', icon: UsersRound, leaderOnly: true },
      { path: '/fuehrung/report', label: 'Satisfaction-Report', icon: Gauge },
      { path: '/fuehrung/einrichtung', label: 'Einrichtung', icon: SlidersHorizontal },
    ],
  },
  {
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
    title: 'Kommunikation',
    area: 'kommunikation',
    items: [
      { path: '/kommunikation/verzeichnis', label: 'Verzeichnis', icon: BookUser },
      { path: '/kommunikation/ankuendigungen', label: 'Ankündigungen', icon: Megaphone },
      { path: '/kommunikation/umfragen', label: 'Umfragen', icon: BarChart3 },
      { path: '/kommunikation/gespraeche', label: 'Gespräche', icon: FileText },
      { path: '/kommunikation/kanaele', label: 'Kanäle', icon: Radio },
    ],
  },
  {
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
    title: 'System',
    area: 'einstellungen',
    items: [{ path: '/einstellungen', label: 'Einstellungen', icon: Settings }],
  },
];
