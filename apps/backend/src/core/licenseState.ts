/**
 * Reiner Zustandsautomat der Lizenz: aus Kalendertag, Installationszeile und
 * geladener Datei wird der Lizenzkern. Keine Datenbank, keine Datei, keine
 * Uhr; die Seiteneffekte (licensed_at setzen, last_seen_date fortschreiben)
 * bleiben beim Aufrufer in core/license.ts. So laesst sich jede Zeile der
 * Textregeln tabellengetrieben pruefen (test/licenseStateTest.ts), und
 * Betreiberwerkzeuge koennen den Zustand einer Datenbank beschreiben, ohne
 * sie zu veraendern.
 */
import {
  COUNTRY_LABELS,
  LICENSE_TRIAL_DAYS,
  LICENSE_TRIAL_WARN_DAYS,
  addDaysIso,
  daysBetweenIso,
  formatDate,
  isPerpetualLicense,
  variantLabelFor,
  type CountryCode,
  type LicensePayload,
  type LicenseState,
} from '@ohrganize/shared';

/** Alles, was das Gate braucht, ohne die Platzzaehlung (die zahlt nur, wer sie sieht). */
export interface LicenseCore {
  state: LicenseState;
  read_only: boolean;
  warning: boolean;
  days_left: number | null;
  valid_until: string | null;
  grace_until: string | null;
  perpetual: boolean;
  issued_at: string | null;
  payload: LicensePayload | null;
  invalid_reason: string | null;
  clock_warning: boolean;
  installation_id: string;
  /** Nur zur Meldung: Testphase (true) oder Lizenz (false) abgelaufen. */
  trial: boolean;
}

export interface LicenseInstallationInput {
  installation_id: string;
  /** SQLite-Zeitstempel (UTC, "YYYY-MM-DD HH:MM:SS") der Anlage. */
  created_at: string;
  licensed_at: string | null;
}

export interface LoadedLicenseInput {
  exists: boolean;
  payload: LicensePayload | null;
  /** Deutsch, fuer die Administration; null wenn payload gesetzt oder keine Datei. */
  invalidReason: string | null;
}

/** Land und Edition des laufenden Builds (packages/shared/src/variants). */
export interface VariantIdentity {
  country: CountryCode;
  edition: string;
  label: string;
}

/**
 * v2-Dateien nennen Land und Edition; passt beides nicht zur Variante des
 * Servers, ist die Datei fuer diese Installation unbrauchbar (wie eine
 * Fremdbindung). v1-Dateien sind variantenneutral.
 */
export function variantMismatchReason(payload: LicensePayload, variant: VariantIdentity | null | undefined): string | null {
  if (!variant || payload.v < 2 || !payload.country || !payload.edition) return null;
  if (payload.country === variant.country && payload.edition === variant.edition) return null;
  const wanted = variantLabelFor(payload.country, payload.edition, COUNTRY_LABELS[payload.country]);
  return `Diese Lizenz gilt für die Ausgabe ${wanted}; installiert ist ${variant.label}.`;
}

export interface DeriveLicenseStateInput {
  /** Heutiger Kalendertag in lokaler Zeit (YYYY-MM-DD). */
  today: string;
  /** Variante des Builds; ohne Angabe keine Variantenpruefung (Werkzeuge, Tests). */
  variant?: VariantIdentity | null;
  /** false = Entwicklungsverzeichnis, keine Pruefung. */
  enforced: boolean;
  installation: LicenseInstallationInput;
  loaded: LoadedLicenseInput;
  clockWarning: boolean;
}

export interface DerivedLicenseState {
  core: LicenseCore;
  /** true: erste gueltige Lizenz dieser Datenbank, der Aufrufer setzt licensed_at. */
  markLicensed: boolean;
}

/**
 * SQLite schreibt datetime('now') in UTC; die Testphase zaehlt aber in
 * Kalendertagen der Firma (today ist lokal). Nachts liegt zwischen beiden
 * ein Tag; ohne Umrechnung waere die Testphase je nach Uhrzeit der
 * Installation einen Tag kuerzer.
 */
