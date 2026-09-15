/**
 * DATEV-LODAS-ASCII-Export (Bewegungsdaten) fuer Deutschland, vereinfacht
 * aber strukturtreu:
 *
 *   [Allgemein]            Kopf mit Ziel=LODAS, Schnittstellen-Version,
 *                          Berater- und Mandantennummer (aus den
 *                          Einstellungen), Feldtrennzeichen und Zahlenkomma.
 *   [Satzbeschreibung]     Beschreibung der Bewegungsdaten-Satzart
 *                          u_lod_bwd_buchung_standard.
 *   [Bewegungsdaten]       Eine Zeile je Mitarbeiter:in und Lohnart:
 *                          1;<Abrechnungszeitraum TT.MM.JJJJ>;<Personalnummer>;
 *                          <Lohnart>;<Betrag mit Komma-Dezimale>
 *
 * Personalnummer = employee_id, Lohnart-Mapping siehe DATEV_LOHNART. Das
 * reale Mapping ist mandantenspezifisch und wird beim Steuerberater
 * gepflegt; die Nummernkreise hier sind an uebliche LODAS-Lohnartenkataloge
 * angelehnt.
 */
import type { CompanySettings } from '../../../core/settings.js';
import {
  decimalComma,
  type PayrollExportItem,
  type PayrollExporter,
  type PayrollExportRun,
} from './index.js';

const DATEV_LOHNART: Record<string, string> = {
  grundgehalt: '200',
  stundenlohn: '300',
  zulage_schicht: '210',
  zulage_erschwernis: '211',
  zulage_funktion: '212',
  sachbezug_dienstwagen: '860',
  sachbezug_jobticket: '861',
  sachbezug_essenszuschuss: '862',
  vwl: '510',
  bav_entgeltumwandlung: '590',
  abzug_sonstig: '900',
  bonus_zielbonus: '400',
  bonus_provision: '410',
  bonus_einmalzahlung: '420',
};

function germanDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export const lodasExporter: PayrollExporter = {
  id: 'lodas',
  country: 'DE',
  label: 'DATEV LODAS (Bewegungsdaten)',
  contentType: 'text/plain; charset=utf-8',
  filename: (run) => `lodas_bewegungsdaten_${run.month}.txt`,
  render(run: PayrollExportRun, items: readonly PayrollExportItem[], settings: CompanySettings) {
    const [y, m] = run.month.split('-');
    const zeitraum = `01.${m}.${y}`;
    const lines: string[] = [
      '[Allgemein]',
      'Ziel=LODAS',
      'Version_SST=1.0',
      `BeraterNr=${settings.datevBeraterNr}`,
      `MandantenNr=${settings.datevMandantenNr}`,
      'Feldtrennzeichen=;',
      'Zahlenkomma=,',
      `Datum=${germanDate(new Date())}`,
      '',
      '[Satzbeschreibung]',
      '1;u_lod_bwd_buchung_standard;abrechnung_zeitraum#bwd;pnr#bwd;lohnart_nummer#bwd;betrag#bwd;',
      '',
      '[Bewegungsdaten]',
    ];
    for (const item of items) {
      const components = JSON.parse(item.components_json) as {
        kind: string;
        monthly_cents: number;
      }[];
      for (const c of components) {
        lines.push(
          `1;${zeitraum};${item.employee_id};${DATEV_LOHNART[c.kind] ?? '999'};${decimalComma(Math.abs(c.monthly_cents))};`,
        );
      }
      const bonuses = JSON.parse(item.bonuses_json) as { kind: string; payout_cents: number }[];
      for (const b of bonuses) {
        lines.push(
          `1;${zeitraum};${item.employee_id};${DATEV_LOHNART[`bonus_${b.kind}`] ?? '999'};${decimalComma(b.payout_cents)};`,
        );
      }
    }
    return lines.join('\r\n') + '\r\n';
  },
};
