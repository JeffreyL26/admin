/**
 * Lizenztexte, an einer Stelle fuer alle Oberflaechen.
 *
 * `describeLicense` macht aus dem Lizenzzustand (LicenseStatus) eine
 * Ueberschrift, einen Detailsatz, eine Tonlage und den Handlungssatz. Desktop-
 * App (Banner, Lizenzseite, Dashboard-Widget), Backend (Fehlermeldung im
 * Nur-Lese-Betrieb, Startlog) und Portal lesen ausschliesslich hieraus; so
 * kann keine Stelle eine eigene, abweichende Diagnose stellen.
 *
 * Die Texte folgen den strukturierten Feldern der Lizenz: Eine unbefristete
 * Lizenz heisst "Ihre Lizenz laeuft unbegrenzt.", mit Abrechnungsart
 * kostenfrei "Ihre Lizenz laeuft unbegrenzt und kostenfrei.", eine Testlizenz
 * "Testlizenz bis TT.MM.JJJJ, noch N Tage.". Der Anbieter kann in der
 * signierten Datei eine eigene Ueberschrift mitgeben (`headline`); sie
 * ersetzt die erzeugte Ueberschrift nur im Zustand `valid`, der erzeugte
 * Satz rueckt dann in `detail`. In Kulanz und Nur-Lese bleibt die erzeugte
 * Ueberschrift, damit die Warnung nicht von einem freundlichen Satz verdeckt
 * wird.
 *
 * Kein Gedankenstrich in diesen Texten (Vorgabe des Anbieters).
 */
import { formatDate, addDaysIso } from './common.js';
import {
  isPerpetualLicense,
  type LicenseKind,
  type LicenseState,
  type LicenseStatus,
} from './license.js';

/** Tonlage fuer Banner und Badges: neutral = kein Banner. */
export type LicenseTone = 'neutral' | 'info' | 'warning' | 'danger';

export interface LicenseDescription {
  headline: string;
  /** Kann leer sein. */
  detail: string;
  tone: LicenseTone;
  /** Handlungssatz fuer Meldungen; die Clients setzen ihn hinter detail. */
  action: string;
}

/** Vertragsbedingungen, wie sie ab Lizenz v2 in der Datei stehen koennen. */
export interface LicenseTermsLike {
  billing: 'kostenfrei' | 'abo' | 'kauf' | 'individuell';
  interval?: 'monatlich' | 'jaehrlich' | null;
  label?: string | null;
}

/**
 * Was `describeLicense` mindestens braucht. LicenseStatus erfuellt es; das
 * Backend kann auch aus seinem internen Kern beschreiben, ohne Plaetze zu
 * zaehlen. `terms` und `headline` sind ab Lizenz v2 belegt.
 */
export interface LicenseDescribable {
  state: LicenseState;
  warning: boolean;
  days_left: number | null;
  valid_until: string | null;
  grace_until: string | null;
  perpetual?: boolean;
  license_id: string | null;
  kind: LicenseKind | null;
  invalid_reason: string | null;
  terms?: LicenseTermsLike | null;
  headline?: string | null;
}

/** Der Satz, der der Administration sagt, was zu tun ist. Der Pfeil ist kein Gedankenstrich. */
export const LICENSE_ACTION_TEXT =
  'Bitte spielen Sie unter Einstellungen → Lizenz eine gültige Lizenzdatei ein.';

/** Nur-Lese-Betrieb in einem Satz (Detail bei expired). */
export const LICENSE_READ_ONLY_DETAIL =
  'Nur-Lese-Betrieb: Daten können eingesehen und exportiert werden, Änderungen sind nicht möglich.';

/** Neutraler Text fuer Portal-Konten: Vertragsdaten gehen Mitarbeitende nichts an. */
export const PORTAL_READ_ONLY_TEXT =
  'Das Portal ist derzeit nur zur Ansicht verfügbar. Anträge und Änderungen sind ' +
  'vorübergehend nicht möglich. Bitte wenden Sie sich an die Personalabteilung.';

