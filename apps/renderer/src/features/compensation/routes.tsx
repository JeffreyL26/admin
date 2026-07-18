import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { PlaceholderPage } from '../../components/PlaceholderPage';

// Modul Vergütung — wird in der Modul-Phase durch echte Seiten ersetzt.
export const compensationRoutes: RouteObject[] = [
  { path: '/verguetung/gehaelter', element: <PlaceholderPage title="Gehälter" /> },
  { path: '/verguetung/abrechnung', element: <PlaceholderPage title="Abrechnung" /> },
  { path: '/verguetung/boni', element: <PlaceholderPage title="Boni & Variable Vergütung" /> },
  { path: '/verguetung/honorare', element: <PlaceholderPage title="Freiberufler & Honorare" /> },
  { path: '/verguetung/bescheinigungen', element: <PlaceholderPage title="Bescheinigungen" /> },
];
