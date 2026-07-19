// Typen des Moduls Kommunikation & Engagement.

/**
 * Einheitliches Zielgruppen-Muster für Ankündigungen, Umfragen und Kanäle:
 * audience_type + audience_id (NULL bei 'alle').
 */
export type AudienceType = 'alle' | 'abteilung' | 'team' | 'standort';

export const AUDIENCE_TYPE_LABELS: Record<AudienceType, string> = {
  alle: 'Alle Mitarbeitenden',
  abteilung: 'Abteilung',
  team: 'Team',
  standort: 'Standort',
};

/** Abgeleiteter Status einer Ankündigung (aus publish_at/expires_at). */
export type AnnouncementStatus = 'geplant' | 'aktiv' | 'abgelaufen';

export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  geplant: 'Geplant',
  aktiv: 'Aktiv',
  abgelaufen: 'Abgelaufen',
};

export type SurveyStatus = 'entwurf' | 'laufend' | 'beendet';

export const SURVEY_STATUS_LABELS: Record<SurveyStatus, string> = {
  entwurf: 'Entwurf',
  laufend: 'Laufend',
  beendet: 'Beendet',
};

export type SurveyQuestionKind = 'skala' | 'einfachauswahl' | 'mehrfachauswahl' | 'freitext';

export const SURVEY_QUESTION_KIND_LABELS: Record<SurveyQuestionKind, string> = {
  skala: 'Skala',
  einfachauswahl: 'Einfachauswahl',
  mehrfachauswahl: 'Mehrfachauswahl',
  freitext: 'Freitext',
};

export type MeetingOccasion =
  | 'einzelgespraech'
  | 'probezeit'
  | 'jahresgespraech'
  | 'konflikt'
  | 'rueckkehr'
  | 'sonstiges';

export const MEETING_OCCASION_LABELS: Record<MeetingOccasion, string> = {
  einzelgespraech: 'Einzelgespräch',
  probezeit: 'Probezeitgespräch',
  jahresgespraech: 'Jahresgespräch',
  konflikt: 'Konfliktgespräch',
  rueckkehr: 'Rückkehrgespräch',
  sonstiges: 'Sonstiges',
};

export type MeetingVisibility = 'nur_hr' | 'hr_vorgesetzte' | 'hr_vorgesetzte_mitarbeiter';

export const MEETING_VISIBILITY_LABELS: Record<MeetingVisibility, string> = {
  nur_hr: 'Nur HR',
  hr_vorgesetzte: 'HR + Vorgesetzte',
  hr_vorgesetzte_mitarbeiter: 'HR + Vorgesetzte + Mitarbeiter:in',
};

/** Konfigurierbare Felder des Mitarbeiterverzeichnisses. */
export type DirectoryFieldKey =
  | 'email'
  | 'phone'
  | 'photo'
  | 'job_title'
  | 'department'
  | 'team'
  | 'location'
  | 'skills';

export const DIRECTORY_FIELD_KEYS: DirectoryFieldKey[] = [
  'photo',
  'job_title',
  'department',
  'team',
  'location',
  'email',
  'phone',
  'skills',
];

export const DIRECTORY_FIELD_LABELS: Record<DirectoryFieldKey, string> = {
  email: 'E-Mail (dienstlich)',
  phone: 'Telefon (dienstlich)',
  photo: 'Foto',
  job_title: 'Funktion / Jobtitel',
  department: 'Abteilung',
  team: 'Team',
  location: 'Standort',
  skills: 'Skills & Kompetenzen',
};

/** Fehlercode der anonymen Umfrageauswertung bei zu wenigen Teilnahmen. */
export const MIN_PARTICIPANTS_NOT_REACHED = 'MIN_PARTICIPANTS_NOT_REACHED';
