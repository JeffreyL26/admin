import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AbsenceBalance,
  AbsenceRequest,
  AbsenceType,
  CompanyClosure,
  MeBonus,
  MeCalendarEmployee,
  MeDocument,
  MeFreelancer,
  MeProfile,
  MeSalary,
  MeSalaryComponent,
  OrgTreeNode,
  SickNote,
} from '@hrmonic/shared';
import { api, downloadFile, uploadFile } from './client';

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

// useChangePassword() wurde entfernt: Der Passwortwechsel liefert ein frisches
// Token zurück (das alte ist durch users.sessions_valid_from sofort ungültig).
// Ein Hook, der nur mutiert, ließ den Client danach ins 401 laufen. Der
// Wechsel läuft deshalb ausschließlich über changePassword() aus
// auth/AuthContext, das Token und Identität mitzieht.

// ---------------------------------------------------------------------------
// Vergütung (GET /api/me/salary, /salary/history, /bonuses, /freelancer)
// ---------------------------------------------------------------------------

export function useMySalary() {
  return useQuery({
    queryKey: ['me', 'salary'],
    queryFn: () => api.get<{ salary: MeSalary }>('/api/me/salary'),
    select: (d) => d.salary,
  });
}

export function useMySalaryHistory() {
  return useQuery({
    queryKey: ['me', 'salary', 'history'],
    queryFn: () => api.get<{ components: MeSalaryComponent[] }>('/api/me/salary/history'),
    select: (d) => d.components,
  });
}

export function useMyBonuses() {
  return useQuery({
    queryKey: ['me', 'bonuses'],
    queryFn: () => api.get<{ bonuses: MeBonus[] }>('/api/me/bonuses'),
    select: (d) => d.bonuses,
  });
}

/**
 * Honorarsätze und eigene Rechnungen. Die Route antwortet für alle anderen
 * Beschäftigungsarten mit zwei leeren Listen — die Seite darf also bedenkenlos
 * laden und entscheidet erst danach, ob sie den Abschnitt zeigt.
 */
export function useMyFreelancer() {
  return useQuery({
    queryKey: ['me', 'freelancer'],
    queryFn: () => api.get<MeFreelancer>('/api/me/freelancer'),
  });
}

// ---------------------------------------------------------------------------
// Organigramm (GET /api/me/org-tree)
// ---------------------------------------------------------------------------

export function useMyOrgTree() {
  return useQuery({
    queryKey: ['me', 'org-tree'],
    queryFn: () => api.get<{ tree: OrgTreeNode[]; unassigned_count: number }>('/api/me/org-tree'),
    // Die Aufbauorganisation ändert sich selten — länger frisch halten als der
    // 15-Sekunden-Standard des QueryClients.
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Firmenkalender (GET /api/me/calendar)
// ---------------------------------------------------------------------------

export interface MeCalendarResponse {
  range: { from: string; to: string };
  employees: MeCalendarEmployee[];
  /** Feiertage je Bundesland, bereits auf den Monat beschnitten. */
  holidays: Record<string, { date: string; name: string }[]>;
  closures: CompanyClosure[];
}

/**
 * Firmenkalender eines Monats. `month` ist im Backend Pflicht (1–12) — ein
 * Aufruf ohne gültigen Monat wird deshalb gar nicht erst abgeschickt.
 */
export function useMyCalendar(year: number, month: number) {
  return useQuery({
    queryKey: ['me', 'calendar', year, month],
    queryFn: () =>
      api.get<MeCalendarResponse>(`/api/me/calendar?year=${year}&month=${month}`),
    enabled: Number.isInteger(year) && month >= 1 && month <= 12,
  });
}

// ---------------------------------------------------------------------------
// Dokumente (GET/POST /api/me/documents)
// ---------------------------------------------------------------------------

/**
 * Kategorien, die das Portal beim Upload anbieten darf. Verträge und Zeugnisse
 * fehlen bewusst: das Backend lehnt sie ab (siehe me/documentRoutes.ts).
 */
export const PORTAL_UPLOAD_CATEGORIES = ['bescheinigung', 'zertifikat', 'sonstiges'] as const;
export type PortalUploadCategory = (typeof PORTAL_UPLOAD_CATEGORIES)[number];

export function useMyDocuments() {
  return useQuery({
    queryKey: ['me', 'documents'],
    queryFn: () => api.get<{ documents: MeDocument[] }>('/api/me/documents'),
    select: (d) => d.documents,
  });
}

export interface NewDocumentUpload {
  file: File;
  category: PortalUploadCategory;
  /** Ohne Titel übernimmt das Backend den Dateinamen. */
  title?: string;
  note?: string;
  expiry_date?: string;
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, category, title, note, expiry_date }: NewDocumentUpload) =>
      uploadFile<{ document: MeDocument }>('/api/me/documents', file, {
        category,
        title,
        note,
        expiry_date,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

/**
 * Download eines eigenen Dokuments: signierte URL holen und anstoßen. Als
 * Mutation und nicht als Query, weil die Route schreibend aufgerufen wird
 * (POST) und der Link nur wenige Minuten gilt — zwischenspeichern wäre falsch.
 */
export function useDocumentDownload() {
  return useMutation({
    mutationFn: (id: number) => downloadFile(`/api/me/documents/${id}/download`),
  });
}
