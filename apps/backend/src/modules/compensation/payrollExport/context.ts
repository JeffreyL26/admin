/**
 * Alles, was ein DATEV-Adapter und der Pruefbericht ueber einen
 * Abrechnungslauf wissen muessen, in EINER Struktur aus der Datenbank
 * gelesen. Die Adapter (lodas.ts, lug.ts) und die Pruefung (check.ts)
 * arbeiten nur auf dieser Struktur; so laesst sich beides mit einem festen
 * Kontext testen (src/test/datevTest.ts), ohne Datenbank.
 *
 * Die Positionen (Komponenten, Boni, Flags, Warnungen) kommen aus dem
 * Snapshot des Laufs (payroll_items), die Stammdaten aus der Personalakte zum
 * Zeitpunkt des Exports (ein Lauf friert Betraege ein, nicht Adressen), die
 * Fehltage aus den genehmigten Abwesenheiten des Monats. Gelesen wird in
 * Sammelabfragen (Region ueber REGION_SELECT_SQL, Vertrag als Unterabfrage),
 * nicht je Person: better-sqlite3 laeuft synchron, waehrenddessen wartet
 * jede andere Anfrage, auch das Portal.
 */
import type { CountryCode, DatevFestbezuegeMode, DatevProgram } from '@ohrganize/shared';
import { getDb } from '../../../db/db.js';
import { type CompanySettings, getAllSettings } from '../../../core/settings.js';
import { addDaysIso, eachDay, isWeekend } from '../../../core/dates.js';
import { isHoliday } from '../../../core/holidays.js';
import {
  closureDates,
  REGION_JOIN_SQL,
  REGION_SELECT_SQL,
  regionSelectParams,
} from '../../absences/service.js';
import { monthBounds, PERSONNEL_KEY_SQL } from '../lib.js';

export interface DatevSettings {
  program: DatevProgram;
  beraterNr: string;
  mandantenNr: string;
  betrieblichePnr: boolean;
  festbezuege: DatevFestbezuegeMode;
  vertragsstunden: boolean;
  /** Gespeicherte Lohnartennummer je DatevLohnartKey; fehlt ein Schluessel, ist er nicht zugeordnet (kein Rueckfall auf den Vorschlag). */
  lohnarten: Record<string, string>;
  /** Ausfallschluessel je Abwesenheitsart (Schluessel ist die id als Text). */
  ausfallschluessel: Record<string, string>;
  companyName: string;
}

export function datevSettingsFrom(s: CompanySettings): DatevSettings {
  return {
    program: s.datevProgramm,
    beraterNr: s.datevBeraterNr.trim(),
    mandantenNr: s.datevMandantenNr.trim(),
    betrieblichePnr: s.datevBetrieblichePnr,
    festbezuege: s.datevFestbezuege,
    vertragsstunden: s.datevVertragsstunden,
    lohnarten: { ...s.datevLohnarten },
    ausfallschluessel: s.datevAusfallschluessel,
    companyName: s.companyName,
  };
}

/**
 * Ein Fehltag im Abrechnungsmonat: nur Arbeitstage (ohne Wochenende,
 * Feiertage der Region und Betriebsruhe, wie countAbsenceDays im
 * Abwesenheitsmodul) und je Person und Tag hoechstens EIN Eintrag.
 */
export interface DatevAbsenceDay {
  date: string;
  type_id: number;
  type_name: string;
  category: string;
  half: boolean;
}

export interface DatevPerson {
  employee_id: number;
  /** Schluessel im Export: Personalnummer, ersatzweise die Profil-ID als Text. */
  pnr: string;
  has_personnel_number: boolean;
  first_name: string;
  last_name: string;
  birth_date: string | null;
  private_street: string | null;
  private_zip: string | null;
  private_city: string | null;
  private_country: string | null;
  iban: string | null;
  bic: string | null;
  tax_id: string | null;
  tax_class: string | null;
  church_tax: string | null;
  child_allowances: number | null;
  social_security_number: string | null;
  health_insurance: string | null;
  employee_type: string;
  job_title: string | null;
  hire_date: string | null;
  exit_date: string | null;
  weekly_hours: number | null;
  /** Vertragsart am Monatsende, bei Austritt im Monat am Austrittstag (contracts); null ohne Vertrag. */
  contract_type: string | null;
  /** Personalakte seit Monatsbeginn geaendert (Stammdaten, genehmigte Aenderungsantraege). */
  changed_in_month: boolean;
  /** Komponentenarten, die beendet sind und keine Nachfolgezeile haben (Festbezug auf 0 setzen). */
  ended_kinds: string[];
  /** Darunter: seit Beginn des Vormonats beendet (zaehlt als Aenderung). */
  ended_recently: boolean;
  /**
   * Aus dem Snapshot des Laufs; `hours` traegt der Stundenlohn (Vertragsstunden,
   * mit denen der Lauf rechnete), `valid_from` den Beginn der Zeile (eine im
   * Monat beginnende ohne Vorgaenger setzt kein Flag „Gehaltsaenderung“).
   */
  components: { kind: string; amount_cents: number; monthly_cents: number; hours?: number; valid_from?: string }[];
  bonuses: { id: number; kind: string; title: string; payout_cents: number }[];
  flags: string[];
  warnings: string[];
  absences: DatevAbsenceDay[];
}

