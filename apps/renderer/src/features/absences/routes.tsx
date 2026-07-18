import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { PlaceholderPage } from '../../components/PlaceholderPage';

// Modul Abwesenheit — wird in der Modul-Phase durch echte Seiten ersetzt.
export const absencesRoutes: RouteObject[] = [
  { path: '/abwesenheit/kalender', element: <PlaceholderPage title="Abwesenheitskalender" /> },
  { path: '/abwesenheit/antraege', element: <PlaceholderPage title="Anträge" /> },
  { path: '/abwesenheit/krankmeldungen', element: <PlaceholderPage title="Krankmeldungen" /> },
  { path: '/abwesenheit/arten', element: <PlaceholderPage title="Abwesenheitsarten" /> },
];
