import React from 'react';
import { Minus } from 'lucide-react';
import { nextOpenAfter, type SetupStepKey } from '@ohrganize/shared';
import { Tooltip } from '../../components/Tooltip';
import { t } from './copy';
import { stepText } from './stepMeta';
import { setupActions } from './store';
import { useSetupContext } from './SetupProvider';

export interface StepCta {
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}

/**
 * Gemeinsamer Rahmen jedes Schritts: Zeile "Schritt n von N", Titel,
 * "Warum jetzt"-Kasten, der eigentliche Inhalt, Fusszeile mit Ort, Ueberspringen
 * und Hauptaktion. Die Schritte liefern nur Inhalt und Hauptaktion.
 */
export function StepShell({
  stepKey,
  cta,
  children,
}: {
  stepKey: SetupStepKey;
  cta: StepCta;
  children: React.ReactNode;
}) {
  const { progress } = useSetupContext();
  const me = progress.steps.find((s) => s.def.key === stepKey);
  const next = nextOpenAfter(progress, stepKey);

  return (
    <div className="hm-setup__step">
      <div className="hm-setup__stepline">
        <span>
          {me ? t('frame.stepLine', { n: me.n, total: progress.total, minutes: me.def.minutes }) : ''}
        </span>
        <Tooltip content={<div className="hm-tooltip__title">{t('frame.minimize.aria')}</div>}>
          <button
            type="button"
            className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
            aria-label={t('frame.minimize.aria')}
            onClick={setupActions.minimize}
          >
            <Minus size={16} />
          </button>
        </Tooltip>
      </div>
      <h2 className="hm-setup__title" id="hm-setup-title" tabIndex={-1} data-setup-focus>
        {stepText(stepKey, 'title')}
      </h2>
      <div className="hm-setup__why">
        <strong>{t('frame.why.label')}</strong>
        <span>{stepText(stepKey, 'why')}</span>
      </div>

      <div className="hm-setup__body">{children}</div>

      <div className="hm-setup__foot">
        <div className="hm-setup__where">
          <span>{t('frame.where.label')}</span>
          <strong>{stepText(stepKey, 'where')}</strong>
        </div>
        <button type="button" className="hm-btn hm-btn--ghost" onClick={() => setupActions.skip(stepKey, next)}>
          {t('frame.skip')}
        </button>
        <button
          type="button"
          className="hm-btn hm-btn--primary"
          disabled={cta.disabled || cta.busy}
          onClick={cta.onClick}
        >
          {cta.label}
        </button>
      </div>
    </div>
  );
}
