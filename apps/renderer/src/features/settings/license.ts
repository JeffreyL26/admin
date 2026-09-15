/**
 * Anzeigehilfen fuer den Lizenzzustand, gemeinsam fuer das Banner
 * (layout/LicenseBanner.tsx), die Seite Einstellungen → Lizenz und das
 * Dashboard-Widget. Die Daten selbst kommen aus dem Auth-Kontext
 * (`license` in Login und /api/auth/me) bzw. GET /api/license.
 *
 * Alle Texte entstehen in packages/shared/src/licenseText.ts
 * (describeLicense); hier bleiben nur Pfad, Query-Key und die Badge-Farbe.
 * Die Re-Exporte halten bestehende Importe stabil.
 */
import type { LicenseStatus } from '@ohrganize/shared';
import type { BadgeTone } from '../../components/ui';

export {
  LICENSE_FILE_MAX_BYTES,
  LICENSE_KIND_LABELS,
  LICENSE_STATE_LABELS,
  addDaysIso,
  describeLicense,
  expiredLead,
  remainingLabel,
  remainingLabelSentence,
  seatsLabel,
  validUntilLabel,
} from '@ohrganize/shared';

/** Pfad der Lizenzseite (nav.ts, features/settings/routes.tsx). */
export const LICENSE_PATH = '/einstellungen/lizenz';

/** Query-Key fuer GET /api/license (Seite); das Banner liest den Auth-Kontext. */
export const LICENSE_QUERY_KEY = ['license'] as const;

/** Farbe des Zustands: gelb, sobald das Backend `warning` setzt. */
export function licenseStateTone(license: LicenseStatus): BadgeTone {
  switch (license.state) {
    case 'valid':
      return license.warning ? 'yellow' : 'green';
    case 'trial':
      return license.warning ? 'yellow' : 'blue';
    case 'grace':
    case 'expired':
      return 'red';
    default:
      return 'neutral';
  }
}
