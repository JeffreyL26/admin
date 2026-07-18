import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { PlaceholderPage } from '../../components/PlaceholderPage';

// Modul Personal — wird in der Modul-Phase durch echte Seiten ersetzt.
// Pfad-Kontrakt siehe layout/nav.ts.
export const employeesRoutes: RouteObject[] = [
  { path: '/personal/mitarbeitende', element: <PlaceholderPage title="Mitarbeitende" /> },
  { path: '/personal/organisation', element: <PlaceholderPage title="Organisation" /> },
  { path: '/personal/dokumente', element: <PlaceholderPage title="Dokumente" /> },
];
