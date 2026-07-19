import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EMPLOYEE_STATUS_LABELS, type EmployeeStatus } from '@hrmonic/shared';
import { api } from '../../api/client';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useDepartments, useLocations, useTeams } from './api';

interface BulkState {
  department: { active: boolean; value: number | null };
  team: { active: boolean; value: number | null };
  location: { active: boolean; value: number | null };
  manager: { active: boolean; value: number | null };
  status: { active: boolean; value: EmployeeStatus };
  weekly_hours: { active: boolean; value: string };
  annual_leave_days: { active: boolean; value: string };
}

const INITIAL: BulkState = {
  department: { active: false, value: null },
  team: { active: false, value: null },
  location: { active: false, value: null },
  manager: { active: false, value: null },
  status: { active: false, value: 'aktiv' },
  weekly_hours: { active: false, value: '' },
  annual_leave_days: { active: false, value: '' },
};

export function BulkEditModal({
  open,
  ids,
  onClose,
  onDone,
}: {
  open: boolean;
  ids: number[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [state, setState] = useState<BulkState>(INITIAL);
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();
  const { data: locations } = useLocations();

  const patch = <K extends keyof BulkState>(key: K, value: Partial<BulkState[K]>) =>
    setState((s) => ({ ...s, [key]: { ...s[key], ...value } }));

  const buildSet = (): Record<string, unknown> => {
    const set: Record<string, unknown> = {};
    if (state.department.active) set.department_id = state.department.value;
    if (state.team.active) set.team_id = state.team.value;
    if (state.location.active) set.location_id = state.location.value;
    if (state.manager.active) set.manager_id = state.manager.value;
    if (state.status.active) set.status = state.status.value;
    if (state.weekly_hours.active)
      set.weekly_hours = state.weekly_hours.value === '' ? null : Number(state.weekly_hours.value.replace(',', '.'));
    if (state.annual_leave_days.active)
      set.annual_leave_days =
        state.annual_leave_days.value === '' ? null : Number(state.annual_leave_days.value.replace(',', '.'));
    return set;
  };

  const mutation = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/api/employees/bulk', { ids, set: buildSet() }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['org'] });
      toast.success(`${res.updated} Mitarbeitende aktualisiert`);
      setState(INITIAL);
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const anyActive = Object.values(state).some((v) => v.active);

  const row = (
    key: keyof BulkState,
    label: string,
    control: React.ReactNode,
  ) => (
    <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
      <label className="hm-checkbox" style={{ width: 210, flexShrink: 0, paddingBottom: 8 }}>
        <input
          type="checkbox"
          checked={state[key].active}
          onChange={(e) => patch(key, { active: e.target.checked } as Partial<BulkState[typeof key]>)}
        />
        {label}
      </label>
      <div style={{ flex: 1, opacity: state[key].active ? 1 : 0.5 }}>{control}</div>
    </div>
  );

  return (
    <Modal
      title={`Massenbearbeitung (${ids.length} ausgewählt)`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!anyActive || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Wird gespeichert…' : 'Änderungen anwenden'}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 14 }}>
        Nur angehakte Felder werden gesetzt. Die Änderung erfolgt transaktional für alle
        ausgewählten Mitarbeitenden und wird auditiert.
      </p>
      <div className="stack">
        {row(
          'department',
          'Abteilung',
          <Field label="">
            <select
              className="hm-select"
              disabled={!state.department.active}
              value={state.department.value ?? ''}
              onChange={(e) => patch('department', { value: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">— keine —</option>
              {(departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>,
        )}
        {row(
          'team',
          'Team',
          <Field label="">
            <select
              className="hm-select"
              disabled={!state.team.active}
              value={state.team.value ?? ''}
              onChange={(e) => patch('team', { value: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">— keines —</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>,
        )}
        {row(
          'location',
          'Standort',
          <Field label="">
            <select
              className="hm-select"
              disabled={!state.location.active}
              value={state.location.value ?? ''}
              onChange={(e) => patch('location', { value: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">— keiner —</option>
              {(locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>,
        )}
        {row(
          'manager',
          'Vorgesetzte:r',
          <Field label="">
            <EmployeeSelect
              value={state.manager.value}
              disabled={!state.manager.active}
              onChange={(id) => patch('manager', { value: id })}
              allowEmpty
            />
          </Field>,
        )}
        {row(
          'status',
          'Status',
          <Field label="">
            <select
              className="hm-select"
              disabled={!state.status.active}
              value={state.status.value}
              onChange={(e) => patch('status', { value: e.target.value as EmployeeStatus })}
            >
              {Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>,
        )}
        {row(
          'weekly_hours',
          'Wochenstunden',
          <Field label="">
            <input
              className="hm-input"
              type="number"
              min={0}
              max={60}
              step={0.5}
              disabled={!state.weekly_hours.active}
              value={state.weekly_hours.value}
              onChange={(e) => patch('weekly_hours', { value: e.target.value })}
            />
          </Field>,
        )}
        {row(
          'annual_leave_days',
          'Jahresurlaub (Tage)',
          <Field label="">
            <input
              className="hm-input"
              type="number"
              min={0}
              max={100}
              step={0.5}
              disabled={!state.annual_leave_days.active}
              value={state.annual_leave_days.value}
              onChange={(e) => patch('annual_leave_days', { value: e.target.value })}
            />
          </Field>,
        )}
      </div>
    </Modal>
  );
}
