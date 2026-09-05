import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { MyTeamPage } from './MyTeamPage';
import { TeamMemberRatingPage } from './TeamMemberRatingPage';
import { SetupPage } from './SetupPage';
import { ReportPage } from './ReportPage';

// Modul Führung & Bewertung — Pfad-Kontrakt aus layout/nav.ts.
// „Mein Team“ und die Bewertungsmaske sind die Führungsfunktion (nur für
// freigeschaltete Personalprofile), Report und Einrichtung die Verwaltung
// (Rechtebereich `fuehrung`). Beides erzwingt das Backend.
export const leadershipRoutes: RouteObject[] = [
  { path: '/fuehrung/mein-team', element: <MyTeamPage /> },
  { path: '/fuehrung/mein-team/:id', element: <TeamMemberRatingPage /> },
  { path: '/fuehrung/report', element: <ReportPage /> },
  { path: '/fuehrung/einrichtung', element: <SetupPage /> },
];
