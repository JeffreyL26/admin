/**
 * Lizenzdatei: Format, Signatur, Prüfung.
 *
 * Eine Zeile: `OHRG1.<base64url(Payload-JSON)>.<base64url(Ed25519-Signatur)>`.
 * Die Signatur deckt EXAKT die dekodierten Payload-Bytes. Vor der Prüfung wird
 * nichts neu serialisiert und kein Feld aus einer unsignierten Hülle gelesen —
 * genau dort entstünden Änderungswege, die die Kryptographie selbst nicht hat.
 *
 * Warum Signatur und nicht Verschlüsselung: Signieren liefert Unversehrtheit
 * und Herkunft — ein geändertes Byte in `valid_until` lässt die Prüfung
 * scheitern, und den Schlüssel zum Neu-Signieren gibt es nur beim Anbieter.
 * Verschlüsseln würde nur den Inhalt verstecken; der Schlüssel dafür müsste
 * auf dem Kundenserver liegen, wo er nichts mehr schützt. Der Inhalt der Datei
 * ist ohnehin nicht geheim (Kundenname, Laufzeit, Platzzahl).
 *
 * Bewusst ohne Datenbank und ohne config.ts: Dieselben Funktionen nutzen der
 * Server (core/license.ts) und das Signierwerkzeug des Anbieters
 * (scripts/license-tool.ts).
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  COUNTRY_CODES,
  EDITION_PATTERN,
  FEATURE_KEY_PATTERN,
  LICENSE_FILE_PREFIX,
  LICENSE_HEADLINE_MAX,
  LICENSE_MAX_DATE,
  LICENSE_MAX_FEATURES,
  type LicensePayload,
} from '@ohrganize/shared';

/** Ein Schlüssel, dem das Backend vertraut — identifiziert über `kid`. */
export interface TrustedLicenseKey {
  kid: string;
  publicKey: crypto.KeyObject;
}

/** Fehler mit deutscher Meldung, die der Administration direkt gezeigt wird. */
export class LicenseFormatError extends Error {}

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum muss JJJJ-MM-TT sein')
  .refine(
    (s) => {
      // Date.parse statt new Date().toISOString(): Letzteres wirft bei einem
      // unmöglichen Datum (2026-13-01) einen RangeError, den zod nicht fängt —
      // aus einem 400 würde ein 500.
      const t = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    },
    'Kein gültiger Kalendertag',
  );

/** Felder, die es erst ab v2 gibt; bei v1 muessen sie fehlen. */
const V2_FIELDS = ['edition', 'country', 'features', 'terms', 'headline'] as const;

/**
 * Inhalt der Datei. `.strict()`: Unbekannte Felder werden abgelehnt; eine
 * neuere Datei mit Feldern, die dieser Server nicht kennt, soll auffallen
 * statt still halb zu gelten. Formataenderungen laufen ueber `v`: v1 ist die
 * Urfassung, v2 traegt Ausgabe, Land, Funktionen, Bedingungen und
 * Ueberschrift. Ein v1-Server (Stand vor diesem Schema) lehnt eine v2-Datei
 * ab, weil er `v: 2` und die neuen Felder nicht kennt; deshalb Rollout
 * immer Server vor Datei.
 */
export const licensePayloadSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    license_id: z.string().min(1).max(64),
    kid: z.string().min(1).max(32),
    customer: z.string().min(1).max(200),
    customer_id: z.string().min(1).max(64),
    installation_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/, 'Installations-ID muss 32 Hex-Zeichen haben')
      .nullable(),
    kind: z.enum(['standard', 'evaluation']),
    issued_at: isoDay,
    valid_from: isoDay,
    valid_until: isoDay,
    grace_days: z.number().int().min(0).max(365),
    warn_days: z.number().int().min(0).max(365),
    max_users: z.number().int().min(1).nullable(),
    notice: z.string().max(200).nullable(),
    // ab v2 (Pflichtfelder und Verbote regelt superRefine unten)
    edition: z.string().regex(EDITION_PATTERN, 'Editionsschlüssel: Kleinbuchstaben, Ziffern, Bindestrich').optional(),
    country: z.enum(COUNTRY_CODES).optional(),
    features: z
      .array(z.string().regex(FEATURE_KEY_PATTERN, 'Feature-Schlüssel wie kunde.musterfirma.export'))
      .max(LICENSE_MAX_FEATURES)
      .optional(),
    terms: z
      .object({
        billing: z.enum(['kostenfrei', 'abo', 'kauf', 'individuell']),
        interval: z.enum(['monatlich', 'jaehrlich']).nullable(),
        label: z.string().min(1).max(80).nullable(),
      })
      .strict()
      .optional(),
    headline: z.string().min(1).max(LICENSE_HEADLINE_MAX).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.v === 1) {
      for (const f of V2_FIELDS) {
        if (p[f] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['v'], message: `Feld ${f} gibt es erst ab v 2` });
          return;
        }
      }
    } else {
      if (p.edition === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edition'], message: 'edition ist ab v 2 Pflicht' });
      }
      if (p.country === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['country'], message: 'country ist ab v 2 Pflicht' });
      }
    }
  })
  .refine((p) => p.valid_from <= p.valid_until, {
    message: 'valid_from liegt nach valid_until',
    path: ['valid_until'],
  })
  .refine((p) => p.valid_until <= LICENSE_MAX_DATE, {
    message: `valid_until darf nicht nach ${LICENSE_MAX_DATE} liegen`,
    path: ['valid_until'],
  });

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(text: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new LicenseFormatError(`Die Lizenzdatei ist beschädigt (${what} nicht lesbar).`);
  }
  return Buffer.from(text, 'base64url');
}

