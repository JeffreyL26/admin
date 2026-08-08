import type { Migration } from './types.js';
import { coreMigrations } from './000_core.js';
import { employeesMigrations } from './100_employees.js';
import { absencesMigrations } from './200_absences.js';
import { performanceMigrations } from './300_performance.js';
import { compensationMigrations } from './400_compensation.js';
import { communicationMigrations } from './500_communication.js';
import { recruitingMigrations } from './600_recruiting.js';
import { adminMigrations } from './700_admin.js';

// Jedes Fachmodul pflegt ausschließlich seine eigene Migrationsdatei —
// diese Index-Datei wird nach der Scaffold-Phase nicht mehr angefasst.
export const allMigrations: Migration[] = [
  ...coreMigrations,
  ...employeesMigrations,
  ...absencesMigrations,
  ...performanceMigrations,
  ...compensationMigrations,
  ...communicationMigrations,
  ...recruitingMigrations,
  ...adminMigrations,
];
