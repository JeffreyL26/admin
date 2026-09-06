/**
 * Datenzugriff des Moduls Führung & Bewertung (TanStack Query).
 *
 * Alle Query-Keys beginnen mit 'leadership'; die Mutations-Hooks invalidieren
 * nach Erfolg den gesamten Baum. Das ist bewusst grob: Freischaltungen,
 * Zuweisungen und Einstellungen wirken auf Team, Status und Report zugleich —
 * eine feinere Invalidierung hätte mehr Fehlerquellen als Nutzen.
 *
 * Antwortformen sind die DTOs aus @ohrganize/shared (leadership.ts); die
 * Pfade entsprechen backend/src/modules/leadership/routes.ts.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AssignmentCreateResponse,
  EmployeeRatingsResponse,
  Leader,
  LeaderBreakdown,
  LeaderCreateResponse,
  LeaderStatus,
  LeaderTeamResponse,
  LeadershipAssignmentInput,
  LeadershipLookup,
  LeadershipReport,
  LeadershipSettings,
  LeadershipSettingsPatch,
  LeadershipSettingsResponse,
  MyTeamResponse,
  Rating,
  RatingCategory,
  RatingCategoryInput,
  RatingDetail,
  RatingsSaveRequest,
  TeamMemberDetailResponse,
} from '@ohrganize/shared';
import { api } from '../../api/client';

export const LEADERSHIP_KEY = ['leadership'] as const;

export function invalidateLeadership(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: LEADERSHIP_KEY });
}

function periodQuery(period: string | null | undefined): string {
  return period ? `?period=${encodeURIComponent(period)}` : '';
}

// ---------------------------------------------------------------------------
// Führungsfunktion (eigenes Team)
// ---------------------------------------------------------------------------

/**
 * Ist das angemeldete Konto eine freigeschaltete Führungskraft? Steuert die
 * Sichtbarkeit von „Mein Team“ in Sidebar und Befehlspalette. Antwortet für
 * jedes Admin-Konto mit 200 — ein Fehler hier heißt „Server nicht erreichbar“,
 * und dafür gibt es bereits die Meldungen der Fachseiten (silentError).
 */
export function useLeaderStatus() {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'me', 'status'],
    queryFn: () => api.get<LeaderStatus>('/api/leadership/me/status'),
    staleTime: 60_000,
    meta: { silentError: true },
  });
}

/** Eigener Zuständigkeitsbereich im Zeitraum (null = aktueller Zeitraum). */
export function useMyTeam(period: string | null) {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'me', 'team', period ?? 'current'],
    queryFn: () => api.get<MyTeamResponse>(`/api/leadership/me/team${periodQuery(period)}`),
    placeholderData: keepPreviousData,
  });
}

/** Bewertungsmaske einer Person aus dem eigenen Bereich. */
export function useTeamMemberDetail(employeeId: number, period: string | null) {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'me', 'employee', employeeId, period ?? 'current'],
    queryFn: () =>
      api.get<TeamMemberDetailResponse>(`/api/leadership/me/employees/${employeeId}${periodQuery(period)}`),
    enabled: Number.isFinite(employeeId),
    placeholderData: keepPreviousData,
  });
}

/** Bewertungsblöcke eines Zeitraums speichern (Upsert je Kategorie, protokolliert). */
export function useSaveRatings(employeeId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RatingsSaveRequest) =>
      api.put<{ ratings: Rating[] }>(`/api/leadership/me/employees/${employeeId}/ratings`, body),
    onSuccess: () => invalidateLeadership(qc),
  });
}

// ---------------------------------------------------------------------------
// Verwaltung: Einstellungen und Kategorien
// ---------------------------------------------------------------------------

export function useLeadershipSettings() {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'settings'],
    queryFn: () => api.get<LeadershipSettingsResponse>('/api/leadership/settings'),
    select: (d) => d.settings,
  });
}

/**
 * Bestehende gegenseitige Verantwortung (gleiche Abfrage wie die
 * Einstellungen) — die Einrichtung warnt damit auch vor Paaren, die durch
 * Organisationsänderungen entstanden sind.
 */
export function useMutualPairs() {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'settings'],
    queryFn: () => api.get<LeadershipSettingsResponse>('/api/leadership/settings'),
    select: (d) => d.mutual_pairs,
  });
}

export function useUpdateLeadershipSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: LeadershipSettingsPatch) =>
      api.put<{ settings: LeadershipSettings }>('/api/leadership/settings', patch),
    onSuccess: () => invalidateLeadership(qc),
  });
}

