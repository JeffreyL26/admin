import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type {
  AnnouncementStatus,
  AudienceType,
  DirectoryFieldKey,
  DistributionList,
  DistributionListDetail,
  DistributionListMember,
  MeAnnouncement,
  MeSurvey,
  MeSurveyDetail,
  MeetingOccasion,
  MeetingRecipientsResponse,
  MeetingVisibility,
  SurveyAnswer,
  SurveyQuestionKind,
  SurveyStatus,
} from '@ohrganize/shared';

// ---------------------------------------------------------------------------
// Typen (API-Felder snake_case wie in der DB)
// ---------------------------------------------------------------------------

export interface OrgData {
  departments: { id: number; name: string; parent_id: number | null }[];
  teams: { id: number; name: string; department_id: number | null }[];
  locations: { id: number; name: string }[];
  distribution_lists: { id: number; name: string }[];
}

export interface DirectoryEmployee {
  id: number;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  email?: string | null;
  phone?: string | null;
  photo_file_id?: number | null;
  photo_thumb_file_id?: number | null;
  photo_url?: string | null;
  department_name?: string | null;
  team_name?: string | null;
  location_name?: string | null;
  skills?: { name: string; level: number }[];
}

export interface DirectoryField {
  field_key: DirectoryFieldKey;
  visible: boolean;
}

export interface Announcement {
  id: number;
  title: string;
  body: string;
  audience_type: AudienceType;
  audience_id: number | null;
  audience_name: string | null;
  publish_at: string;
  expires_at: string | null;
  requires_ack: boolean;
  status: AnnouncementStatus;
  recipients: number;
  ack_count: number;
  created_at: string;
}

export interface AnnouncementAttachment {
  id: number;
  file_id: number;
  original_name: string;
  size_bytes: number;
  mime_type: string;
}

export interface SurveyQuestion {
  id: number;
  survey_id: number;
  kind: SurveyQuestionKind;
  text: string;
  options: string[] | null;
  scale_max: number | null;
  sort_order: number;
}

export interface Survey {
  id: number;
  title: string;
  description: string | null;
  audience_type: AudienceType;
  audience_id: number | null;
  audience_name: string | null;
  date_from: string;
  date_to: string;
  min_participants: number | null;
  effective_min_participants: number;
  status: SurveyStatus;
  recipients: number;
  participant_count: number;
  /** Laufend, aber date_to ueberschritten: das Portal bietet sie nicht mehr an. */
  deadline_passed: boolean;
}

export interface SurveyResults {
  survey_id: number;
  response_count: number;
  min_participants: number;
  questions: {
    id: number;
    kind: SurveyQuestionKind;
    text: string;
    answer_count: number;
    scale_max?: number;
    average?: number | null;
    distribution?: { value: number; count: number }[];
    frequencies?: { option: string; count: number }[];
    texts?: string[];
  }[];
}

export interface Meeting {
  id: number;
  employee_id: number;
  first_name: string;
  last_name: string;
  meeting_date: string;
  occasion: MeetingOccasion;
  participants: string | null;
  content: string | null;
  agreements: string | null;
  follow_up_date: string | null;
  visibility: MeetingVisibility;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Query-Hooks
// ---------------------------------------------------------------------------

export function useOrg() {
  return useQuery({
    queryKey: ['communication', 'org'],
    queryFn: () => api.get<OrgData>('/api/communication/org'),
  });
}

export function useDirectory(filters: {
  search?: string;
  department_id?: number;
  location_id?: number;
  skill?: string;
}) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.department_id) params.set('department_id', String(filters.department_id));
  if (filters.location_id) params.set('location_id', String(filters.location_id));
  if (filters.skill) params.set('skill', filters.skill);
  const qs = params.toString();
  return useQuery({
    queryKey: ['communication', 'directory', filters],
    queryFn: () =>
      api.get<{ employees: DirectoryEmployee[]; fields: Record<DirectoryFieldKey, boolean> }>(
        `/api/communication/directory${qs ? `?${qs}` : ''}`,
      ),
  });
}

export function useDirectoryFields() {
  return useQuery({
    queryKey: ['communication', 'directory-fields'],
    queryFn: () => api.get<{ fields: DirectoryField[] }>('/api/communication/directory/fields'),
    select: (d) => d.fields,
  });
}

export function useSaveDirectoryFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fields: DirectoryField[]) =>
      api.put<{ fields: DirectoryField[] }>('/api/communication/directory/fields', { fields }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['communication', 'directory'] });
      qc.invalidateQueries({ queryKey: ['communication', 'directory-fields'] });
    },
  });
}

export function useAnnouncements() {
  return useQuery({
    queryKey: ['communication', 'announcements'],
    queryFn: () => api.get<{ announcements: Announcement[] }>('/api/communication/announcements'),
    select: (d) => d.announcements,
  });
}

export interface AnnouncementAck {
  employee_id: number;
  name: string;
  acked_at: string;
}

export function useAnnouncement(id: number | null) {
  return useQuery({
    queryKey: ['communication', 'announcements', id],
    queryFn: () =>
      api.get<{ announcement: Announcement & { attachments: AnnouncementAttachment[]; acks: AnnouncementAck[] } }>(
        `/api/communication/announcements/${id}`,
      ),
    select: (d) => d.announcement,
    enabled: id !== null,
  });
}

