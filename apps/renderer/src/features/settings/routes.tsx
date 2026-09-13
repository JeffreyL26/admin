import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { SettingsPage } from './SettingsPage';
import { LicensePage } from './LicensePage';

/** Pfade laut Navigations-Kontrakt in layout/nav.ts (Abschnitt „System“). */
export const settingsRoutes: RouteObject[] = [
  { path: '/einstellungen', element: <SettingsPage /> },
  { path: '/einstellungen/lizenz', element: <LicensePage /> },
];
