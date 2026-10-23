import { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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

/**
 * Bestaetigt den Schritt "abwesenheit" fuer die ganze Installation
 * (`setup_confirmations`), nicht nur fuer dieses Geraet, und laedt den Status neu.
 * Eine laufende Anfrage wird je QueryClient geteilt: Der Schritt und der
 * Nachtrag in useSetup loesen sonst im selben Moment beide aus.
 */
const confirmInFlight = new WeakMap<QueryClient, Promise<void>>();
export function postAbsenceConfirmed(qc: QueryClient): Promise<void> {
  const running = confirmInFlight.get(qc);
  if (running) return running;
  const request = (async () => {
    try {
      await api.post('/api/setup/absence-confirmed');
      await qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
    } finally {
      confirmInFlight.delete(qc);
    }
  })();
  confirmInFlight.set(qc, request);
  return request;
}

/**
 * Meldet dem Server, dass ein Konto die Einrichtung uebernommen hat
 * (`assistant_started`). Danach bieten Dashboard-Karte und Willkommen sie
 * keinem weiteren Konto an, auf keinem Arbeitsplatz. Geteilt wie oben.
 */
const startedInFlight = new WeakMap<QueryClient, Promise<void>>();
function postAssistantStarted(qc: QueryClient): Promise<void> {
  const running = startedInFlight.get(qc);
  if (running) return running;
  const request = (async () => {
    try {
      await api.post('/api/setup/started');
      await qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
    } finally {
      startedInFlight.delete(qc);
    }
  })();
  startedInFlight.set(qc, request);
  return request;
}

/** Darf dieses Konto die Bestaetigung jetzt schreiben? Recht des Schritts, keine Nur-Lese-Lizenz. */
export function mayConfirmAbsence(
  can: ReturnType<typeof useAuth>['can'],
  license: ReturnType<typeof useAuth>['license'],
): boolean {
  return can('abwesenheit', 'bearbeiten') && license?.read_only !== true;
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
  const { user, can, features, license } = useAuth();
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

  // Nachtrag: Der Schritt schreibt die Bestaetigung selbst (postAbsenceConfirmed).
  // Kennt nur dieses Geraet sie (Bestaetigung aus der Zeit vor dem Serverfeld,
  // oder das Schreiben im Schritt scheiterte), traegt es sie hier nach, damit
  // kein weiterer Arbeitsplatz fragt. Bis dahin zaehlt sie lokal. Erneut
  // versucht wird mit jedem Abruf des Status (`dataUpdatedAt`; die Daten selbst
  // behalten bei gleichem Inhalt ihre Identitaet). Im Nur-Lese-Betrieb nicht:
  // Der Server lehnte jeden Schreibzugriff ab. Ohne Toast, niemand hat es
  // angestossen. Ein 403 (etwa Rechte auf einem anderen Arbeitsplatz entzogen,
  // bevor dieser Client es weiss) beendet die Versuche fuer Installation und
  // Konto in dieser Sitzung, statt bei jedem Abruf erneut zu scheitern.
  const confirmKey = local.bound && instance !== null && userId !== null ? `${instance}.${userId}` : null;
  const refusedFor = useRef<string | null>(null);
  const owesConfirm =
    confirmKey !== null &&
    refusedFor.current !== confirmKey &&
    local.absenceConfirmed &&
    mayConfirmAbsence(can, license) &&
    status?.absence_confirmed === false;
  useEffect(() => {
    if (!owesConfirm) return;
    postAbsenceConfirmed(qc).catch((err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 403) refusedFor.current = confirmKey;
    });
  }, [owesConfirm, confirmKey, statusUpdatedAt, qc]);

  // Uebernahme melden: Wer den Willkommensdialog gesehen, den Assistenten
  // geoeffnet oder die Karte ausgeblendet hat (alles setzt einen lokalen
  // Merker), hat die Einrichtung uebernommen oder abgelehnt. Das gilt dann fuer
  // die Installation, sonst bekaeme jedes weitere Konto auf jedem Arbeitsplatz
  // die Karte erneut. Ein Effekt fuer alle Wege; er traegt auch Merker nach,
  // die nur das Geraet kennt (gesetzt vor diesem Serverfeld). Regeln fuer
  // Nur-Lese und 403 wie beim Nachtrag oben.
  const startedRefusedFor = useRef<string | null>(null);
  const owesStarted =
    confirmKey !== null &&
    eligible &&
    startedRefusedFor.current !== confirmKey &&
    (local.welcomed || local.cardDismissed) &&
    license?.read_only !== true &&
    status?.assistant_started === false;
  useEffect(() => {
    if (!owesStarted) return;
    postAssistantStarted(qc).catch((err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 403) startedRefusedFor.current = confirmKey;
    });
  }, [owesStarted, confirmKey, statusUpdatedAt, qc]);

  // Die Route aendert sich staendig, der Stand auch: Wer eine Abteilung auf der
  // normalen Seite anlegt, soll sie im Assistenten sofort erledigt sehen. Die
  // Abfrage besteht nur aus Zaehlungen, laeuft aber nur, solange der Assistent oder
  // seine Karte etwas anzeigen: nicht nach dem Abschluss, nicht nach dem
  // Ausblenden, die Karte auch nicht mehr, sobald ein Konto uebernommen hat.
  const watching =
    eligible &&
    !progress.complete &&
    (local.welcomed || (!local.cardDismissed && status?.assistant_started !== true));
  useEffect(() => {
    if (watching) qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
  }, [location.pathname, watching, qc]);

  return { eligible, status, progress, visibleKeys };
}
