/**
 * Ausstell-Baustein des Anbieters: aus Eingaben eine signierte Lizenzdatei.
 *
 * Gemeinsam fuer das Werkzeug scripts/license-tool.ts und das Register
 * tools/conspectus. Bewusst ohne Konsole, ohne Dateizugriff, ohne
 * Datenbank: Der Aufrufer liest den Schluessel, schreibt die Datei und
 * fuehrt sein Register. Hier stehen nur Pruefung, Vorgaben, Payload-Bau,
 * Signatur und die Gegenprobe mit genau der Pruefung, die der Server macht.
 *
 * Lizenzmodelle entstehen ausschliesslich aus den Feldern der Datei:
 *   Testlizenz beliebiger Laufzeit   kind evaluation, until = heute + n
 *   kostenfrei unbefristet           until unbefristet, terms.billing kostenfrei
 *   Abo                              until = Vertragsende, terms.billing abo
 *   Kundenfunktion                   features [kunde.musterfirma.export]
 * Nichts davon ist beim Kunden umstellbar; jede Aenderung ist eine neue Datei.
 */
import crypto from 'node:crypto';
import {
  COUNTRY_CODES,
  EDITION_PATTERN,
  FEATURE_KEY_PATTERN,
  LICENSE_DEFAULT_GRACE_DAYS,
  LICENSE_DEFAULT_WARN_DAYS,
  LICENSE_HEADLINE_MAX,
  LICENSE_MAX_DATE,
  LICENSE_MAX_FEATURES,
  addDaysIso,
  daysBetweenIso,
  todayIsoLocal,
  type CountryCode,
  type LicenseBilling,
  type LicenseInterval,
  type LicenseKind,
  type LicensePayload,
} from '@ohrganize/shared';
import { publicKeyToRawBase64, signLicensePayload, verifyLicenseText } from './licenseCodec.js';

/** Fehler in den Eingaben; die Meldung ist deutsch und fuer die Konsole gedacht. */
export class LicenseIssueError extends Error {}

export interface LicenseIssueInput {
  kid: string;
  customer: string;
  customerId: string;
  /** 32 Hex oder null (ungebunden). */
  installationId: string | null;
  /** JJJJ-MM-TT, `unbefristet`, oder eine Laufzeit wie `3t`, `6m`, `1j` ab validFrom. */
  until: string;
  /** JJJJ-MM-TT; Vorgabe heute. */
  from?: string | null;
  seats?: number | null;
  /** Vorgabe je Art: standard 14, evaluation 0. */
  graceDays?: number | null;
  /** Vorgabe je Art: standard 30, evaluation min(30, Laufzeit / 2). */
  warnDays?: number | null;
  kind?: LicenseKind;
  notice?: string | null;
  /** v2-Felder; sobald eines gesetzt ist, entsteht eine v2-Datei. */
  edition?: string | null;
  country?: string | null;
  features?: string[] | null;
  billing?: LicenseBilling | null;
  interval?: LicenseInterval | null;
  termsLabel?: string | null;
  headline?: string | null;
  /** Erzwingt v2 auch ohne weitere Felder (edition und country dann Pflicht). */
  forceV2?: boolean;
  /** Fuer Tests: fester Ausstelltag statt heute. */
  issuedAt?: string;
}

export interface IssuedLicense {
  text: string;
  payload: LicensePayload;
  version: 1 | 2;
}

export function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/**
 * Laufzeitangabe: `3t` (Tage), `2w` (Wochen), `6m` (Monate), `1j` (Jahre).
 * Ergebnis ist der LETZTE gueltige Tag: `3t` ab dem 1. ergibt den 3.
 * Monate und Jahre rechnen kalendarisch (31.01. plus 1 Monat = 28./29.02.).
 */
export function parseDuration(spec: string, from: string): string | null {
  const m = /^(\d{1,4})\s*([tTwWmMjJ])$/.exec(spec.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  const unit = m[2].toLowerCase();
  if (unit === 't') return addDaysIso(from, n - 1);
  if (unit === 'w') return addDaysIso(from, n * 7 - 1);
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (unit === 'm' ? n : n * 12));
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return addDaysIso(d.toISOString().slice(0, 10), -1);
}

