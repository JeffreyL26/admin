// Typen des Moduls Recruiting & Bewerbermanagement (Nummernkreis 6xx).
//
// Schließt die Lücke gegenüber Personio & Co.: von der Stellenausschreibung über
// eine mehrstufige Bewerbungs-Pipeline mit Interviews/Scorecards bis zur
// Einstellung, die (als Lebenszyklus-Brücke zum Personal-Modul) einen
// Mitarbeitenden-Datensatz erzeugt.

import type { EmployeeType } from './employees.js';

// ---------------------------------------------------------------------------
// Stellenausschreibungen
// ---------------------------------------------------------------------------

export type JobPostingStatus =
  | 'entwurf'
  | 'veroeffentlicht'
  | 'pausiert'
  | 'besetzt'
  | 'geschlossen';

export const JOB_POSTING_STATUS_LABELS: Record<JobPostingStatus, string> = {
  entwurf: 'Entwurf',
  veroeffentlicht: 'Veröffentlicht',
  pausiert: 'Pausiert',
  besetzt: 'Besetzt',
  geschlossen: 'Geschlossen',
};

/** Erlaubte Statuswechsel einer Stelle (Backend prüft, UI blendet passend aus). */
export const JOB_POSTING_TRANSITIONS: Record<JobPostingStatus, JobPostingStatus[]> = {
  entwurf: ['veroeffentlicht', 'geschlossen'],
  veroeffentlicht: ['pausiert', 'besetzt', 'geschlossen'],
  pausiert: ['veroeffentlicht', 'besetzt', 'geschlossen'],
  besetzt: ['geschlossen', 'veroeffentlicht'],
  geschlossen: ['entwurf'],
};

// ---------------------------------------------------------------------------
// Pipeline-Stufen
// ---------------------------------------------------------------------------

/**
 * Kategorie einer Pipeline-Stufe. 'aktiv' = laufende Bewerbung (Kanban-Spalte),
 * 'eingestellt'/'abgelehnt' = Terminalzustände (aus dem Board ausgeblendet).
 */
export type StageCategory = 'aktiv' | 'eingestellt' | 'abgelehnt';

export interface RecruitingStageDto {
  id: number;
  name: string;
  category: StageCategory;
  sort_order: number;
  color: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Bewerber:innen & Herkunftskanäle
// ---------------------------------------------------------------------------

export type CandidateSource =
  | 'website'
  | 'stellenportal'
  | 'linkedin'
  | 'empfehlung'
  | 'personalvermittlung'
  | 'initiativ'
  | 'hochschule'
  | 'sonstiges';

export const CANDIDATE_SOURCE_LABELS: Record<CandidateSource, string> = {
  website: 'Karriereseite',
  stellenportal: 'Stellenportal',
  linkedin: 'LinkedIn / Xing',
  empfehlung: 'Mitarbeiterempfehlung',
  personalvermittlung: 'Personalvermittlung',
  initiativ: 'Initiativbewerbung',
  hochschule: 'Hochschule / Messe',
  sonstiges: 'Sonstiges',
};

// ---------------------------------------------------------------------------
// Bewerbungen
// ---------------------------------------------------------------------------

export type ApplicationStatus = 'aktiv' | 'eingestellt' | 'abgelehnt' | 'zurueckgezogen';

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  aktiv: 'In Bearbeitung',
  eingestellt: 'Eingestellt',
  abgelehnt: 'Abgelehnt',
  zurueckgezogen: 'Zurückgezogen',
};

/** Ereignisarten der Bewerbungs-Timeline. */
export type ApplicationEventKind =
  | 'eingang'
  | 'stufenwechsel'
  | 'notiz'
  | 'bewertung'
  | 'interview'
  | 'absage'
  | 'einstellung'
  | 'status';

export const APPLICATION_EVENT_LABELS: Record<ApplicationEventKind, string> = {
  eingang: 'Bewerbung eingegangen',
  stufenwechsel: 'Stufe gewechselt',
  notiz: 'Notiz',
  bewertung: 'Bewertung',
  interview: 'Interview',
  absage: 'Absage',
  einstellung: 'Einstellung',
  status: 'Status',
};

