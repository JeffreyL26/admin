import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ContractDto,
  DocumentDto,
  EmployeeDto,
  EmployeeSortField,
  EmployeeStatus,
  EmployeeType,
} from '@hrmonic/shared';
import { API_BASE, api } from '../../api/client';

// ---------------------------------------------------------------------------
// Typen (API-Formen mit Join-Feldern)
// ---------------------------------------------------------------------------

export interface EmployeeRow extends EmployeeDto {
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
  location_bundesland: string | null;
  manager_name: string | null;
}

export interface DocumentRow extends DocumentDto {
  original_name: string;
  mime_type: string;
  size_bytes: number;
  employee_name: string | null;
  is_superseded: number;
  days_until_expiry: number | null;
}

export interface Department {
  id: number;
  name: string;
  parent_id: number | null;
  head_employee_id: number | null;
  head_name?: string | null;
  employee_count?: number;
}

export interface Team {
  id: number;
  name: string;
  department_id: number | null;
  lead_employee_id: number | null;
  lead_name?: string | null;
  employee_count?: number;
}

export interface Location {
  id: number;
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  bundesland: string;
  employee_count?: number;
}

export interface OrgTreeNode extends Department {
  head_name: string | null;
  employee_count: number;
  total_employee_count: number;
  teams: (Team & { lead_name: string | null; employee_count: number })[];
  children: OrgTreeNode[];
}

/**
 * Filter der Mitarbeiterliste. Alle Auswahlfilter sind Listen — leer heißt
 * „kein Filter“, mehrere Werte werden verodert („Vollzeit ODER Werkstudent“).
 */
export interface EmployeeFilters {
  search: string;
  status: EmployeeStatus[];
  employee_type: EmployeeType[];
  job_title: string[];
  department_id: number[];
  team_id: number[];
  location_id: number[];
  sort: EmployeeSortField;
  dir: 'asc' | 'desc';
}

export const EMPTY_FILTERS: EmployeeFilters = {
  search: '',
  // Ausgeschiedene bleiben wie bisher außen vor, bis man sie ausdrücklich dazunimmt.
  status: ['aktiv'],
  employee_type: [],
  job_title: [],
  department_id: [],
  team_id: [],
  location_id: [],
  sort: 'last_name',
  dir: 'asc',
};

