// GENERIERT aus packages/shared/src/variants/registry.json durch scripts/variant-wiring.mjs.
// Nicht von Hand aendern. Nach einer Aenderung am Register: npm run variants:gen
// Variante: de-vollversion
import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { RequestsPage } from '../pages/RequestsPage';
import { NewRequestPage } from '../pages/NewRequestPage';
import { SickNotePage } from '../pages/SickNotePage';
import { CalendarPage } from '../pages/CalendarPage';
import { SalaryPage } from '../pages/SalaryPage';

export * from './de-vollversion.manifest';

/** Seiten optionaler Module dieser Variante (App.tsx haengt die Basisseiten an). */
export const portalRoutes: RouteObject[] = [
  { path: '/antraege', element: <RequestsPage /> },
  { path: '/antraege/neu', element: <NewRequestPage /> },
  { path: '/krankmeldung', element: <SickNotePage /> },
  { path: '/kalender', element: <CalendarPage /> },
  { path: '/gehalt', element: <SalaryPage /> },
];
