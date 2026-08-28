import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AbsenceBalance, AbsenceRequest, AbsenceType, MeProfile, SickNote } from '@hrmonic/shared';
import { api } from './client';

export function useMyProfile() {
  return useQuery({
    queryKey: ['me', 'profile'],
    queryFn: () => api.get<{ profile: MeProfile }>('/api/me/profile'),
    select: (d) => d.profile,
  });
}

export function useLeaveTypes() {
  return useQuery({
    queryKey: ['me', 'leave-types'],
    queryFn: () => api.get<{ types: AbsenceType[] }>('/api/me/leave-types'),
    select: (d) => d.types,
  });
}

export function useMyRequests(year?: number) {
  return useQuery({
    queryKey: ['me', 'leave-requests', year ?? 'alle'],
    queryFn: () =>
      api.get<{ requests: AbsenceRequest[] }>(
        `/api/me/leave-requests${year ? `?year=${year}` : ''}`,
      ),
    select: (d) => d.requests,
    // Entscheidungen der HR-Administration ohne manuelles Neuladen sichtbar machen.
    refetchInterval: 30_000,
  });
}

export function useMyBalance(year: number) {
  return useQuery({
    queryKey: ['me', 'leave-balance', year],
    queryFn: () => api.get<{ balance: AbsenceBalance }>(`/api/me/leave-balance?year=${year}`),
    select: (d) => d.balance,
  });
}

export function useLeavePreview(
  dateFrom: string,
  dateTo: string,
  halfDayStart: boolean,
  halfDayEnd: boolean,
) {
  const enabled = !!dateFrom && !!dateTo && dateFrom <= dateTo;
  return useQuery({
    queryKey: ['me', 'leave-preview', dateFrom, dateTo, halfDayStart, halfDayEnd],
    queryFn: () =>
      api.get<{ days_counted: number; bundesland: string }>(
        `/api/me/leave-preview?date_from=${dateFrom}&date_to=${dateTo}` +
          `&half_day_start=${halfDayStart ? 1 : 0}&half_day_end=${halfDayEnd ? 1 : 0}`,
      ),
    enabled,
  });
}

export function useMySickNotes() {
  return useQuery({
    queryKey: ['me', 'sick-notes'],
    queryFn: () => api.get<{ sick_notes: SickNote[] }>('/api/me/sick-notes'),
    select: (d) => d.sick_notes,
  });
}

export interface NewLeaveRequest {
  type_id: number;
  date_from: string;
  date_to: string;
  half_day_start?: boolean;
  half_day_end?: boolean;
  comment?: string;
}

export function useCreateRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewLeaveRequest) =>
      api.post<{ request: AbsenceRequest }>('/api/me/leave-requests', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useCancelRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api.post<{ request: AbsenceRequest }>(`/api/me/leave-requests/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export interface NewSickNote {
  date_from: string;
  date_to: string;
  child_sick?: boolean;
  comment?: string;
}

export function useCreateSickNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewSickNote) => api.post<{ sick_note: SickNote }>('/api/me/sick-notes', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.put<{ ok: boolean }>('/api/auth/password', body),
  });
}
