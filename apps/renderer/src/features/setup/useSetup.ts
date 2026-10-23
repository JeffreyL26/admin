import { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  deriveSetupProgress,
  setupClaimOwed,
  setupStatusWatched,
  visibleSetupStepKeys,
  type SetupProgress,
  type SetupStatus,
  type SetupStepKey,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { ApiRequestError, api } from '../../api/client';
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

/** Merker des Assistenten, die der Server fuer die Installation haelt (core/setupRoutes.ts). */
type SetupMark = '/api/setup/absence-confirmed' | '/api/setup/started';

/**
 * Schreibt einen Merker und laedt den Status neu. Eine laufende Anfrage wird je
 * QueryClient und Merker geteilt: Der Schritt und der Nachtrag in useSetup
 * loesen sonst im selben Moment beide aus.
 */
const marksInFlight = new WeakMap<QueryClient, Map<SetupMark, Promise<void>>>();
function postSetupMark(qc: QueryClient, mark: SetupMark): Promise<void> {
  let running = marksInFlight.get(qc);
  if (!running) {
    running = new Map();
    marksInFlight.set(qc, running);
  }
  const pending = running.get(mark);
  if (pending) return pending;
  const inFlight = running;
  const request = (async () => {
    try {
      await api.post(mark);
      await qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
    } finally {
      inFlight.delete(mark);
    }
  })();
  inFlight.set(mark, request);
  return request;
}

/**
 * Bestaetigt den Schritt "abwesenheit" fuer die ganze Installation
 * (`setup_confirmations`), nicht nur fuer dieses Geraet.
 */
export function postAbsenceConfirmed(qc: QueryClient): Promise<void> {
  return postSetupMark(qc, '/api/setup/absence-confirmed');
}

/** Darf dieses Konto die Bestaetigung jetzt schreiben? Recht des Schritts, keine Nur-Lese-Lizenz. */
export function mayConfirmAbsence(
  can: ReturnType<typeof useAuth>['can'],
  license: ReturnType<typeof useAuth>['license'],
): boolean {
  return can('abwesenheit', 'bearbeiten') && license?.read_only !== true;
}

/**
 * Traegt einen Merker nach, solange `owed` gilt. Erneut versucht wird mit jedem
 * Abruf des Status (`statusUpdatedAt`; die Daten selbst behalten bei gleichem
 * Inhalt ihre Identitaet). Ohne Toast, niemand hat es angestossen. Ein 403
 * (etwa Rechte auf einem anderen Arbeitsplatz entzogen, bevor dieser Client es
 * weiss) beendet die Versuche fuer Installation und Konto (`key`) in dieser
 * Sitzung, statt bei jedem Abruf erneut zu scheitern.
 */
function useOwedSetupMark(mark: SetupMark, owed: boolean, key: string | null, statusUpdatedAt: number): void {
  const qc = useQueryClient();
  const refusedFor = useRef<string | null>(null);
  const due = owed && key !== null && refusedFor.current !== key;
  useEffect(() => {
    if (!due) return;
    postSetupMark(qc, mark).catch((err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 403) refusedFor.current = key;
    });
  }, [due, key, statusUpdatedAt, mark, qc]);
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
 * mitbringt und was die Lizenz freigibt (visibleSetupStepKeys in shared, dieselbe
 * Funktion prueft das Backend vor einer Uebernahme). Dieselbe Regel wie die
 * Seitenleiste (layout/AppShell.tsx), damit der Assistent nie auf eine Seite
 * zeigt, die der Person verschlossen bleibt. Die eigentliche Sperre sitzt im Backend.
 */
export function useSetup(): SetupView {
  const { user, can, features, license } = useAuth();
  const local = useSetupState();
  const qc = useQueryClient();
  const location = useLocation();

  const userId = user?.id ?? null;

  const visibleKeys = useMemo(
    () => visibleSetupStepKeys((area) => can(area, 'bearbeiten'), VARIANT, features),
    [can, features],
  );

  const eligible = user?.role === 'admin' && visibleKeys.length > 0;
  // Der Status wird fuer jedes Admin-Konto geholt: Er liefert auch die Kennung
  // der Installation, an die sich der Stand der Seiten-Einfuehrungen haengt.
  const { data: status, dataUpdatedAt: statusUpdatedAt } = useSetupStatus(user?.role === 'admin');

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

  const markKey = local.bound && instance !== null && userId !== null ? `${instance}.${userId}` : null;

  // Nachtrag: Der Schritt schreibt die Bestaetigung selbst (postAbsenceConfirmed).
  // Kennt nur dieses Geraet sie (Bestaetigung aus der Zeit vor dem Serverfeld,
  // oder das Schreiben im Schritt scheiterte), traegt es sie hier nach, damit
  // kein weiterer Arbeitsplatz fragt. Bis dahin zaehlt sie lokal. Im
  // Nur-Lese-Betrieb nicht: Der Server lehnte jeden Schreibzugriff ab.
  useOwedSetupMark(
    '/api/setup/absence-confirmed',
    local.absenceConfirmed && mayConfirmAbsence(can, license) && status?.absence_confirmed === false,
    markKey,
    statusUpdatedAt,
  );

  // Uebernahme melden (setupClaimOwed in shared): Wer den Assistenten
  // kennengelernt hat, uebernimmt die Einrichtung, solange sie frei ist; danach
  // bieten Karte und Willkommen sie keinem anderen Konto an. Ein Weg fuer alle
  // Ausloeser, auch fuer Merker aus der Zeit, als nur das Geraet sie kannte. Den
  // Nur-Lese-Betrieb prueft der Server schon in `assistant_claimable`.
  useOwedSetupMark(
    '/api/setup/started',
    eligible && status !== undefined && setupClaimOwed(status, local),
    markKey,
    statusUpdatedAt,
  );

  // Die Route aendert sich staendig, der Stand auch: Wer eine Abteilung auf der
  // normalen Seite anlegt, soll sie im Assistenten sofort erledigt sehen. Die
  // Abfrage besteht nur aus Zaehlungen, laeuft aber nur, solange der Assistent oder
  // seine Karte etwas anzeigen koennen (setupStatusWatched in shared).
  const watching = eligible && setupStatusWatched(progress, local);
  useEffect(() => {
    if (watching) qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
  }, [location.pathname, watching, qc]);

  return { eligible, status, progress, visibleKeys };
}
