import { useEffect, useRef } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ContractDto,
  CountryCode,
  DocumentDto,
  DocumentSource,
  EmployeeChangeRequestForHr,
  EmployeeChangeRequestStatus,
  EmployeeDto,
  EmployeeSortField,
  EmployeeStatus,
  EmployeeType,
  OrgChartOriginalsResponse,
  OrgChartResponse,
} from '@ohrganize/shared';
import { API_BASE, api, getToken } from '../../api/client';

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
  /** Land des Standorts (Vorgabe: Land der Variante). */
  country: CountryCode;
  /** Regionscode dieses Landes; steuert die Feiertagsberechnung. */
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

/**
 * Personen-Organigramm. Unter dem Präfix 'org', damit Änderungen an der
 * Struktur (Leitung setzen, Team umhängen) es mit invalidieren; die
 * Personalakte invalidiert 'employees' und trifft es deshalb ebenfalls.
 */
export function useOrgChart() {
  return useQuery({
    queryKey: ['org', 'chart', 'employees'],
    queryFn: () => api.get<OrgChartResponse>('/api/org/chart'),
  });
}

/**
 * Signierte Links auf die Original-Fotos des Organigramms (GET
 * /api/org/chart/originals). Erst abgerufen, wenn der Zoom über der Grenze
 * des Vorschaubilds liegt (`enabled`): Als Feld im Organigramm trüge sonst
 * jeder Abruf alle Originale mit. Läuft ein Link ab, holt refreshListLinks
 * genau diese Abfrage neu.
 */
export function useOrgChartOriginals(enabled: boolean) {
  return useQuery({
    queryKey: ['org', 'chart', 'originals'],
    queryFn: () => api.get<OrgChartOriginalsResponse>('/api/org/chart/originals'),
    select: (d) => d.originals,
    enabled,
    // Die Links gelten bis zum Ende ihres Zehn-Minuten-Fensters, mindestens
    // eine Minute; abgelaufene holt refreshListLinks gezielt. Ohne diese Frist
    // lüde jeder Fensterwechsel die ganze Liste (bei 2000 Fotos rund 230 KB) neu.
    staleTime: 5 * 60_000,
  });
}

export interface DocumentFilters {
  search?: string;
  category?: string;
  employee_id?: number;
  /** Herkunft: HR-Upload oder aus dem Portal hochgeladen. */
  source?: DocumentSource;
  include_superseded?: boolean;
}

function documentFilterParams(params: DocumentFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (params.search?.trim()) p.set('search', params.search.trim());
  if (params.category) p.set('category', params.category);
  if (params.employee_id !== undefined) p.set('employee_id', String(params.employee_id));
  if (params.source) p.set('source', params.source);
  if (params.include_superseded) p.set('include_superseded', 'true');
  return p;
}

/** Alle Treffer ungeblättert: Personalakte (Dokumente EINER Person samt Versionen). */
export function useDocuments(params: DocumentFilters) {
  const qs = documentFilterParams(params).toString();
  return useQuery({
    queryKey: ['documents', 'list', params],
    queryFn: () => api.get<{ documents: DocumentRow[] }>(`/api/documents${qs ? `?${qs}` : ''}`),
    select: (d) => d.documents,
  });
}

/**
 * Dokumentablage: serverseitig geblättert (bei großer Belegschaft
 * fünfstellig). Suche und Filter wirken im Backend über alle Seiten;
 * `focus_id` liefert die Seite eines angesprungenen Dokuments.
 */
