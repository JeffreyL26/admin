import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Select } from './Select';

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

/**
 * Alle Mitarbeitenden (leichtgewichtig), von allen Modulen gemeinsam genutzt.
 * Bewusst ueber die bereichsneutrale Lookup-Route statt ueber /api/employees:
 * Die haengt am Rechtebereich `personal`, und eine Rolle ohne diesen Bereich
 * saehe in Recruiting, Verwaltung und Co. nur leere Auswahlfelder.
 */
export function useEmployees(includeInactive = false) {
  return useQuery({
    queryKey: ['employees', 'lite', includeInactive],
    queryFn: () =>
      api.get<{ employees: EmployeeLite[] }>(
        `/api/lookup/employees${includeInactive ? '?include_inactive=1' : ''}`,
      ),
    select: (d) => d.employees,
  });
}

export function employeeName(e: Pick<EmployeeLite, 'first_name' | 'last_name'>): string {
  return `${e.first_name} ${e.last_name}`;
}

/**
 * Einheitlicher Mitarbeitenden-Picker für Formulare aller Module.
 *
 * `includeInactive`: auch Ausgeschiedene anbieten, gekennzeichnet mit
 * „(ausgeschieden)“. Noetig, wo ein gespeicherter Verweis auf eine
 * ausgeschiedene Person sichtbar bleiben muss (etwa Vorgesetzte in der
 * Personalakte); ohne die Option zeigte das Feld still „auswählen“.
 */
export function EmployeeSelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = '— auswählen —',
  disabled,
  includeInactive = false,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
  includeInactive?: boolean;
}) {
  const { data: employees } = useEmployees(includeInactive);
  return (
    <Select
      className="hm-select"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">{emptyLabel}</option>
      {(employees ?? []).map((e) => (
        <option key={e.id} value={e.id}>
          {e.last_name}, {e.first_name}
          {e.status === 'ausgeschieden' ? ' (ausgeschieden)' : ''}
        </option>
      ))}
      {!allowEmpty && null}
    </Select>
  );
}
