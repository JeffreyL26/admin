import React from 'react';
import { createHashRouter, Navigate } from 'react-router-dom';
import { variantRoutes } from '@variant';
import { AppShell } from './layout/AppShell';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { settingsRoutes } from './features/settings/routes';

// Hash-Router statt Browser-Router: die Desktop-App lädt den Build über
// file://, dort gibt es keinen Server, der Deep-Links beantworten könnte.
//
// Die Seiten der Fachmodule kommen aus der Variante (@variant zeigt auf
// src/variants/<id>.ts, erzeugt aus packages/shared/src/variants/registry.json):
// Nur die Module der Variante werden importiert und landen im Bundle.
// Dashboard und Einstellungen gibt es in jeder Variante.
export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      { path: '/dashboard', element: <DashboardPage /> },
      ...variantRoutes,
      ...settingsRoutes,
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);
