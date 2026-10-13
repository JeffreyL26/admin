/**
 * DATEV LODAS, ASCII-Import (Schnittstellenhandbuch SSH LODAS, Fach 3 und 4).
 * Zwei Dateien je Abrechnungslauf:
 *
 *   Bewegungsdaten   u_lod_bwd_buchung_standard (Einmalzahlungen mit
 *                    Bearbeitungsschluessel 2, Stunden mit 1, Nettoabzuege
 *                    mit 3) und u_lod_bwd_buchung_kalendarium (Fehltage mit
 *                    Ausfallschluessel). Wiederkehrende Bezuege stehen hier
 *                    nur, wenn die Einstellung „Festbezuege“ auf
 *                    Bewegungsdaten steht.
 *   Stammdaten       u_lod_psd_mitarbeiter, _ma_bank, _steuer, _taetigkeit,
 *                    _beschaeftigung, der Stundensatz
 *                    (u_lod_psd_lohn_festbezuege) und (Vorgabe) die
 *                    Festbezuege u_lod_psd_festbezuege und Nettoabzuege
 *                    u_lod_psd_nettobeabzug, gueltig ab dem Monatsersten.
 *
 * Aufbau jeder Datei: [Allgemein] (Ziel, Berater, Mandant, Trenner, Komma,
 * Datumsformat, Stringbegrenzer), [Satzbeschreibung] (aus LODAS_SATZ in
 * packages/shared/src/datev.ts), die Daten, dann [Hinweisdaten] mit den
 * Warnungen des Pruefberichts zu genau dieser Datei, die LODAS im
 * Pruefprotokoll anzeigt. Zeichensatz Windows-1252, Satzende CR/LF, jeder
 * Satz endet mit dem Feldtrenner, Text steht in Stringbegrenzern, Zahlen
 * und Datumswerte nicht. Was in welche Datei kommt, entscheidet positions.ts.
 */
import {
  datevBetrag,
  datevDatum,
  datevStunden,
  datevZeitraum,
  DEFAULT_WEEKLY_HOURS,
  EMPLOYEE_TYPE_LABELS,
  HOURLY_MONTH_FACTOR,
  issuesForFile,
  LODAS_ARBEITSVERHAELTNIS,
  LODAS_BS,
  LODAS_KONFESSION,
  LODAS_LENGTH,
  LODAS_PERSONENGRUPPE,
  LODAS_SATZ,
  LODAS_STEUERKLASSE,
  lodasSatzbeschreibung,
  normalizeIban,
  normalizeSvNummer,
  splitStreet,
  type ChurchTax,
  type DatevCheckReport,
  type DatevExportKind,
  type DatevStammdatenScope,
  type EmployeeType,
  type TaxClass,
} from '@ohrganize/shared';
import type { DatevExportContext, DatevPerson } from './context.js';
import { addressExportable, personLabel, pnrMode } from './check.js';
import { encodeCp1252 } from './cp1252.js';
import { bewegungenOf, fehltageOf, festbezuegeOf } from './positions.js';
import type { DatevFile, PayrollExporter } from './index.js';

const SEP = ';';
const QUOTE = '"';

/** Textfeld: Zeilenumbrueche raus, innere Begrenzer zu Apostrophen, gekuerzt, in Begrenzern. */
function text(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const cleaned = value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim().slice(0, max);
  return cleaned ? `${QUOTE}${cleaned}${QUOTE}` : '';
}

/** Alphanumerisches Feld (as_kal): reine Ziffern ohne Begrenzer wie in der Mustervorlage, sonst als Text. */
function alnum(value: string, max: number): string {
  return /^\d+$/.test(value) ? value.slice(0, max) : text(value, max);
}

function date(iso: string | null | undefined): string {
  return iso ? datevDatum(iso) : '';
}

function record(satzart: number, fields: (string | number)[]): string {
  return [satzart, ...fields].join(SEP) + SEP;
}

