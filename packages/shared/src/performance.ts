// Typen des Moduls Leistungsverwaltung & Entwicklung.

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

/** Ein Kriterium eines Beurteilungsbogens (Skala konfigurierbar, z. B. 1–5 oder 1–10). */
export interface ReviewCriterion {
  key: string;
  label: string;
  description?: string;
  scale_max: number;
}

export interface ReviewTemplate {
  id: number;
  name: string;
  criteria: ReviewCriterion[];
  created_at: string;
}

export type ReviewKind = 'selbst' | 'vorgesetzt' | 'feedback360';
export type ReviewStatus = 'offen' | 'in_bearbeitung' | 'abgeschlossen';

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  selbst: 'Selbstbewertung',
  vorgesetzt: 'Vorgesetztenbewertung',
  feedback360: '360°-Feedback',
};

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
  overall_score: number | null;
  summary: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ReviewAggregateCriterion {
  key: string;
  label: string;
  avg_score: number;
  count: number;
}

export interface ReviewAggregate {
  cycle_id: number;
  employee_id: number;
  reviews_count: number;
  criteria: ReviewAggregateCriterion[];
  overall_score: number | null;
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