/** Loest `--until`: Kalendertag, `unbefristet` oder Laufzeit ab `from`. */
export function resolveUntil(until: string, from: string): string {
  const trimmed = until.trim();
  if (trimmed.toLowerCase() === 'unbefristet') return LICENSE_MAX_DATE;
  if (isIsoDay(trimmed)) return trimmed;
  const byDuration = parseDuration(trimmed, from);
  if (byDuration) return byDuration;
  throw new LicenseIssueError(
    `--until muss ein Kalendertag JJJJ-MM-TT, "unbefristet" oder eine Laufzeit wie 3t, 2w, 6m, 1j sein (erhalten: ${until})`,
  );
}

/** Vorgaben fuer Kulanz und Vorwarnung je Art und Laufzeit. */
export function defaultDays(kind: LicenseKind, from: string, until: string): { grace: number; warn: number } {
  if (kind === 'evaluation') {
    const runtime = until >= LICENSE_MAX_DATE ? 365 : daysBetweenIso(from, until) + 1;
    return { grace: 0, warn: Math.max(1, Math.min(30, Math.floor(runtime / 2))) };
  }
  return { grace: LICENSE_DEFAULT_GRACE_DAYS, warn: LICENSE_DEFAULT_WARN_DAYS };
}

function intOrFail(value: number | null | undefined, name: string, min: number): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < min) throw new LicenseIssueError(`${name} muss eine ganze Zahl ab ${min} sein`);
  return value;
}

/**
 * Prueft, baut, signiert und macht die Gegenprobe. Die Fassung ist 1, solange
 * kein v2-Feld gesetzt ist; sonst 2 (dann sind edition und country Pflicht).
 */
