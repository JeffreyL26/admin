import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AbsenceBalance,
  AbsenceRequest,
  AbsenceType,
  CalendarConflict,
  CalendarEmployee,
  CompanyClosure,
  SickNote,
} from '@ohrganize/shared';
import { api } from '../../api/client';
import { LOCALE } from '../../lib/locale';

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
    `Restanspruch ${details.remaining.toLocaleString(LOCALE)} Tage im Jahr ${details.year}, ` +
    `beantragt ${details.requested_days.toLocaleString(LOCALE)} Tage. Trotzdem ${verb}?`
  );
}

export function useAbsenceTypes() {
  return useQuery({
    queryKey: ['absences', 'types'],
    queryFn: () => api.get<{ types: AbsenceType[] }>('/api/absences/types'),
    select: (d) => d.types,
  });
}

/**
 * Arten, die eine bestimmte Person beantragen darf (Rollen-Allowlist plus
 * Personenregeln, aufgeloest im Backend). Die HR-Erfassung graut damit
 * gesperrte Arten aus, statt erst den 403 des POST zu ernten.
 */
export function useAllowedTypeIds(employeeId: number | null) {
  return useQuery({
    queryKey: ['absences', 'types', 'allowed', employeeId],
    queryFn: () =>
      api.get<{ employee_id: number; type_ids: number[] }>(
        `/api/absences/types/allowed?employee_id=${employeeId}`,
      ),
    select: (d) => new Set(d.type_ids),
    enabled: employeeId !== null,
  });
}

export interface RequestFilters {
  status?: string;
  type_id?: number | null;
  employee_id?: number | null;
  from?: string;
  to?: string;
}

function requestFilterParams(filters: RequestFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type_id) params.set('type_id', String(filters.type_id));
  if (filters.employee_id) params.set('employee_id', String(filters.employee_id));
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return params;
}

/** Alle Treffer ungeblättert: nur für enge Filter (offene Anträge, eine Person). */
export function useAbsenceRequests(filters: RequestFilters) {
  const qs = requestFilterParams(filters).toString();
  return useQuery({
    queryKey: ['absences', 'requests', filters],
    queryFn: () => api.get<{ requests: AbsenceRequest[] }>(`/api/absences/requests${qs ? `?${qs}` : ''}`),
    select: (d) => d.requests,
    // Offene Anträge kommen seit dem Web-Portal auch von Mitarbeitenden herein —
    // die Genehmigungsansicht hält sich deshalb selbst aktuell.
    refetchInterval: filters.status === 'beantragt' ? 30_000 : false,
  });
}

/** Eine Seite der Antragsliste samt Treffern über alle Seiten und tatsächlichem Seitenbeginn. */
export interface AbsenceRequestPage {
  requests: AbsenceRequest[];
  total: number;
  offset: number;
}

export interface PageParams {
  limit: number;
  offset: number;
  /** Seite liefern, auf der dieser Antrag steht (Absprung aus dem Kalender). */
  focus_id?: number | null;
}

/**
 * „Alle Anträge“: serverseitig geblättert, die Historie kann sechsstellig
 * sein. Beim Blättern bleibt die alte Seite stehen, bis die neue da ist.
 */
export function useAbsenceRequestPage(filters: RequestFilters, page: PageParams) {
  const params = requestFilterParams(filters);
  params.set('limit', String(page.limit));
  params.set('offset', String(page.offset));
  if (page.focus_id) params.set('focus_id', String(page.focus_id));
  return useQuery({
    queryKey: ['absences', 'requests', 'page', filters, page],
    queryFn: () => api.get<AbsenceRequestPage>(`/api/absences/requests?${params.toString()}`),
    placeholderData: keepPreviousData,
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

export interface SickNoteFilters {
  childSick?: '0' | '1' | null;
  /** Nur Krankmeldungen, die das Jahr berühren; null = alle Jahre. */
  year?: number | null;
  /** Eine Person über alle Jahre (Auswahl der Erstbescheinigung). */
  employeeId?: number | null;
}

export function useSickNotes(filters: SickNoteFilters, enabled = true) {
  const params = new URLSearchParams();
  if (filters.childSick) params.set('child_sick', filters.childSick);
  if (filters.year) params.set('year', String(filters.year));
  if (filters.employeeId) params.set('employee_id', String(filters.employeeId));
  const qs = params.toString();
  return useQuery({
    queryKey: ['absences', 'sick-notes', filters],
    queryFn: () => api.get<{ sick_notes: SickNote[] }>(`/api/absences/sick-notes${qs ? `?${qs}` : ''}`),
    select: (d) => d.sick_notes,
    enabled,
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
