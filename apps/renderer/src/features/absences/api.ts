import { useQuery } from '@tanstack/react-query';
import type {
  AbsenceBalance,
  AbsenceRequest,
  AbsenceType,
  CalendarConflict,
  CalendarEmployee,
  CompanyClosure,
  SickNote,
} from '@hrmonic/shared';
import { api } from '../../api/client';

/** 409-Details des Backends, wenn ein Antrag den Urlaubssaldo überziehen würde. */
export interface BalanceExceededDetails {
  year: number;
  remaining: number;
  requested_days: number;
}

/**
 * Rückfragetext zu BALANCE_EXCEEDED — zentral formuliert, damit Erfassen
 * (RequestDialog) und Genehmigen (RequestsPage) nicht auseinanderdriften.
 * `verb` benennt die bestätigende Aktion („erfassen“ bzw. „genehmigen“).
 */
export function balanceExceededQuestion(details: BalanceExceededDetails, verb: string): string {
  return (
    `Restanspruch ${details.remaining.toLocaleString('de-DE')} Tage im Jahr ${details.year}, ` +
    `beantragt ${details.requested_days.toLocaleString('de-DE')} Tage — trotzdem ${verb}?`
  );
}

export function useAbsenceTypes() {
  return useQuery({
    queryKey: ['absences', 'types'],
    queryFn: () => api.get<{ types: AbsenceType[] }>('/api/absences/types'),
    select: (d) => d.types,
  });
}

export interface RequestFilters {
  status?: string;
  type_id?: number | null;
  employee_id?: number | null;
  from?: string;
  to?: string;
}

export function useAbsenceRequests(filters: RequestFilters) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type_id) params.set('type_id', String(filters.type_id));
  if (filters.employee_id) params.set('employee_id', String(filters.employee_id));
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const qs = params.toString();
  return useQuery({
    queryKey: ['absences', 'requests', filters],
    queryFn: () => api.get<{ requests: AbsenceRequest[] }>(`/api/absences/requests${qs ? `?${qs}` : ''}`),
    select: (d) => d.requests,
    // Offene Anträge kommen seit dem Web-Portal auch von Mitarbeitenden herein —
    // die Genehmigungsansicht hält sich deshalb selbst aktuell.
    refetchInterval: filters.status === 'beantragt' ? 30_000 : false,
  });
}

export function useBalances(year: number) {
  return useQuery({
    queryKey: ['absences', 'balances', year],
    queryFn: () =>
      api.get<{ balances: AbsenceBalance[]; carryover_deadline: string }>(
        `/api/absences/balances/${year}`,
      ),
  });
}

export interface CalendarData {
  range: { from: string; to: string };
  employees: CalendarEmployee[];
  holidays: Record<string, { date: string; name: string }[]>;
  closures: CompanyClosure[];
  conflicts: CalendarConflict[];
}

export function useCalendar(year: number, month: number | null, departmentId: number | null, teamId: number | null) {
  const params = new URLSearchParams({ year: String(year) });
  if (month) params.set('month', String(month));
  if (departmentId) params.set('department_id', String(departmentId));
  if (teamId) params.set('team_id', String(teamId));
  return useQuery({
    queryKey: ['absences', 'calendar', year, month, departmentId, teamId],
    queryFn: () => api.get<CalendarData>(`/api/absences/calendar?${params.toString()}`),
  });
}

export function useSickNotes(childSick: '0' | '1' | null) {
  return useQuery({
    queryKey: ['absences', 'sick-notes', childSick],
    queryFn: () =>
      api.get<{ sick_notes: SickNote[] }>(
        `/api/absences/sick-notes${childSick !== null ? `?child_sick=${childSick}` : ''}`,
      ),
    select: (d) => d.sick_notes,
  });
}

export function useMissingSickNotes() {
  return useQuery({
    queryKey: ['absences', 'sick-notes', 'missing'],
    queryFn: () => api.get<{ sick_notes: SickNote[] }>('/api/absences/sick-notes/missing'),
    select: (d) => d.sick_notes,
  });
}

export function useClosures() {
  return useQuery({
    queryKey: ['absences', 'closures'],
    queryFn: () => api.get<{ closures: CompanyClosure[] }>('/api/absences/closures'),
    select: (d) => d.closures,
  });
}

/**
 * Abteilungen/Teams fürs Kalender-Filtern gehören dem Personal-Modul — dessen
 * Hooks werden wiederverwendet, damit Cache und ['org']-Invalidierung (OrgPage)
 * zusammenfallen statt unter einem zweiten Key zu doppeln und nachzuhinken.
 */
export { useDepartments, useTeams } from '../employees/api';

/** Live-Vorschau der gezählten Tage für Antrags-/Krankmeldungsdialoge. */
export function useDaysPreview(
  employeeId: number | null,
  dateFrom: string,
  dateTo: string,
  halfDayStart = false,
  halfDayEnd = false,
) {
  const enabled = !!employeeId && !!dateFrom && !!dateTo && dateFrom <= dateTo;
  return useQuery({
    queryKey: ['absences', 'preview', employeeId, dateFrom, dateTo, halfDayStart, halfDayEnd],
    queryFn: () =>
      api.get<{ days_counted: number; bundesland: string }>(
        `/api/absences/preview?employee_id=${employeeId}&date_from=${dateFrom}&date_to=${dateTo}` +
          `&half_day_start=${halfDayStart ? 1 : 0}&half_day_end=${halfDayEnd ? 1 : 0}`,
      ),
    enabled,
  });
}