export function issueLicense(input: LicenseIssueInput, privateKey: crypto.KeyObject): IssuedLicense {
  const kind = input.kind ?? 'standard';
  if (kind !== 'standard' && kind !== 'evaluation') throw new LicenseIssueError('--kind: standard | evaluation');
  if (!input.customer.trim()) throw new LicenseIssueError('--customer fehlt');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.customerId)) {
    throw new LicenseIssueError('--customer-id: Buchstaben, Ziffern, . _ - (max. 64)');
  }
  if (input.installationId !== null && !/^[0-9a-fA-F]{32}$/.test(input.installationId)) {
    throw new LicenseIssueError(
      '--installation muss die 32-stellige Installations-ID (Einstellungen → Lizenz) oder - für ungebunden sein',
    );
  }
  const issuedAt = input.issuedAt ?? todayIsoLocal();
  const validFrom = input.from?.trim() || issuedAt;
  if (!isIsoDay(validFrom)) throw new LicenseIssueError(`--from muss ein gültiger Kalendertag JJJJ-MM-TT sein (erhalten: ${validFrom})`);
  const validUntil = resolveUntil(input.until, validFrom);
  if (validUntil > LICENSE_MAX_DATE) throw new LicenseIssueError(`--until darf nicht nach ${LICENSE_MAX_DATE} liegen ("unbefristet" = ${LICENSE_MAX_DATE})`);
  if (validUntil < validFrom) throw new LicenseIssueError(`--until (${validUntil}) liegt vor --from (${validFrom})`);

  const defaults = defaultDays(kind, validFrom, validUntil);
  const grace = intOrFail(input.graceDays, '--grace', 0) ?? defaults.grace;
  const warn = intOrFail(input.warnDays, '--warn', 0) ?? defaults.warn;
  const seats = intOrFail(input.seats, '--seats', 1);

  const edition = input.edition?.trim() || null;
  const country = input.country?.trim().toUpperCase() || null;
  const features = input.features?.map((f) => f.trim()).filter(Boolean) ?? [];
  const billing = input.billing ?? null;
  const headline = input.headline?.trim() || null;
  const termsLabel = input.termsLabel?.trim() || null;
  const wantsV2 =
    input.forceV2 === true || edition !== null || country !== null || features.length > 0 || billing !== null || headline !== null;

  const payload: LicensePayload = {
    v: 1,
    license_id: crypto.randomUUID(),
    kid: input.kid,
    customer: input.customer.trim(),
    customer_id: input.customerId,
    installation_id: input.installationId === null ? null : input.installationId.toLowerCase(),
    kind,
    issued_at: issuedAt,
    valid_from: validFrom,
    valid_until: validUntil,
    grace_days: grace,
    warn_days: warn,
    max_users: seats,
    notice: input.notice?.trim() || null,
  };

  if (wantsV2) {
    if (!edition) throw new LicenseIssueError('--edition fehlt (ab Lizenz v2 Pflicht, z. B. vollversion)');
    if (!EDITION_PATTERN.test(edition)) throw new LicenseIssueError('--edition: Kleinbuchstaben, Ziffern, Bindestrich (max. 32)');
    if (!country) throw new LicenseIssueError(`--country fehlt (ab Lizenz v2 Pflicht: ${COUNTRY_CODES.join(', ')})`);
    if (!(COUNTRY_CODES as readonly string[]).includes(country)) {
      throw new LicenseIssueError(`--country: ${COUNTRY_CODES.join(' | ')} (erhalten: ${country})`);
    }
    if (features.length > LICENSE_MAX_FEATURES) throw new LicenseIssueError(`Höchstens ${LICENSE_MAX_FEATURES} Feature-Schlüssel`);
    for (const f of features) {
      if (!FEATURE_KEY_PATTERN.test(f)) throw new LicenseIssueError(`--feature ${f}: Muster wie kunde.musterfirma.export`);
    }
    if (headline && headline.length > LICENSE_HEADLINE_MAX) throw new LicenseIssueError(`--headline höchstens ${LICENSE_HEADLINE_MAX} Zeichen`);
    if (input.interval && !billing) throw new LicenseIssueError('--interval braucht --billing');
    if (termsLabel && !billing) throw new LicenseIssueError('--label braucht --billing');
    payload.v = 2;
    payload.edition = edition;
    payload.country = country as CountryCode;
    if (features.length) payload.features = [...new Set(features)].sort();
    if (billing) payload.terms = { billing, interval: input.interval ?? null, label: termsLabel };
    if (headline) payload.headline = headline;
  }

  const text = signLicensePayload(payload, privateKey);
  // Gegenprobe mit genau der Pruefung, die der Server macht.
  verifyLicenseText(text, [{ kid: input.kid, publicKey: crypto.createPublicKey(privateKey) }]);
  return { text, payload, version: payload.v };
}

/** Passt der private Schluessel zum eingebauten oeffentlichen (Rohbytes Base64)? */
export function privateKeyMatches(privateKey: crypto.KeyObject, publicRawBase64: string): boolean {
  return publicKeyToRawBase64(crypto.createPublicKey(privateKey)) === publicRawBase64;
}

// ---------------------------------------------------------------------------
// CSV-Register (Semikolon), Sicht des Anbieters auf "wer hat was bis wann"
// ---------------------------------------------------------------------------

export const REGISTER_CSV_HEADER =
  'issued_at;license_id;kid;customer_id;customer;installation_id;kind;valid_from;valid_until;' +
  'grace_days;warn_days;max_users;notice;v;edition;country;features;billing;interval;headline;file\n';

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerCsvLine(payload: LicensePayload, filePath: string): string {
  return (
    [
      payload.issued_at,
      payload.license_id,
      payload.kid,
      payload.customer_id,
      payload.customer,
      payload.installation_id ?? '',
      payload.kind,
      payload.valid_from,
      payload.valid_until,
      payload.grace_days,
      payload.warn_days,
      payload.max_users ?? '',
      payload.notice ?? '',
      payload.v,
      payload.edition ?? '',
      payload.country ?? '',
      payload.features?.join(' ') ?? '',
      payload.terms?.billing ?? '',
      payload.terms?.interval ?? '',
      payload.headline ?? '',
      filePath,
    ]
      .map(csvCell)
      .join(';') + '\n'
  );
}
