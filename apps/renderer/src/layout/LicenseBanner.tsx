import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info, Lock } from 'lucide-react';
import { formatDate, type LicenseStatus } from '@ohrganize/shared';
import { useAuth } from '../auth/AuthContext';
import { addDaysIso, expiredLead, LICENSE_PATH, remainingLabel } from '../features/settings/license';

/**
 * Lizenz-Banner oberhalb des Seiteninhalts (AppShell, erstes Kind von `.main`,
 * scrollt nicht mit). Liest den Zustand aus dem Auth-Kontext — keine eigene
 * Abfrage; Login, /api/auth/me und `refreshLicense` halten ihn aktuell.
 *
 * Stufen (packages/shared/src/license.ts):
 *   entwicklung / valid ohne warning  → nichts
 *   trial                             → schmale Info-Leiste (gelb kurz vor Ende)
 *   valid mit warning                 → gelb, Ablauf naht
 *   grace                             → rot, Kulanz läuft, volle Funktion
 *   expired                           → rot, Nur-Lese-Betrieb
 * Dazu, unabhängig davon, die Uhrenwarnung (gelb). Nichts davon ist
 * wegklickbar: Das Banner ist die einzige Stelle, an der die Administration
 * vom Ablauf erfährt — der Server hat keinen Rückkanal zum Anbieter.
 */

type Tone = 'info' | 'warning' | 'danger';

interface Notice {
  tone: Tone;
  slim?: boolean;
  /** Satz vor dem Verweis auf die Lizenzseite. */
  text: string;
  /** Wort vor dem Link „Einstellungen → Lizenz“ (endet mit „unter“). */
  lead: string;
}

function describe(l: LicenseStatus): Notice | null {
  switch (l.state) {
    case 'trial':
      return {
        tone: l.warning ? 'warning' : 'info',
        slim: !l.warning,
        text: `Testphase: ${remainingLabel(l.days_left)} (bis ${formatDate(l.valid_until)}).`,
        lead: 'Lizenz einspielen unter',
      };
    case 'valid':
      if (!l.warning) return null;
      return {
        tone: 'warning',
        text: `Die oHRganize-Lizenz läuft am ${formatDate(l.valid_until)} ab (${remainingLabel(l.days_left)}).`,
        lead: 'Verlängerung unter',
      };
    case 'grace': {
      // Letzter Kulanztag + 1 = erster Tag im Nur-Lese-Betrieb.
      const readOnlyFrom = l.grace_until ? formatDate(addDaysIso(l.grace_until, 1)) : '—';
      return {
        tone: 'danger',
        text:
          `Die Lizenz ist am ${formatDate(l.valid_until)} abgelaufen. ` +
          `Ab ${readOnlyFrom} läuft oHRganize im Nur-Lese-Betrieb.`,
        lead: 'Lizenz einspielen unter',
      };
    }
    case 'expired':
      // Die Ursache (Testphase, Lizenz, unbrauchbare oder fehlende Datei)
      // entscheidet, was die Administration tun muss — deshalb hier benannt.
      return {
        tone: 'danger',
        text:
          `Nur-Lese-Betrieb: ${expiredLead(l)} Daten können eingesehen und exportiert werden, ` +
          'Änderungen sind nicht möglich.',
        lead: 'Lizenz einspielen unter',
      };
    default:
      return null;
  }
}

const ICONS: Record<Tone, React.ReactNode> = {
  info: <Info size={16} />,
  warning: <AlertTriangle size={16} />,
  danger: <Lock size={16} />,
};

export function LicenseBanner() {
  const { license, can } = useAuth();
  if (!license) return null;
  const notice = describe(license);
  if (!notice && !license.clock_warning) return null;

  // Ohne Leserecht auf `einstellungen` führte der Link nur auf eine Seite
  // voller 403 — dann bleibt der Verweis Text.
  const target = can('einstellungen') ? (
    <Link to={LICENSE_PATH} className="hm-banner__link">
      Einstellungen → Lizenz
    </Link>
  ) : (
    <b>Einstellungen → Lizenz</b>
  );

  return (
    <div className="hm-banner-stack" role="status">
      {notice && (
        <div className={`hm-banner hm-banner--${notice.tone}${notice.slim ? ' hm-banner--slim' : ''}`}>
          {ICONS[notice.tone]}
          <div className="hm-banner__body">
            {notice.text} {notice.lead} {target}.
          </div>
        </div>
      )}
      {license.clock_warning && (
        <div className="hm-banner hm-banner--warning">
          {ICONS.warning}
          <div className="hm-banner__body">
            Die Systemuhr des Servers steht vor einem bereits gesehenen Datum — bitte prüfen.
          </div>
        </div>
      )}
    </div>
  );
}
