import React from 'react';
import type { RouteObject } from 'react-router-dom';
import { moduleEnabled } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { SettingsPage } from './SettingsPage';
import { DatevSettingsPage } from './DatevSettingsPage';
import { LicensePage } from './LicensePage';
import { AccountPage } from './AccountPage';

/**
 * Pfade laut Navigations-Kontrakt in layout/nav.ts (Abschnitt „System“).
 * Der DATEV-Lohnexport gehoert zum Modul Verguetung: Eine Ausgabe ohne das
 * Modul hat die Seite nicht (wie der Eintrag in der Seitenleiste).
 */
export const settingsRoutes: RouteObject[] = [
  { path: '/einstellungen', element: <SettingsPage /> },
  ...(moduleEnabled(VARIANT, 'compensation') ? [{ path: '/einstellungen/datev', element: <DatevSettingsPage /> }] : []),
  { path: '/einstellungen/lizenz', element: <LicensePage /> },
  // Ohne Rechtebereich: eigenes Passwort, Darstellung, Seitenleiste.
  { path: '/einstellungen/konto', element: <AccountPage /> },
];
