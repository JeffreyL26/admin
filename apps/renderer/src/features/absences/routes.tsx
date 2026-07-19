import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { CalendarPage } from './CalendarPage';
import { RequestsPage } from './RequestsPage';
import { SickNotesPage } from './SickNotesPage';
import { TypesPage } from './TypesPage';

// Modul Abwesenheit — Pfad-Kontrakt aus layout/nav.ts.
export const absencesRoutes: RouteObject[] = [
  { path: '/abwesenheit/kalender', element: <CalendarPage /> },
  { path: '/abwesenheit/antraege', element: <RequestsPage /> },
  { path: '/abwesenheit/krankmeldungen', element: <SickNotesPage /> },
  { path: '/abwesenheit/arten', element: <TypesPage /> },
];