export function useDocumentPage(
  params: DocumentFilters,
  page: { limit: number; offset: number; focus_id?: number | null },
) {
  const p = documentFilterParams(params);
  p.set('limit', String(page.limit));
  p.set('offset', String(page.offset));
  if (page.focus_id) p.set('focus_id', String(page.focus_id));
  return useQuery({
    queryKey: ['documents', 'page', params, page],
    queryFn: () =>
      api.get<{ documents: DocumentRow[]; total: number; offset: number }>(`/api/documents?${p.toString()}`),
    placeholderData: keepPreviousData,
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
// Änderungsanträge zu Stammdaten (Portal → Personalabteilung)
// ---------------------------------------------------------------------------

export interface ChangeRequestFilter {
  status?: EmployeeChangeRequestStatus;
  /** null = kein Filter (so liefert es der EmployeeSelect). */
  employee_id?: number | null;
}

export function useEmployeeChangeRequests(filter: ChangeRequestFilter = {}) {
  const p = new URLSearchParams();
  if (filter.status) p.set('status', filter.status);
  if (filter.employee_id) p.set('employee_id', String(filter.employee_id));
  const qs = p.toString();
  return useQuery({
    // Unter dem Präfix 'employees': Eine Genehmigung schreibt die Personalakte,
    // die Invalidierung nach der Entscheidung trifft damit Liste, Akte und
    // diese Anträge in einem Zug.
    queryKey: ['employees', 'change-requests', filter],
    queryFn: () =>
      api.get<{ requests: EmployeeChangeRequestForHr[]; open_count: number }>(
        `/api/employees/change-requests${qs ? `?${qs}` : ''}`,
      ),
    // Jeder Filterwechsel ist ein neuer Key ohne Daten — ohne Platzhalter fiele
    // die Tabelle bei jedem Filterklick auf den Spinner zurück.
    placeholderData: keepPreviousData,
  });
}

/**
 * Entscheidung über einen Antrag. Bewusst OHNE eigenes Fehler-Handling: Die
 * Aufrufstelle zeigt die Meldung des Backends (Vier-Augen-Prinzip, bereits
 * entschieden, fehlende Begründung) und lässt ihren Dialog offen.
 */
export function useDecideChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: number;
      decision: 'genehmigt' | 'abgelehnt';
      decision_note?: string;
    }) =>
      api.post<{ request: EmployeeChangeRequestForHr }>(
        `/api/employees/change-requests/${vars.id}/decide`,
        // Leere Begründung gar nicht erst mitschicken — das Backend prüft auf
        // „gesetzt“, ein leerer String zählte als Begründung.
        { decision: vars.decision, ...(vars.decision_note ? { decision_note: vars.decision_note } : {}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      // Die Kachel „Offene Stammdaten-Anträge“ zählt dieselben Anträge.
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ---------------------------------------------------------------------------
// CSV-Export (Auth-Header nötig, daher fetch statt <a href>)
// ---------------------------------------------------------------------------

export async function downloadEmployeesCsv(filters: EmployeeFilters): Promise<void> {
  const token = getToken();
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
 * hart auf 60 Sekunden, Fotos in Listen auf das Ende eines Zeitfensters
 * (core/files.ts); eine gecachte URL wäre beim nächsten
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
 *
 * `load = false` hält den Abruf zurück, bis der Avatar sichtbar wird
 * (useAvatarPhoto in avatarPhoto.ts); ein schon gecachtes Bild kommt trotzdem.
 * Listenlinks gelten bis zum Ende ihres Zeitfensters (signPhotoUrl in
 * core/files.ts). Wird eine Karte erst danach sichtbar, antwortet der
 * Download mit 401: Dann holt die Abfrage, die den Link geliefert hat, frische
 * Links (refreshListLinks), und der Avatar lädt mit dem neuen Link nach. Auch hier
 * nicht selbst signieren, Grund oben.
 */
export function usePhotoUrl(fileId: number | null | undefined, signedUrl?: string | null, load = true) {
  const qc = useQueryClient();
  ensurePhotoCleanup(qc);
  const query = useQuery({
    // Bewusst derselbe Key wie ohne signedUrl: gecacht wird das BILD je Datei —
    // Verzeichnis und Personalakte teilen sich so denselben Blob.
    queryKey: ['files', 'photo', fileId],
    queryFn: async () => {
      const url = signedUrl ?? (await api.post<{ url: string }>(`/api/files/${fileId}/sign`)).url;
      const res = await fetch(`${API_BASE}${url}`);
      if (res.status === 401 && signedUrl) refreshListLinks(qc, signedUrl);
      if (!res.ok) throw new Error('Foto konnte nicht geladen werden');
      return URL.createObjectURL(await res.blob());
    },
    enabled: !!fileId && load,
    staleTime: Infinity,
    // 15 statt 60 Minuten: Hier liegen Bilder im Speicher (Vorschaubilder,
    // beim Bestand ohne Vorschaubild Originale); nach einem Verzeichnisbesuch
    // sonst eine Stunde lang sämtliche Fotos.
    gcTime: 15 * 60 * 1000,
    // Kein globaler Fehler-Toast: Der Avatar fällt gewollt auf Initialen
    // zurück, und der plain Error des Blob-Fetch würde sonst als „Server
    // nicht erreichbar“ fehlgedeutet.
    meta: { silentError: true },
  });
  // Nach einem Fehlschlag nur mit einem NEUEN Link erneut versuchen: Mit dem
  // bisherigen ist der Abruf gerade gescheitert.
  const { isError, refetch } = query;
  const lastSignedUrl = useRef(signedUrl);
  useEffect(() => {
    if (lastSignedUrl.current === signedUrl) return;
    lastSignedUrl.current = signedUrl;
    if (isError && signedUrl && load) void refetch();
  }, [signedUrl, isError, load, refetch]);
  return query;
}

/** Letzte Erneuerung je Abfrage (queryHash), für die Drossel unten. */
const linksRefreshedAt = new Map<string, number>();

/**
 * Frische Fotolinks nach einem abgelaufenen (401): nur die aktiven Abfragen
 * neu holen, deren Daten den gescheiterten Link enthalten, also die Liste,
 * die ihn geliefert hat; nicht alles, was gerade auf der Seite steht
 * (Dashboard-Kacheln, geblätterte Listen, Report). Je Abfrage höchstens
 * einmal je halbe Minute, denn meist scheitern mehrere Avatare derselben
 * Liste zugleich.
 */
function refreshListLinks(qc: QueryClient, signedUrl: string): void {
  const now = Date.now();
  for (const [hash, at] of linksRefreshedAt) if (now - at >= 30_000) linksRefreshedAt.delete(hash);
  void qc.refetchQueries({
    type: 'active',
    predicate: (q) => {
      if (q.queryKey[0] === 'files' || q.state.data === undefined || linksRefreshedAt.has(q.queryHash)) return false;
      if (!JSON.stringify(q.state.data).includes(signedUrl)) return false;
      linksRefreshedAt.set(q.queryHash, now);
      return true;
    },
  });
}
