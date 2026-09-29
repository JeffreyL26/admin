// Typen des Moduls Kommunikation & Engagement.
import type { ScopeSource } from './leadership.js';

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

/** Einzige Quelle der Stufen: Backend (zod-Enum) und Clients lesen hier. */
export const MEETING_VISIBILITIES = ['nur_hr', 'hr_vorgesetzte', 'hr_vorgesetzte_mitarbeiter'] as const;
export type MeetingVisibility = (typeof MEETING_VISIBILITIES)[number];

/**
 * Wer ein Protokoll ausser der HR liest. EINZIGE Quelle dieser Zuordnung:
 * Die Filter der Portal- und der Fuehrungsrouten (`meetingVisibilitiesFor`),
 * `visible_to_employee`, der Empfaengerhinweis und die Badges der HR leiten
 * sich daraus ab. Eine neue Stufe verlangt hier einen Eintrag, sonst schlaegt
 * der Typecheck an.
 */
export const MEETING_VISIBILITY_READERS: Record<MeetingVisibility, { leaders: boolean; employee: boolean }> = {
  nur_hr: { leaders: false, employee: false },
  hr_vorgesetzte: { leaders: true, employee: false },
  hr_vorgesetzte_mitarbeiter: { leaders: true, employee: true },
};

/** Stufen, die die Fuehrung bzw. die Person selbst erreichen. */
export function meetingVisibilitiesFor(reader: 'leaders' | 'employee'): MeetingVisibility[] {
  return MEETING_VISIBILITIES.filter((v) => MEETING_VISIBILITY_READERS[v][reader]);
}

/**
 * Faellig ist eine Wiedervorlage ab ihrem Datum (heute oder frueher). Gleiche
 * Regel wie die SQL-Abfragen der Wiedervorlagen (`follow_up_date <= heute`).
 */
export function isFollowUpDue(followUpDate: string | null, today: string): boolean {
  return followUpDate !== null && followUpDate <= today;
}

/**
 * Wer ein Protokoll sieht:
 * - 'nur_hr': nur die Personalabteilung (Kommunikation → Gesprächsprotokolle).
 * - 'hr_vorgesetzte': zusaetzlich die zustaendigen Fuehrungskraefte unter
 *   „Mein Team“ (GET /api/leadership/me/employees/:id/meetings). Wer
 *   zustaendig ist, bestimmt allein die Fuehrungsverwaltung (scopeFor): der
 *   HEUTIGE Bereich, ohne Verlauf.
 * - 'hr_vorgesetzte_mitarbeiter': wie zuvor, dazu die Person selbst im Portal
 *   (GET /api/me/meetings).
 */
export const MEETING_VISIBILITY_LABELS: Record<MeetingVisibility, string> = {
  nur_hr: 'Nur HR',
  hr_vorgesetzte: 'HR und Führungskräfte',
  hr_vorgesetzte_mitarbeiter: 'HR, Führungskräfte und Mitarbeitende',
};

/** Erklaerung je Stufe fuer das Formular der HR. */
export const MEETING_VISIBILITY_HINTS: Record<MeetingVisibility, string> = {
  nur_hr: 'Nur die Personalabteilung sieht dieses Protokoll.',
  hr_vorgesetzte:
    'Sichtbar für die zuständigen Führungskräfte unter „Mein Team“, nicht für die Person selbst.',
  hr_vorgesetzte_mitarbeiter:
    'Sichtbar für die zuständigen Führungskräfte und im Portal der Person unter „Gesprächsprotokolle“.',
};

/** Eigenes Gespraechsprotokoll im Portal (GET /api/me/meetings). */
export interface MeMeeting {
  id: number;
  meeting_date: string;
  occasion: MeetingOccasion;
  participants: string | null;
  content: string | null;
  agreements: string | null;
  follow_up_date: string | null;
}

/**
 * Gespraechsprotokoll aus Sicht der Fuehrungskraft („Mein Team“). Nur Stufen
 * mit `MEETING_VISIBILITY_READERS[..].leaders` erreichen sie. Ohne Autor und
 * Zeitstempel: das Protokoll fuehrt die HR.
 */
export interface LeaderMeeting extends MeMeeting {
  employee_id: number;
  first_name: string;
  last_name: string;
  /** 1 = die Stufe gibt das Protokoll auch fuer die Person selbst frei. */
  released_to_employee: 0 | 1;
  /**
   * 1 = freigegeben UND die Person hat ein Konto mit verknuepftem Profil,
   * kann es im Portal also tatsaechlich lesen.
   */
  visible_to_employee: 0 | 1;
}

/** Eine Fuehrungskraft, die ein Protokoll der Person heute erreicht (HR-Editor). */
export interface MeetingRecipient {
  employee_id: number;
  name: string;
  /**
   * Warum die Fuehrungskraft zustaendig ist (direkt, Abteilung, Team,
   * zugewiesen). Nur fuer Konten mit Recht „Fuehrung: lesen“: Zuweisungen
   * gehoeren zur Fuehrungsverwaltung, nicht zur Kommunikation.
   */
  sources?: ScopeSource[];
  /**
   * 1 = das Konto darf die Protokolle unter „Mein Team“ auch lesen. 0 bei
   * einem Konto, das die Zustaendigkeit selbst veraendern kann, aber kein
   * Leserecht in „Kommunikation“ hat (Selbstschutz beim Lesen).
   */
  can_read: 0 | 1;
  /** 1 = die Fuehrungskraft hat ein Desktop-Konto und sieht „Mein Team“ auch. */
  has_account: 0 | 1;
}

/** GET /api/communication/meetings/recipients?employee_id= */
export interface MeetingRecipientsResponse {
  leaders: MeetingRecipient[];
}

/**
 * Eintrag des Verzeichnisses (HR: GET /api/communication/directory, Portal:
 * GET /api/me/directory). Felder fehlen, wenn die HR sie ausgeblendet hat;
 * `fields` in der Antwort sagt, welche.
 */
export interface DirectoryEmployee {
  id: number;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  email?: string | null;
  phone?: string | null;
  photo_file_id?: number | null;
  /** Kurzlebig signiert (core/files.ts): sofort laden, nicht merken. */
  photo_url?: string | null;
  department_name?: string | null;
  team_name?: string | null;
  location_name?: string | null;
  skills?: { name: string; level: number }[];
}

export interface MeDirectoryResponse {
  employees: DirectoryEmployee[];
  fields: Record<DirectoryFieldKey, boolean>;
  /** Fuer den Abteilungsfilter; leer, wenn das Feld Abteilung ausgeblendet ist. */
  departments: { id: number; name: string; parent_id: number | null }[];
}

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
