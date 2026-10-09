import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AdminArea, FeedbackMeetingKind, InterviewKind } from '@ohrganize/shared';

/**
 * Antwortform von GET /api/dashboard (Core, modulübergreifende Aggregation).
 *
 * Alle Fachfelder sind optional, weil das Backend Blöcke, für die der Admin-Rolle
 * das Leserecht fehlt, gar nicht erst mitschickt (statt sie mit 0/[] zu füllen —
 * das würde „0 offene Anträge“ anzeigen, wo in Wahrheit welche liegen).
 * `allowed_areas` nennt die lesbaren Bereiche; danach blendet die Oberfläche
 * Bereiche und Widgets aus.
 */
export interface DashboardStats {
  upcomingInterviewsCount?: number;
}

export interface DashboardData {
  allowed_areas: AdminArea[];
  stats: DashboardStats;
  byDepartment?: { department_id: number | null; department: string; count: number }[];
  absenceDaysByMonth?: { month: string; days: number }[];
  upcomingMeetings?: { id: number; kind: FeedbackMeetingKind; scheduled_date: string; first_name: string; last_name: string }[];
  upcomingBirthdays?: { id: number; first_name: string; last_name: string; birth_date: string; next_birthday: string }[];
  /** Alle mit Geburtstag heute (ohne die Grenze der Vorschau; 29.2. feiert sonst am 28.2.). */
  birthdays_today?: { id: number; first_name: string; last_name: string }[];
  runningSurveys?: { id: number; title: string; date_to: string; participations: number }[];
  upcomingInterviews?: { id: number; kind: InterviewKind; scheduled_at: string; posting_title: string; first_name: string; last_name: string }[];
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
  });
}
