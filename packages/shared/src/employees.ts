// Typen des Moduls Personalverwaltung & Stammdaten.

export type EmployeeType =
  | 'vollzeit'
  | 'teilzeit'
  | 'minijob'
  | 'werkstudent'
  | 'praktikant'
  | 'freiberufler'
  | 'auszubildender';

export const EMPLOYEE_TYPE_LABELS: Record<EmployeeType, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob: 'Minijob',
  werkstudent: 'Werkstudent',
  praktikant: 'Praktikant',
  freiberufler: 'Freiberufler',
  auszubildender: 'Auszubildender',
};
