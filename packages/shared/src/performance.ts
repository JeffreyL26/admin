// Typen des Moduls Leistungsverwaltung & Entwicklung.

import type { RatingScaleKey } from './leadership.js';

// ---------------------------------------------------------------------------
// Ziele & OKR
// ---------------------------------------------------------------------------

export type GoalKind = 'objective' | 'key_result' | 'kpi';
export type GoalStatus = 'aktiv' | 'erreicht' | 'verfehlt' | 'abgebrochen';

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  objective: 'Objective',
  key_result: 'Key Result',
  kpi: 'KPI',
};

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  aktiv: 'Aktiv',
  erreicht: 'Erreicht',
  verfehlt: 'Verfehlt',
  abgebrochen: 'Abgebrochen',
};

export interface Goal {
  id: number;
  employee_id: number;
  title: string;
  description: string | null;
  kind: GoalKind;
  parent_goal_id: number | null;
  metric: string | null;
  target_value: string | null;
  current_value: string | null;
  progress: number; // 0–100
  period_from: string | null;
  period_to: string | null;
  status: GoalStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Beurteilungen
// ---------------------------------------------------------------------------

export type ReviewCycleKind = 'jaehrlich' | 'halbjaehrlich' | 'adhoc';
export type ReviewCycleStatus = 'geplant' | 'laufend' | 'abgeschlossen';

export const REVIEW_CYCLE_KIND_LABELS: Record<ReviewCycleKind, string> = {
  jaehrlich: 'Jährlich',
  halbjaehrlich: 'Halbjährlich',
  adhoc: 'Ad-hoc',
};

export const REVIEW_CYCLE_STATUS_LABELS: Record<ReviewCycleStatus, string> = {
  geplant: 'Geplant',
  laufend: 'Laufend',
  abgeschlossen: 'Abgeschlossen',
};

export interface ReviewCycle {
  id: number;
  name: string;
  kind: ReviewCycleKind;
  period_from: string;
  period_to: string;
  status: ReviewCycleStatus;
  created_at: string;
}

/**
 * Ein Kriterium eines Beurteilungsbogens. Jedes Kriterium trägt eine der
 * zentralen Skalen (`RatingScaleKey`, siehe leadership.ts) und stammt
 * entweder aus einer zentralen Bewertungskategorie (`category_id`, Name und
 * Skala werden beim Speichern des Bogens übernommen) oder ist frei
 * formuliert (z. B. eine 360°-Frage).
 */
export interface ReviewCriterion {
  key: string;
  label: string;
  description?: string;
  scale: RatingScaleKey;
  category_id?: number | null;
}

export interface ReviewTemplate {
  id: number;
  name: string;
  criteria: ReviewCriterion[];
  created_at: string;
}

/** Zentrale Bewertungskategorie, wie sie Bögen anbieten (GET /api/performance/rating-categories). */
export interface ReviewCategoryOption {
  id: number;
  name: string;
  description: string | null;
  scale: RatingScaleKey;
  is_overall: number;
}

export type ReviewKind = 'selbst' | 'feedback360';
export type ReviewStatus = 'offen' | 'in_bearbeitung' | 'abgeschlossen';

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  selbst: 'Selbstbewertung',
  feedback360: '360°-Feedback',
};

/**
 * Anlegbare Arten. Die Vorgesetztenbewertung ist keine Beurteilung, sondern
 * die Bewertung im Bereich Führung („Mein Team"): dort bewertet die
 * zuständige Führungskraft je Zeitraum mit Pflichtkommentar und
 * unveränderlichem Protokoll.
 */
export const REVIEW_CREATABLE_KINDS = ['selbst', 'feedback360'] as const satisfies readonly ReviewKind[];

