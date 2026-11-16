import type { EntitlementDetail } from './leaveEntitlement.js';
import type { HomeOfficeException } from './homeOffice.js';
import { formatDate } from './common.js';
import { daysBetweenIso } from './license.js';
// Typen des Moduls Abwesenheitsmanagement.

export type AbsenceCategory = 'urlaub' | 'krankheit' | 'sonder';

export const ABSENCE_CATEGORY_LABELS: Record<AbsenceCategory, string> = {
  urlaub: 'Urlaub',
  krankheit: 'Krankheit',
  sonder: 'Sonderabwesenheit',
};

export type AbsenceRequestStatus = 'beantragt' | 'genehmigt' | 'abgelehnt' | 'storniert';

export const ABSENCE_STATUS_LABELS: Record<AbsenceRequestStatus, string> = {
  beantragt: 'Beantragt',
  genehmigt: 'Genehmigt',
  abgelehnt: 'Abgelehnt',
  storniert: 'Storniert',
};

/**
 * Schwelle der Kalender-Konflikterkennung: Ist an einem Tag mehr als dieser
 * Anteil eines Teams gleichzeitig abwesend (beantragt oder genehmigt), wird
 * der Tag als Konflikt markiert. Bewusst hart kodiert (keine Einstellung).
 */
export const ABSENCE_CONFLICT_THRESHOLD = 0.5;

/**
 * Sichtbarkeit einer Abwesenheitsart im Firmenkalender des Portals:
 * `name` zeigt die Art im Klartext, `neutral` maskiert sie zu „Abwesend“.
 */
export type PortalVisibility = 'name' | 'neutral';

export const PORTAL_VISIBILITY_LABELS: Record<PortalVisibility, string> = {
  name: 'Art im Klartext',
  neutral: 'Nur „Abwesend“',
};

export interface AbsenceType {
  id: number;
  name: string;
  category: AbsenceCategory;
  paid: number; // SQLite-Bool (0/1)
  affects_balance: number;
  requires_proof: number;
  requires_approval: number;
  color: string;
  max_days_per_year: number | null;
  active: number;
  portal_visibility: PortalVisibility;
  /**
   * Angereichert in der HR-Liste (GET /api/absences/types): Rollen-Allowlist
   * und Personenregeln zur Anzeige. Leere Rollenliste ⇒ alle Rollen dürfen
   * (die Liste filtert nicht). Feldnamen wie im Backend (absences/routes.ts).
   */
  eligible_role_ids?: number[];
  employee_rules?: AbsenceTypeEligibility['employee_rules'];
}

/**
 * Wer darf eine Abwesenheitsart beantragen? Rollen-Allowlist (leere Liste ⇒
 * alle Rollen dürfen) plus Personenregeln, die die Rollenregel schlagen.
 * Die Kategorie `krankheit` ist von der Prüfung ausgenommen.
 */
export interface AbsenceTypeEligibility {
  role_ids: number[];
  employee_rules: { employee_id: number; effect: 'allow' | 'deny' }[];
}

export interface AbsenceRequest {
  id: number;
  employee_id: number;
  type_id: number;
  date_from: string; // ISO YYYY-MM-DD
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  days_counted: number;
  status: AbsenceRequestStatus;
  comment: string | null;
  rejection_reason: string | null;
  decided_by_user_id: number | null;
  decided_at: string | null;
  created_by_user_id: number | null;
  created_at: string;
  // Angereichert in Listen-Antworten:
  first_name?: string;
  last_name?: string;
  type_name?: string;
  type_color?: string;
  type_category?: AbsenceCategory;
  /** Nur Self-Service (/api/me/leave-requests): Name der entscheidenden Person. */
  decided_by_name?: string | null;
  /**
   * Anlegende Person in Listen-Antworten. `created_by_proxy` 1 heisst: das
   * anlegende Konto gehoert nicht der betroffenen Person, die HR hat also
   * stellvertretend erfasst (ein Admin mit eigenem Profil, der fuer sich
   * selbst beantragt, zaehlt nicht als stellvertretend).
   */
  created_by_name?: string | null;
  created_by_proxy?: number;
  /** 1: erst die Betriebsruhe bringt den Zeitraum auf 0 Tage (Anzeige „Betriebsruhe“ statt 0; beim Zaehlen gespeichert). */
  closure_covered?: number;
}

/**
 * Zeitabschnitt eines saldowirksamen Antrags im Jahr: genehmigte Anträge
 * zerfallen in den bis heute genommenen und den ab morgen verplanten Teil,
 * beantragte sind ein einziger verplanter Abschnitt.
 */
export interface AbsenceBalanceBreakdownSegment {
  request_id: number;
  type_name: string;
  type_color: string;
  status: AbsenceRequestStatus;
  kind: 'taken' | 'planned';
  date_from: string;
  date_to: string;
  days: number;
}

