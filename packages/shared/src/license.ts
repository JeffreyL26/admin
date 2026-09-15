/**
 * Lizenzmodell — gemeinsamer Vertrag zwischen Backend, Desktop-App, Portal und
 * dem Signierwerkzeug des Anbieters.
 *
 * Grundidee: Die Nutzungsberechtigung ist eine vom Anbieter signierte Datei im
 * Datenverzeichnis des Backends (Ed25519, privater Schlüssel liegt nur beim
 * Anbieter, öffentlicher Schlüssel steckt im Backend). Es gibt bewusst KEINEN
 * Rückkanal zum Anbieter: Die Laufzeit der Datei ist der bezahlte Zeitraum,
 * und bei Nichtzahlung stellt der Anbieter schlicht keine neue Datei aus. Das
 * Backend braucht dafür weder Netz noch Uhrzeit von außen — und der Anbieter
 * kann von außen nichts abschalten, was zu einem laufenden System gehört.
 *
 * Was nach dem Ablauf passiert, ist absichtlich abgestuft und nie
 * destruktiv: Warnung, Kulanzfrist mit voller Funktion, dann Nur-Lese-Betrieb.
 * Daten bleiben unangetastet, lesbar und exportierbar — die Personalakte
 * unterliegt Aufbewahrungsfristen, die einen Vertrag überdauern.
 */

import type { CountryCode, Edition } from './country.js';

/** Kennung am Dateianfang; steigt nur bei inkompatiblem Format. */
export const LICENSE_FILE_PREFIX = 'OHRG1';

/**
 * Hoechste Payload-Fassung (`v`), die dieser Stand liest. Server melden sie
 * in /api/health und im Lizenzbericht (`license_format`), damit der Anbieter
 * vor dem Ausstellen einer v2-Datei weiss, ob der Server sie annimmt.
 * Rollout immer Server vor Datei.
 */
export const LICENSE_FORMAT_VERSION = 2;

/** Dateiname im Datenverzeichnis des Backends (neben ohrganize.db und secret.key). */
export const LICENSE_FILE_NAME = 'lizenz.ohrganize';

/** Header, mit dem das Backend den Lizenzzustand auf jeder ANGEMELDETEN Antwort
 *  mitschickt (nur der Zustand, keine Vertragsdaten; Portal-Konten sehen nur
 *  valid/expired, öffentliche Routen tragen ihn nicht — Fastify liest Header
 *  kleingeschrieben). */
export const LICENSE_STATE_HEADER = 'x-ohrganize-license';

/** Obergrenze für den Upload einer Lizenzdatei (Server prüft, Client warnt vorher).
 *  Eine Datei hat wenige hundert Byte; die Grenze lässt Platz für Leerraum aus
 *  Copy & Paste, aber nicht für Missbrauch als Ablage. */
export const LICENSE_FILE_MAX_BYTES = 16 * 1024;

/**
 * Obergrenze für `valid_until` und zugleich die Schreibweise für „unbefristet“:
 * weit genug, aber diesseits der Jahr-10000-Grenze, an der die ISO-Datums-
 * arithmetik kippt. Das Werkzeug nimmt `--until unbefristet` als Alias.
 */
export const LICENSE_MAX_DATE = '2999-12-31';

/** Unbefristete Lizenz: Anzeige „unbefristet“ statt eines Datums in 973 Jahren. */
export function isPerpetualLicense(validUntil: string | null): boolean {
  return validUntil !== null && validUntil >= LICENSE_MAX_DATE;
}

/** Testphase für eine Datenbank, die noch nie eine Lizenz gesehen hat. */
export const LICENSE_TRIAL_DAYS = 30;
/** Ab so vielen Resttagen warnt die Testphase. */
export const LICENSE_TRIAL_WARN_DAYS = 7;
/** Vorgaben, falls die Lizenzdatei nichts anderes sagt. */
export const LICENSE_DEFAULT_GRACE_DAYS = 14;
export const LICENSE_DEFAULT_WARN_DAYS = 30;

