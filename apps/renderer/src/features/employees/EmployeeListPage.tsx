import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDownAZ, ArrowUpAZ, Columns3, Download, Plus, Search, UserCog, Users } from 'lucide-react';
import {
  EMPLOYEE_LIST_COLUMNS,
  EMPLOYEE_SORT_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_TYPE_LABELS,
  SENIORITY_FORMAT_LABELS,
  formatDate,
  formatSeniority,
  type EmployeeSortField,
  type EmployeeStatus,
  type EmployeeType,
  type SeniorityFormat,
} from '@hrmonic/shared';
import { Avatar, Badge, Card, EmptyState, PageHeader, Spinner, type BadgeTone } from '../../components/ui';
import { MultiSelect } from '../../components/MultiSelect';
import { Popover } from '../../components/Popover';
import { useToast } from '../../components/Toast';
import {
  EMPTY_FILTERS,
  downloadEmployeesCsv,
  useDepartments,
  useEmployeeList,
  useJobTitles,
  useLocations,
  useTeams,
  type EmployeeFilters,
  type EmployeeRow,
} from './api';
import { EmployeeCreateModal } from './EmployeeCreateModal';
import { BulkEditModal } from './BulkEditModal';

export const TYPE_TONES: Record<EmployeeType, BadgeTone> = {
  vollzeit: 'blue',
  teilzeit: 'navy',
  minijob: 'yellow',
  werkstudent: 'green',
  praktikant: 'neutral',
  freiberufler: 'red',
  auszubildender: 'green',
};

/**
 * Spaltenauswahl und Senioritätsformat sind eine Arbeitsplatz-Einstellung, kein
 * Firmenstammdatum — sie liegen deshalb wie die Dashboard-Konfiguration lokal
 * je Gerät und nicht in der Datenbank.
 */
const VIEW_KEY = 'hrmonic.employeeList';

interface ViewConfig {
  columns: string[];
  seniorityFormat: SeniorityFormat;
}

const DEFAULT_VIEW: ViewConfig = {
  columns: EMPLOYEE_LIST_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id),
  seniorityFormat: 'jahre',
};

