import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info, Lock } from 'lucide-react';
import { LICENSE_CLOCK_WARNING_TEXT, describeLicense, type LicenseStatus } from '@ohrganize/shared';
import { useAuth } from '../auth/AuthContext';
import { LICENSE_PATH } from '../features/settings/license';

/**
 * Lizenz-Banner oberhalb des Seiteninhalts (AppShell, erstes Kind von `.main`,
 * scrollt nicht mit). Liest den Zustand aus dem Auth-Kontext, keine eigene
 * Abfrage; Login, /api/auth/me und `refreshLicense` halten ihn aktuell.
 *
 * Text und Tonlage kommen aus describeLicense (packages/shared):
 *   neutral  (entwicklung, gueltig ohne Warnung, unbefristet)  kein Banner
 *   info     (Testphase, Testlizenz)                            schmale Leiste
 *   warning  (Ablauf naht, Testphase kurz vor Ende)             gelb
 *   danger   (Kulanz, Nur-Lese-Betrieb)                         rot
 * Dazu, unabhaengig davon, die Uhrenwarnung (gelb). Nichts davon ist
 * wegklickbar: Das Banner ist die einzige Stelle, an der die Administration
 * vom Ablauf erfaehrt; der Server hat keinen Rueckkanal zum Anbieter.
 */

type Tone = 'info' | 'warning' | 'danger';

interface Notice {
  tone: Tone;
  slim?: boolean;
  /** Saetze vor dem Verweis auf die Lizenzseite. */
  text: string;
  /** Wort vor dem Link "Einstellungen → Lizenz" (endet mit "unter"). */
  lead: string;
}

function describe(l: LicenseStatus): Notice | null {
  const d = describeLicense(l);
  if (d.tone === 'neutral') return null;
  return {
    tone: d.tone,
    slim: d.tone === 'info',
    text: [d.headline, d.detail].filter(Boolean).join(' '),
    lead: l.state === 'valid' && l.kind !== 'evaluation' ? 'Verlängerung unter' : 'Lizenz einspielen unter',
  };
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
            {LICENSE_CLOCK_WARNING_TEXT}
          </div>
        </div>
      )}
    </div>
  );
}