/** Fehlercodes, auf die die Clients reagieren (`{ error: { code } }`). */
export const LICENSE_ERROR_CODES = {
  /** Nur-Lese-Betrieb: Schreibzugriff abgelehnt (403). */
  EXPIRED: 'LICENSE_EXPIRED',
  /** Platz-Obergrenze der Lizenz erreicht (409). */
  SEATS_EXCEEDED: 'LICENSE_SEATS_EXCEEDED',
  /** Eingespielte Datei unbrauchbar: Signatur, Format, Bindung, Laufzeit (400). */
  INVALID: 'LICENSE_INVALID',
  /** Funktion ist im Build vorhanden, aber nicht in der Lizenz freigeschaltet (403). */
  FEATURE_MISSING: 'LICENSE_FEATURE_MISSING',
} as const;

/** Abrechnungsart, nur Anzeige und Register; steuert keine Pruefung. */
export type LicenseBilling = 'kostenfrei' | 'abo' | 'kauf' | 'individuell';
export type LicenseInterval = 'monatlich' | 'jaehrlich';

/** Vertragsbedingungen in der signierten Datei (ab v2), Quelle der Lizenztexte. */
export interface LicenseTerms {
  billing: LicenseBilling;
  interval: LicenseInterval | null;
  /** Freier Kurztext, der den erzeugten Satz ersetzt (z. B. "Partnerkonditionen"). */
  label: string | null;
}

/**
 * Feature-Schluessel: Kleinbuchstaben, Ziffern, Bindestrich, mindestens
 * zwei Segmente mit Punkt (`kunde.musterfirma.export`, `modul.zeiterfassung`).
 */
export const FEATURE_KEY_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const LICENSE_MAX_FEATURES = 50;
export const LICENSE_HEADLINE_MAX = 120;

/** Art der Lizenz — steuert nur Anzeige und Register, nicht die Prüfung. */
export type LicenseKind = 'standard' | 'evaluation';

/**
 * Zustand, wie ihn das Backend berechnet. Reihenfolge ist zugleich Schwere:
 *   entwicklung  Dev-Datenverzeichnis, keine Prüfung
 *   valid        Lizenz gültig (warning = true ab warn_days vor Ablauf)
 *   trial        keine Lizenz je eingespielt, Testphase läuft
 *   grace        abgelaufen, Kulanzfrist läuft — volle Funktion, rotes Banner
 *   expired      Kulanz vorbei (oder Testphase vorbei) — Nur-Lese-Betrieb
 */
export type LicenseState = 'entwicklung' | 'valid' | 'trial' | 'grace' | 'expired';

/** Anzeigename je Zustand (Badge auf der Lizenzseite und im Dashboard-Widget). */
export const LICENSE_STATE_LABELS: Record<LicenseState, string> = {
  entwicklung: 'Entwicklung',
  valid: 'Gültig',
  trial: 'Testphase',
  grace: 'Kulanzfrist',
  expired: 'Abgelaufen',
};

/** Anzeigename je Lizenzart. `evaluation` heisst in der Oberflaeche Testlizenz. */
export const LICENSE_KIND_LABELS: Record<LicenseKind, string> = {
  standard: 'Standard',
  evaluation: 'Testlizenz',
};

