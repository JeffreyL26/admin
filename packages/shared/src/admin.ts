// Typen des Moduls Verwaltung (Rollen, HR-Vorlagen, On-/Offboarding).

import type { EmployeeStatus, EmployeeType } from './employees.js';

// ---------------------------------------------------------------------------
// Fachrollen
// ---------------------------------------------------------------------------

/**
 * Frei anlegbare Fachrolle (Tabelle `roles`). Bewusst getrennt von
 * `users.role` (`admin`/`mitarbeiter`, Zugriffssteuerung) und von
 * `employees.employee_type` — die Startbelegung stammt zwar aus der
 * Beschäftigungsart, darf danach aber frei davon abweichen.
 */
export interface Role {
  id: number;
  name: string;
  description: string | null;
  active: number; // SQLite-Bool (0/1)
  created_at: string;
  /** Angereichert in GET /api/admin/roles. */
  member_count?: number;
}

/** Mitglied einer Rolle (GET /api/admin/roles/:id/members) — Personalstammdaten. */
export interface RoleMember {
  id: number;
  first_name: string;
  last_name: string;
  employee_type: EmployeeType;
  status: EmployeeStatus;
  job_title: string | null;
  department_name: string | null;
}

// ---------------------------------------------------------------------------
// HR-Vorlagen (Dokumentverzeichnis der Abteilung)
// ---------------------------------------------------------------------------

export type HrTemplateCategory =
  | 'schreiben'
  | 'vertrag'
  | 'formular'
  | 'richtlinie'
  | 'checkliste'
  | 'sonstiges';

export const HR_TEMPLATE_CATEGORY_LABELS: Record<HrTemplateCategory, string> = {
  schreiben: 'Schreiben',
  vertrag: 'Vertragsvorlage',
  formular: 'Formular',
  richtlinie: 'Richtlinie',
  checkliste: 'Checkliste',
  sonstiges: 'Sonstiges',
};

export interface HrTemplate {
  id: number;
  file_id: number;
  category: HrTemplateCategory;
  title: string;
  description: string | null;
  updated_at: string;
  created_at: string;
  // Angereichert aus files:
  original_name?: string;
  mime_type?: string;
  size_bytes?: number;
}

// ---------------------------------------------------------------------------
// On-/Offboarding
// ---------------------------------------------------------------------------

export type OnboardingKind = 'onboarding' | 'offboarding';

export const ONBOARDING_KIND_LABELS: Record<OnboardingKind, string> = {
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
};

export type OnboardingStatus = 'laufend' | 'abgeschlossen';

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  laufend: 'Laufend',
  abgeschlossen: 'Abgeschlossen',
};

export interface OnboardingProcess {
  id: number;
  employee_id: number;
  kind: OnboardingKind;
  status: OnboardingStatus;
  target_date: string | null; // z. B. erster Arbeitstag bzw. Austrittsdatum
  note: string | null;
  completed_at: string | null;
  created_at: string;
  // Angereichert in Listen-Antworten:
  first_name?: string;
  last_name?: string;
  job_title?: string | null;
  department_name?: string | null;
  total_tasks?: number;
  done_tasks?: number;
}

export interface OnboardingTask {
  id: number;
  process_id: number;
  title: string;
  done: number; // SQLite-Bool (0/1)
  done_at: string | null;
  done_by_user_id: number | null;
  sort_order: number;
  // Angereichert:
  done_by_name?: string | null;
}

export interface OnboardingTaskTemplate {
  id: number;
  kind: OnboardingKind;
  title: string;
  sort_order: number;
  active: number;
}

// ---------------------------------------------------------------------------
// Admin-Rollen und Rechte
// ---------------------------------------------------------------------------

/**
 * Rechtebereiche der HR-Administration. Ein Bereich bündelt fachlich
 * zusammengehörende Routen und Menüpunkte; feiner zu schneiden würde die
 * Pflege unübersichtlich machen (rund 30 Menüpunkte).
 *
 * `benutzer` ist der Sonderfall: Wer ihn auf `bearbeiten` hat, vergibt Rechte.
 * `einstellungen` deckt die Firmen- und Systemeinstellungen ab.
 */
export const ADMIN_AREAS = [
  'personal',
  'abwesenheit',
  'leistung',
  'verguetung',
  'recruiting',
  'kommunikation',
  'verwaltung',
  'einstellungen',
  'benutzer',
] as const;

