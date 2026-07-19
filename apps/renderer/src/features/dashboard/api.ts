import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { FeedbackMeetingKind, InterviewKind } from '@hrmonic/shared';

// Antwortform von GET /api/dashboard (Core, modulübergreifende Aggregation).
export interface DashboardStats {
  headcount: number;
  hiresYtd: number;
  pendingAbsences: number;
  missingSickNotes: number;
  expiringDocuments: number;
  openSalaryRequests: number;
  openPositions: number;
  activeApplications: number;
  upcomingInterviewsCount: number;
  absentTodayCount: number;
}

export interface DashboardData {
  stats: DashboardStats;
  absentToday: { id: number; first_name: string; last_name: string; type_name: string; color: string; date_to: string }[];
  byDepartment: { department: string; count: number }[];
  absenceDaysByMonth: { month: string; days: number }[];
  upcomingMeetings: { id: number; kind: FeedbackMeetingKind; scheduled_date: string; first_name: string; last_name: string }[];
  upcomingBirthdays: { id: number; first_name: string; last_name: string; birth_date: string; next_birthday: string }[];
  activeAnnouncements: { id: number; title: string; publish_at: string; requires_ack: number }[];
  runningSurveys: { id: number; title: string; date_to: string; participations: number }[];
  upcomingInterviews: { id: number; kind: InterviewKind; scheduled_at: string; posting_title: string; first_name: string; last_name: string }[];
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
  });
}