export function useSurveys() {
  return useQuery({
    queryKey: ['communication', 'surveys'],
    queryFn: () => api.get<{ surveys: Survey[] }>('/api/communication/surveys'),
    select: (d) => d.surveys,
  });
}

export function useSurvey(id: number | null) {
  return useQuery({
    queryKey: ['communication', 'surveys', id],
    queryFn: () =>
      api.get<{ survey: Survey & { questions: SurveyQuestion[] } }>(`/api/communication/surveys/${id}`),
    select: (d) => d.survey,
    enabled: id !== null,
  });
}

export function useMeetings(filters: { employee_id?: number; occasion?: MeetingOccasion } = {}) {
  const params = new URLSearchParams();
  if (filters.employee_id) params.set('employee_id', String(filters.employee_id));
  if (filters.occasion) params.set('occasion', filters.occasion);
  const qs = params.toString();
  return useQuery({
    // 'list' trennt die Liste vom Schluessel der Wiedervorlagen (['meetings',
    // 'follow-ups']); invalidate('meetings') trifft weiterhin beide.
    queryKey: ['communication', 'meetings', 'list', filters],
    queryFn: () => api.get<{ meetings: Meeting[] }>(`/api/communication/meetings${qs ? `?${qs}` : ''}`),
    select: (d) => d.meetings,
  });
}

/**
 * Führungskräfte, die ein Protokoll der Person heute erreicht (Zuständigkeit
 * laut Führungsverwaltung). Die Route gibt es nur in Varianten mit Führung;
 * der Aufrufer (RecipientsNote) erscheint nur dort. Eigener Schlüssel außerhalb
 * von ['communication', 'meetings']: Speichern eines Protokolls ändert nicht,
 * wer zuständig ist. Kein eigenes `staleTime`: Die Zuständigkeit ändern
 * andere Arbeitsplätze, und der Editor soll sie beim Wechsel der Person
 * aktuell zeigen.
 */
export function useMeetingRecipients(employeeId: number | null) {
  return useQuery({
    queryKey: ['communication', 'meeting-recipients', employeeId],
    queryFn: () =>
      api.get<MeetingRecipientsResponse>(`/api/communication/meetings/recipients?employee_id=${employeeId}`),
    select: (d) => d.leaders,
    enabled: employeeId !== null,
    meta: { silentError: true },
  });
}

export function useFollowUps() {
  return useQuery({
    queryKey: ['communication', 'meetings', 'follow-ups'],
    queryFn: () => api.get<{ meetings: Meeting[] }>('/api/communication/meetings/follow-ups'),
    select: (d) => d.meetings,
  });
}

export function useDistributionLists() {
  return useQuery({
    queryKey: ['communication', 'distribution-lists'],
    queryFn: () => api.get<{ distribution_lists: DistributionList[] }>('/api/communication/distribution-lists'),
    select: (d) => d.distribution_lists,
  });
}

export function useDistributionList(id: number | null) {
  return useQuery({
    queryKey: ['communication', 'distribution-lists', id],
    queryFn: () =>
      api.get<{ distribution_list: DistributionListDetail }>(`/api/communication/distribution-lists/${id}`),
    select: (d) => d.distribution_list,
    enabled: id !== null,
  });
}

export type { DistributionListMember };

// ---------------------------------------------------------------------------
// Eigene Sicht (Self-Service-Routen, auch fuer Admin-Konten mit Profil)
// ---------------------------------------------------------------------------

/**
 * Ankuendigungen und Umfragen an die angemeldete Person. Antwortet das
 * Backend mit 403 (Konto ohne verknuepftes Personalprofil), gibt es schlicht
 * nichts anzuzeigen; deshalb kein Retry und keine Fehlermeldung. Die
 * Dashboard-Kacheln erscheinen nur, wenn die Liste Eintraege hat.
 */
/** Nach einem Fehler (403 ohne Profil) nicht weiter im Minutentakt anfragen. */
const pollUnlessFailed = (query: { state: { error: unknown } }) => (query.state.error ? false : 60_000);

export function useMyAnnouncements(enabled = true) {
  return useQuery({
    queryKey: ['me', 'announcements'],
    queryFn: () => api.get<{ announcements: MeAnnouncement[] }>('/api/me/announcements'),
    select: (d) => d.announcements,
    enabled,
    retry: false,
    refetchInterval: pollUnlessFailed,
  });
}

export function useMySurveys(enabled = true) {
  return useQuery({
    queryKey: ['me', 'surveys'],
    queryFn: () => api.get<{ surveys: MeSurvey[] }>('/api/me/surveys'),
    select: (d) => d.surveys,
    enabled,
    retry: false,
    refetchInterval: pollUnlessFailed,
  });
}

export function useMySurvey(id: number | null) {
  return useQuery({
    queryKey: ['me', 'surveys', id],
    queryFn: () => api.get<{ survey: MeSurveyDetail }>(`/api/me/surveys/${id}`),
    select: (d) => d.survey,
    enabled: id !== null,
  });
}

export function useAckAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<void>(`/api/me/announcements/${id}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'announcements'] }),
  });
}

export function useSubmitSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, answers }: { id: number; answers: SurveyAnswer[] }) =>
      api.post(`/api/me/surveys/${id}/responses`, { answers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'surveys'] }),
  });
}

/** Invalidiert alle Queries des Kommunikationsmoduls unterhalb eines Schlüssels. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...key: (string | number)[]) =>
    qc.invalidateQueries({ queryKey: ['communication', ...key] });
}
