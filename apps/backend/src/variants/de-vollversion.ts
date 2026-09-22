// GENERIERT aus packages/shared/src/variants/registry.json durch scripts/variant-wiring.mjs.
// Nicht von Hand aendern. Nach einer Aenderung am Register: npm run variants:gen
// Variante: de-vollversion
import type { FastifyPluginAsync } from 'fastify';
import { employeesModule } from '../modules/employees/routes.js';
import { absencesModule } from '../modules/absences/routes.js';
import { performanceModule } from '../modules/performance/routes.js';
import { compensationModule } from '../modules/compensation/routes.js';
import { communicationModule } from '../modules/communication/routes.js';
import { recruitingModule } from '../modules/recruiting/routes.js';
import { adminModule } from '../modules/admin/routes.js';
import { leadershipModule } from '../modules/leadership/routes.js';
import { meModule } from '../modules/me/routes.js';
import { meSalaryRoutes } from '../modules/me/salaryRoutes.js';
import { meCommunicationRoutes } from '../modules/me/communicationRoutes.js';

export * from './de-vollversion.manifest.js';

/** Plugins dieser Variante in Registrierungsreihenfolge (modules/index.ts). */
export const backendModules: FastifyPluginAsync[] = [
  employeesModule,
  absencesModule,
  performanceModule,
  compensationModule,
  communicationModule,
  recruitingModule,
  adminModule,
  leadershipModule,
  meModule,
  meSalaryRoutes,
  meCommunicationRoutes,
];
