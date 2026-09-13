/**
 * Anzeigehilfen für den Lizenzzustand — gemeinsam für das Banner
 * (layout/LicenseBanner.tsx), die Seite Einstellungen → Lizenz und das
 * Dashboard-Widget. Die Daten selbst kommen aus dem Auth-Kontext
 * (`license` in Login und /api/auth/me) bzw. GET /api/license; der Vertrag
 * steht in packages/shared/src/license.ts.
 */
import { formatDate, type LicenseKind, type LicenseState, type LicenseStatus } from '@ohrganize/shared';
import type { BadgeTone } from '../../components/ui';

/** Pfad der Lizenzseite (nav.ts, features/settings/routes.tsx). */
export const LICENSE_PATH = '/einstellungen/lizenz';

/** Query-Key für GET /api/license (Seite); das Banner liest den Auth-Kontext. */
export const LICENSE_QUERY_KEY = ['license'] as const;

/**
 * Obergrenze einer Lizenzdatei — wenige hundert Byte plus Platz für
 * Kopierfehler. Dieselbe Zahl wie das `max` des PUT /api/license
 * (core/licenseRoutes.ts); die Seite prüft sie VOR dem Einlesen, damit ein
 * versehentlich abgelegtes Backup-Archiv nicht erst komplett in den
 * Renderer-Speicher wandert.
 */
export { LICENSE_FILE_MAX_BYTES } from '@ohrganize/shared';

export const LICENSE_STATE_LABELS: Record<LicenseState, string> = {
  entwicklung: 'Entwicklung',
  valid: 'Gültig',
  trial: 'Testphase',
  grace: 'Kulanzfrist',
  expired: 'Abgelaufen',
};

export const LICENSE_KIND_LABELS: Record<LicenseKind, string> = {
  standard: 'Standard',
  evaluation: 'Auswertung',
};

/** Farbe des Zustands — gelb, sobald das Backend `warning` setzt. */
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

/**
 * „noch 14 Tage“ / „noch 1 Tag“ / „heute letzter Tag“ — `days_left` zählt
 * volle Tage NACH heute (`valid_until` einschließlich), 0 heißt also: heute
 * ist der letzte Tag mit voller Funktion, nicht „schon vorbei“.
 */
export function remainingLabel(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'heute letzter Tag';
  return days === 1 ? 'noch 1 Tag' : `noch ${days} Tage`;
}

/** `remainingLabel` am Satzanfang („Noch 3 Tage …“, „Heute letzter Tag …“). */
export function remainingLabelSentence(days: number | null): string {
  const label = remainingLabel(days);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Ursache des Nur-Lese-Betriebs (state = expired) — spiegelt
 * core/license.ts#readOnlyMessage, damit Banner und Fehlermeldung eines
 * abgewiesenen Schreibzugriffs dieselbe Diagnose stellen. Reihenfolge:
 * eine unbrauchbare Datei vor allem anderen (sie kann mit einer abgelaufenen
 * Testphase zusammenfallen), dann echte Lizenz (license_id gesetzt), dann
 * Testphase (nur valid_until), sonst gar keine Lizenz (Datei fehlt nach
 * einer Wiederherstellung).
 */
export function expiredLead(l: LicenseStatus): string {
  if (l.invalid_reason !== null) return 'Die Lizenzdatei ist unbrauchbar.';
  if (l.license_id !== null) {
    return (
      `Die Lizenz ist am ${formatDate(l.valid_until)} abgelaufen` +
      (l.grace_until ? `; die Kulanzfrist endete am ${formatDate(l.grace_until)}.` : '.')
    );
  }
  if (l.valid_until !== null) return `Die Testphase ist am ${formatDate(l.valid_until)} abgelaufen.`;
  return 'Es liegt keine gültige Lizenz vor.';
}

/** Plätze: „12 von 25“ oder „unbegrenzt“ (max_users = null). */
export function seatsLabel(license: LicenseStatus): string {
  return license.max_users === null ? 'unbegrenzt' : `${license.seats_used} von ${license.max_users}`;
}

/** ISO-Kalendertag ± Tage, ohne Zeitzoneneffekt (UTC-Mitternacht). */
export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
