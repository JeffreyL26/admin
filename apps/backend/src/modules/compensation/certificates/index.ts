/**
 * Registry der Bescheinigungsvorlagen je Land.
 *
 * Welche Bescheinigungen es gibt und wie sie aussehen, ist Landesrecht. Die
 * Route liest deshalb die Vorlage des Variantenlandes statt einer festen
 * Liste; ein Land ohne Vorlage liefert eine klare Meldung statt eines
 * deutschen Formulars mit falschen Paragraphen.
 */
import type { CertificateKind, CountryCode } from '@ohrganize/shared';
import { AppError } from '../../../core/errors.js';
import type { CompanySettings } from '../../../core/settings.js';
import type { EmployeeRow } from '../lib.js';
import { deCertificates } from './de.js';

export interface CertificateTemplate {
  country: CountryCode;
  /** Arten, die dieses Land kennt (Reihenfolge = Reihenfolge im Formular). */
  kinds: readonly CertificateKind[];
  render(
    kind: CertificateKind,
    period: string,
    employee: EmployeeRow,
    settings: CompanySettings,
  ): string;
}

export const CERTIFICATE_TEMPLATES: Record<CountryCode, CertificateTemplate | null> = {
  DE: deCertificates,
  AT: null,
  CH: null,
};

export function certificateTemplateFor(country: CountryCode): CertificateTemplate {
  const template = CERTIFICATE_TEMPLATES[country];
  if (!template) {
    throw new AppError(
      501,
      'CERTIFICATES_UNAVAILABLE',
      'Für dieses Land sind noch keine Bescheinigungsvorlagen hinterlegt.',
    );
  }
  return template;
}