/** Zerlegt den Dateiinhalt; prüft NUR das Format, nicht die Signatur. */
export function decodeLicenseText(text: string): { payloadBytes: Buffer; signature: Buffer } {
  // Zeilenumbrüche und Leerraum sind erlaubt (E-Mail-Anhang, Copy & Paste).
  const compact = text.replace(/\s+/g, '');
  const parts = compact.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_FILE_PREFIX) {
    throw new LicenseFormatError(
      'Das ist keine oHRganize-Lizenzdatei (erwartet wird eine Zeile, die mit ' +
        `„${LICENSE_FILE_PREFIX}.“ beginnt).`,
    );
  }
  const payloadBytes = fromB64url(parts[1], 'Inhalt');
  const signature = fromB64url(parts[2], 'Signatur');
  if (signature.length !== 64) {
    throw new LicenseFormatError('Die Lizenzdatei ist beschädigt (Signaturlänge stimmt nicht).');
  }
  return { payloadBytes, signature };
}

/** Parst und validiert die Payload-Bytes — ohne Signaturprüfung. */
export function parseLicensePayload(payloadBytes: Buffer): LicensePayload {
  let json: unknown;
  try {
    json = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new LicenseFormatError('Die Lizenzdatei ist beschädigt (Inhalt ist kein JSON).');
  }
  const result = licensePayloadSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    throw new LicenseFormatError(
      `Der Inhalt der Lizenzdatei ist ungültig${where}: ${first?.message ?? 'unbekannter Fehler'}.`,
    );
  }
  return result.data;
}

/**
 * Vollständige Prüfung: Format → Inhalt → bekannter Schlüssel → Signatur.
 * Wirft LicenseFormatError mit dem Grund; liefert sonst die geprüfte Payload.
 *
 * Die `kid` steht in der Payload und wählt den Schlüssel aus, BEVOR die
 * Signatur geprüft ist. Das ist unproblematisch: Wer die kid ändert, ändert
 * die signierten Bytes, und die Prüfung gegen den gewählten Schlüssel scheitert.
 */
export function verifyLicenseText(text: string, trusted: readonly TrustedLicenseKey[]): LicensePayload {
  const { payloadBytes, signature } = decodeLicenseText(text);
  const payload = parseLicensePayload(payloadBytes);
  const key = trusted.find((k) => k.kid === payload.kid);
  if (!key) {
    throw new LicenseFormatError(
      `Die Lizenzdatei wurde mit einem Schlüssel signiert, den dieser Server nicht kennt (${payload.kid}). ` +
        'Vermutlich ist die Serverversion älter als die Lizenz — bitte zuerst aktualisieren.',
    );
  }
  const ok = crypto.verify(null, payloadBytes, key.publicKey, signature);
  if (!ok) {
    throw new LicenseFormatError(
      'Die Signatur der Lizenzdatei ist ungültig. Die Datei wurde verändert oder stammt nicht vom Anbieter.',
    );
  }
  return payload;
}

/** Erzeugt den Dateiinhalt (eine Zeile ohne Zeilenumbruch). */
export function signLicensePayload(payload: LicensePayload, privateKey: crypto.KeyObject): string {
  // Validieren, bevor etwas signiert wird — ein Werkzeugfehler soll hier
  // scheitern, nicht später beim Kunden.
  const checked = licensePayloadSchema.parse(payload);
  const payloadBytes = Buffer.from(JSON.stringify(checked), 'utf8');
  const signature = crypto.sign(null, payloadBytes, privateKey);
  return `${LICENSE_FILE_PREFIX}.${b64url(payloadBytes)}.${b64url(signature)}`;
}

/** SPKI-DER-Präfix eines Ed25519-Schlüssels (RFC 8410): 12 Bytes vor den 32 Rohbytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Öffentlicher Schlüssel aus PEM oder aus den 32 Rohbytes in Base64 — Letzteres,
 * damit ein Schlüssel auch in einer Umgebungsvariable ohne Zeilenumbrüche Platz
 * hat (Tests) und kompakt in core/licenseKeys.ts steht.
 */
export function publicKeyFrom(text: string): crypto.KeyObject {
  const trimmed = text.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.createPublicKey({ key: trimmed, format: 'pem' });
  }
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 32) {
    throw new Error('Öffentlicher Ed25519-Schlüssel muss PEM oder 32 Rohbytes in Base64 sein.');
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** 32 Rohbytes des öffentlichen Schlüssels als Base64 (Gegenstück zu publicKeyFrom). */
export function publicKeyToRawBase64(key: crypto.KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Kurzer Fingerabdruck zum Vergleichen am Telefon (SHA-256 der Rohbytes, 16 Hex). */
export function publicKeyFingerprint(key: crypto.KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(der.subarray(der.length - 32)).digest('hex').slice(0, 16);
}
