/**
 * Self-Service: eigene Vergütungsdaten (/api/me/salary, /salary/history,
 * /bonuses, /freelancer).
 *
 * DATENSCHUTZ — der Kern dieser Datei: die Vergütungstabellen (Migration
 * 400_compensation) führen mehrere HR-interne Spalten, die im Portal nichts zu
 * suchen haben:
 *   - `salary_components.note`  — Begründungen aus Gehaltsänderungsanträgen
 *     ("Änderungsantrag #<id>: <reason>", Verhandlungsstand, Vermerke),
 *   - `bonuses.note` und `bonuses.goal_id` — interne Notiz bzw. die Kopplung an
 *     ein Ziel des Leistungs-Moduls (das Zielobjekt selbst bleibt ebenfalls
 *     draußen; die HR-Ansicht liefert es, das Portal nicht),
 *   - `freelancer_invoices.note` und `.file_id` — Prüfvermerke und der interne
 *     Dateiverweis,
 *   - `salary_change_requests`, `payroll_items`, `certificates` — hier gar nicht
 *     angefasst; sie enthalten Begründungen, Warnungen und Snapshots aus der
 *     Sachbearbeitung.
 * Deshalb: KEIN `SELECT *` und KEIN `{ ...row }` in dieser Datei. Jedes Feld der
 * Antwort wird einzeln gesetzt — so kann eine später ergänzte Spalte nicht
 * versehentlich ins Portal durchrutschen.
 *
 * Alle Routen sind lesend; ein Audit-Eintrag entsteht daher nicht.
 */
import type { FastifyInstance } from 'fastify';
import type {
  BonusKind,
  BonusStatus,
  FreelancerInvoiceStatus,
  FreelancerRateUnit,
  MeBonus,
  MeFreelancer,
  MeSalary,
  MeSalaryComponent,
  SalaryComponentKind,
} from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { todayIso } from '../../core/dates.js';
import {
  componentsAt,
  currentMonthlyGross,
  getEmployee,
  goalPayoutCents,
  goalsForEmployee,
  monthlyCents,
} from '../compensation/lib.js';
import { requireEmployee } from './lib.js';

/** Die Felder, aus denen eine Portal-Komponente gebaut wird — bewusst ohne `note`. */
interface ComponentFields {
  id: number;
  kind: string;
  amount_cents: number;
  valid_from: string;
  valid_to: string | null;
}

/**
 * Monatswert einer Komponente — ehrlich statt geschätzt.
 *
 * `monthlyCents()` rechnet einen Stundenlohn mit den Wochenstunden hoch und
 * fällt dabei still auf 40 h zurück, wenn keine hinterlegt sind. In der
 * HR-Ansicht ist das eine akzeptable Schätzung; im Portal wäre es eine Zahl,
 * die die Mitarbeitenden als Zusage ihres Monatsbruttos lesen. Fehlen die
 * Wochenstunden, liefern wir für Stundenlohn-Komponenten deshalb 0 statt einer
 * erfundenen Hochrechnung. Der Client kann den Fall am `weekly_hours: null`
 * der Antwort erkennen und ihn erklären. Alle anderen Arten sind bereits
 * Monatsbeträge und von den Wochenstunden unabhängig — sie bleiben exakt.
 */
function honestMonthlyCents(kind: string, amountCents: number, weeklyHours: number | null): number {
  if (kind === 'stundenlohn' && weeklyHours === null) return 0;
  return monthlyCents(kind, amountCents, weeklyHours);
}

/** Baut die Portal-Sicht einer Komponente Feld für Feld (kein Spread, siehe Kopf). */
function toComponent(row: ComponentFields, weeklyHours: number | null): MeSalaryComponent {
  return {
    id: row.id,
    kind: row.kind as SalaryComponentKind,
    amount_cents: row.amount_cents,
    monthly_cents: honestMonthlyCents(row.kind, row.amount_cents, weeklyHours),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
  };
}

