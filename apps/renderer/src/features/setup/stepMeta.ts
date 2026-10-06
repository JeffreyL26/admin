import type { SetupStepKey } from '@ohrganize/shared';
import { REGION_TERM } from '../../lib/locale';
import { t, type CopyKey } from './copy';

/** Schritt-Schluessel zur Nummer in den Textschluesseln (`step3.title`). */
export const STEP_NO: Record<SetupStepKey, number> = {
  firma: 1,
  abteilungen: 2,
  mitarbeitende: 3,
  vorgesetzte: 4,
  abwesenheit: 5,
  adminkonto: 6,
  portal: 7,
};

/** Text eines Schritts: `stepText('portal', 'title')` liest `step7.title`. */
export function stepText(key: SetupStepKey, field: string, vars?: Record<string, string | number>): string {
  // regionTerm (Bundesland, Kanton) gilt fuer jeden Text, damit kein Aufrufer ihn vergisst.
  return t(`step${STEP_NO[key]}.${field}` as CopyKey, { regionTerm: REGION_TERM, ...vars });
}

/** Nutzwerte, die ein Schritt beim Speichern fuer den Erfolgsmoment mitgibt. */
export type StepVars = Record<string, string | number>;

export interface Celebration {
  milestone: string;
  win: string;
  result: string;
  unlock: string;
}

/** Texte des Erfolgsmoments. Ein/Mehrzahl-Varianten haengen an `count`. */
export function celebrationFor(key: SetupStepKey, vars: StepVars): Celebration {
  const count = Number(vars.count ?? 0);
  const many = count > 1;
  switch (key) {
    case 'abteilungen':
      return {
        milestone: stepText(key, 'milestone'),
        win: stepText(key, 'win'),
        result: stepText(key, many ? 'result.many' : 'result.one', vars),
        unlock: stepText(key, 'unlock'),
      };
    case 'mitarbeitende':
      return {
        milestone: stepText(key, 'milestone'),
        win: stepText(key, many ? 'win.many' : 'win.one'),
        result: stepText(key, many ? 'result.many' : 'result.one', vars),
        unlock: stepText(key, 'unlock'),
      };
    case 'adminkonto':
      return {
        milestone: stepText(key, 'milestone'),
        win: stepText(key, 'win'),
        result: stepText(key, many ? 'result.many' : 'result', vars),
        unlock: stepText(key, 'unlock'),
      };
    case 'portal':
      return {
        milestone: stepText(key, 'milestone'),
        win: stepText(key, 'win'),
        result: stepText(key, many ? 'result.many' : 'result', vars),
        unlock: stepText(key, 'unlock'),
      };
    default:
      return {
        milestone: stepText(key, 'milestone'),
        win: stepText(key, 'win'),
        result: stepText(key, 'result', vars),
        unlock: stepText(key, 'unlock'),
      };
  }
}