/** Wann was genommen/verplant ist; liefert nur GET /api/absences/balance/:employeeId/:year. */
export interface AbsenceBalanceBreakdown {
  /** Letzter Tag, bis zu dem "genommen" zählt; null, wenn das Jahr noch nicht begonnen hat. */
  taken_until: string | null;
  segments: AbsenceBalanceBreakdownSegment[];
}

export interface AbsenceBalance {
  employee_id: number;
  year: number;
  entitlement: number;
  /** Aufteilung des Anspruchs nach BUrlG (leaveEntitlement.ts). */
  entitlement_detail?: EntitlementDetail;
  carryover: number;
  carryover_expired: boolean;
  taken: number;
  planned: number;
  remaining: number;
  first_name?: string;
  last_name?: string;
  breakdown?: AbsenceBalanceBreakdown;
}

/**
 * Antwort der Antragsvorschau (`GET /api/absences/preview`,
 * `GET /api/me/leave-preview`). Bei flexibler Arbeitswoche ist
 * `days_counted` ein Vorschlag; das Formular fragt nach den tatsächlichen
 * Arbeitstagen (höchstens `weekdays`) und schickt sie als `days_override`.
 */
export interface LeavePreview {
  days_counted: number;
  bundesland: string;
  region: string;
  country: string;
  flexible: boolean;
  days_per_week: number;
  weekdays: number | null;
}

export interface SickNote {
  id: number;
  absence_request_id: number;
  certificate_file_id: number | null;
  certificate_due_date: string;
  received_date: string | null;
  follow_up_of_id: number | null;
  child_sick: number;
  created_at: string;
  // Angereichert:
  employee_id?: number;
  first_name?: string;
  last_name?: string;
  date_from?: string;
  date_to?: string;
  days_counted?: number;
  request_status?: AbsenceRequestStatus;
  /** 1: erst die Betriebsruhe bringt den Zeitraum auf 0 Tage (Anzeige „Betriebsruhe“ statt 0; beim Zaehlen gespeichert). */
  closure_covered?: number;
  /** Bereits angefallene Fehltage (Arbeitstage von Beginn bis heute). */
  days_absent_so_far?: number;
  /** Kalendertage seit Beginn der AU-Kette (Erst- + Folgebescheinigungen), bis heute. */
  sick_pay_days_used?: number;
  /** Entgeltfortzahlung (42 Kalendertage) überzogen. */
  sick_pay_exceeded?: boolean;
}

/** Entgeltfortzahlung im Krankheitsfall: 6 Wochen = 42 Kalendertage. */
export const SICK_PAY_LIMIT_DAYS = 42;

/** Glied einer AU-Kette: Erst- oder Folgebescheinigung (follow_up_of_id). */
export interface SickChainNote {
  id: number;
  follow_up_of_id: number | null;
  date_from: string;
  date_to: string;
}

/**
 * Umfang der AU-Kette jeder Krankmeldung: frühester Beginn und spätestes Ende
 * aller Bescheinigungen, die über follow_up_of_id an derselben
 * Erstbescheinigung hängen. Ein Verweis auf eine Bescheinigung außerhalb der
 * Liste (storniert, nicht geladen) beendet die Kette dort, ein Ring bricht ab.
 * Die Liste enthält deshalb alle nicht stornierten Krankmeldungen der
 * Personen, nicht nur die angezeigten.
 */
export function sickChainSpans(notes: readonly SickChainNote[]): Map<number, { from: string; to: string }> {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const rootOf = (note: SickChainNote): number => {
    let cur = note;
    const seen = new Set<number>();
    while (cur.follow_up_of_id !== null && byId.has(cur.follow_up_of_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.follow_up_of_id)!;
    }
    return cur.id;
  };
  const byRoot = new Map<number, { from: string; to: string }>();
  const spans = new Map<number, { from: string; to: string }>();
  for (const n of notes) {
    const root = rootOf(n);
    let chain = byRoot.get(root);
    if (!chain) {
      chain = { from: n.date_from, to: n.date_to };
      byRoot.set(root, chain);
    } else {
      if (n.date_from < chain.from) chain.from = n.date_from;
      if (n.date_to > chain.to) chain.to = n.date_to;
    }
    spans.set(n.id, chain);
  }
  return spans;
}

/** Ab sechs Wochen (42 Kalendertagen) gilt eine Abwesenheit als lang, wie bei der Entgeltfortzahlung. */
export const LONG_ABSENCE_DAYS = SICK_PAY_LIMIT_DAYS;

/**
 * Lange Abwesenheit, die heute andauert: Zusatz zum Status „Aktiv“ in
 * Personalliste, Personalakte und Gehaltsübersicht (longAbsenceFor). Die
 * Antworten tragen ihn nur für Konten mit `abwesenheit: lesen`.
 */
