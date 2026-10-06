import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SETUP_STEPS,
  deriveSetupProgress,
  moduleEnabled,
  pathAllowedByFeatures,
  type SetupProgress,
  type SetupStatus,
  type SetupStepKey,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { bindSetupKey, useSetupState } from './store';
import { bindToursKey } from '../tours/store';

export const SETUP_STATUS_KEY = ['setup', 'status'];

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
    enabled,
  });
}

export interface SetupView {
  /** Konto darf den Assistenten ueberhaupt sehen (Admin mit mindestens einem Schritt). */
  eligible: boolean;
  status: SetupStatus | undefined;
  progress: SetupProgress;
  visibleKeys: SetupStepKey[];
}

const EMPTY_PROGRESS: SetupProgress = {
  steps: [],
  total: 0,
  doneCount: 0,
  remainingMinutes: 0,
  next: null,
  complete: false,
};

/**
 * Sichtbare Schritte: nur, was das Konto bearbeiten darf, was die Variante
 * mitbringt und was die Lizenz freigibt. Dieselbe Regel wie die Seitenleiste
 * (layout/AppShell.tsx), damit der Assistent nie auf eine Seite zeigt, die der
 * Person verschlossen bleibt. Die eigentliche Sperre sitzt im Backend.
 */
export function useSetup(): SetupView {
  const { user, can, features } = useAuth();
  const local = useSetupState();
  const qc = useQueryClient();
  const location = useLocation();

  const userId = user?.id ?? null;

  const visibleKeys = useMemo(
    () =>
      SETUP_STEPS.filter(
        (d) =>
          can(d.area, 'bearbeiten') &&
          moduleEnabled(VARIANT, d.module) &&
          pathAllowedByFeatures(d.navPath, features),
      ).map((d) => d.key),
    [can, features],
  );

  const eligible = user?.role === 'admin' && visibleKeys.length > 0;
  // Der Status wird fuer jedes Admin-Konto geholt: Er liefert auch die Kennung
  // der Installation, an die sich der Stand der Seiten-Einfuehrungen haengt.
  const { data: status } = useSetupStatus(user?.role === 'admin');

  // Der lokale Stand gilt erst, wenn Installation (aus dem Status) und Konto
  // feststehen; bis dahin bleibt `bound` falsch und nichts oeffnet sich.
  const instance = status?.instance ?? null;
  useEffect(() => {
    const key = userId !== null && instance !== null ? `${instance}.${userId}` : null;
    bindSetupKey(key);
    bindToursKey(key);
  }, [userId, instance]);

  const progress = useMemo(
    () =>
      status
        ? deriveSetupProgress(
            status,
            { absenceConfirmed: local.absenceConfirmed, skipped: local.skipped },
            visibleKeys,
          )
        : EMPTY_PROGRESS,
    [status, local.absenceConfirmed, local.skipped, visibleKeys],
  );

  // Die Route aendert sich staendig, der Stand auch: Wer eine Abteilung auf der
  // normalen Seite anlegt, soll sie im Assistenten sofort erledigt sehen. Die
  // Abfrage besteht nur aus Zaehlungen, laeuft aber nur, solange der Assistent oder
  // seine Karte etwas anzeigen: nicht nach dem Abschluss, nicht nach dem Ausblenden.
  const watching = eligible && !progress.complete && (local.welcomed || !local.cardDismissed);
  useEffect(() => {
    if (watching) qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
  }, [location.pathname, watching, qc]);

  return { eligible, status, progress, visibleKeys };
}
