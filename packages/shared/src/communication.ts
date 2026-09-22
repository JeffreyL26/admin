// Typen des Moduls Kommunikation & Engagement.

/**
 * Einheitliches Zielgruppen-Muster fuer Ankuendigungen und Umfragen:
 * audience_type + audience_id (NULL bei 'alle').
 *
 * 'abteilung' schliesst Unterabteilungen ein (departments.parent_id),
 * 'verteiler' zeigt auf einen von der HR gepflegten Verteiler
 * (distribution_lists), der Abteilungen, Teams, Standorte und einzelne
 * Personen aufnimmt. Aufgeloest wird ausschliesslich im Backend
 * (modules/communication/audience.ts); die Clients zeigen nur an.
 */
export type AudienceType = 'alle' | 'abteilung' | 'team' | 'standort' | 'verteiler';

export const AUDIENCE_TYPE_LABELS: Record<AudienceType, string> = {
  alle: 'Alle Mitarbeitenden',
  abteilung: 'Abteilung',
  team: 'Team',
  standort: 'Standort',
  verteiler: 'Verteiler',
};

/** Mitgliedsarten eines Verteilers. */
/** Einzige Quelle der Mitgliedsarten: Backend (zod-Enum) und Clients lesen hier. */
export const DISTRIBUTION_MEMBER_TYPES = ['abteilung', 'team', 'standort', 'mitarbeiter'] as const;
export type DistributionMemberType = (typeof DISTRIBUTION_MEMBER_TYPES)[number];

export const DISTRIBUTION_MEMBER_TYPE_LABELS: Record<DistributionMemberType, string> = {
  abteilung: 'Abteilung',
  team: 'Team',
  standort: 'Standort',
  mitarbeiter: 'Person',
};

export interface DistributionListMember {
  member_type: DistributionMemberType;
  member_id: number;
  /** Anzeigename der Einheit bzw. Person; null, wenn sie inzwischen geloescht ist. */
  name: string | null;
}

export interface DistributionList {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  member_count: number;
  /** Aktive Mitarbeitende, die der Verteiler heute erreicht. */
  recipients: number;
  /** Ankuendigungen und Umfragen, die auf den Verteiler zeigen. */
  usage_count: number;
}

export interface DistributionListDetail extends DistributionList {
  members: DistributionListMember[];
}

// ---------------------------------------------------------------------------
// Self-Service (/api/me/announcements, /api/me/surveys)
// ---------------------------------------------------------------------------

/**
 * Anhang einer Ankuendigung. Bewusst OHNE signierte URL: Die Signatur gilt nur
 * 60 Sekunden, die Karte liegt aber laenger offen. Die Clients signieren beim
 * Klick (Portal: POST /api/me/announcements/:id/attachments/:fileId/sign,
 * Desktop: POST /api/files/:id/sign).
 */
export interface MeAnnouncementAttachment {
  file_id: number;
  original_name: string;
  size_bytes: number;
  mime_type: string | null;
}

/** Aktive Ankuendigung an die angemeldete Person. */
export interface MeAnnouncement {
  id: number;
  title: string;
  body: string;
  publish_at: string;
  expires_at: string | null;
  requires_ack: boolean;
  /** Zeitpunkt der eigenen Lesebestaetigung; null = noch nicht bestaetigt. */
  acked_at: string | null;
  attachments: MeAnnouncementAttachment[];
}

export interface MeSurveyQuestion {
  id: number;
  kind: SurveyQuestionKind;
  text: string;
  options: string[] | null;
  scale_max: number | null;
}

/** Laufende Umfrage an die angemeldete Person. */
export interface MeSurvey {
  id: number;
  title: string;
  description: string | null;
  date_from: string;
  date_to: string;
  /** true, sobald die Person teilgenommen hat (die Antworten selbst bleiben anonym). */
  participated: boolean;
}

export interface MeSurveyDetail extends MeSurvey {
  questions: MeSurveyQuestion[];
}

export type SurveyAnswerValue = string | number | string[];

export interface SurveyAnswer {
  question_id: number;
  value: SurveyAnswerValue;
}

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
