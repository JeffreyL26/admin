import {
  LayoutDashboard, Users, Network, FolderOpen, CalendarDays, Send, Stethoscope,
  ListChecks, Target, ClipboardCheck, Grid3x3, GraduationCap, MessagesSquare,
  Wallet, Calculator, Gift, Receipt, FileBadge, BookUser, Megaphone, BarChart3,
  FileText, Radio, Settings, Briefcase, KanbanSquare, UserSearch, CalendarClock,
  LineChart, FileStack, UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
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
    items: [
      { path: '/personal/mitarbeitende', label: 'Mitarbeitende', icon: Users },
      { path: '/personal/organisation', label: 'Organisation', icon: Network },
      { path: '/personal/dokumente', label: 'Dokumente', icon: FolderOpen },
    ],
  },
  {
    title: 'Recruiting',
    items: [
      { path: '/recruiting/stellen', label: 'Stellen', icon: Briefcase },
      { path: '/recruiting/pipeline', label: 'Pipeline', icon: KanbanSquare },
      { path: '/recruiting/bewerber', label: 'Bewerber:innen', icon: UserSearch },
      { path: '/recruiting/interviews', label: 'Interviews', icon: CalendarClock },
      { path: '/recruiting/analyse', label: 'Analyse', icon: LineChart },
    ],
  },
  {
    title: 'Abwesenheit',
    items: [
      { path: '/abwesenheit/kalender', label: 'Kalender', icon: CalendarDays },
      { path: '/abwesenheit/antraege', label: 'Anträge', icon: Send },
      { path: '/abwesenheit/krankmeldungen', label: 'Krankmeldungen', icon: Stethoscope },
      { path: '/abwesenheit/arten', label: 'Abwesenheitsarten', icon: ListChecks },
    ],
  },
  {
    title: 'Leistung',
    items: [
      { path: '/leistung/ziele', label: 'Ziele & OKR', icon: Target },
      { path: '/leistung/beurteilungen', label: 'Beurteilungen', icon: ClipboardCheck },
      { path: '/leistung/skills', label: 'Skills & Kompetenzen', icon: Grid3x3 },
      { path: '/leistung/trainings', label: 'Trainings', icon: GraduationCap },
      { path: '/leistung/feedback', label: 'Feedback-Zyklen', icon: MessagesSquare },
    ],
  },
  {
    title: 'Vergütung',
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
    items: [
      { path: '/verwaltung/vorlagen', label: 'HR-Vorlagen', icon: FileStack },
      { path: '/verwaltung/onboarding', label: 'On- & Offboarding', icon: UserPlus },
    ],
  },
  {
    title: 'System',
    items: [{ path: '/einstellungen', label: 'Einstellungen', icon: Settings }],
  },
];
