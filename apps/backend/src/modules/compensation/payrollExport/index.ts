/**
 * Registry der Lohnexport-Adapter.
 *
 * Abrechnungsformate sind Landesrecht: DATEV LODAS und DATEV Lohn und
 * Gehalt sind deutsche Formate, ein oesterreichischer oder Schweizer Kunde
 * braucht andere. Statt eines Formats fest in der Route steht hier eine
 * kleine Registry; die Route `/export.datev` schlaegt den Adapter aus der
 * Einstellung `datevProgramm` nach. Ein neues Land bringt eine Datei
 * daneben und einen Eintrag in PAYROLL_EXPORTERS mit.
 *
 * Alle Adapter lesen denselben Kontext (context.ts) und denselben
 * Pruefbericht (check.ts); sie formatieren nur. Das Ergebnis ist ein Buffer
 * im Zeichensatz des Zielprogramms (Windows-1252), nie ein String.
 */
import type {
  CountryCode,
  DatevCheckReport,
  DatevExportKind,
  DatevProgram,
  DatevStammdatenScope,
} from '@ohrganize/shared';
import type { DatevExportContext, DatevPerson } from './context.js';
import { lodasExporter } from './lodas.js';
import { lugExporter } from './lug.js';

export interface DatevFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface PayrollExporter {
  /** Schluessel in der Registry, Einstellung `datevProgramm` und Audit-Eintrag. */
  id: DatevProgram;
  country: CountryCode;
  label: string;
  /** Welche Dateien der Adapter liefert. */
  kinds: DatevExportKind[];
  /** Personen, die eine Datei enthaelt (Sperre und Hinweisdaten betreffen nur sie). */
  persons(kind: DatevExportKind, ctx: DatevExportContext, scope: DatevStammdatenScope): DatevPerson[];
  render(
    kind: DatevExportKind,
    ctx: DatevExportContext,
    options: { scope: DatevStammdatenScope; report: DatevCheckReport },
  ): DatevFile;
}

/** Alle bekannten Adapter, Schluessel ist `PayrollExporter.id`. */
export const PAYROLL_EXPORTERS: Record<DatevProgram, PayrollExporter> = {
  lodas: lodasExporter,
  lug: lugExporter,
};

export function payrollExporter(id: string): PayrollExporter {
  const exporter = (PAYROLL_EXPORTERS as Record<string, PayrollExporter | undefined>)[id];
  if (!exporter) throw new Error(`Unbekannter Lohnexport-Adapter: ${id}`);
  return exporter;
}

/** Adapter eines Landes (Auswahl der Einstellungen, Pruefung der Route). */
export function payrollExportersFor(country: CountryCode): PayrollExporter[] {
  return Object.values(PAYROLL_EXPORTERS).filter((e) => e.country === country);
}

/** Betrag in Cent als Dezimaldarstellung mit Komma ('1234,56'), fuer den CSV-Export. */
export function decimalComma(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