export async function meSalaryRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------ aktuelles Gehalt ---
  app.get('/api/me/salary', async (req) => {
    const me = requireEmployee(req);
    // requireEmployee liefert die Abwesenheits-Sicht der Zeile; getEmployee gibt
    // dieselbe Zeile mit den Vergütungsfeldern (weekly_hours, employee_type).
    const employee = getEmployee(me.id);
    const today = todayIso();
    const rows = componentsAt(employee.id, today);
    const hasHourly = rows.some((c) => c.kind === 'stundenlohn');
    const salary: MeSalary = {
      weekly_hours: employee.weekly_hours,
      // Ohne Wochenstunden lässt sich ein Stundenlohn nicht seriös auf den Monat
      // rechnen; dann bleibt das Monatsbrutto ehrlich 0, statt über den
      // 40-h-Rückfall in currentMonthlyGross eine Zahl zu behaupten.
      monthly_gross_cents:
        hasHourly && employee.weekly_hours === null ? 0 : currentMonthlyGross(employee, today),
      components: rows.map((row) => toComponent(row, employee.weekly_hours)),
    };
    return { salary };
  });

  // --------------------------------------------------------------- Historie ---
  app.get('/api/me/salary/history', async (req) => {
    const me = requireEmployee(req);
    const employee = getEmployee(me.id);
    const rows = getDb()
      .prepare(
        // Spalten einzeln: `note` bleibt HR-intern (siehe Dateikopf).
        `SELECT id, kind, amount_cents, valid_from, valid_to
         FROM salary_components
         WHERE employee_id = ?
         ORDER BY valid_from DESC, kind`,
      )
      .all(employee.id) as ComponentFields[];
    return { components: rows.map((row) => toComponent(row, employee.weekly_hours)) };
  });

  // ------------------------------------------------------------------- Boni ---
  app.get('/api/me/bonuses', async (req) => {
    const me = requireEmployee(req);
    const rows = getDb()
      .prepare(
        // `note` bleibt draußen. `goal_id` wird nur zur Berechnung geladen und
        // NICHT ausgeliefert — welches Ziel an einem Bonus hängt, ist Sache der
        // HR-Ansicht.
        `SELECT id, kind, title, amount_cents, target_amount_cents, goal_id,
                payout_month, status, created_at
         FROM bonuses
         WHERE employee_id = ?
         ORDER BY payout_month DESC, id DESC`,
      )
      .all(me.id) as {
      id: number;
      kind: string;
      title: string;
      amount_cents: number | null;
      target_amount_cents: number | null;
      goal_id: number | null;
      payout_month: string;
      status: string;
      created_at: string;
    }[];

    // Alle Ziele der Person in EINER Abfrage; danach Zuordnung im Speicher
    // (goalById je Bonus wäre eine N+1-Abfrage).
    const goalsById = new Map(goalsForEmployee(me.id).map((g) => [g.id, g]));

    const bonuses: MeBonus[] = rows.map((row) => {
      // Bei Auszahlung friert die HR-Ansicht den berechneten Betrag in
      // amount_cents ein; ab dann ist er fest. Solange das nicht geschehen ist,
      // ist ein zielgekoppelter Bonus volatil — daher is_projected.
      const isProjected = row.goal_id !== null && row.amount_cents === null;
      const payout = isProjected
        ? goalPayoutCents(row.target_amount_cents ?? 0, goalsById.get(row.goal_id as number) ?? null)
        : row.amount_cents ?? 0;
      return {
        id: row.id,
        kind: row.kind as BonusKind,
        title: row.title,
        amount_cents: row.amount_cents,
        target_amount_cents: row.target_amount_cents,
        payout_cents: payout,
        is_projected: isProjected,
        payout_month: row.payout_month,
        status: row.status as BonusStatus,
        created_at: row.created_at,
      };
    });
    return { bonuses };
  });

  // ---------------------------------------------------------- Freiberufler ---
  app.get('/api/me/freelancer', async (req) => {
    const me = requireEmployee(req);
    const employee = getEmployee(me.id);
    // Honorare gibt es nur für employee_type='freiberufler'. Für alle anderen
    // Beschäftigungsarten antwortet die Route mit leeren Listen statt 403 —
    // das Portal kann den Bereich damit still ausblenden.
    if (employee.employee_type !== 'freiberufler') {
      const empty: MeFreelancer = { rates: [], invoices: [] };
      return empty;
    }

    const rates = getDb()
      .prepare(
        `SELECT id, description, rate_cents, unit, valid_from
         FROM freelancer_rates
         WHERE employee_id = ?
         ORDER BY valid_from DESC, id DESC`,
      )
      .all(employee.id) as {
      id: number;
      description: string;
      rate_cents: number;
      unit: string;
      valid_from: string;
    }[];

    const invoices = getDb()
      .prepare(
        // Ohne `note` (Prüfvermerke der HR) und ohne `file_id` (interner
        // Dateiverweis) — siehe Dateikopf.
        `SELECT id, invoice_number, invoice_date, period, amount_cents, hours, status, paid_date
         FROM freelancer_invoices
         WHERE employee_id = ?
         ORDER BY invoice_date DESC, id DESC`,
      )
      .all(employee.id) as {
      id: number;
      invoice_number: string;
      invoice_date: string;
      period: string | null;
      amount_cents: number;
      hours: number | null;
      status: string;
      paid_date: string | null;
    }[];

    const freelancer: MeFreelancer = {
      rates: rates.map((r) => ({
        id: r.id,
        description: r.description,
        rate_cents: r.rate_cents,
        unit: r.unit as FreelancerRateUnit,
        valid_from: r.valid_from,
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        invoice_number: i.invoice_number,
        invoice_date: i.invoice_date,
        period: i.period,
        amount_cents: i.amount_cents,
        hours: i.hours,
        status: i.status as FreelancerInvoiceStatus,
        paid_date: i.paid_date,
      })),
    };
    return freelancer;
  });
}
