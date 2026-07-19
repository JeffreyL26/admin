import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { GoalsPage } from './GoalsPage';
import { ReviewsPage } from './ReviewsPage';
import { SkillsPage } from './SkillsPage';
import { TrainingsPage } from './TrainingsPage';
import { FeedbackPage } from './FeedbackPage';

// Modul Leistung — Pfad-Kontrakt aus layout/nav.ts.
export const performanceRoutes: RouteObject[] = [
  { path: '/leistung/ziele', element: <GoalsPage /> },
  { path: '/leistung/beurteilungen', element: <ReviewsPage /> },
  { path: '/leistung/skills', element: <SkillsPage /> },
  { path: '/leistung/trainings', element: <TrainingsPage /> },
  { path: '/leistung/feedback', element: <FeedbackPage /> },
];
