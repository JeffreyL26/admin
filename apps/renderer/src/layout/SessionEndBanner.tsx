import React from 'react';
import { Clock } from 'lucide-react';
import { sessionEndWarningText } from '@ohrganize/shared';
import { useAuth } from '../auth/AuthContext';
import { LOCALE } from '../lib/locale';

/**
 * Vorwarnung vor dem Ende der Sitzung (Höchstdauer, OHRGANIZE_DESKTOP_SESSION_MAX):
 * zehn Minuten vorher über dem Seiteninhalt, damit niemand mitten in einer
 * Eingabe auf der Anmeldeseite landet. Zeitpunkt und Regel aus dem
 * Auth-Kontext (packages/shared/src/session.ts).
 */
export function SessionEndBanner() {
  const { sessionEndsAt } = useAuth();
  if (sessionEndsAt === null) return null;
  const time = new Date(sessionEndsAt).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="hm-banner-stack" role="status">
      <div className="hm-banner hm-banner--warning">
        <Clock size={16} />
        <div className="hm-banner__body">{sessionEndWarningText(time)}</div>
      </div>
    </div>
  );
}
