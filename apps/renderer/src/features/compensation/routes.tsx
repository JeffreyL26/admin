import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { SalariesPage } from './SalariesPage';
import { PayrollPage } from './PayrollPage';
import { BonusesPage } from './BonusesPage';
import { FreelancersPage } from './FreelancersPage';
import { CertificatesPage } from './CertificatesPage';

// Modul Vergütung — Pfad-Kontrakt aus layout/nav.ts.
export const compensationRoutes: RouteObject[] = [
  { path: '/verguetung/gehaelter', element: <SalariesPage /> },
  { path: '/verguetung/abrechnung', element: <PayrollPage /> },
  { path: '/verguetung/boni', element: <BonusesPage /> },
  { path: '/verguetung/honorare', element: <FreelancersPage /> },
  { path: '/verguetung/bescheinigungen', element: <CertificatesPage /> },
];
