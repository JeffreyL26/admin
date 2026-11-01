/**
 * Jahresurlaubsanspruch einer Person nach BUrlG, getrennt in gesetzlichen
 * Mindesturlaub, vertraglichen Mehrurlaub und Zusatzurlaub bei
 * Schwerbehinderung. DOM-frei, damit Backend (Saldo) und Oberfläche
 * (Hinweise im Formular) dieselbe Rechnung zeigen; Test
 * apps/backend/src/test/leaveEntitlementTest.ts.
 *
 * Regeln:
 * - Mindesturlaub (§ 3 BUrlG): 24 Werktage bei sechs Tagen, also vier Wochen,
 *   umgerechnet 4 × Arbeitstage je Woche (20 bei fünf, 12 bei drei Tagen).
 * - Voller Anspruch erstmals nach sechs Monaten (Wartezeit, § 4). Ein
 *   Zwölftel je vollem Beschäftigungsmonat (§ 5 Abs. 1) nur, wenn die
 *   Wartezeit im Kalenderjahr nicht erfüllt wird (Eintritt nach dem 1. Juli),
 *   wenn jemand vor erfüllter Wartezeit ausscheidet oder nach erfüllter
 *   Wartezeit in der ersten Jahreshälfte. Bruchteile ab einem halben Tag
 *   werden aufgerundet (§ 5 Abs. 2), kleinere bleiben stehen.
 * - Vertraglicher Mehrurlaub ist, was `annual_leave_days` über dem Minimum
 *   liegt; er wird bei unterjährigem Ein- oder Austritt immer gezwölftelt
 *   (Entscheidung des Anbieters, auf halbe Tage gerundet). Liegt der
 *   eingetragene Wert unter dem Minimum, gilt das Minimum.
 * - Zusatzurlaub bei Schwerbehinderung (§ 208 SGB IX) ab einem Grad von 50:
 *   eine Arbeitswoche (5 Tage bei fünf Arbeitstagen), nicht bei
 *   Gleichstellung; unterjährig wie der Mindesturlaub (§ 208 Abs. 2, 3).
 * - Ohne bekannte Arbeitswoche gibt es keinen gesetzlichen Teil und keinen
 *   Zusatzurlaub (er bemisst sich an der Woche): Der ganze Wert gilt als
 *   vertraglich und wird gezwölftelt wie vor der Umstellung. Vollzeit und
 *   Ausbildung gelten ohne Angabe als fünf Tage, freie Mitarbeit hat keinen
 *   Anspruch (`entitlementDaysPerWeek`).
 */
import { addDaysIso, addMonthsIso, formatDate } from './common.js';
import { parseWeekdays } from './workSchedule.js';

export interface EntitlementInput {
  hire_date: string | null;
  exit_date: string | null;
  annual_leave_days: number | null;
  /** Arbeitstage je Woche; null = unbekannt (kein gesetzlicher Teil). */
  days_per_week: number | null;
  /** Grad der Behinderung; Zusatzurlaub ab 50. */
  disability_degree?: number | null;
  /** Gleichgestellt (§ 2 Abs. 3 SGB IX): kein Zusatzurlaub. */
  disability_equal?: boolean;
}

export interface EntitlementParts {
  statutory: number;
  contractual: number;
  disability: number;
  total: number;
}

export interface EntitlementDetail extends EntitlementParts {
  /** Volle Beschäftigungsmonate im Jahr (0 bis 12). */
  months: number;
  /** Anspruch, wenn das ganze Jahr beschäftigt (zum Vergleich). */
  full_year: EntitlementParts;
  /** Weicht vom Ganzjahreswert ab (unterjähriger Ein- oder Austritt). */
  prorated: boolean;
  /** Ist der Mindesturlaub berechnet (Arbeitswoche bekannt)? */
  statutory_known: boolean;
  /**
   * Nur bei mehreren Zeitabschnitten im Jahr (Wechsel der Arbeitswoche oder
   * des Jahresurlaubs, leaveEntitlementForPeriods): Beitrag je Abschnitt.
   */
  periods?: EntitlementPeriodPart[];
}

/** Tage auf zwei Stellen, ohne Gleitkommareste (8,333 statt 8,3333333). */
const round2 = (n: number) => Math.round(n * 100) / 100;
const roundHalf = (n: number) => Math.round(n * 2) / 2;

/** § 5 Abs. 2 BUrlG: ab einem halben Tag aufrunden, sonst stehen lassen. */
function roundStatutory(n: number): number {
  const whole = Math.floor(n + 1e-9);
  return n - whole >= 0.5 - 1e-9 ? whole + 1 : round2(n);
}

