import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { PlaceholderPage } from '../../components/PlaceholderPage';

// Modul Leistung — wird in der Modul-Phase durch echte Seiten ersetzt.
export const performanceRoutes: RouteObject[] = [
  { path: '/leistung/ziele', element: <PlaceholderPage title="Ziele & OKR" /> },
  { path: '/leistung/beurteilungen', element: <PlaceholderPage title="Beurteilungen" /> },
  { path: '/leistung/skills', element: <PlaceholderPage title="Skills & Kompetenzen" /> },
  { path: '/leistung/trainings', element: <PlaceholderPage title="Trainings" /> },
  { path: '/leistung/feedback', element: <PlaceholderPage title="Feedback-Zyklen" /> },
];