/** Was das Backend über `GET /api/license`, `/api/auth/me` und Login liefert. */
export interface LicenseStatus {
  state: LicenseState;
  /** true ⇔ Schreibzugriffe werden abgelehnt (state = expired). */
  read_only: boolean;
  /** Banner zeigen: nahender Ablauf, Kulanz, Testphase kurz vor Ende. */
  warning: boolean;
  /** Tage bis zum nächsten Übergang (Ablauf, Kulanzende, Testende); null in entwicklung. */
  days_left: number | null;
  /** Letzter Tag der Gültigkeit (Lizenz) bzw. der Testphase (trial). */
  valid_until: string | null;
  /** Letzter Tag der Kulanzfrist; null ohne Lizenz und bei unbefristeten Lizenzen. */
  grace_until: string | null;
  /**
   * Unbefristete Lizenz (valid_until = LICENSE_MAX_DATE). Dann gilt:
   * days_left null, grace_until null, warning false. Die Anzeige sagt
   * "unbegrenzt" statt eines Datums im Jahr 2999.
   */
  perpetual: boolean;
  /** Ausstelldatum der Lizenzdatei; null ohne brauchbare Datei. */
  issued_at: string | null;
  /** Ausgabe, fuer die die Datei gilt (ab v2); null bei v1 und ohne Datei. */
  edition: Edition | null;
  country: CountryCode | null;
  /** Freigeschaltete Funktionen; null = alles an (v1, Testphase, keine Datei). */
  features: string[] | null;
  terms: LicenseTerms | null;
  /** Signierte Ueberschrift des Anbieters; ersetzt im Zustand valid die erzeugte. */
  headline: string | null;
  customer: string | null;
  license_id: string | null;
  kind: LicenseKind | null;
  /** Obergrenze aktiver Personalprofile; null = unbegrenzt. */
  max_users: number | null;
  /** Aktive Personalprofile (status = 'aktiv') — dieselbe Zahl wie die Dashboard-Kopfzahl. */
  seats_used: number;
  /** Zufalls-ID dieser Datenbank; steht in der Lizenzdatei, wenn sie gebunden ist. */
  installation_id: string;
  /** Freitext des Anbieters aus der Lizenzdatei (z. B. Rechnungsbezug); nur für Admins. */
  notice: string | null;
  /**
   * Eine Lizenzdatei liegt vor, ist aber unbrauchbar (Signatur, Format,
   * falsche Installation). Der Zustand fällt dann auf trial/expired zurück;
   * der Grund steht hier für die Administration.
   */
  invalid_reason: string | null;
  /**
   * Stolperdraht: Die Datenbank hat schon ein späteres Datum gesehen als die
   * Systemuhr heute zeigt. Kein Riegel — Windows stellt Uhren auch von selbst
   * um —, aber ein Hinweis, der protokolliert und angezeigt wird.
   */
  clock_warning: boolean;
}

/** Schlanke Fassung für Portal-Konten: nichts, was den Arbeitgeber betrifft. */
export interface LicenseStatusPublic {
  read_only: boolean;
  /** Freigeschaltete Funktionen fuer die Navigation des Portals; null = alles an. */
  features: string[] | null;
}

/**
 * Inhalt der signierten Datei (JSON, base64url-kodiert zwischen Kennung und
 * Signatur). Die Signatur deckt exakt die dekodierten Bytes — nichts wird vor
 * der Prüfung neu serialisiert. Datumswerte sind Kalendertage (YYYY-MM-DD),
 * `valid_until` ist einschließlich.
 */
export interface LicensePayload {
  /** 1 = Urfassung; 2 = mit Ausgabe, Land, Funktionen, Bedingungen, Ueberschrift. */
  v: 1 | 2;
  license_id: string;
  /** Kennung des Signierschlüssels — erlaubt einen Schlüsselwechsel ohne Bruch. */
  kid: string;
  customer: string;
  customer_id: string;
  /** null = ungebunden (Auswertungslizenz vor der Installation). */
  installation_id: string | null;
  kind: LicenseKind;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  grace_days: number;
  warn_days: number;
  max_users: number | null;
  notice: string | null;
  /** Ab v2 Pflicht: Ausgabe und Land, gegen die Variante des Servers geprueft. */
  edition?: Edition;
  country?: CountryCode;
  /** Ab v2 optional; fehlt es, sind alle Funktionen des Builds an. */
  features?: string[];
  terms?: LicenseTerms;
  headline?: string;
}

/** Inhalt des Lizenzberichts, den der Kunde selbst herunterlädt und einer
 *  Verlängerung beilegt — nur Zahlen und Kennungen, keine Personendaten. */
export interface LicenseReport {
  generated_at: string;
  installation_id: string;
  license_id: string | null;
  customer_id: string | null;
  state: LicenseState;
  valid_until: string | null;
  seats_used: number;
  max_users: number | null;
  server_version: string;
  /** Hoechste Lizenzfassung, die dieser Server liest (fehlt bei Servern vor v2). */
  license_format?: number;
  edition?: Edition | null;
  country?: CountryCode | null;
}

/** Tage zwischen zwei ISO-Kalendertagen (b − a), taggenau, ohne Zeitzoneneffekt. */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