/** Uhren-Stolperdraht, Banner und Lizenzseite. */
export const LICENSE_CLOCK_WARNING_TEXT =
  'Die Systemuhr des Servers steht vor einem bereits gesehenen Datum. Bitte prüfen.';

/** Anzeigename je Abrechnungsart (Lizenz v2). */
export const LICENSE_BILLING_LABELS: Record<LicenseTermsLike['billing'], string> = {
  kostenfrei: 'kostenfrei',
  abo: 'Abonnement',
  kauf: 'Kauflizenz',
  individuell: 'individuelle Vereinbarung',
};

/** Anzeigename je Abrechnungsintervall (Lizenz v2). */
export const LICENSE_INTERVAL_LABELS: Record<NonNullable<LicenseTermsLike['interval']>, string> = {
  monatlich: 'monatliche Verlängerung',
  jaehrlich: 'jährliche Verlängerung',
};

/**
 * "noch 14 Tage" / "noch 1 Tag" / "heute letzter Tag". `days_left` zaehlt
 * volle Tage NACH heute (`valid_until` einschliesslich); 0 heisst: heute ist
 * der letzte Tag mit voller Funktion, nicht "schon vorbei". null ergibt den
 * Leerwert.
 */
export function remainingLabel(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'heute letzter Tag';
  return days === 1 ? 'noch 1 Tag' : `noch ${days} Tage`;
}

