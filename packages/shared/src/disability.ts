/**
 * Schwerbehinderung in den Stammdaten (SGB IX). Gesundheitsdaten nach
 * Art. 9 DSGVO: Lesen und Ändern hängen am eigenen Rechtebereich
 * `schwerbehinderung` (admin.ts), das Portal bekommt die Felder nie.
 * Durchsetzung im Backend: modules/employees/disability.ts.
 */
import type { EntitlementDetail } from './leaveEntitlement.js';

/** Spalten der Personalakte, die nur mit dem Recht "Schwerbehinderung" sichtbar sind. */
export const DISABILITY_FIELDS = [
  'disability_degree',
  'disability_equal',
  'disability_valid_until',
  'disability_note',
] as const;
export type DisabilityField = (typeof DISABILITY_FIELDS)[number];

/** Grad der Behinderung in Zehnerstufen (§ 152 Abs. 1 SGB IX). */
export const DISABILITY_DEGREES = [20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** Ab diesem Grad gilt jemand als schwerbehindert (§ 2 Abs. 2 SGB IX). */
export const SEVERE_DISABILITY_DEGREE = 50;

/** Schwerbehindert oder gleichgestellt (Kündigungsschutz, § 168 SGB IX)? */
export function hasDisabilityProtection(degree: number | null | undefined, equal: boolean): boolean {
  return (degree ?? 0) >= SEVERE_DISABILITY_DEGREE || (equal && (degree ?? 0) >= 30);
}

/**
 * Feste Hinweise der Personalakte: was der Status mit sich bringt. Kurz und
 * mit Fundstelle; die Rechnung des Zusatzurlaubs steht in leaveEntitlement.ts.
 */
export function disabilityNotes(degree: number | null | undefined, equal: boolean): string[] {
  const notes: string[] = [];
  const severe = (degree ?? 0) >= SEVERE_DISABILITY_DEGREE;
  if (severe) {
    notes.push('Zusatzurlaub: eine Arbeitswoche je Jahr, bei fünf Arbeitstagen fünf Tage (§ 208 SGB IX); im Urlaubsanspruch eingerechnet.');
  } else if (equal) {
    notes.push('Gleichgestellt: kein Zusatzurlaub (§ 151 Abs. 3 SGB IX), aber Kündigungsschutz wie bei Schwerbehinderung.');
  }
  if (hasDisabilityProtection(degree, equal)) {
    notes.push('Kündigung nur mit vorheriger Zustimmung des Integrationsamts (§ 168 SGB IX), nach sechs Monaten Beschäftigung (§ 173).');
    notes.push('Mindestkündigungsfrist vier Wochen (§ 169 SGB IX).');
    notes.push('Vor jeder Kündigung die Schwerbehindertenvertretung beteiligen (§ 178 Abs. 2 SGB IX).');
  }
  return notes;
}

/**
 * Anspruch ohne benannten Zusatzurlaub, für Konten ohne Recht
 * "Schwerbehinderung" und das Portal: Die Tage stecken im vertraglichen Teil,
 * die Summe bleibt gleich.
 */
export function maskDisabilityEntitlement(detail: EntitlementDetail): EntitlementDetail {
  if (detail.disability === 0 && detail.full_year.disability === 0) return detail;
  return {
    ...detail,
    contractual: detail.contractual + detail.disability,
    disability: 0,
    full_year: {
      ...detail.full_year,
      contractual: detail.full_year.contractual + detail.full_year.disability,
      disability: 0,
    },
  };
}