/** Mindesturlaub in Tagen bei `daysPerWeek` Arbeitstagen (§ 3 BUrlG). */
export function statutoryLeaveDays(daysPerWeek: number): number {
  return round2(4 * daysPerWeek);
}

/** Ende einer Frist von `months` Monaten ab `start` (§§ 187 Abs. 2, 188 BGB). */
function periodEnd(start: string, months: number): string {
  const target = addMonthsIso(start, months);
  return target.slice(8) !== start.slice(8) ? target : addDaysIso(target, -1);
}

/** Volle Monate von `start` bis einschließlich `end`, höchstens 12. */
export function fullMonthsBetween(start: string, end: string): number {
  let months = 0;
  while (months < 12 && periodEnd(start, months + 1) <= end) months++;
  return months;
}

export function leaveEntitlementFor(input: EntitlementInput, year: number): EntitlementDetail {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const annual = Math.max(0, input.annual_leave_days ?? 0);
  const known = input.days_per_week !== null && input.days_per_week > 0;
  const statutoryFull = known ? statutoryLeaveDays(input.days_per_week!) : 0;
  const disabilityFull =
    known && (input.disability_degree ?? 0) >= 50 && !input.disability_equal ? round2(input.days_per_week!) : 0;
  const contractualFull = Math.max(0, round2(annual - statutoryFull));
  const full: EntitlementParts = {
    statutory: statutoryFull,
    contractual: contractualFull,
    disability: disabilityFull,
    total: round2(statutoryFull + contractualFull + disabilityFull),
  };

  const start = input.hire_date && input.hire_date > yearStart ? input.hire_date : yearStart;
  const end = input.exit_date && input.exit_date < yearEnd ? input.exit_date : yearEnd;
  if (start > yearEnd || end < yearStart || start > end) {
    return {
      statutory: 0, contractual: 0, disability: 0, total: 0,
      months: 0, full_year: full, prorated: full.total > 0, statutory_known: known,
    };
  }
  const months = fullMonthsBetween(start, end);

  // Gesetzlicher Teil (und Zusatzurlaub): voll oder gezwölftelt nach § 5 Abs. 1.
  const waitingEnd = input.hire_date ? periodEnd(input.hire_date, 6) : null;
  const exitThisYear = input.exit_date !== null && input.exit_date >= yearStart && input.exit_date <= yearEnd;
  const hiredThisYear = input.hire_date !== null && input.hire_date >= yearStart;
  const waitingNotInYear = hiredThisYear && waitingEnd !== null && waitingEnd > yearEnd;
  const leavesBeforeWaiting = exitThisYear && waitingEnd !== null && input.exit_date! < waitingEnd;
  const leavesFirstHalf = exitThisYear && input.exit_date! <= `${year}-06-30`;
  const statutoryPartial = waitingNotInYear || leavesBeforeWaiting || leavesFirstHalf;
  const partial = (n: number) => (statutoryPartial ? roundStatutory((n * months) / 12) : n);

  const statutory = partial(statutoryFull);
  const disability = partial(disabilityFull);
  const contractual = months >= 12 ? contractualFull : roundHalf((contractualFull * months) / 12);
  const total = round2(statutory + contractual + disability);
  return {
    statutory,
    contractual,
    disability,
    total,
    months,
    full_year: full,
    prorated: total !== full.total,
    statutory_known: known,
  };
}

/**
 * Zeitabschnitt eines Jahres mit eigener Arbeitswoche und eigenem
 * Jahresurlaub, in der Regel eine Vertragsversion (beide Grenzen
 * einschließlich).
 */
export interface EntitlementPeriod {
  from: string;
  to: string;
  annual_leave_days: number | null;
  /** Wie EntitlementInput.days_per_week; null = unbekannt. */
  days_per_week: number | null;
}

