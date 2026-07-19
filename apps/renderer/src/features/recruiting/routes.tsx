import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { StellenPage } from './StellenPage';
import { PipelinePage } from './PipelinePage';
import { BewerberPage } from './BewerberPage';
import { InterviewsPage } from './InterviewsPage';
import { AnalysePage } from './AnalysePage';

// Modul Recruiting & Bewerbermanagement — Pfad-Kontrakt aus layout/nav.ts.
export const recruitingRoutes: RouteObject[] = [
  { path: '/recruiting/stellen', element: <StellenPage /> },
  { path: '/recruiting/pipeline', element: <PipelinePage /> },
  { path: '/recruiting/bewerber', element: <BewerberPage /> },
  { path: '/recruiting/interviews', element: <InterviewsPage /> },
  { path: '/recruiting/analyse', element: <AnalysePage /> },
];
