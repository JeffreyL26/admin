import { useAuth } from '../auth/AuthContext';
import { PORTAL_READ_ONLY_NOTICE, READ_ONLY_NOTICE_ID } from '../lib/license';

/**
 * Globaler Hinweis auf den Nur-Lese-Betrieb, einmal in der Shell über dem
 * Seiteninhalt. Neutraler Info-Ton, nicht schließbar: Er beschreibt einen
 * Zustand, den die Mitarbeitenden nicht ändern können, und keinen Fehler.
 * Solange Änderungen möglich sind, rendert er nichts — Testphase, Warnfrist
 * und Kulanz erreichen das Portal gar nicht erst.
 */
export function ReadOnlyNotice() {
  const { readOnly } = useAuth();
  if (!readOnly) return null;
  return (
    <div className="portal-notice">
      <p id={READ_ONLY_NOTICE_ID} className="pt-alert pt-alert--info" role="status">
        {PORTAL_READ_ONLY_NOTICE}
      </p>
    </div>
  );
}