/** Name und Wert des Schluesselfelds, je nach Einstellung und Abschnitt. */
function key(ctx: DatevExportContext, section: 'bwd' | 'psd') {
  if (pnrMode(ctx) === 'betrieblich') {
    return { name: 'pnr_betriebliche#psd', value: (p: DatevPerson) => text(p.pnr, LODAS_LENGTH.pnr_betriebliche) };
  }
  return { name: `pnr#${section}`, value: (p: DatevPerson) => p.pnr };
}

function header(ctx: DatevExportContext, stammdaten: boolean): string[] {
  const lines = [
    '[Allgemein]',
    'Ziel=LODAS',
    'Version_SST=1.0',
    `BeraterNr=${ctx.settings.beraterNr}`,
    `MandantenNr=${ctx.settings.mandantenNr}`,
    'Feldtrennzeichen=;',
    'Zahlenkomma=,',
    'Datumsformat=TT.MM.JJJJ',
    'Stringbegrenzer="',
    'Kommentarzeichen=*',
  ];
  if (stammdaten) lines.push(`StammdatenGueltigAb=${datevZeitraum(ctx.run.month)}`);
  if (pnrMode(ctx) === 'betrieblich') lines.push('BetrieblichePNrVerwenden=Ja');
  lines.push('');
  return lines;
}

/**
 * Die ganze Datei: Kopf, Satzbeschreibung, Daten, dann die Hinweisdaten mit
 * den Warnungen, die DIESE Datei betreffen (Dateiart und Personen darin),
 * und den Hinweisen des Adapters. LODAS zeigt sie im Pruefprotokoll.
 */
function lodasFile(
  ctx: DatevExportContext,
  report: DatevCheckReport,
  kind: DatevExportKind,
  persons: readonly DatevPerson[],
  satzbeschreibung: string[],
  data: string[],
  extra: string[],
): string {
  const [y, m] = ctx.run.month.split('-');
  const notes = [
    text(`oHRganize, ${ctx.settings.companyName}: Lohnexport ${m}/${y}, erzeugt ${ctx.generated_at}`, 200),
  ];
  const ids = new Set(persons.map((p) => p.employee_id));
  for (const issue of issuesForFile(report.issues, kind, ids)) {
    if (issue.level !== 'warnung') continue;
    const who = issue.person ? `${issue.person} (${issue.personnel_number}): ` : '';
    notes.push(text(`${who}${issue.message}`, 200));
  }
  for (const line of extra) notes.push(text(line, 200));
  return [
    ...header(ctx, kind === 'stammdaten'),
    '[Satzbeschreibung]',
    ...satzbeschreibung,
    '',
    kind === 'stammdaten' ? '[Stammdaten]' : '[Bewegungsdaten]',
    ...data,
    '',
    '[Hinweisdaten]',
    ...notes,
  ].join('\r\n') + '\r\n';
}

function lohnart(ctx: DatevExportContext, k: string): string {
  return (ctx.settings.lohnarten[k] ?? '').trim();
}

export function renderLodasBewegungsdaten(ctx: DatevExportContext, report: DatevCheckReport): string {
  const k = key(ctx, 'bwd');
  const zeitraum = datevZeitraum(ctx.run.month);
  const data: string[] = [];
  const extra: string[] = [];
  for (const p of ctx.persons) {
    const who = k.value(p);
    for (const b of bewegungenOf(ctx, p)) {
      if (b.type === 'stunden') {
        data.push(record(1, [zeitraum, who, LODAS_BS.stunden, datevStunden(b.hours), lohnart(ctx, b.key)]));
        extra.push(
          `${personLabel(p)} (${p.pnr}): ${datevStunden(b.hours)} Stunden sind Vertragsstunden (${p.weekly_hours ?? DEFAULT_WEEKLY_HOURS} h/Woche × ${String(HOURLY_MONTH_FACTOR).replace('.', ',')}), keine Ist-Stunden`,
        );
      } else {
        const bs = b.type === 'nettoabzug' ? LODAS_BS.nettoabzug : LODAS_BS.bruttobezug;
        data.push(record(1, [zeitraum, who, bs, datevBetrag(b.cents), lohnart(ctx, b.key)]));
      }
    }
    for (const a of fehltageOf(ctx, p)) {
      data.push(record(2, [zeitraum, who, a.date.slice(8, 10), alnum(a.as, LODAS_LENGTH.ausfallschluessel)]));
      if (a.half) extra.push(`${personLabel(p)} (${p.pnr}): ${datevDatum(a.date)} ${a.type_name} nur ein halber Tag`);
    }
  }
  const satzbeschreibung = [
    lodasSatzbeschreibung(1, LODAS_SATZ.buchung_standard, k.name),
    lodasSatzbeschreibung(2, LODAS_SATZ.buchung_kalendarium, k.name),
  ];
  return lodasFile(ctx, report, 'bewegungsdaten', ctx.persons, satzbeschreibung, data, extra);
}

