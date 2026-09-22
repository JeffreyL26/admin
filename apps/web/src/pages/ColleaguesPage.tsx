/**
 * Kolleg:innen-Verzeichnis des Portals (GET /api/me/directory).
 *
 * Dieselben Felder, dieselbe Feldsichtbarkeit und dieselben Filter wie das
 * HR-Verzeichnis (Backend: modules/communication/directoryService.ts): Was
 * die Personalabteilung dort ausblendet, fehlt hier ebenfalls, und ein
 * Filter auf ein ausgeblendetes Feld wird gar nicht erst angeboten. Fotos
 * kommen kurzlebig signiert wie im Organigramm (OrgPage.tsx) und laden
 * direkt ueber `API_BASE`.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DirectoryEmployee, MeDirectoryResponse } from '@ohrganize/shared';
import { API_BASE, api } from '../api/client';
import { Card, EmptyState, LoadError, Skeleton } from '../components/ui';
import { Select } from '../components/Select';

interface Filters {
  search: string;
  departmentId: number | null;
}

/** Suche erst nach kurzer Tipp-Pause abschicken (kein Request je Taste). */
function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function useColleagues(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.departmentId) params.set('department_id', String(filters.departmentId));
  const qs = params.toString();
  return useQuery({
    queryKey: ['me', 'directory', filters],
    queryFn: () => api.get<MeDirectoryResponse>(`/api/me/directory${qs ? `?${qs}` : ''}`),
    // Beim Filterwechsel die alte Liste stehen lassen statt zu flackern.
    placeholderData: (previous) => previous,
  });
}

/**
 * Foto oder Initialen (Muster aus OrgPage.tsx). Der signierte Link gilt nur
 * kurz; scheitert der Abruf, bleiben die Initialen.
 */
function ColleagueAvatar({ person }: { person: DirectoryEmployee }) {
  const [failed, setFailed] = useState(false);
  const src = person.photo_url && !failed ? `${API_BASE}${person.photo_url}` : null;
  const initials = `${person.first_name[0] ?? ''}${person.last_name[0] ?? ''}`.toUpperCase();
  return (
    <span className="pt-orgc-avatar" style={{ width: 48, height: 48, fontSize: 18 }} aria-hidden="true">
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : initials}
    </span>
  );
}

function ColleagueCard({ person, fields }: { person: DirectoryEmployee; fields: MeDirectoryResponse['fields'] }) {
  const where = [person.department_name, person.team_name, person.location_name].filter(Boolean).join(' · ');
  return (
    <article className="pt-card">
      <div className="pt-card__body" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {fields.photo && <ColleagueAvatar person={person} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 650 }}>
            {person.first_name} {person.last_name}
          </div>
          {fields.job_title && person.job_title && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{person.job_title}</div>
          )}
          {where && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{where}</div>
          )}
          {(person.email || person.phone) && (
            <div className="stack" style={{ gap: 4, marginTop: 10, fontSize: 'var(--text-sm)' }}>
              {person.email && (
                <a href={`mailto:${person.email}`} style={{ overflowWrap: 'anywhere' }}>
                  {person.email}
                </a>
              )}
              {person.phone && <a href={`tel:${person.phone}`}>{person.phone}</a>}
            </div>
          )}
          {fields.skills && (person.skills?.length ?? 0) > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {person.skills!.map((s) => (
                <span key={s.name} className="pt-chip pt-chip--info">
                  {s.name} · {s.level}/5
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function ColleaguesPage() {
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const debouncedSearch = useDebounced(search.trim());
  const { data, isLoading, error } = useColleagues({ search: debouncedSearch, departmentId });

  const employees = data?.employees ?? [];
  const departments = data?.departments ?? [];
  const filtered = search.trim() !== '' || departmentId !== null;

  return (
    <div>
      <header className="portal-page-header">
        <h1 className="portal-title">Kolleg:innen</h1>
        <p className="portal-subtitle">
          Dienstliche Kontaktdaten aller aktiven Mitarbeitenden. Welche Angaben hier stehen, legt Ihre
          Personalabteilung fest.
        </p>
      </header>

      {error && (
        <div style={{ marginBottom: 20 }}>
          <LoadError error={error} />
        </div>
      )}

      <div className="stack">
        <Card>
          <div className="pt-form-grid">
            <label className="pt-field">
              <span className="pt-field__label">Suche</span>
              <input
                className="pt-input"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, Funktion oder E-Mail"
                autoComplete="off"
              />
            </label>
            {/* Ohne sichtbare Abteilung liefert das Backend keine Liste;
                dann gibt es auch keinen Filter. */}
            {departments.length > 0 && (
              <label className="pt-field">
                <span className="pt-field__label">Abteilung</span>
                <Select
                  className="pt-select"
                  value={departmentId ?? ''}
                  onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Alle Abteilungen</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
        </Card>

        {error ? null : isLoading || !data ? (
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="pt-card">
                <div className="pt-card__body stack" style={{ gap: 10 }}>
                  <Skeleton width="60%" />
                  <Skeleton width="45%" />
                  <Skeleton width="70%" />
                </div>
              </div>
            ))}
          </div>
        ) : employees.length === 0 ? (
          <Card>
            <EmptyState
              title={filtered ? 'Keine Kolleg:innen zu dieser Suche' : 'Noch keine Kolleg:innen'}
              hint={filtered ? 'Passen Sie Suche oder Abteilung an.' : undefined}
            />
          </Card>
        ) : (
          <>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {employees.length} {employees.length === 1 ? 'Person' : 'Personen'}
              {departmentId !== null ? ' (einschließlich Unterabteilungen)' : ''}
            </p>
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}
            >
              {employees.map((person) => (
                <ColleagueCard key={person.id} person={person} fields={data.fields} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