function loadView(): ViewConfig {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return DEFAULT_VIEW;
    const parsed = JSON.parse(raw) as Partial<ViewConfig>;
    const known = new Set(EMPLOYEE_LIST_COLUMNS.map((c) => c.id));
    // Unbekannte Spalten aus einer älteren Version stillschweigend verwerfen,
    // damit ein Umbenennen später keine kaputte Ansicht hinterlässt.
    const columns = Array.isArray(parsed.columns)
      ? parsed.columns.filter((c) => known.has(c))
      : DEFAULT_VIEW.columns;
    return {
      columns: columns.length ? columns : DEFAULT_VIEW.columns,
      seniorityFormat: parsed.seniorityFormat === 'monate' ? 'monate' : 'jahre',
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function EmployeeListPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<EmployeeFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useState<ViewConfig>(loadView);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);

  const createOpen = searchParams.get('neu') === '1';
  const setCreateOpen = (open: boolean) => setSearchParams(open ? { neu: '1' } : {}, { replace: true });

  const { data: employees, isLoading } = useEmployeeList(filters);
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();
  const { data: locations } = useLocations();
  const { data: jobTitles } = useJobTitles();

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* Speicher voll oder gesperrt — die Ansicht funktioniert trotzdem. */
    }
  }, [view]);

  const set = (patch: Partial<EmployeeFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setSelected(new Set());
  };

  const visible = useMemo(() => {
    const chosen = new Set(view.columns);
    return EMPLOYEE_LIST_COLUMNS.filter((c) => c.fixed || chosen.has(c.id));
  }, [view.columns]);

  const toggleColumn = (id: string) => {
    setView((v) => {
      const next = new Set(v.columns);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...v, columns: [...next] };
    });
  };

  const allSelected = useMemo(
    () => (employees?.length ?? 0) > 0 && employees!.every((e) => selected.has(e.id)),
    [employees, selected],
  );

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set((employees ?? []).map((e) => e.id)));
  };

  const toggle = (id: number) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadEmployeesCsv(filters);
      toast.success('CSV-Export gestartet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export fehlgeschlagen');
    } finally {
      setExporting(false);
    }
  };

  /**
   * Abweichungen von der Standardansicht — NICHT einfach alle gesetzten Werte.
   *
   * Die Liste startet mit status = ['aktiv'], zeigt also von Haus aus keine
   * Ausgeschiedenen. Zählte man das als gesetzten Filter, stünde schon beim
   * Öffnen „1 Filter zurücksetzen“, ohne dass jemand etwas eingestellt hat —
   * und der Knopf würde ausgerechnet die sinnvolle Vorbelegung entfernen.
   * Gezählt wird deshalb nur, was von EMPTY_FILTERS abweicht.
   */
  const abweichendeFilter = useMemo(() => {
    const felder: { key: keyof EmployeeFilters; label: string }[] = [
      { key: 'status', label: 'Status' },
      { key: 'employee_type', label: 'Typ' },
      { key: 'job_title', label: 'Titel' },
      { key: 'department_id', label: 'Abteilung' },
      { key: 'team_id', label: 'Team' },
      { key: 'location_id', label: 'Standort' },
    ];
    const gleich = (a: (string | number)[], b: (string | number)[]) =>
      a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
    return felder
      .filter((f) => !gleich(filters[f.key] as (string | number)[], EMPTY_FILTERS[f.key] as (string | number)[]))
      .map((f) => f.label);
  }, [filters]);

  function cell(e: EmployeeRow, columnId: string): React.ReactNode {
    switch (columnId) {
      case 'name':
        return (
          <div className="row">
            <Avatar name={`${e.first_name} ${e.last_name}`} size={30} />
            <span style={{ fontWeight: 600 }}>
              {e.first_name} {e.last_name}
            </span>
          </div>
        );
      case 'personnel_number':
        return e.personnel_number ? (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{e.personnel_number}</span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        );
      case 'employee_type':
        return <Badge tone={TYPE_TONES[e.employee_type]}>{EMPLOYEE_TYPE_LABELS[e.employee_type]}</Badge>;
      case 'department':
        return (
          <>
            <div>{e.department_name ?? '—'}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{e.team_name ?? ''}</div>
          </>
        );
      case 'job_title':
        return e.job_title ?? '—';
      case 'hire_date':
        return formatDate(e.hire_date);
      case 'seniority':
        return formatSeniority(e.hire_date, view.seniorityFormat);
      case 'location':
        return e.location_name ?? '—';
      case 'status':
        return (
          <Badge tone={e.status === 'aktiv' ? 'green' : 'neutral'}>{EMPLOYEE_STATUS_LABELS[e.status]}</Badge>
        );
      case 'email':
        return e.email ?? '—';
      case 'phone':
        return e.phone ?? '—';
      case 'manager':
        return e.manager_name ?? '—';
      case 'weekly_hours':
        return e.weekly_hours != null ? `${e.weekly_hours} h` : '—';
      case 'annual_leave_days':
        return e.annual_leave_days != null ? `${e.annual_leave_days} Tage` : '—';
      case 'exit_date':
        return formatDate(e.exit_date);
      default:
        return null;
    }
  }

  return (
    <>
      <PageHeader
        title="Mitarbeitende"
        subtitle="Stammdaten, Suche und Massenbearbeitung der Personalakte."
        actions={
          <>
            {selected.size > 0 && (
              <button className="hm-btn hm-btn--secondary" onClick={() => setBulkOpen(true)}>
                <UserCog size={16} /> Massenbearbeitung ({selected.size})
              </button>
            )}
            <button className="hm-btn hm-btn--secondary" disabled={exporting} onClick={exportCsv}>
              <Download size={16} /> CSV-Export
            </button>
            <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Mitarbeiter:in anlegen
            </button>
          </>
        }
      />

      <Card flush style={{ marginBottom: 16 }}>
        <div className="row row--wrap" style={{ padding: 14 }}>
          <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
            <Search size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-muted)' }} />
            <input
              className="hm-input"
              style={{ paddingLeft: 34 }}
              placeholder="Suchen (Name, E-Mail, Ort, IBAN, …)"
              value={filters.search}
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>

          <MultiSelect
            allLabel="Alle Status"
            width={150}
            value={filters.status}
            onChange={(v) => set({ status: v as EmployeeStatus[] })}
            options={Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => ({
              value: value as EmployeeStatus,
              label,
            }))}
          />
          <MultiSelect
            allLabel="Alle Typen"
            width={160}
            value={filters.employee_type}
            onChange={(v) => set({ employee_type: v as EmployeeType[] })}
            options={Object.entries(EMPLOYEE_TYPE_LABELS).map(([value, label]) => ({
              value: value as EmployeeType,
              label,
            }))}
          />
          <MultiSelect
            allLabel="Alle Abteilungen"
            width={175}
            value={filters.department_id}
            onChange={(v) => set({ department_id: v as number[], team_id: [] })}
            options={(departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
          />
          <MultiSelect
            allLabel="Alle Teams"
            width={150}
            value={filters.team_id}
            onChange={(v) => set({ team_id: v as number[] })}
            options={(teams ?? [])
              .filter((t) => filters.department_id.length === 0 || filters.department_id.includes(t.department_id ?? -1))
              .map((t) => ({ value: t.id, label: t.name }))}
          />
          <MultiSelect
            allLabel="Alle Titel"
            width={175}
            searchable
            value={filters.job_title}
            onChange={(v) => set({ job_title: v as string[] })}
            options={(jobTitles ?? []).map((t) => ({ value: t.title, label: t.title, hint: String(t.count) }))}
          />
          <MultiSelect
            allLabel="Alle Standorte"
            width={160}
            value={filters.location_id}
            onChange={(v) => set({ location_id: v as number[] })}
            options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />
        </div>

        <div
          className="row row--wrap"
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--border)',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Sortieren nach</span>
          <select
            className="hm-select"
            style={{ width: 160 }}
            value={filters.sort}
            onChange={(e) => set({ sort: e.target.value as EmployeeSortField })}
            aria-label="Sortierfeld"
          >
            {Object.entries(EMPLOYEE_SORT_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button
            className="hm-btn hm-btn--secondary hm-btn--sm"
            onClick={() => set({ dir: filters.dir === 'asc' ? 'desc' : 'asc' })}
            aria-label={filters.dir === 'asc' ? 'Aufsteigend, klicken für absteigend' : 'Absteigend, klicken für aufsteigend'}
          >
            {filters.dir === 'asc' ? <ArrowDownAZ size={15} /> : <ArrowUpAZ size={15} />}
            {filters.dir === 'asc' ? 'A – Z' : 'Z – A'}
          </button>

          <div style={{ flex: 1 }} />

          {abweichendeFilter.length > 0 && (
            <button
              className="hm-btn hm-btn--quiet hm-btn--sm"
              // Nennt beim Überfahren, WELCHE Filter greifen — sonst sucht man
              // bei sieben Auswahlfeldern, welches den Bestand ausblendet.
              title={`Gesetzt: ${abweichendeFilter.join(', ')}. Setzt auf die Standardansicht zurück (nur aktive Mitarbeitende).`}
              // Zurück auf die Standardansicht, nicht auf "gar kein Filter":
              // Alles zu leeren würde Ausgeschiedene einblenden — das erwartet
              // niemand hinter „zurücksetzen“.
              onClick={() =>
                set({
                  status: EMPTY_FILTERS.status,
                  employee_type: EMPTY_FILTERS.employee_type,
                  job_title: EMPTY_FILTERS.job_title,
                  department_id: EMPTY_FILTERS.department_id,
                  team_id: EMPTY_FILTERS.team_id,
                  location_id: EMPTY_FILTERS.location_id,
                })
              }
            >
              {abweichendeFilter.length === 1
                ? `Filter „${abweichendeFilter[0]}“ zurücksetzen`
                : `${abweichendeFilter.length} Filter zurücksetzen`}
            </button>
          )}

          <div className="hm-multi" style={{ width: 150 }}>
            <button
              ref={columnsButtonRef}
              type="button"
              className="hm-multi__button"
              onClick={() => setColumnsOpen((o) => !o)}
              aria-expanded={columnsOpen}
            >
              <Columns3 size={14} />
              <span className="hm-multi__label">Spalten</span>
            </button>
            {/* Portal statt eingebettetem Panel: Die Filterkarte hat
                `overflow: hidden` und schnitt das Panel vorher vollständig ab.
                Der frühere bildschirmfüllende Klickfänger entfällt damit — er
                hat auch das Scrollen der Seite geschluckt. */}
            <Popover
              open={columnsOpen}
              onClose={() => setColumnsOpen(false)}
              anchorRef={columnsButtonRef}
              align="right"
              minWidth={280}
            >
              <div>
                <div className="hm-multi__list">
                    {EMPLOYEE_LIST_COLUMNS.map((c) => {
                      const on = c.fixed || view.columns.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className={`hm-multi__option${on ? ' hm-multi__option--on' : ''}`}
                          style={c.fixed ? { opacity: 0.65, cursor: 'default' } : undefined}
                          title={
                            c.fixed
                              ? 'Ohne Name und Personalnummer ließe sich eine Zeile nicht mehr zuordnen.'
                              : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={c.fixed}
                            onChange={() => !c.fixed && toggleColumn(c.id)}
                          />
                          <span className="hm-multi__text">{c.label}</span>
                          {c.fixed && <span className="hm-multi__hint">immer</span>}
                        </label>
                      );
                    })}
                  </div>
                  {view.columns.includes('seniority') && (
                    <div style={{ padding: '8px', borderTop: '1px solid var(--border)' }}>
                      <div
                        style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 5 }}
                      >
                        Betriebszugehörigkeit anzeigen
                      </div>
                      <select
                        className="hm-select"
                        style={{ width: '100%' }}
                        value={view.seniorityFormat}
                        onChange={(e) =>
                          setView((v) => ({ ...v, seniorityFormat: e.target.value as SeniorityFormat }))
                        }
                      >
                        {Object.entries(SENIORITY_FORMAT_LABELS).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button
                    type="button"
                    className="hm-multi__reset"
                    onClick={() => setView(DEFAULT_VIEW)}
                  >
                  Auf Standard zurücksetzen
                </button>
              </div>
            </Popover>
          </div>
        </div>
      </Card>

      <Card flush>
        {isLoading ? (
          <Spinner center />
        ) : (employees?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Users size={40} />}
            title="Keine Mitarbeitenden gefunden"
            hint="Passen Sie Suche oder Filter an — oder legen Sie die erste Person an."
            action={
              <button className="hm-btn hm-btn--primary" onClick={() => setCreateOpen(true)}>
                <Plus size={16} /> Mitarbeiter:in anlegen
              </button>
            }
          />
        ) : (
          <div className="hm-table-wrap">
            <table className="hm-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Alle sichtbaren auswählen"
                    />
                  </th>
                  {visible.map((c) => (
                    <th key={c.id}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees!.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => navigate(`/personal/mitarbeitende/${e.id}`)}>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggle(e.id)}
                        aria-label={`${e.first_name} ${e.last_name} auswählen`}
                      />
                    </td>
                    {visible.map((c) => (
                      <td key={c.id}>{cell(e, c.id)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <EmployeeCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <BulkEditModal
        open={bulkOpen}
        ids={[...selected]}
        onClose={() => setBulkOpen(false)}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}