export type AdminArea = (typeof ADMIN_AREAS)[number];

export const ADMIN_AREA_LABELS: Record<AdminArea, string> = {
  personal: 'Personal',
  abwesenheit: 'Abwesenheit',
  leistung: 'Leistung',
  verguetung: 'Vergütung',
  recruiting: 'Recruiting',
  kommunikation: 'Kommunikation',
  verwaltung: 'Verwaltung',
  einstellungen: 'Einstellungen',
  benutzer: 'Benutzer & Rechte',
};

/** Kurzbeschreibung je Bereich — erklärt in der Rechtevergabe, was betroffen ist. */
export const ADMIN_AREA_HINTS: Record<AdminArea, string> = {
  personal: 'Mitarbeitende, Organisation, Verträge und Dokumente',
  abwesenheit: 'Kalender, Anträge, Krankmeldungen und Abwesenheitsarten',
  leistung: 'Ziele, Beurteilungen, Skills, Trainings und Feedback',
  verguetung: 'Gehälter, Abrechnung, Boni, Honorare und Bescheinigungen',
  recruiting: 'Stellen, Bewerbungen, Interviews und Auswertungen',
  kommunikation: 'Verzeichnis, Ankündigungen, Umfragen und Gesprächsnotizen',
  verwaltung: 'HR-Vorlagen, On- und Offboarding sowie Fachrollen',
  einstellungen: 'Firmendaten und Systemeinstellungen',
  benutzer: 'Konten anlegen und Rechte vergeben',
};

/** Drei Stufen je Bereich. Fehlt ein Eintrag, gilt `kein` (fail closed). */
export const PERMISSION_LEVELS = ['kein', 'lesen', 'bearbeiten'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PERMISSION_LEVEL_LABELS: Record<PermissionLevel, string> = {
  kein: 'Kein Zugriff',
  lesen: 'Nur lesen',
  bearbeiten: 'Bearbeiten',
};

/** Rechte einer Admin-Rolle über alle Bereiche. */
export type AdminPermissions = Record<AdminArea, PermissionLevel>;

/** Frei konfigurierbare Admin-Rolle (Tabelle `admin_roles`). */
export interface AdminRole {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  permissions: AdminPermissions;
  /** Angereichert in GET /api/admin/admin-roles. */
  member_count?: number;
}

/** Konto der HR-Administration in der Benutzerverwaltung. */
export interface AdminAccount {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'mitarbeiter';
  employee_id: number | null;
  admin_role_id: number | null;
  admin_role_name: string | null;
  created_at: string;
  /**
   * 0/1 (SQLite kennt kein Boolean). 1 = Das Konto hat noch das vom Server
   * erzeugte Erstpasswort und erreicht bis zum Wechsel nur `/api/auth/me`
   * und `/api/auth/password`.
   */
  must_change_password?: number;
}

/**
 * Antwort auf das Anlegen eines Kontos und auf das Zurücksetzen eines
 * Passworts. `initial_password` erzeugt der Server zufällig und gibt es
 * GENAU EINMAL zurück — es ist nirgends gespeichert. Die Oberfläche muss es
 * deshalb sofort anzeigen; wer es verliert, muss erneut zurücksetzen.
 */
export interface AdminAccountWithPassword {
  user: AdminAccount;
  initial_password: string;
}

/**
 * Rechte eines Kontos OHNE zugewiesene Rolle: Vollzugriff.
 *
 * Bewusst so herum, damit ein Update bestehende Installationen nicht lahmlegt
 * und ein neu angelegtes Konto sich nicht selbst aussperrt. Die Einschränkung
 * ist die aktive Entscheidung, nicht der Standard.
 */
export const FULL_ACCESS: AdminPermissions = Object.fromEntries(
  ADMIN_AREAS.map((a) => [a, 'bearbeiten' as PermissionLevel]),
) as AdminPermissions;

/** Prüft, ob eine Stufe für den geforderten Zugriff ausreicht. */
export function permits(level: PermissionLevel, needed: 'lesen' | 'bearbeiten'): boolean {
  if (needed === 'lesen') return level === 'lesen' || level === 'bearbeiten';
  return level === 'bearbeiten';
}
