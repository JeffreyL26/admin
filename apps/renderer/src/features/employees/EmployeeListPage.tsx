import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Search, UserCog, Users } from 'lucide-react';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_TYPE_LABELS,
  formatDate,
  type EmployeeStatus,
  type EmployeeType,
} from '@hrmonic/shared';
import { Avatar, Badge, Card, EmptyState, PageHeader, Spinner, type BadgeTone } from '../../components/ui';
import { useToast } from '../../components/Toast';
import {
  EMPTY_FILTERS,
  downloadEmployeesCsv,
  useDepartments,
  useEmployeeList,
  useLocations,
  useTeams,
  type EmployeeFilters,
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

export function EmployeeListPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<EmployeeFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const createOpen = searchParams.get('neu') === '1';
  const setCreateOpen = (open: boolean) => setSearchParams(open ? { neu: '1' } : {}, { replace: true });

  const { data: employees, isLoading } = useEmployeeList(filters);
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();
  const { data: locations } = useLocations();

  const set = (patch: Partial<EmployeeFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setSelected(new Set());
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
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 220 }}>
            <Search
              size={15}
              style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-muted)' }}
            />
            <input
              className="hm-input"
              style={{ paddingLeft: 34 }}
              placeholder="Suchen (Name, E-Mail, Ort, IBAN, …)"
              value={filters.search}
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>
          <select
            className="hm-select"
            style={{ width: 150 }}
            value={filters.status}
            onChange={(e) => set({ status: e.target.value as EmployeeStatus | '' })}
          >
            <option value="">Alle Status</option>
            {Object.entries(EMPLOYEE_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            className="hm-select"
            style={{ width: 160 }}
            value={filters.employee_type}
            onChange={(e) => set({ employee_type: e.target.value as EmployeeType | '' })}
          >
            <option value="">Alle Typen</option>
            {Object.entries(EMPLOYEE_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            className="hm-select"
            style={{ width: 170 }}
            value={filters.department_id}
            onChange={(e) => set({ department_id: e.target.value === '' ? '' : Number(e.target.value), team_id: '' })}
          >
            <option value="">Alle Abteilungen</option>
            {(departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            className="hm-select"
            style={{ width: 150 }}
            value={filters.team_id}
            onChange={(e) => set({ team_id: e.target.value === '' ? '' : Number(e.target.value) })}
          >
            <option value="">Alle Teams</option>
            {(teams ?? [])
              .filter((t) => filters.department_id === '' || t.department_id === filters.department_id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <select
            className="hm-select"
            style={{ width: 160 }}
            value={filters.location_id}
            onChange={(e) => set({ location_id: e.target.value === '' ? '' : Number(e.target.value) })}
          >
            <option value="">Alle Standorte</option>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
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
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </th>
                  <th>Name</th>
                  <th>Typ</th>
                  <th>Abteilung / Team</th>
                  <th>Standort</th>
                  <th>Status</th>
                  <th>Eintritt</th>
                </tr>
              </thead>
              <tbody>
                {employees!.map((e) => (
                  <tr
                    key={e.id}
                    className="clickable"
                    onClick={() => navigate(`/personal/mitarbeitende/${e.id}`)}
                  >
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                    </td>
                    <td>
                      <div className="row">
                        <Avatar name={`${e.first_name} ${e.last_name}`} size={30} />
                        <div>
                          <div style={{ fontWeight: 600 }}>
                            {e.first_name} {e.last_name}
                          </div>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            {e.job_title ?? '—'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={TYPE_TONES[e.employee_type]}>{EMPLOYEE_TYPE_LABELS[e.employee_type]}</Badge>
                    </td>
                    <td>
                      <div>{e.department_name ?? '—'}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {e.team_name ?? ''}
                      </div>
                    </td>
                    <td>{e.location_name ?? '—'}</td>
                    <td>
                      <Badge tone={e.status === 'aktiv' ? 'green' : 'neutral'}>
                        {EMPLOYEE_STATUS_LABELS[e.status]}
                      </Badge>
                    </td>
                    <td>{formatDate(e.hire_date)}</td>
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
