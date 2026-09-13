import React from 'react';
import { createHashRouter, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { settingsRoutes } from './features/settings/routes';
import { employeesRoutes } from './features/employees/routes';
import { absencesRoutes } from './features/absences/routes';
import { performanceRoutes } from './features/performance/routes';
import { compensationRoutes } from './features/compensation/routes';
import { communicationRoutes } from './features/communication/routes';
import { recruitingRoutes } from './features/recruiting/routes';
import { adminRoutes } from './features/admin/routes';
import { leadershipRoutes } from './features/leadership/routes';

// Hash-Router statt Browser-Router: die Desktop-App lädt den Build über
// file://, dort gibt es keinen Server, der Deep-Links beantworten könnte.
export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      { path: '/dashboard', element: <DashboardPage /> },
      ...employeesRoutes,
      ...recruitingRoutes,
      ...absencesRoutes,
      ...performanceRoutes,
      ...compensationRoutes,
      ...communicationRoutes,
      ...adminRoutes,
      ...leadershipRoutes,
      ...settingsRoutes,
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);
