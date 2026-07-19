import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { DirectoryPage } from './DirectoryPage';
import { AnnouncementsPage } from './AnnouncementsPage';
import { SurveysPage } from './SurveysPage';
import { MeetingsPage } from './MeetingsPage';
import { ChannelsPage } from './ChannelsPage';

// Modul Kommunikation & Engagement — Pfad-Kontrakt aus layout/nav.ts.
export const communicationRoutes: RouteObject[] = [
  { path: '/kommunikation/verzeichnis', element: <DirectoryPage /> },
  { path: '/kommunikation/ankuendigungen', element: <AnnouncementsPage /> },
  { path: '/kommunikation/umfragen', element: <SurveysPage /> },
  { path: '/kommunikation/gespraeche', element: <MeetingsPage /> },
  { path: '/kommunikation/kanaele', element: <ChannelsPage /> },
];
