import { sessionEndWarningText } from '@ohrganize/shared';
import { useAuth } from '../auth/AuthContext';
import { LOCALE } from '../lib/locale';

/**
 * Vorwarnung vor dem Ende der Sitzung (Höchstdauer, OHRGANIZE_SESSION_MAX):
 * zehn Minuten vorher einmal in der Shell über dem Seiteninhalt, damit
 * niemand mitten in einem Antrag auf der Anmeldeseite landet. Zeitpunkt und
 * Regel aus dem Auth-Kontext (packages/shared/src/session.ts).
 */
export function SessionEndNotice() {
  const { sessionEndsAt } = useAuth();
  if (sessionEndsAt === null) return null;
  const time = new Date(sessionEndsAt).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="portal-notice">
      <p className="pt-alert pt-alert--info" role="status">
        {sessionEndWarningText(time)}
      </p>
    </div>
  );
}