/**
 * Personen, die der Stammdatenexport umfasst. „Aenderungen“ heisst: Eintritt,
 * Austritt oder Gehaltsaenderung im Monat, eine seit Monatsbeginn geaenderte
 * Personalakte (etwa eine genehmigte neue Bankverbindung) oder eine seit dem
 * Vormonat beendete Komponente.
 */
export function stammdatenPersons(ctx: DatevExportContext, scope: DatevStammdatenScope): DatevPerson[] {
  if (scope === 'alle') return ctx.persons;
  return ctx.persons.filter(
    (p) =>
      p.changed_in_month ||
      p.ended_recently ||
      p.flags.some((f) => f === 'neueintritt' || f === 'austritt' || f === 'gehaltsaenderung'),
  );
}

export function renderLodasStammdaten(
  ctx: DatevExportContext,
  report: DatevCheckReport,
  scope: DatevStammdatenScope,
): string {
  const k = key(ctx, 'psd');
  const festbezuege = ctx.settings.festbezuege === 'stammdaten';
  const satzbeschreibung = [
    lodasSatzbeschreibung(1, LODAS_SATZ.mitarbeiter, k.name),
    lodasSatzbeschreibung(2, LODAS_SATZ.bank, k.name),
    lodasSatzbeschreibung(3, LODAS_SATZ.steuer, k.name),
    lodasSatzbeschreibung(4, LODAS_SATZ.taetigkeit, k.name),
    lodasSatzbeschreibung(5, LODAS_SATZ.beschaeftigung, k.name),
    lodasSatzbeschreibung(7, LODAS_SATZ.stundenlohn, k.name),
  ];
  if (festbezuege) {
    satzbeschreibung.push(
      lodasSatzbeschreibung(6, LODAS_SATZ.festbezuege, k.name),
      lodasSatzbeschreibung(8, LODAS_SATZ.nettoabzug, k.name),
    );
  }
  const persons = stammdatenPersons(ctx, scope);
  const data: string[] = [];
  const extra: string[] = [];
  let derivedPersgrs = false;
  for (const p of persons) {
    const who = k.value(p);
    // Eine Anschrift, die nicht vollstaendig hinausgehen kann (Ausland,
    // ungueltige Postleitzahl), geht gar nicht: leere Felder lassen in LODAS
    // die bisherige Anschrift stehen, statt sie zu mischen.
    const exportable = addressExportable(p);
    const street = exportable ? splitStreet(p.private_street ?? '') : { name: '', number: '' };
    data.push(
      record(1, [
        who,
        text(p.last_name, LODAS_LENGTH.familienname),
        text(p.first_name, LODAS_LENGTH.vorname),
        text(street.name, LODAS_LENGTH.strassenname),
        text(street.number, LODAS_LENGTH.strasse_nr),
        exportable ? (p.private_zip?.trim() ?? '') : '',
        text(exportable ? p.private_city : '', LODAS_LENGTH.ort),
        date(p.birth_date),
        text(p.social_security_number ? normalizeSvNummer(p.social_security_number) : '', LODAS_LENGTH.sozialversicherung_nr),
      ]),
    );
    if (p.iban) {
      data.push(
        record(2, [
          who,
          text(normalizeIban(p.iban), LODAS_LENGTH.iban),
          text(p.bic?.trim().toUpperCase() ?? '', LODAS_LENGTH.bic),
        ]),
      );
    }
    if (p.tax_id || p.tax_class || p.church_tax) {
      const stKlasse = p.tax_class ? (LODAS_STEUERKLASSE[p.tax_class as TaxClass] ?? '') : '';
      const konf = p.church_tax ? (LODAS_KONFESSION[p.church_tax as ChurchTax] ?? '') : '';
      const kfb = p.child_allowances === null ? '' : p.child_allowances.toFixed(1).replace('.', ',');
      data.push(
        record(3, [who, text(p.tax_id?.replace(/[\s/]/g, '') ?? '', LODAS_LENGTH.identifikationsnummer), stKlasse, kfb, konf]),
      );
    }
    // Personengruppe nur beim Neueintritt: Bei bestehenden Personen bleibt
    // das Feld leer, sonst ueberschriebe die Ableitung, was das Lohnbuero in
    // LODAS korrigiert hat (Altersrentner, Altersteilzeit).
    const persgrs = p.flags.includes('neueintritt') ? LODAS_PERSONENGRUPPE[p.employee_type as EmployeeType] : undefined;
    if (persgrs !== undefined || p.job_title) {
      if (persgrs !== undefined) derivedPersgrs = true;
      data.push(record(4, [who, persgrs ?? '', text(p.job_title, LODAS_LENGTH.berufsbezeichnung)]));
    }
    if (p.hire_date || p.exit_date) {
      const arbeitsverhaeltnis = p.contract_type ? (LODAS_ARBEITSVERHAELTNIS[p.contract_type] ?? '') : '';
      data.push(record(5, [who, date(p.hire_date), date(p.exit_date), arbeitsverhaeltnis]));
    }
    const hourly = p.components.find((c) => c.kind === 'stundenlohn');
    if (hourly) data.push(record(7, [who, datevBetrag(hourly.amount_cents)]));
    for (const f of festbezuegeOf(ctx, p)) {
      if (f.type === 'festbezug') data.push(record(6, [who, f.id, lohnart(ctx, f.key), datevBetrag(f.cents)]));
      else data.push(record(8, [who, 1, lohnart(ctx, f.key), datevBetrag(f.cents)]));
    }
  }
  if (derivedPersgrs) {
    const pairs = Object.entries(LODAS_PERSONENGRUPPE)
      .map(([type, code]) => `${code} ${EMPLOYEE_TYPE_LABELS[type as EmployeeType] ?? type}`)
      .join(', ');
    extra.push(`Personengruppe (persgrs) nur bei Neueintritten, abgeleitet aus der Beschäftigungsart (${pairs}); Sonderfälle bitte in LODAS prüfen`);
  }
  if (festbezuege) {
    const [y, m] = ctx.run.month.split('-');
    extra.push(`Festbezüge, Stundensätze und Nettoabzüge gelten ab ${m}/${y}; ein Betrag von 0,00 beendet einen entfallenen Festbezug; Beträge ohne Vorzeichen, die Lohnart entscheidet über Bezug oder Abzug`);
  }
  return lodasFile(ctx, report, 'stammdaten', persons, satzbeschreibung, data, extra);
}

export const lodasExporter: PayrollExporter = {
  id: 'lodas',
  country: 'DE',
  label: 'DATEV LODAS',
  kinds: ['bewegungsdaten', 'stammdaten'],
  persons(kind, ctx, scope) {
    return kind === 'stammdaten' ? stammdatenPersons(ctx, scope) : ctx.persons;
  },
  render(kind, ctx, options): DatevFile {
    const body =
      kind === 'stammdaten'
        ? renderLodasStammdaten(ctx, options.report, options.scope)
        : renderLodasBewegungsdaten(ctx, options.report);
    return {
      filename: `lodas_${kind}_${ctx.run.month}.txt`,
      contentType: 'text/plain; charset=windows-1252',
      content: encodeCp1252(body),
    };
  },
};
