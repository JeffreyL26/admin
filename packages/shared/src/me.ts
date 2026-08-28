// Typen des Mitarbeitenden-Self-Service (Web-Portal, /api/me/*).

/** Rollen von Benutzerkonten: HR-Administration (Desktop) bzw. Web-Portal. */
export type UserRole = 'admin' | 'mitarbeiter';

/** Angemeldeter Benutzer (JWT-Payload und /api/auth/me). */
export interface AuthUserDto {
  id: number;
  email: string;
  name: string;
  role: string;
  /** Verknüpftes Personalprofil (nur Mitarbeitenden-Accounts, sonst null). */
  employee_id: number | null;
}

/** Eigene Stammdaten (GET /api/me/profile) — bewusst ohne Bank-/Steuerdaten. */
export interface MeProfile {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  birth_date: string | null;
  private_street: string | null;
  private_zip: string | null;
  private_city: string | null;
  private_phone: string | null;
  private_email: string | null;
  employee_type: string;
  job_title: string | null;
  hire_date: string | null;
  weekly_hours: number | null;
  annual_leave_days: number | null;
  health_insurance: string | null;
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
  manager_name: string | null;
}
