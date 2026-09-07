import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { EmployeeListPage } from './EmployeeListPage';
import { EmployeeDetailPage } from './EmployeeDetailPage';
import { OrgPage } from './OrgPage';
import { DocumentsPage } from './DocumentsPage';
import { ChangeRequestsPage } from './ChangeRequestsPage';

// Modul Personal — Pfad-Kontrakt siehe layout/nav.ts.
export const employeesRoutes: RouteObject[] = [
  { path: '/personal/mitarbeitende', element: <EmployeeListPage /> },
  { path: '/personal/mitarbeitende/:id', element: <EmployeeDetailPage /> },
  { path: '/personal/organisation', element: <OrgPage /> },
  { path: '/personal/aenderungsantraege', element: <ChangeRequestsPage /> },
  { path: '/personal/dokumente', element: <DocumentsPage /> },
];