/** Anteil eines Abschnitts am Anspruch des Jahres (für die Anzeige). */
export interface EntitlementPeriodPart {
  from: string;
  to: string;
  annual_leave_days: number | null;
  days_per_week: number | null;
  /** Tage, die dieser Abschnitt zum Anspruch des Jahres beiträgt. */
  total: number;
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Anteil von from bis to (einschließlich) an einem Jahr, in Monaten
 * gemessen: ein voller Kalendermonat zählt 1/12, ein angebrochener
 * tagesgenau seinen Teil davon. So ergibt ein Wechsel zum Monatsersten genau
 * die Monate (9/12 und 3/12).
 */
function yearShare(from: string, to: string): number {
  let share = 0;
  for (let d = from; d <= to; ) {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(5, 7));
    const monthEnd = `${d.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
    const end = monthEnd < to ? monthEnd : to;
    share += (Number(end.slice(8)) - Number(d.slice(8)) + 1) / daysInMonth(y, m);
    d = addDaysIso(end, 1);
  }
  return share / 12;
}

/**
 * Anspruch eines Jahres aus Zeitabschnitten mit eigener Arbeitswoche und
 * eigenem Jahresurlaub (Vertragsversionen): Ändert sich die Arbeitswoche im
 * Lauf des Jahres, rechnet jeder Abschnitt nach `leaveEntitlementFor` und
 * zählt mit seinem Anteil an der Beschäftigungszeit des Jahres
 * (Zeitabschnitte wie in der Rechtsprechung zu § 3 BUrlG; in Vollzeit
 * erworbener Urlaub wird durch Teilzeit nicht gekürzt). Ein- und Austritt
 * regelt weiter `leaveEntitlementFor` je Abschnitt. Mit nur einem Abschnitt
 * ist das Ergebnis genau `leaveEntitlementFor`; sonst trägt es `periods`.
 * Die Abschnitte sollen das Jahr lückenlos abdecken (der Aufrufer füllt
 * Lücken mit den Werten der Personalakte).
 */
export function leaveEntitlementForPeriods(
  input: Omit<EntitlementInput, 'annual_leave_days' | 'days_per_week'>,
  periods: readonly EntitlementPeriod[],
  year: number,
): EntitlementDetail {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const start = input.hire_date && input.hire_date > yearStart ? input.hire_date : yearStart;
  const end = input.exit_date && input.exit_date < yearEnd ? input.exit_date : yearEnd;
  // Benachbarte Abschnitte mit gleicher Woche und gleichem Urlaub (etwa eine
  // Version, die nur Stunden oder Befristung ändert) sind für den Anspruch
  // EIN Abschnitt; sonst teilte jede Vertragsversion die Anzeige.
  const clipped: EntitlementPeriod[] = [];
  for (const p of periods) {
    const from = p.from > start ? p.from : start;
    const to = p.to < end ? p.to : end;
    if (from > to) continue;
    const prev = clipped[clipped.length - 1];
    if (
      prev &&
      addDaysIso(prev.to, 1) === from &&
      prev.annual_leave_days === p.annual_leave_days &&
      prev.days_per_week === p.days_per_week
    ) {
      prev.to = to;
    } else {
      clipped.push({ ...p, from, to });
    }
  }
  const single = (p: EntitlementPeriod | undefined) =>
    leaveEntitlementFor(
      { ...input, annual_leave_days: p?.annual_leave_days ?? null, days_per_week: p?.days_per_week ?? null },
      year,
    );
  if (clipped.length <= 1) return single(clipped[0] ?? periods[periods.length - 1]);

  const whole = yearShare(start, end);
  const parts = clipped.map((p) => ({ period: p, weight: yearShare(p.from, p.to) / whole, detail: single(p) }));
  const weighted = (pick: (d: EntitlementParts) => number) =>
    round2(parts.reduce((sum, x) => sum + pick(x.detail) * x.weight, 0));
  const weightedFull = (pick: (d: EntitlementParts) => number) =>
    round2(parts.reduce((sum, x) => sum + pick(x.detail.full_year) * x.weight, 0));
  const statutory = weighted((d) => d.statutory);
  const contractual = weighted((d) => d.contractual);
  const disability = weighted((d) => d.disability);
  const total = round2(statutory + contractual + disability);
  const fullStatutory = weightedFull((d) => d.statutory);
  const fullContractual = weightedFull((d) => d.contractual);
  const fullDisability = weightedFull((d) => d.disability);
  const full: EntitlementParts = {
    statutory: fullStatutory,
    contractual: fullContractual,
    disability: fullDisability,
    total: round2(fullStatutory + fullContractual + fullDisability),
  };
  // Beiträge je Abschnitt: Den Rundungsrest zur Summe trägt der größte, damit
  // die Beiträge genau den Anspruch ergeben und ein Abschnitt ohne Anspruch
  // (etwa freie Mitarbeit) bei 0 bleibt statt bei -0,01.
  const shares = parts.map((x) => round2(x.detail.total * x.weight));
  const largest = shares.reduce((best, s, i) => (s > shares[best] ? i : best), 0);
  shares[largest] = round2(total - shares.reduce((sum, s, i) => (i === largest ? sum : sum + s), 0));
  return {
    statutory,
    contractual,
    disability,
    total,
    months: parts[0].detail.months,
    full_year: full,
    prorated: total !== full.total,
    statutory_known: parts.some((x) => x.detail.statutory_known),
    periods: parts.map((x, i) => ({
      from: x.period.from,
      to: x.period.to,
      annual_leave_days: x.period.annual_leave_days,
      days_per_week: x.period.days_per_week,
      total: shares[i],
    })),
  };
}

/**
 * Arbeitstage je Woche für den Mindesturlaub: hinterlegte Arbeitswoche, sonst
 * fünf bei Vollzeit und Ausbildung, sonst unbekannt (null). Freie Mitarbeit
 * hat keinen Urlaubsanspruch nach BUrlG.
 */
export function entitlementDaysPerWeek(row: {
  employee_type: string;
  work_days_per_week?: number | null;
  work_weekdays?: string | null;
}): number | null {
  if (row.employee_type === 'freiberufler') return null;
  const fixed = parseWeekdays(row.work_weekdays)?.length ?? 0;
  if (fixed > 0) return fixed;
  if (row.work_days_per_week !== null && row.work_days_per_week !== undefined && row.work_days_per_week > 0) {
    return row.work_days_per_week;
  }
  return row.employee_type === 'vollzeit' || row.employee_type === 'auszubildender' ? 5 : null;
}

/**
 * Bestandteile des Anspruchs als kurze Texte, z. B. ["gesetzlich 20",
 * "vertraglich 2"]; Teile mit 0 fallen weg, der gesetzliche nur ohne bekannte
 * Arbeitswoche. `withDisability: false` rechnet den Zusatzurlaub in den
 * vertraglichen Teil ein, statt ihn zu nennen (Konten ohne Recht
 * "Schwerbehinderung", Portal).
 */
export function entitlementPartLabels(
  detail: EntitlementDetail,
  format: (n: number) => string,
  withDisability = true,
): string[] {
  const contractual = withDisability ? detail.contractual : round2(detail.contractual + detail.disability);
  const parts: string[] = [];
  if (detail.statutory_known) parts.push(`gesetzlich ${format(detail.statutory)}`);
  if (contractual > 0 || !detail.statutory_known) parts.push(`vertraglich ${format(contractual)}`);
  if (withDisability && detail.disability > 0) parts.push(`Zusatzurlaub ${format(detail.disability)}`);
  return parts;
}

/**
 * Hinweis bei mehreren Zeitabschnitten im Jahr (Vertragsversionen mit anderer
 * Arbeitswoche oder anderem Jahresurlaub), z. B. "je Zeitraum: 22,5 bis
 * 30.09.2026 (5 Tage je Woche, 30 Urlaubstage) + 4,5 ab 01.10.2026 (3 Tage je
 * Woche, 18 Urlaubstage)". "Zeitraum", nicht "Vertragsversion": Gleiche
 * Nachbarn sind einer, und was keine Version abdeckt, kommt aus der
 * Personalakte. Ohne Abschnitte null.
 */
export function entitlementPeriodNote(detail: EntitlementDetail, format: (n: number) => string): string | null {
  const periods = detail.periods;
  if (!periods || periods.length < 2) return null;
  const parts = periods.map((p, i) => {
    const range =
      i === 0
        ? `bis ${formatDate(p.to)}`
        : i === periods.length - 1
          ? `ab ${formatDate(p.from)}`
          : `${formatDate(p.from)} bis ${formatDate(p.to)}`;
    const values = [
      p.days_per_week !== null ? `${format(p.days_per_week)} Tage je Woche` : null,
      p.annual_leave_days !== null ? `${format(p.annual_leave_days)} Urlaubstage` : null,
    ].filter(Boolean);
    return `${format(p.total)} ${range}${values.length ? ` (${values.join(', ')})` : ''}`;
  });
  return `je Zeitraum: ${parts.join(' + ')}`;
}

/** Hinweis bei unterjährigem Anspruch, z. B. "anteilig, 6 von 12 Monaten (ganzes Jahr 30)". */
export function entitlementProrationNote(detail: EntitlementDetail, format: (n: number) => string): string | null {
  if (!detail.prorated) return null;
  return `anteilig, ${detail.months} von 12 Monaten (ganzes Jahr ${format(detail.full_year.total)})`;
}