export function utcTimestampToLocalDate(sqliteUtc: string): string {
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Letzter Tag der Testphase ohne Datei. */
export function trialEndFor(installation: Pick<LicenseInstallationInput, 'created_at'>): string {
  return addDaysIso(utcTimestampToLocalDate(installation.created_at), LICENSE_TRIAL_DAYS - 1);
}

export function deriveLicenseState(input: DeriveLicenseStateInput): DerivedLicenseState {
  const { today, installation: inst, loaded } = input;
  const base = {
    installation_id: inst.installation_id,
    payload: null as LicensePayload | null,
    invalid_reason: loaded.invalidReason,
    grace_until: null as string | null,
    perpetual: false,
    issued_at: null as string | null,
    clock_warning: input.clockWarning,
    trial: false,
  };

  if (!input.enforced) {
    return {
      markLicensed: false,
      core: { ...base, clock_warning: false, state: 'entwicklung', read_only: false, warning: false, days_left: null, valid_until: null },
    };
  }

  let payload = loaded.payload;
  const mismatch = payload ? variantMismatchReason(payload, input.variant) : null;
  if (payload && mismatch) {
    base.invalid_reason = mismatch;
    payload = null;
  }
  if (payload && payload.installation_id !== null && payload.installation_id !== inst.installation_id) {
    base.invalid_reason =
      `Die Lizenzdatei ist an eine andere Installation gebunden (${payload.installation_id}); ` +
      `diese Datenbank hat die Installations-ID ${inst.installation_id}.`;
    payload = null;
  }
  if (payload && inst.licensed_at === null && today > addDaysIso(payload.valid_until, payload.grace_days)) {
    // Diese Datenbank war nie lizenziert, und die Datei ist schon ueber die
    // Kulanz hinaus: dieselbe Regel wie beim Einspielen (installLicense).
    // Ein alter Anhang, den jemand ins Datenverzeichnis kopiert, darf die
    // Testphase nicht beenden. Der Grund bleibt sichtbar.
    base.invalid_reason =
      `Die Lizenzdatei ist bereits abgelaufen (gültig bis ${formatDate(payload.valid_until)}, ` +
      `Kulanz bis ${formatDate(addDaysIso(payload.valid_until, payload.grace_days))}).`;
    payload = null;
  }

  if (payload) {
    const markLicensed = inst.licensed_at === null;
    const perpetual = isPerpetualLicense(payload.valid_until);
    const graceUntil = addDaysIso(payload.valid_until, payload.grace_days);
    const withPayload = { ...base, payload, issued_at: payload.issued_at, perpetual };
    if (today <= payload.valid_until) {
      if (perpetual) {
        // Unbefristet: kein Countdown, keine Kulanz, keine Warnung.
        return {
          markLicensed,
          core: { ...withPayload, state: 'valid', read_only: false, warning: false, days_left: null, valid_until: payload.valid_until, grace_until: null },
        };
      }
      const daysLeft = daysBetweenIso(today, payload.valid_until);
      return {
        markLicensed,
        core: {
          ...withPayload,
          state: 'valid',
          read_only: false,
          warning: daysLeft <= payload.warn_days,
          days_left: daysLeft,
          valid_until: payload.valid_until,
          grace_until: graceUntil,
        },
      };
    }
    if (today <= graceUntil) {
      return {
        markLicensed,
        core: {
          ...withPayload,
          state: 'grace',
          read_only: false,
          warning: true,
          days_left: daysBetweenIso(today, graceUntil),
          valid_until: payload.valid_until,
          grace_until: graceUntil,
        },
      };
    }
    return {
      markLicensed,
      core: {
        ...withPayload,
        state: 'expired',
        read_only: true,
        warning: true,
        days_left: 0,
        valid_until: payload.valid_until,
        grace_until: graceUntil,
      },
    };
  }

  // Keine brauchbare Lizenz. Testphase nur, solange nie eine eingespielt war.
  if (inst.licensed_at === null) {
    const trialUntil = trialEndFor(inst);
    if (today <= trialUntil) {
      const daysLeft = daysBetweenIso(today, trialUntil);
      return {
        markLicensed: false,
        core: {
          ...base,
          trial: true,
          state: 'trial',
          read_only: false,
          warning: daysLeft <= LICENSE_TRIAL_WARN_DAYS,
          days_left: daysLeft,
          valid_until: trialUntil,
        },
      };
    }
    return {
      markLicensed: false,
      core: { ...base, trial: true, state: 'expired', read_only: true, warning: true, days_left: 0, valid_until: trialUntil },
    };
  }
  return {
    markLicensed: false,
    core: { ...base, state: 'expired', read_only: true, warning: true, days_left: 0, valid_until: null },
  };
}
