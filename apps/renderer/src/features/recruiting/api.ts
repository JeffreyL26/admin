import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type {
  ApplicationDto,
  ApplicationEventDto,
  CandidateDto,
  InterviewDto,
  JobPostingDto,
  RecruitingStageDto,
} from '@hrmonic/shared';

// ---------------------------------------------------------------------------
// Angereicherte Client-Typen
// ---------------------------------------------------------------------------

export interface OrgData {
  departments: { id: number; name: string }[];
  teams: { id: number; name: string; department_id: number | null }[];
  locations: { id: number; name: string }[];
}

export type Posting = JobPostingDto & {
  stage_counts?: { stage_id: number; name: string; color: string; count: number }[];
};
export type Candidate = CandidateDto & { photo_url?: string | null };
export type Application = ApplicationDto & { candidate_email?: string | null };

export interface ApplicationDetail extends Application {
  cv_url: string | null;
  events: ApplicationEventDto[];
  interviews: InterviewDto[];
}

export interface CandidateDetail extends Candidate {
  applications: Application[];
}

export interface RecruitingAnalytics {
  stats: {
    openPostings: number;
    openSeats: number;
    activeApplications: number;
    hiresYtd: number;
    upcomingInterviews: number;
    avgTimeToHire: number | null;
  };
  funnel: { name: string; color: string; category: string; count: number }[];
  bySource: { source: string; count: number; hired: number }[];
}

// ---------------------------------------------------------------------------
// Query-Hooks
// ---------------------------------------------------------------------------

export function useRecruitingOrg() {
  return useQuery({
    queryKey: ['recruiting', 'org'],
    queryFn: () => api.get<OrgData>('/api/recruiting/org'),
  });
}

export function useStages() {
  return useQuery({
    queryKey: ['recruiting', 'stages'],
    queryFn: () => api.get<{ stages: RecruitingStageDto[] }>('/api/recruiting/stages'),
    select: (d) => d.stages,
  });
}

export function usePostings(filters: { status?: string; search?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);
  const qs = params.toString();
  return useQuery({
    queryKey: ['recruiting', 'postings', filters],
    queryFn: () => api.get<{ postings: Posting[] }>(`/api/recruiting/postings${qs ? `?${qs}` : ''}`),
    select: (d) => d.postings,
  });
}

export function usePosting(id: number | null) {
  return useQuery({
    queryKey: ['recruiting', 'postings', id],
    queryFn: () => api.get<{ posting: Posting }>(`/api/recruiting/postings/${id}`),
    select: (d) => d.posting,
    enabled: id !== null,
  });
}

export function useCandidates(search?: string) {
  return useQuery({
    queryKey: ['recruiting', 'candidates', search ?? ''],
    queryFn: () =>
      api.get<{ candidates: Candidate[] }>(
        `/api/recruiting/candidates${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    select: (d) => d.candidates,
  });
}

export function useCandidate(id: number | null) {
  return useQuery({
    queryKey: ['recruiting', 'candidates', id],
    queryFn: () => api.get<{ candidate: CandidateDetail }>(`/api/recruiting/candidates/${id}`),
    select: (d) => d.candidate,
    enabled: id !== null,
  });
}

export function useApplications(filters: { posting_id?: number; status?: string; search?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.posting_id) params.set('posting_id', String(filters.posting_id));
  if (filters.status) params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);
  const qs = params.toString();
  return useQuery({
    queryKey: ['recruiting', 'applications', filters],
    queryFn: () =>
      api.get<{ applications: Application[] }>(`/api/recruiting/applications${qs ? `?${qs}` : ''}`),
    select: (d) => d.applications,
  });
}

export function useApplication(id: number | null) {
  return useQuery({
    queryKey: ['recruiting', 'applications', id],
    queryFn: () => api.get<{ application: ApplicationDetail }>(`/api/recruiting/applications/${id}`),
    select: (d) => d.application,
    enabled: id !== null,
  });
}

export function useInterviews(filters: { upcoming?: boolean; status?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.upcoming) params.set('upcoming', 'true');
  if (filters.status) params.set('status', filters.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['recruiting', 'interviews', filters],
    queryFn: () => api.get<{ interviews: InterviewDto[] }>(`/api/recruiting/interviews${qs ? `?${qs}` : ''}`),
    select: (d) => d.interviews,
  });
}

export function useAnalytics() {
  return useQuery({
    queryKey: ['recruiting', 'analytics'],
    queryFn: () => api.get<{ analytics: RecruitingAnalytics }>('/api/recruiting/analytics'),
    select: (d) => d.analytics,
  });
}

/** Invalidiert alle Recruiting-Queries (nach Mutationen). */
export function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['recruiting'] });
}
