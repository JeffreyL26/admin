import type { FastifyPluginAsync } from 'fastify';
import { salaryRoutes } from './salaryRoutes.js';
import { bonusRoutes } from './bonusRoutes.js';
import { payrollRoutes } from './payrollRoutes.js';
import { freelancerRoutes } from './freelancerRoutes.js';
import { certificateRoutes } from './certificateRoutes.js';

// Modul: Vergütung — Gehaltskomponenten (lückenlose Historie),
// Gehaltsänderungs-Workflow, Boni (inkl. Zielkopplung an das Leistungs-Modul),
// Abrechnungsläufe mit DATEV-/CSV-Export, Freiberufler-Honorare und
// Bescheinigungen.
export const compensationModule: FastifyPluginAsync = async (app) => {
  await salaryRoutes(app);
  await bonusRoutes(app);
  await payrollRoutes(app);
  await freelancerRoutes(app);
  await certificateRoutes(app);
};
