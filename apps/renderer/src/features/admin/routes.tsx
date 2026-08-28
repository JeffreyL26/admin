import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { TemplatesPage } from './TemplatesPage';
import { OnboardingPage } from './OnboardingPage';
import { RolesPage } from './RolesPage';

// Modul Verwaltung — Pfad-Kontrakt aus layout/nav.ts.
export const adminRoutes: RouteObject[] = [
  { path: '/verwaltung/vorlagen', element: <TemplatesPage /> },
  { path: '/verwaltung/onboarding', element: <OnboardingPage /> },
  { path: '/verwaltung/rollen', element: <RolesPage /> },
];