/** `remainingLabel` am Satzanfang ("Noch 3 Tage ...", "Heute letzter Tag ..."). */
export function remainingLabelSentence(days: number | null): string {
  const label = remainingLabel(days);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "31.12.2027" oder "unbefristet" (valid_until = LICENSE_MAX_DATE). */
export function validUntilLabel(license: Pick<LicenseStatus, 'valid_until'>): string {
  return isPerpetualLicense(license.valid_until) ? 'unbefristet' : formatDate(license.valid_until);
}

/** Plaetze: "12 von 25" oder "unbegrenzt" (max_users = null). */
export function seatsLabel(license: Pick<LicenseStatus, 'max_users' | 'seats_used'>): string {
  return license.max_users === null ? 'unbegrenzt' : `${license.seats_used} von ${license.max_users}`;
}

/** Vertragsbedingungen als kurzer Satz: "Abonnement, jährliche Verlängerung." oder das Label. */
export function termsLabel(terms: LicenseTermsLike | null | undefined): string {
  if (!terms) return '';
  if (terms.label) return terms.label.endsWith('.') ? terms.label : `${terms.label}.`;
  const parts = [LICENSE_BILLING_LABELS[terms.billing]];
  if (terms.interval) parts.push(LICENSE_INTERVAL_LABELS[terms.interval]);
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * Ursache des Nur-Lese-Betriebs (state = expired). Reihenfolge: eine
 * unbrauchbare Datei vor allem anderen (sie kann mit einer abgelaufenen
 * Testphase zusammenfallen), dann echte Lizenz (license_id gesetzt), dann
 * Testphase (nur valid_until), sonst gar keine Lizenz (Datei fehlt nach
 * einer Wiederherstellung).
 */
export function expiredLead(l: LicenseDescribable): string {
  if (l.invalid_reason !== null) return 'Die Lizenzdatei ist unbrauchbar.';
  if (l.license_id !== null) {
    return (
      `Ihre Lizenz ist am ${formatDate(l.valid_until)} abgelaufen` +
      (l.grace_until ? `; die Kulanzfrist endete am ${formatDate(l.grace_until)}.` : '.')
    );
  }
  if (l.valid_until !== null) return `Die Testphase ist am ${formatDate(l.valid_until)} abgelaufen.`;
  return 'Es liegt keine gültige Lizenz vor.';
}

function isPerpetual(l: LicenseDescribable): boolean {
  return l.perpetual === true || isPerpetualLicense(l.valid_until);
}

/** Erzeugte Beschreibung ohne Anbieter-Ueberschrift. */
function describeGenerated(l: LicenseDescribable): LicenseDescription {
  const action = LICENSE_ACTION_TEXT;
  switch (l.state) {
    case 'entwicklung':
      return { headline: 'Entwicklungsverzeichnis, keine Lizenzprüfung.', detail: '', tone: 'neutral', action };

    case 'trial':
      return {
        headline: `Testphase bis ${formatDate(l.valid_until)}, ${remainingLabel(l.days_left)}.`,
        detail: 'Ohne Lizenzdatei läuft oHRganize danach im Nur-Lese-Betrieb.',
        tone: l.warning ? 'warning' : 'info',
        action,
      };

    case 'valid': {
      if (l.kind === 'evaluation') {
        if (isPerpetual(l)) {
          return { headline: 'Ihre Testlizenz läuft unbegrenzt.', detail: termsLabel(l.terms), tone: 'neutral', action };
        }
        return {
          headline: `Testlizenz bis ${formatDate(l.valid_until)}, ${remainingLabel(l.days_left)}.`,
          detail: 'Danach Nur-Lese-Betrieb.',
          tone: l.warning ? 'warning' : 'info',
          action,
        };
      }
      if (isPerpetual(l)) {
        const free = l.terms?.billing === 'kostenfrei';
        return {
          headline: free ? 'Ihre Lizenz läuft unbegrenzt und kostenfrei.' : 'Ihre Lizenz läuft unbegrenzt.',
          detail: free && !l.terms?.label ? '' : termsLabel(l.terms),
          tone: 'neutral',
          action,
        };
      }
      if (l.warning) {
        return {
          headline: `Ihre Lizenz läuft am ${formatDate(l.valid_until)} ab (${remainingLabel(l.days_left)}).`,
          detail: 'Bitte rechtzeitig verlängern.',
          tone: 'warning',
          action,
        };
      }
      return {
        headline: `Ihre Lizenz gilt bis ${formatDate(l.valid_until)} (${remainingLabel(l.days_left)}).`,
        detail: termsLabel(l.terms),
        tone: 'neutral',
        action,
      };
    }

    case 'grace': {
      // Letzter Kulanztag plus 1 = erster Tag im Nur-Lese-Betrieb.
      const readOnlyFrom = l.grace_until ? formatDate(addDaysIso(l.grace_until, 1)) : '—';
      return {
        headline: `Ihre Lizenz ist am ${formatDate(l.valid_until)} abgelaufen.`,
        detail:
          `Kulanz bis ${formatDate(l.grace_until)}, ab ${readOnlyFrom} Nur-Lese-Betrieb ` +
          `(${remainingLabel(l.days_left)}).`,
        tone: 'danger',
        action,
      };
    }

    case 'expired':
      return {
        headline: expiredLead(l),
        detail: l.invalid_reason !== null ? `${l.invalid_reason} ${LICENSE_READ_ONLY_DETAIL}` : LICENSE_READ_ONLY_DETAIL,
        tone: 'danger',
        action,
      };
  }
}

/**
 * Ueberschrift, Detail, Tonlage und Handlungssatz zum Lizenzzustand. Reine
 * Funktion; alle Oberflaechen und das Backend nutzen genau diese.
 */
export function describeLicense(l: LicenseDescribable): LicenseDescription {
  const generated = describeGenerated(l);
  const custom = l.headline?.trim();
  if (custom && l.state === 'valid') {
    return {
      ...generated,
      headline: custom,
      detail: [generated.headline, generated.detail].filter(Boolean).join(' '),
    };
  }
  return generated;
}

/** Vollstaendige Meldung fuer Fehlerantworten und Logs: Ueberschrift, Detail, Handlung. */
export function licenseMessage(l: LicenseDescribable): string {
  const d = describeLicense(l);
  return [d.headline, d.detail, d.action].filter(Boolean).join(' ');
}
