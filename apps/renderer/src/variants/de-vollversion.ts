// GENERIERT aus packages/shared/src/variants/registry.json durch scripts/variant-wiring.mjs.
// Nicht von Hand aendern. Nach einer Aenderung am Register: npm run variants:gen
// Variante: de-vollversion
import type { RouteObject } from 'react-router-dom';
import { employeesRoutes } from '../features/employees/routes';
import { recruitingRoutes } from '../features/recruiting/routes';
import { absencesRoutes } from '../features/absences/routes';
import { performanceRoutes } from '../features/performance/routes';
import { compensationRoutes } from '../features/compensation/routes';
import { communicationRoutes } from '../features/communication/routes';
import { adminRoutes } from '../features/admin/routes';
import { leadershipRoutes } from '../features/leadership/routes';

export * from './de-vollversion.manifest';

/** Seiten der Fachmodule dieser Variante (router.tsx haengt Dashboard und Einstellungen an). */
export const variantRoutes: RouteObject[] = [
  ...employeesRoutes,
  ...recruitingRoutes,
  ...absencesRoutes,
  ...performanceRoutes,
  ...compensationRoutes,
  ...communicationRoutes,
  ...adminRoutes,
  ...leadershipRoutes,
];
