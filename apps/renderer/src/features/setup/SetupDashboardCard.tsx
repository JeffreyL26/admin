import React from 'react';
import { X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { t } from './copy';
import { stepText } from './stepMeta';
import { setupActions, useSetupState } from './store';
import { useSetupContext } from './SetupProvider';

/**
 * Hinweiskarte auf dem Dashboard, solange Schritte offen sind. Wie die
 * persoenlichen Hinweise (PersonalNotices) bewusst keine Widget-Kachel: Sie
 * erscheint nur mit Inhalt und verschwindet mit dem letzten Schritt. Wer den
 * Assistenten schon im Launcher fuehrt, braucht die Karte nicht doppelt.
 */
export function SetupDashboardCard() {
  const { eligible, status, progress } = useSetupContext();
  const s = useSetupState();
  if (!eligible || !status || !s.bound || progress.total === 0 || progress.complete) return null;
  if (s.cardDismissed || s.open || s.welcomed) return null;
  const next = progress.next;
  if (!next) return null;
  const pct = Math.round((progress.doneCount / progress.total) * 100);

  return (
    <div className="hm-setup-card">
      <div className="hm-setup-card__main">
        <div className="hm-setup-card__row">
          <strong>{t('card.title')}</strong>
          <span>{pct} %</span>
        </div>
        <div className="hm-setup__bar-track">
          <div className="hm-setup__bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <p>
          {t('card.next', {
            next: stepText(next, 'label'),
            minutes: progress.steps.find((x) => x.def.key === next)?.def.minutes ?? 1,
          })}
        </p>
      </div>
      <button type="button" className="hm-btn hm-btn--primary" onClick={() => setupActions.openAt(next)}>
        {t('card.cta')}
      </button>
      <Tooltip content={<div className="hm-tooltip__title">{t('card.dismiss')}</div>}>
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--icon hm-btn--sm"
          aria-label={t('card.dismiss.aria')}
          onClick={setupActions.dismissCard}
        >
          <X size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