/** Erklärtexte je Art, damit die Arten in der Oberfläche klar auseinandergehalten werden. */
export const REVIEW_KIND_DESCRIPTIONS: Record<ReviewKind, string> = {
  selbst:
    'Die Person schätzt sich selbst ein, auf denselben Kategorien und Skalen wie die Führungskraft. Dient dem Abgleich im Gespräch, ist keine Bewertung durch andere.',
  feedback360:
    'Rückmeldung aus dem Umfeld: Kolleg:innen, Projektpartner, interne Kund:innen. Mehrere Bögen je Person, die gemittelt werden. Bewusst getrennt von der Vorgesetztenbewertung.',
};

/** Erklärtext zur Vorgesetztenbewertung: entsteht im Bereich Führung, erscheint hier als Ergebnis. */
export const SUPERVISOR_RATING_DESCRIPTION =
  'Bewertung durch die zuständige Führungskraft. Sie wird ausschließlich im Bereich Führung unter „Mein Team" abgegeben, mit Pflichtkommentar und unveränderlichem Protokoll; hier erscheint sie als Ergebnis neben Selbstbild und Umfeld.';

/** Vorgesetztenbewertung aus dem Bereich Führung, wie sie das Aggregat mitliefert. */
export interface SupervisorRatingSummary {
  period_key: string;
  period_label: string;
  leader_name: string | null;
  overall: { scale: RatingScaleKey; score: number } | null;
  categories: { name: string; scale: RatingScaleKey; score: number }[];
}

/** Vorschläge für Reviewer:innen eines 360°-Feedbacks (GET /api/performance/reviews/suggestions/:employeeId). */
export interface ReviewerSuggestion {
  id: number;
  name: string;
  job_title: string | null;
  relation: 'vorgesetzt' | 'team' | 'kollegium';
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  offen: 'Offen',
  in_bearbeitung: 'In Bearbeitung',
  abgeschlossen: 'Abgeschlossen',
};

export interface ReviewScore {
  key: string;
  score: number;
  comment?: string;
}