export interface LongAbsence {
  /** 'sonder': Sonderabwesenheit wie Elternzeit oder Mutterschutz; 'krankheit': eigene AU-Kette. */
  kind: 'sonder' | 'krankheit';
  /** Name der Abwesenheitsart, bei Krankheit „Langzeitkrank“. */
  label: string;
  /** Beginn des Antrags bzw. der AU-Kette. */
  since: string;
  /** Ende des Antrags bzw. der letzten Bescheinigung der Kette. */
  until: string;
}

/**
 * Regel des Zusatzes für EINE Person. `specialLeaves` sind ihre genehmigten
 * Anträge der Kategorie 'sonder', `sickNotes` alle nicht stornierten
 * Krankmeldungen (für die Kette, siehe sickChainSpans).
 * - Sonderabwesenheit: deckt heute ab und dauert mindestens sechs Wochen;
 *   kurze Arten wie Umzug oder Bildungsurlaub bleiben außen vor. Bei mehreren
 *   gilt die, die am längsten reicht.
 * - Krankheit: eine eigene Krankmeldung (nicht Kind krank) deckt heute ab,
 *   und ihre AU-Kette läuft seit mehr als sechs Wochen, die
 *   Entgeltfortzahlung ist also vorbei (dieselbe Zählung wie
 *   sick_pay_exceeded der Krankmeldungen).
 * Die Sonderabwesenheit geht vor: Wer in Elternzeit krank wird, bleibt in
 * Elternzeit.
 */
export function longAbsenceFor(
  today: string,
  specialLeaves: readonly { type_name: string; date_from: string; date_to: string }[],
  sickNotes: readonly (SickChainNote & { child_sick: number })[],
): LongAbsence | null {
  let leave: LongAbsence | null = null;
  for (const r of specialLeaves) {
    if (r.date_from > today || r.date_to < today) continue;
    if (daysBetweenIso(r.date_from, r.date_to) + 1 < LONG_ABSENCE_DAYS) continue;
    if (!leave || r.date_to > leave.until) {
      leave = { kind: 'sonder', label: r.type_name, since: r.date_from, until: r.date_to };
    }
  }
  if (leave) return leave;
  const spans = sickChainSpans(sickNotes);
  for (const n of sickNotes) {
    if (n.child_sick !== 0 || n.date_from > today || n.date_to < today) continue;
    const chain = spans.get(n.id);
    if (chain && daysBetweenIso(chain.from, today) + 1 > SICK_PAY_LIMIT_DAYS) {
      return { kind: 'krankheit', label: 'Langzeitkrank', since: chain.from, until: chain.to };
    }
  }
  return null;
}

/** Text des Zusatzes: „Elternzeit bis 31.03.2027“ bzw. „Langzeitkrank seit 01.09.2026“. */
export function longAbsenceText(a: LongAbsence): string {
  return a.kind === 'krankheit' ? `${a.label} seit ${formatDate(a.since)}` : `${a.label} bis ${formatDate(a.until)}`;
}

export interface CompanyClosure {
  id: number;
  date_from: string;
  date_to: string;
  name: string;
}

export interface CalendarAbsenceEntry {
  request_id: number;
  type_id: number;
  type_name: string;
  color: string;
  status: AbsenceRequestStatus;
  date_from: string;
  date_to: string;
  half_day_start: number;
  half_day_end: number;
  /** Gezählte Tage wie in der Antragsliste (ohne Wochenenden/Feiertage/Betriebsruhe, halbe Tage 0,5). */
  days_counted: number;
  /** 1: erst die Betriebsruhe bringt den Zeitraum auf 0 Tage (Anzeige „Betriebsruhe“ statt 0; beim Zaehlen gespeichert). */
  closure_covered?: number;
}

export interface CalendarEmployee {
  id: number;
  first_name: string;
  last_name: string;
  department_id: number | null;
  team_id: number | null;
  bundesland: string;
  /** Arbeitswoche (workSchedule.ts): Tage außerhalb fester Wochentage zeigt der Kalender wie Wochenenden. */
  work_weekdays?: string | null;
  work_days_per_week?: number | null;
  /** Home-Office-Muster und abweichende Tage im Zeitraum (homeOffice.ts). */
  home_office_weekdays?: string | null;
  home_office?: HomeOfficeException[];
  absences: CalendarAbsenceEntry[];
}

export interface CalendarConflict {
  date: string;
  team_id: number;
  absent: number;
  team_size: number;
  ratio: number;
}

/**
 * Schrift der Artbezeichnung im Kalenderbalken — identisch in Desktop-App
 * (.hm-cal__bar-label) und Portal (.pt-cal__bar-label); die Clients messen
 * damit, ob ein Balken breit genug für seinen Schriftzug ist.
 */
export const ABSENCE_BAR_LABEL_FONT = "650 11px 'Creato Display', 'Plus Jakarta Sans Variable', 'Segoe UI', system-ui, sans-serif";
