import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type {
  AnnouncementStatus,
  AudienceType,
  DirectoryFieldKey,
  MeetingOccasion,
  MeetingVisibility,
  SurveyQuestionKind,
  SurveyStatus,
} from '@hrmonic/shared';

// ---------------------------------------------------------------------------
// Typen (API-Felder snake_case wie in der DB)
// ---------------------------------------------------------------------------

export interface OrgData {
  departments: { id: number; name: string }[];
  teams: { id: number; name: string; department_id: number | null }[];
  locations: { id: number; name: string }[];
}

export interface DirectoryEmployee {
  id: number;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  email?: string | null;
  phone?: string | null;
  photo_file_id?: number | null;
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

export interface Channel {
  id: number;
  name: string;
  topic: string | null;
  audience_type: AudienceType;
  audience_id: number | null;
  audience_name: string | null;
  archived: boolean;
  recipients: number;
  message_count: number;
  last_message_at: string | null;
}

export interface ChannelMessage {
  id: number;
  channel_id: number;
  body: string;
  sent_at: string;
  sent_by_user_id: number | null;
  sent_by_name: string | null;
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

export function useAnnouncement(id: number | null) {
  return useQuery({
    queryKey: ['communication', 'announcements', id],
    queryFn: () =>
      api.get<{ announcement: Announcement & { attachments: AnnouncementAttachment[] } }>(
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

export function useMeetings() {
  return useQuery({
    queryKey: ['communication', 'meetings'],
    queryFn: () => api.get<{ meetings: Meeting[] }>('/api/communication/meetings'),
    select: (d) => d.meetings,
  });
}

export function useFollowUps() {
  return useQuery({
    queryKey: ['communication', 'meetings', 'follow-ups'],
    queryFn: () => api.get<{ meetings: Meeting[] }>('/api/communication/meetings/follow-ups'),
    select: (d) => d.meetings,
  });
}

export function useChannels() {
  return useQuery({
    queryKey: ['communication', 'channels'],
    queryFn: () => api.get<{ channels: Channel[] }>('/api/communication/channels'),
    select: (d) => d.channels,
  });
}

export function useChannelMessages(channelId: number | null) {
  return useQuery({
    queryKey: ['communication', 'channels', channelId, 'messages'],
    queryFn: () =>
      api.get<{ messages: ChannelMessage[] }>(`/api/communication/channels/${channelId}/messages`),
    select: (d) => d.messages,
    enabled: channelId !== null,
  });
}

/** Invalidiert alle Queries des Kommunikationsmoduls unterhalb eines Schlüssels. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...key: (string | number)[]) =>
    qc.invalidateQueries({ queryKey: ['communication', ...key] });
}