export interface Review {
  id: number;
  cycle_id: number;
  employee_id: number;
  template_id: number;
  reviewer_employee_id: number | null;
  kind: ReviewKind;
  status: ReviewStatus;
  scores: ReviewScore[];
  /** 0…100, Anteil der Bestnote über alle Kriterien (skalenübergreifend vergleichbar). */
  overall_percent: number | null;
  summary: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ReviewAggregateCriterion {
  key: string;
  label: string;
  scale: RatingScaleKey;
  avg_score: number;
  avg_percent: number;
  count: number;
}

export interface ReviewAggregate {
  cycle_id: number;
  employee_id: number;
  reviews_count: number;
  criteria: ReviewAggregateCriterion[];
  overall_percent: number | null;
  /** Vorgesetztenbewertungen aus dem Bereich Führung, deren Zeitraum den Zyklus berührt. */
  supervisor: SupervisorRatingSummary[];
}

// ---------------------------------------------------------------------------
// Entwicklung & Karriere
// ---------------------------------------------------------------------------

export type DevelopmentPlanStatus = 'aktiv' | 'abgeschlossen' | 'abgebrochen';
export type DevelopmentMeasureStatus = 'offen' | 'laufend' | 'erledigt' | 'verworfen';

export const DEVELOPMENT_PLAN_STATUS_LABELS: Record<DevelopmentPlanStatus, string> = {
  aktiv: 'Aktiv',
  abgeschlossen: 'Abgeschlossen',
  abgebrochen: 'Abgebrochen',
};

export const DEVELOPMENT_MEASURE_STATUS_LABELS: Record<DevelopmentMeasureStatus, string> = {
  offen: 'Offen',
  laufend: 'Laufend',
  erledigt: 'Erledigt',
  verworfen: 'Verworfen',
};

export interface DevelopmentPlan {
  id: number;
  employee_id: number;
  title: string;
  goal: string | null;
  status: DevelopmentPlanStatus;
  created_at: string;
}

export interface DevelopmentMeasure {
  id: number;
  plan_id: number;
  title: string;
  due_date: string | null;
  owner_employee_id: number | null;
  status: DevelopmentMeasureStatus;
  note: string | null;
  created_at: string;
}

export interface CareerLevel {
  id: number;
  role_name: string;
  level: number;
  title: string;
  requirements: string | null;
  created_at: string;
}

export interface EmployeeLevel {
  id: number;
  employee_id: number;
  career_level_id: number;
  since_date: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface Skill {
  id: number;
  name: string;
  category: string | null;
  created_at: string;
}

export interface EmployeeSkill {
  employee_id: number;
  skill_id: number;
  level: number; // 1–5
  assessed_at: string | null;
}

export interface RoleSkillProfile {
  id: number;
  role_name: string;
  skill_id: number;
  required_level: number; // 1–5
}

export interface SkillGapEntry {
  skill_id: number;
  skill_name: string;
  required_level: number;
  current_level: number;
  gap: number; // >0 = Lücke
}

// ---------------------------------------------------------------------------
// Trainings
// ---------------------------------------------------------------------------

export type TrainingKind = 'intern' | 'extern';
export type TrainingRegistrationStatus = 'angemeldet' | 'teilgenommen' | 'abgeschlossen' | 'storniert';

export const TRAINING_KIND_LABELS: Record<TrainingKind, string> = {
  intern: 'Intern',
  extern: 'Extern',
};

export const TRAINING_REGISTRATION_STATUS_LABELS: Record<TrainingRegistrationStatus, string> = {
  angemeldet: 'Angemeldet',
  teilgenommen: 'Teilgenommen',
  abgeschlossen: 'Abgeschlossen',
  storniert: 'Storniert',
};

export interface Training {
  id: number;
  title: string;
  provider: string | null;
  kind: TrainingKind;
  cost_cents: number | null;
  mandatory: number; // SQLite-Bool 0/1
  repeat_interval_months: number | null;
  description: string | null;
  created_at: string;
}

export interface TrainingRegistration {
  id: number;
  training_id: number;
  employee_id: number;
  status: TrainingRegistrationStatus;
  date: string | null;
  completed_at: string | null;
  certificate_file_id: number | null;
  note: string | null;
  created_at: string;
}

export type TrainingDueStatus = 'ueberfaellig' | 'bald_faellig';

export interface TrainingDueEntry {
  training_id: number;
  training_title: string;
  repeat_interval_months: number | null;
  employee_id: number;
  first_name: string;
  last_name: string;
  last_completed_at: string | null;
  due_date: string | null; // NULL = nie absolviert, sofort fällig
  due_status: TrainingDueStatus;
}

// ---------------------------------------------------------------------------
// Feedback-Zyklen
// ---------------------------------------------------------------------------

export type FeedbackMeetingKind =
  | 'einzelgespraech'
  | 'probezeitgespraech'
  | 'jahresgespraech'
  | 'sonstiges';
export type FeedbackMeetingStatus = 'geplant' | 'stattgefunden' | 'abgesagt';
export type FeedbackActionStatus = 'offen' | 'erledigt';

export const FEEDBACK_MEETING_KIND_LABELS: Record<FeedbackMeetingKind, string> = {
  einzelgespraech: 'Einzelgespräch',
  probezeitgespraech: 'Probezeitgespräch',
  jahresgespraech: 'Jahresgespräch',
  sonstiges: 'Sonstiges',
};

export const FEEDBACK_MEETING_STATUS_LABELS: Record<FeedbackMeetingStatus, string> = {
  geplant: 'Geplant',
  stattgefunden: 'Stattgefunden',
  abgesagt: 'Abgesagt',
};

export interface FeedbackMeeting {
  id: number;
  employee_id: number;
  kind: FeedbackMeetingKind;
  scheduled_date: string;
  held_date: string | null;
  notes: string | null;
  status: FeedbackMeetingStatus;
  recurrence_months: number | null;
  created_at: string;
}

export interface FeedbackAction {
  id: number;
  meeting_id: number;
  title: string;
  due_date: string | null;
  owner_employee_id: number | null;
  status: FeedbackActionStatus;
  created_at: string;
}