export function filtersToQuery(f: EmployeeFilters): string {
  const p = new URLSearchParams();
  if (f.search.trim()) p.set('search', f.search.trim());
  // Kommagetrennt statt wiederholter Parameter — kürzere URLs, und das Backend
  // versteht beides.
  const list = (key: string, values: (string | number)[]) => {
    if (values.length) p.set(key, values.join(','));
  };
  list('status', f.status);
  list('employee_type', f.employee_type);
  list('job_title', f.job_title);
  list('department_id', f.department_id);
  list('team_id', f.team_id);
  list('location_id', f.location_id);
  if (f.sort !== 'last_name') p.set('sort', f.sort);
  if (f.dir !== 'asc') p.set('dir', f.dir);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Vorhandene Titel als Filterwerte (aus dem Bestand, nicht gepflegt). */
export function useJobTitles() {
  return useQuery({
    queryKey: ['employees', 'job-titles'],
    queryFn: () => api.get<{ job_titles: { title: string; count: number }[] }>('/api/employees/job-titles'),
    select: (d) => d.job_titles,
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useEmployeeList(filters: EmployeeFilters) {
  return useQuery({
    queryKey: ['employees', 'list', filters],
    queryFn: () => api.get<{ employees: EmployeeRow[] }>(`/api/employees${filtersToQuery(filters)}`),
    select: (d) => d.employees,
    // Jeder Filterwechsel ist ein neuer Query-Key ohne Daten — ohne Platzhalter
    // fiele die Tabelle bei jedem Suchanschlag auf den Spinner zurück.
    placeholderData: keepPreviousData,
  });
}

export function useEmployee(id: number) {
  return useQuery({
    queryKey: ['employees', 'detail', id],
    queryFn: () =>
      api.get<{ employee: EmployeeRow; reporting_line: { id: number; name: string; job_title: string | null }[] }>(
        `/api/employees/${id}`,
      ),
    enabled: Number.isFinite(id),
  });
}

export function useContracts(employeeId: number) {
  return useQuery({
    queryKey: ['contracts', employeeId],
    queryFn: () => api.get<{ contracts: ContractDto[] }>(`/api/employees/${employeeId}/contracts`),
    select: (d) => d.contracts,
  });
}

export function useDepartments() {
  return useQuery({
    queryKey: ['org', 'departments'],
    queryFn: () => api.get<{ departments: Department[] }>('/api/departments'),
    select: (d) => d.departments,
  });
}

export function useTeams() {
  return useQuery({
    queryKey: ['org', 'teams'],
    queryFn: () => api.get<{ teams: Team[] }>('/api/teams'),
    select: (d) => d.teams,
  });
}

export function useLocations() {
  return useQuery({
    queryKey: ['org', 'locations'],
    queryFn: () => api.get<{ locations: Location[] }>('/api/locations'),
    select: (d) => d.locations,
  });
}

export function useOrgTree() {
  return useQuery({
    queryKey: ['org', 'tree'],
    queryFn: () => api.get<{ tree: OrgTreeNode[]; unassigned_count: number }>('/api/org/tree'),
  });
}

export function useDocuments(params: {
  search?: string;
  category?: string;
  employee_id?: number;
  include_superseded?: boolean;
}) {
  const p = new URLSearchParams();
  if (params.search?.trim()) p.set('search', params.search.trim());
  if (params.category) p.set('category', params.category);
  if (params.employee_id !== undefined) p.set('employee_id', String(params.employee_id));
  if (params.include_superseded) p.set('include_superseded', 'true');
  const qs = p.toString();
  return useQuery({
    queryKey: ['documents', 'list', params],
    queryFn: () => api.get<{ documents: DocumentRow[] }>(`/api/documents${qs ? `?${qs}` : ''}`),
    select: (d) => d.documents,
  });
}

export function useExpiringDocuments() {
  return useQuery({
    queryKey: ['documents', 'expiring'],
    queryFn: () => api.get<{ documents: DocumentRow[] }>('/api/documents/expiring'),
    select: (d) => d.documents,
  });
}

// ---------------------------------------------------------------------------
// CSV-Export (Auth-Header nötig, daher fetch statt <a href>)
// ---------------------------------------------------------------------------

export async function downloadEmployeesCsv(filters: EmployeeFilters): Promise<void> {
  const token = localStorage.getItem('hrmonic.token');
  const res = await fetch(`${API_BASE}/api/employees/export.csv${filtersToQuery(filters)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('CSV-Export fehlgeschlagen');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mitarbeitende.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Beim Verdrängen aus dem Cache die Object-URL wieder freigeben, sonst hält
 * der Browser die Bild-Bytes bis zum Neustart. Einmal je QueryClient
 * registriert — die App hat genau einen, das WeakSet fängt Strict-Mode-
 * Doppelaufrufe ab.
 */
const photoCleanupRegistered = new WeakSet<QueryClient>();
function ensurePhotoCleanup(qc: QueryClient): void {
  if (photoCleanupRegistered.has(qc)) return;
  photoCleanupRegistered.add(qc);
  qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'removed') return;
    const key = event.query.queryKey;
    if (key[0] === 'files' && key[1] === 'photo' && typeof event.query.state.data === 'string') {
      URL.revokeObjectURL(event.query.state.data);
    }
  });
}

/**
 * Bild-Anzeige (z. B. Mitarbeiterfoto) als Object-URL.
 *
 * Bewusst NICHT die signierte URL cachen: Der Server deckelt deren Gültigkeit
 * hart auf 60 Sekunden (core/files.ts) — eine gecachte URL wäre beim nächsten
 * Mount längst abgelaufen und das <img> zeigt ein kaputtes Bild. Der Link wird
 * deshalb sofort konsumiert und das BILD gehalten. staleTime Infinity stimmt,
 * weil sich der Inhalt einer files-Zeile nie ändert — ein neues Foto bekommt
 * eine neue photo_file_id und damit einen neuen Key. Fokus-Refetches laden so
 * auch keine Bild-Bytes mehr nach.
 *
 * `signedUrl`: Liefert der Server die signierte URL bereits in seiner Antwort
 * mit (z. B. `photo_url` im Mitarbeiterverzeichnis), wird sie direkt konsumiert
 * statt selbst zu signieren. Das eigene Signieren (`POST /api/files/:id/sign`)
 * verlangt personal:lesen — ein Admin mit nur kommunikation:lesen sähe sonst
 * statt der Fotos nur Initialen plus 403- und Audit-Rauschen je Foto.
 */
export function usePhotoUrl(fileId: number | null | undefined, signedUrl?: string | null) {
  const qc = useQueryClient();
  ensurePhotoCleanup(qc);
  return useQuery({
    // Bewusst derselbe Key wie ohne signedUrl: gecacht wird das BILD je Datei —
    // Verzeichnis und Personalakte teilen sich so denselben Blob.
    queryKey: ['files', 'photo', fileId],
    queryFn: async () => {
      const url = signedUrl ?? (await api.post<{ url: string }>(`/api/files/${fileId}/sign`)).url;
      const res = await fetch(`${API_BASE}${url}`);
      if (!res.ok) throw new Error('Foto konnte nicht geladen werden');
      return URL.createObjectURL(await res.blob());
    },
    enabled: !!fileId,
    staleTime: Infinity,
    // 15 statt 60 Minuten: Hier liegen Blobs in Originalgröße im Speicher —
    // nach einem Verzeichnisbesuch sonst eine Stunde lang sämtliche Fotos.
    gcTime: 15 * 60 * 1000,
    // Kein globaler Fehler-Toast: Der Avatar fällt gewollt auf Initialen
    // zurück, und der plain Error des Blob-Fetch würde sonst als „Server
    // nicht erreichbar“ fehlgedeutet.
    meta: { silentError: true },
  });
}
