import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface EmployeeLite {
  id: number;
  first_name: string;
  last_name: string;
  employee_type: string;
  status: string;
  job_title: string | null;
  department_id: number | null;
  team_id: number | null;
  location_id: number | null;
}

/** Alle Mitarbeitenden (leichtgewichtig) — von allen Modulen gemeinsam genutzt. */
export function useEmployees(includeInactive = false) {
  return useQuery({
    queryKey: ['employees', 'lite', includeInactive],
    queryFn: () =>
      api.get<{ employees: EmployeeLite[] }>(
        `/api/employees?fields=lite${includeInactive ? '' : '&status=aktiv'}`,
      ),
    select: (d) => d.employees,
  });
}

export function employeeName(e: Pick<EmployeeLite, 'first_name' | 'last_name'>): string {
  return `${e.first_name} ${e.last_name}`;
}

/** Einheitlicher Mitarbeitenden-Picker für Formulare aller Module. */
export function EmployeeSelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = '— auswählen —',
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const { data: employees } = useEmployees();
  return (
    <select
      className="hm-select"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">{emptyLabel}</option>
      {(employees ?? []).map((e) => (
        <option key={e.id} value={e.id}>
          {e.last_name}, {e.first_name}
        </option>
      ))}
      {!allowEmpty && null}
    </select>
  );
}