// ---------------------------------------------------------------------------
// Interviews & Scorecards
// ---------------------------------------------------------------------------

export type InterviewKind = 'telefon' | 'video' | 'vor_ort' | 'technik' | 'kennenlernen';

export const INTERVIEW_KIND_LABELS: Record<InterviewKind, string> = {
  telefon: 'Telefoninterview',
  video: 'Videointerview',
  vor_ort: 'Vor-Ort-Gespräch',
  technik: 'Technisches Interview',
  kennenlernen: 'Kennenlernen / Team',
};

export type InterviewStatus = 'geplant' | 'stattgefunden' | 'abgesagt';

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  geplant: 'Geplant',
  stattgefunden: 'Stattgefunden',
  abgesagt: 'Abgesagt',
};

export type InterviewRecommendation = 'ja' | 'nein' | 'vielleicht';

export const INTERVIEW_RECOMMENDATION_LABELS: Record<InterviewRecommendation, string> = {
  ja: 'Einstellen',
  nein: 'Ablehnen',
  vielleicht: 'Unentschieden',
};

/** Ein Kriterium der Interview-Scorecard (1–5). */
export interface ScorecardEntry {
  criterion: string;
  score: number;
}

// ---------------------------------------------------------------------------
// API-Formen (snake_case wie in der DB)
// ---------------------------------------------------------------------------

export interface JobPostingDto {
  id: number;
  title: string;
  employment_type: EmployeeType;
  department_id: number | null;
  team_id: number | null;
  location_id: number | null;
  hiring_manager_id: number | null;
  seats: number;
  employment_start: string | null;
  salary_min_cents: number | null;
  salary_max_cents: number | null;
  description: string | null;
  requirements: string | null;
  status: JobPostingStatus;
  published_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  // angereichert
  department_name?: string | null;
  team_name?: string | null;
  location_name?: string | null;
  hiring_manager_name?: string | null;
  application_count?: number;
  active_count?: number;
  hired_count?: number;
}

export interface CandidateDto {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  source: CandidateSource;
  headline: string | null;
  linkedin_url: string | null;
  photo_file_id: number | null;
  note: string | null;
  consent_until: string | null;
  created_at: string;
  updated_at: string;
  application_count?: number;
}

export interface ApplicationDto {
  id: number;
  candidate_id: number;
  posting_id: number;
  stage_id: number;
  status: ApplicationStatus;
  rating: number | null;
  source: CandidateSource | null;
  cover_letter: string | null;
  cv_file_id: number | null;
  salary_expectation_cents: number | null;
  available_from: string | null;
  applied_at: string;
  stage_changed_at: string;
  rejection_reason: string | null;
  decided_at: string | null;
  converted_employee_id: number | null;
  created_at: string;
  // angereichert
  candidate_first_name?: string;
  candidate_last_name?: string;
  posting_title?: string;
  stage_name?: string;
  stage_category?: StageCategory;
  stage_color?: string;
  days_in_stage?: number;
  interview_count?: number;
}

export interface ApplicationEventDto {
  id: number;
  application_id: number;
  kind: ApplicationEventKind;
  body: string | null;
  from_stage_id: number | null;
  to_stage_id: number | null;
  from_stage_name?: string | null;
  to_stage_name?: string | null;
  user_id: number | null;
  user_name?: string | null;
  created_at: string;
}

export interface InterviewDto {
  id: number;
  application_id: number;
  kind: InterviewKind;
  scheduled_at: string;
  duration_minutes: number | null;
  location: string | null;
  interviewer_ids: number[];
  status: InterviewStatus;
  recommendation: InterviewRecommendation | null;
  scorecard: ScorecardEntry[];
  feedback: string | null;
  created_at: string;
  // angereichert
  interviewer_names?: string[];
  candidate_first_name?: string;
  candidate_last_name?: string;
  posting_title?: string;
}
