// Typen des Moduls Verwaltung (HR-Vorlagen, On-/Offboarding).

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