export interface DatevExportContext {
  run: { id: number; month: string; status: string };
  settings: DatevSettings;
  persons: DatevPerson[];
  /** Abwesenheitsarten ohne Ausfallschluessel, die im Monat vorkamen. */
  unmapped_absence_types: { id: number; name: string }[];
  /** Personalnummern von Profilen AUSSERHALB des Laufs (Kollisionspruefung des Ersatzschluessels). */
  other_personnel_numbers: { employee_id: number; personnel_number: string }[];
  /** Zeitpunkt des Exports fuer die Hinweisdaten, Ortszeit TT.MM.JJJJ, HH:MM. */
  generated_at: string;
}

/** Felder einer Person, die die Abfrage unveraendert aus `employees` liest. */
type StammFelder = Omit<
  DatevPerson,
  | 'pnr'
  | 'has_personnel_number'
  | 'changed_in_month'
  | 'ended_kinds'
  | 'ended_recently'
  | 'components'
  | 'bonuses'
  | 'flags'
  | 'warnings'
  | 'absences'
>;

interface ItemRow extends StammFelder {
  components_json: string;
  bonuses_json: string;
  flags_json: string;
  warnings_json: string;
  /** PERSONNEL_KEY_SQL: Personalnummer, ersatzweise die Profil-ID. */
  pnr: string;
  has_personnel_number: number;
  changed_in_month: number;
  country: CountryCode;
  bundesland: string;
}

interface AbsenceRow {
  employee_id: number;
  type_id: number;
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  name: string;
  category: string;
}

/** Welcher Eintrag gewinnt, wenn zwei genehmigte Abwesenheiten denselben Tag decken: Krankheit vor allem anderen, ganzer vor halbem Tag. */
function outranks(a: DatevAbsenceDay, b: DatevAbsenceDay): boolean {
  const sickA = a.category === 'krankheit';
  const sickB = b.category === 'krankheit';
  if (sickA !== sickB) return sickA;
  return !a.half && b.half;
}

/**
 * Genehmigte Abwesenheiten des Monats als Arbeitstage je Person des Laufs.
 * Wochenenden, Feiertage der Region und Betriebsruhe fallen weg (dieselbe
 * Zaehlung wie days_counted): Ein Kalendarium meldet Fehltage, an denen
 * gearbeitet worden waere. Ueberschneiden sich zwei Abwesenheiten (Krankheit
 * im Urlaub ist erlaubt), steht der Tag einmal da, als Krankheit.
 */
