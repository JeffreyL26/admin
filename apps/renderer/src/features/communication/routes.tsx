import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { PlaceholderPage } from '../../components/PlaceholderPage';

// Modul Kommunikation — wird in der Modul-Phase durch echte Seiten ersetzt.
export const communicationRoutes: RouteObject[] = [
  { path: '/kommunikation/verzeichnis', element: <PlaceholderPage title="Mitarbeiterverzeichnis" /> },
  { path: '/kommunikation/ankuendigungen', element: <PlaceholderPage title="Ankündigungen" /> },
  { path: '/kommunikation/umfragen', element: <PlaceholderPage title="Umfragen" /> },
  { path: '/kommunikation/gespraeche', element: <PlaceholderPage title="Gespräche" /> },
  { path: '/kommunikation/kanaele', element: <PlaceholderPage title="Kanäle" /> },
];