/** Alle Kategorien inklusive inaktiver (Verwaltungssicht). */
export function useRatingCategories() {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'categories'],
    queryFn: () => api.get<{ categories: RatingCategory[] }>('/api/leadership/categories'),
    select: (d) => d.categories,
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RatingCategoryInput) =>
      api.post<{ category: RatingCategory }>('/api/leadership/categories', input),
    onSuccess: () => invalidateLeadership(qc),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<RatingCategoryInput> }) =>
      api.patch<{ category: RatingCategory }>(`/api/leadership/categories/${id}`, patch),
    onSuccess: () => invalidateLeadership(qc),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/leadership/categories/${id}`),
    onSuccess: () => invalidateLeadership(qc),
  });
}

/** Neue Reihenfolge — `ids` muss jede Kategorie genau einmal enthalten. */
export function useReorderCategories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) =>
      api.post<{ categories: RatingCategory[] }>('/api/leadership/categories/reorder', { ids }),
    onSuccess: () => invalidateLeadership(qc),
  });
}

// ---------------------------------------------------------------------------
// Verwaltung: Führungskräfte und Zuständigkeiten
// ---------------------------------------------------------------------------

export function useLeaders() {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'leaders'],
    queryFn: () => api.get<{ leaders: Leader[] }>('/api/leadership/leaders'),
    select: (d) => d.leaders,
  });
}

export function useGrantLeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { employee_id: number; auto_scope?: boolean; note?: string | null }) =>
      api.post<LeaderCreateResponse>('/api/leadership/leaders', input),
    onSuccess: () => invalidateLeadership(qc),
  });
}

export function useUpdateLeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, patch }: { employeeId: number; patch: { auto_scope?: boolean; note?: string | null } }) =>
      api.patch<{ leader: Leader; warnings: string[] }>(`/api/leadership/leaders/${employeeId}`, patch),
    onSuccess: () => invalidateLeadership(qc),
  });
}

export function useRevokeLeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (employeeId: number) => api.delete<void>(`/api/leadership/leaders/${employeeId}`),
    onSuccess: () => invalidateLeadership(qc),
  });
}

/**
 * Auswahllisten der Einrichtung (Personen, Abteilungen, Teams, Fachrollen) —
 * eigener Endpunkt im Bereich `fuehrung`, damit die Einrichtung ohne die
 * Bereiche `personal`/`verwaltung` auskommt.
 */
export function useLeadershipLookup() {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'lookup'],
    queryFn: () => api.get<LeadershipLookup>('/api/leadership/lookup'),
    staleTime: 30_000,
  });
}

/** Vorschau der Zuständigkeit einer Führungskraft (null = nicht laden). */
export function useLeaderTeam(employeeId: number | null) {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'leaders', employeeId, 'team'],
    queryFn: () => api.get<LeaderTeamResponse>(`/api/leadership/leaders/${employeeId}/team`),
    enabled: employeeId !== null,
  });
}

export function useCreateAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leaderId, input }: { leaderId: number; input: LeadershipAssignmentInput }) =>
      api.post<AssignmentCreateResponse>(`/api/leadership/leaders/${leaderId}/assignments`, input),
    onSuccess: () => invalidateLeadership(qc),
  });
}

export function useDeleteAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/leadership/assignments/${id}`),
    onSuccess: () => invalidateLeadership(qc),
  });
}

// ---------------------------------------------------------------------------
// Report: Aufschlüsselung und Detail
// ---------------------------------------------------------------------------

/**
 * Aufschlüsselung eines Report-Widgets (verantwortete Personen mit
 * Gesamtbewertung je Zeitraum). Lädt erst, wenn das Widget aufgeklappt ist —
 * `employeeId: null` hält die Abfrage still.
 */
export function useLeaderBreakdown(employeeId: number | null, period: string | null, columns?: number) {
  const params = new URLSearchParams();
  if (period) params.set('period', period);
  if (columns !== undefined) params.set('columns', String(columns));
  const qs = params.toString();
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'leaders', employeeId, 'breakdown', period ?? 'current', columns ?? 'default'],
    queryFn: () => api.get<LeaderBreakdown>(`/api/leadership/leaders/${employeeId}/breakdown${qs ? `?${qs}` : ''}`),
    enabled: employeeId !== null,
    placeholderData: keepPreviousData,
  });
}

/**
 * Eine Bewertung vollständig — alle Kategorien des Zeitraums mit Kommentaren
 * plus Protokoll. Grundlage des Detail-Pop-ups; lädt nur bei geöffnetem Dialog.
 */
export function useRatingDetail(leaderId: number | null, memberId: number | null, period: string | null) {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'leaders', leaderId, 'detail', memberId, period ?? 'current'],
    queryFn: () =>
      api.get<RatingDetail>(
        `/api/leadership/leaders/${leaderId}/employees/${memberId}/ratings${period ? `?period=${encodeURIComponent(period)}` : ''}`,
      ),
    enabled: leaderId !== null && memberId !== null,
  });
}

// ---------------------------------------------------------------------------
// Report und Einsicht
// ---------------------------------------------------------------------------

/** Satisfaction-Report im Zeitraum (null = aktueller Zeitraum). */
export function useLeadershipReport(period: string | null) {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'report', period ?? 'current'],
    queryFn: () => api.get<LeadershipReport>(`/api/leadership/report${periodQuery(period)}`),
    placeholderData: keepPreviousData,
  });
}

/** Alle Bewertungen einer Person von allen Führungskräften (Verwaltungssicht). */
export function useEmployeeRatings(employeeId: number | null) {
  return useQuery({
    queryKey: [...LEADERSHIP_KEY, 'employees', employeeId, 'ratings'],
    queryFn: () => api.get<EmployeeRatingsResponse>(`/api/leadership/employees/${employeeId}/ratings`),
    enabled: employeeId !== null,
  });
}