function absenceDays(
  runId: number,
  month: string,
  regions: Map<number, { country: CountryCode; region: string }>,
): Map<number, DatevAbsenceDay[]> {
  const { start, end } = monthBounds(month);
  const rows = getDb()
    .prepare(
      `SELECT r.employee_id, r.type_id, r.date_from, r.date_to, r.half_day_start, r.half_day_end,
              t.name, t.category
       FROM absence_requests r
       JOIN absence_types t ON t.id = r.type_id
       JOIN payroll_items i ON i.employee_id = r.employee_id AND i.run_id = ?
       WHERE r.status = 'genehmigt' AND r.date_from <= ? AND r.date_to >= ?
       ORDER BY r.employee_id, r.date_from`,
    )
    .all([runId, end, start]) as AbsenceRow[];
  const closures = closureDates(start, end);
  const byPerson = new Map<number, Map<string, DatevAbsenceDay>>();
  for (const r of rows) {
    const region = regions.get(r.employee_id);
    if (!region) continue;
    const from = r.date_from > start ? r.date_from : start;
    const to = r.date_to < end ? r.date_to : end;
    const days = byPerson.get(r.employee_id) ?? new Map<string, DatevAbsenceDay>();
    for (const d of eachDay(from, to)) {
      if (isWeekend(d) || closures.has(d) || isHoliday(d, region.country, region.region)) continue;
      const entry: DatevAbsenceDay = {
        date: d,
        type_id: r.type_id,
        type_name: r.name,
        category: r.category,
        half: (d === r.date_from && r.half_day_start === 1) || (d === r.date_to && r.half_day_end === 1),
      };
      const existing = days.get(d);
      if (!existing || outranks(entry, existing)) days.set(d, entry);
    }
    byPerson.set(r.employee_id, days);
  }
  const result = new Map<number, DatevAbsenceDay[]>();
  for (const [id, days] of byPerson) {
    result.set(id, [...days.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }
  return result;
}

/** Beendete Komponentenarten je Person des Laufs: letzter valid_to vor Monatsbeginn. */
function endedComponents(runId: number, start: string): Map<number, { kind: string; last_to: string }[]> {
  const rows = getDb()
    .prepare(
      `SELECT c.employee_id, c.kind, MAX(c.valid_to) AS last_to
       FROM salary_components c
       JOIN payroll_items i ON i.employee_id = c.employee_id AND i.run_id = ?
       WHERE c.valid_to IS NOT NULL AND c.valid_to < ?
       GROUP BY c.employee_id, c.kind`,
    )
    .all([runId, start]) as { employee_id: number; kind: string; last_to: string }[];
  const result = new Map<number, { kind: string; last_to: string }[]>();
  for (const r of rows) {
    const list = result.get(r.employee_id) ?? [];
    list.push({ kind: r.kind, last_to: r.last_to });
    result.set(r.employee_id, list);
  }
  return result;
}

/** Ortszeit des Servers als TT.MM.JJJJ, HH:MM (die Hinweisdaten liest ein Mensch). */
function localTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildDatevContext(run: { id: number; month: string; status: string }): DatevExportContext {
  const settings = datevSettingsFrom(getAllSettings());
  const { start, end } = monthBounds(run.month);
  const previousMonthStart = `${addDaysIso(start, -1).slice(0, 7)}-01`;
  // Vertragsart am Monatsende, bei Austritt im Monat am Austrittstag: Ein
  // Vertrag, der mit einem Eintritt zur Monatsmitte beginnt, gilt am
  // Monatsersten noch nicht.
  const refDate = 'CASE WHEN e.exit_date IS NOT NULL AND e.exit_date < ? THEN e.exit_date ELSE ? END';
  const db = getDb();
  // updated_at ist datetime('now'), also UTC; der Monatsbeginn ist Ortszeit.
  // datetime(?, 'utc') rechnet den lokalen Monatsersten in UTC um, sonst
  // fehlten Aenderungen aus den ersten Stunden des Monats.
  const rows = db
    .prepare(
      `SELECT i.employee_id, i.components_json, i.bonuses_json, i.flags_json, i.warnings_json,
              ${REGION_SELECT_SQL},
              ${PERSONNEL_KEY_SQL} AS pnr,
              (NULLIF(TRIM(e.personnel_number), '') IS NOT NULL) AS has_personnel_number,
              e.first_name, e.last_name, e.birth_date,
              e.private_street, e.private_zip, e.private_city, e.private_country,
              e.iban, e.bic, e.tax_id, e.tax_class, e.church_tax, e.child_allowances,
              e.social_security_number, e.health_insurance, e.employee_type, e.job_title,
              e.hire_date, e.exit_date, e.weekly_hours,
              (e.updated_at >= datetime(?, 'utc')) AS changed_in_month,
              (SELECT c.contract_type FROM contracts c
                WHERE c.employee_id = e.id
                  AND c.valid_from <= ${refDate}
                  AND (c.valid_to IS NULL OR c.valid_to >= ${refDate})
                ORDER BY c.valid_from DESC, c.id DESC LIMIT 1) AS contract_type
       FROM payroll_items i JOIN employees e ON e.id = i.employee_id
       ${REGION_JOIN_SQL}
       WHERE i.run_id = ? ORDER BY e.last_name, e.first_name`,
    )
    .all([...regionSelectParams(), start, end, end, end, end, run.id]) as ItemRow[];
  const regions = new Map(rows.map((r) => [r.employee_id, { country: r.country, region: r.bundesland }]));
  const absences = absenceDays(run.id, run.month, regions);
  const ended = endedComponents(run.id, start);
  const unmapped = new Map<number, string>();
  const persons: DatevPerson[] = rows.map((r) => {
    const {
      components_json,
      bonuses_json,
      flags_json,
      warnings_json,
      has_personnel_number,
      changed_in_month,
      country: _country,
      bundesland: _bundesland,
      ...stamm
    } = r;
    const days = absences.get(r.employee_id) ?? [];
    for (const d of days) {
      if (!settings.ausfallschluessel[String(d.type_id)]) unmapped.set(d.type_id, d.type_name);
    }
    const components = JSON.parse(components_json) as DatevPerson['components'];
    const current = new Set(components.map((c) => c.kind));
    const endedKinds = (ended.get(r.employee_id) ?? []).filter((e) => !current.has(e.kind));
    return {
      ...stamm,
      has_personnel_number: has_personnel_number === 1,
      changed_in_month: changed_in_month === 1,
      ended_kinds: endedKinds.map((e) => e.kind),
      ended_recently: endedKinds.some((e) => e.last_to >= previousMonthStart),
      components,
      bonuses: JSON.parse(bonuses_json),
      flags: JSON.parse(flags_json),
      warnings: JSON.parse(warnings_json),
      absences: days,
    };
  });
  const otherNumbers = db
    .prepare(
      `SELECT e.id AS employee_id, TRIM(e.personnel_number) AS personnel_number FROM employees e
       WHERE NULLIF(TRIM(e.personnel_number), '') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM payroll_items i WHERE i.run_id = ? AND i.employee_id = e.id)`,
    )
    .all(run.id) as { employee_id: number; personnel_number: string }[];
  return {
    run: { id: run.id, month: run.month, status: run.status },
    settings,
    persons,
    unmapped_absence_types: [...unmapped].map(([id, name]) => ({ id, name })),
    other_personnel_numbers: otherNumbers,
    generated_at: localTimestamp(new Date()),
  };
}
