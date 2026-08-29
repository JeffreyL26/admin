import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AdminArea, FeedbackMeetingKind, InterviewKind } from '@hrmonic/shared';

/**
 * Antwortform von GET /api/dashboard (Core, modulübergreifende Aggregation).
 *
 * Alle Fachfelder sind optional, weil das Backend Blöcke, für die der Admin-Rolle
 * das Leserecht fehlt, gar nicht erst mitschickt (statt sie mit 0/[] zu füllen —
 * das würde „0 offene Anträge“ anzeigen, wo in Wahrheit welche liegen).
 * `allowed_areas` nennt die lesbaren Bereiche; danach blendet die Oberfläche
 * Kacheln und Widgets aus.
 */
export interface DashboardStats {
  headcount?: number;
  hiresYtd?: number;
  pendingAbsences?: number;
  missingSickNotes?: number;
  expiringDocuments?: number;
  openSalaryRequests?: number;
  openPositions?: number;
  activeApplications?: number;
  upcomingInterviewsCount?: number;
  absentTodayCount?: number;
}

export interface DashboardData {
  allowed_areas: AdminArea[];
  stats: DashboardStats;
  absentToday?: { id: number; first_name: string; last_name: string; type_name: string; color: string; date_to: string }[];
  byDepartment?: { department: string; count: number }[];
  absenceDaysByMonth?: { month: string; days: number }[];
  upcomingMeetings?: { id: number; kind: FeedbackMeetingKind; scheduled_date: string; first_name: string; last_name: string }[];
  upcomingBirthdays?: { id: number; first_name: string; last_name: string; birth_date: string; next_birthday: string }[];
  activeAnnouncements?: { id: number; title: string; publish_at: string; requires_ack: number }[];
  runningSurveys?: { id: number; title: string; date_to: string; participations: number }[];
  upcomingInterviews?: { id: number; kind: InterviewKind; scheduled_at: string; posting_title: string; first_name: string; last_name: string }[];
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
  });
}
