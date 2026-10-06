import React, { useEffect } from 'react';
import { useToast } from '../../components/Toast';
import { openDocs } from '../../lib/docs';
import { t } from './copy';
import { SKIP_EVENT } from './skipEvent';

/** Text mit dem Wort "Dokumentation" als Link; derselbe Aufruf wie im Titelleisten-Menue. */
function SkipNotice() {
  const [before, after] = t('skip.notice', { docs: '\u0000' }).split('\u0000');
  return (
    <span>
      {before}
      <button type="button" className="hm-toast__link" onClick={openDocs}>
        {t('skip.docs')}
      </button>
      {after}
    </span>
  );
}

/**
 * Zeigt die gruene Meldung, sobald etwas uebersprungen wurde (Schritt des
 * Einrichtungs-Assistenten, Seiten-Einfuehrung). Eine Stelle fuer alle, damit
 * Text und Link nicht auseinanderlaufen.
 */
export function SkipNoticeBridge() {
  const toast = useToast();
  useEffect(() => {
    const on = () => toast.success(<SkipNotice />, { duration: 10000, green: true });
    window.addEventListener(SKIP_EVENT, on);
    return () => window.removeEventListener(SKIP_EVENT, on);
  }, [toast]);
  return null;
}
