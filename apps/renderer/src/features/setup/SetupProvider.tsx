import React, { createContext, useContext, useEffect } from 'react';
import { isFreshInstallation } from '@ohrganize/shared';
import { setupActions, useSetupState } from './store';
import { useSetup, type SetupView } from './useSetup';

const SetupContext = createContext<SetupView | null>(null);

export function useSetupContext(): SetupView {
  const v = useContext(SetupContext);
  if (!v) throw new Error('useSetupContext ausserhalb von SetupProvider');
  return v;
}

/**
 * Haelt Status und Fortschritt des Einrichtungs-Assistenten fuer die ganze
 * Shell (Dialog, Launcher, Seitenleiste, Dashboard-Karte). Oeffnet den
 * Willkommensdialog genau einmal, und nur, wenn die Installation noch leer ist.
 */
export function SetupProvider({ children }: { children: React.ReactNode }) {
  const view = useSetup();
  const local = useSetupState();
  const { eligible, status } = view;

  useEffect(() => {
    // `bound`: erst, wenn der Stand dieser Installation und dieses Kontos geladen ist.
    if (eligible && status && local.bound && !local.welcomed && isFreshInstallation(status)) {
      setupActions.showWelcome();
    }
  }, [eligible, status, local.bound, local.welcomed]);

  return <SetupContext.Provider value={view}>{children}</SetupContext.Provider>;
}

/** Eintrag der Seitenleiste, der gerade hervorgehoben wird (oder null). */
export function useSpotlightPath(): string | null {
  const { progress } = useSetupContext();
  const local = useSetupState();
  if (!local.open || local.view !== 'step' || !local.current) return null;
  return progress.steps.find((s) => s.def.key === local.current)?.def.navPath ?? null;
}
