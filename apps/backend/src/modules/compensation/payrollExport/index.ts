/**
 * Registry der Lohnexport-Adapter.
 *
 * Abrechnungsformate sind Landesrecht: DATEV LODAS ist ein deutsches
 * Format, ein oesterreichischer oder Schweizer Kunde braucht ein anderes.
 * Statt eines Formats fest in der Route steht hier eine kleine Registry;
 * die Route `/export.datev` schlaegt den Adapter `lodas` nach und bleibt
 * unveraendert, damit bestehende Lesezeichen und die Oberflaeche weiter
 * funktionieren. Ein neues Land bringt eine Datei daneben und einen Eintrag
 * in EXPORTERS mit.
 */
import type { CountryCode } from '@ohrganize/shared';
import type { CompanySettings } from '../../../core/settings.js';
import { lodasExporter } from './lodas.js';

/** Abrechnungslauf, so viel davon ein Adapter braucht. */
export interface PayrollExportRun {
  id: number;
  /** Abrechnungsmonat 'JJJJ-MM'. */
  month: string;
  status: string;
}

/** Eine Zeile des Laufs, angereichert um den Namen der Person. */
export interface PayrollExportItem {
  employee_id: number;
  gross_cents: number;
  bonus_cents: number;
  total_cents: number;
  components_json: string;
  bonuses_json: string;
  flags_json: string;
  warnings_json: string;
  unpaid_absence_days: number;
  first_name?: string;
  last_name?: string;
  employee_type?: string;
}

export interface PayrollExporter {
  /** Schluessel in der Registry und im Audit-Eintrag des Exports. */
  id: string;
  country: CountryCode;
  label: string;
  contentType: string;
  filename(run: PayrollExportRun): string;
  render(
    run: PayrollExportRun,
    items: readonly PayrollExportItem[],
    settings: CompanySettings,
  ): string;
}

/** Alle bekannten Adapter, Schluessel ist `PayrollExporter.id`. */
export const PAYROLL_EXPORTERS: Record<string, PayrollExporter> = {
  [lodasExporter.id]: lodasExporter,
};

export function payrollExporter(id: string): PayrollExporter {
  const exporter = PAYROLL_EXPORTERS[id];
  if (!exporter) throw new Error(`Unbekannter Lohnexport-Adapter: ${id}`);
  return exporter;
}

/** Adapter eines Landes (Auswahlliste, spaeter mehrere je Land). */
export function payrollExportersFor(country: CountryCode): PayrollExporter[] {
  return Object.values(PAYROLL_EXPORTERS).filter((e) => e.country === country);
}

/** Betrag in Cent als Dezimaldarstellung mit Komma ('1234,56'). */
export function decimalComma(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
