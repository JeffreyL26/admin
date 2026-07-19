import { getDb } from '../../db/db.js';
import { notFound, badRequest, conflict } from '../../core/errors.js';
import { addDaysIso } from '../../core/dates.js';
import {
  HOURLY_MONTH_FACTOR,
  SALARY_DEDUCTION_KINDS,
  type SalaryComponentKind,
} from '@hrmonic/shared';

/** Relevante Spalten der employees-Kerntabelle (nur lesend, Kontrakt 100_employees_core). */
export interface EmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  employee_type: string;
  status: string;
  iban: string | null;
  tax_id: string | null;
  social_security_number: string | null;
  hire_date: string | null;
  exit_date: string | null;
  weekly_hours: number | null;
  job_title: string | null;
}

export function getEmployee(id: number): EmployeeRow {
  const row = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as
    | EmployeeRow
    | undefined;
  if (!row) throw notFound('Mitarbeiter:in nicht gefunden');
  return row;
}

/** Existiert eine Tabelle (Fremdmodul evtl. noch nicht migriert)? */
export function tableExists(name: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** Spaltennamen einer Tabelle (für defensive Fremdtabellen-Zugriffe). */
export function tableColumns(name: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

export function assertMonth(month: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw badRequest('Monat muss das Format JJJJ-MM haben');
  }
}

/** Erster und letzter Kalendertag eines Monats 'YYYY-MM'. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Monatswert einer Komponente in Cent. VEREINFACHUNG (dokumentiert):
 * - stundenlohn: Cent/Stunde × Wochenstunden × 4,33 (Ø Wochen je Monat),
 *   kaufmännisch gerundet. Keine Ist-Stunden-Erfassung.
 * - Abzugsarten (bav_entgeltumwandlung, abzug_sonstig) gehen negativ ein.
 */
export function monthlyCents(
  kind: SalaryComponentKind | string,
  amountCents: number,
  weeklyHours: number | null,
): number {
  const base =
    kind === 'stundenlohn'
      ? Math.round(amountCents * (weeklyHours ?? 40) * HOURLY_MONTH_FACTOR)
      : amountCents;
  return (SALARY_DEDUCTION_KINDS as string[]).includes(kind) ? -base : base;
}

export interface SalaryComponentRow {
  id: number;
  employee_id: number;
  kind: string;
  amount_cents: number;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
  created_at: string;
}

/** Am Stichtag gültige Komponenten einer Mitarbeiter:in. */
export function componentsAt(employeeId: number, date: string): SalaryComponentRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM salary_components
       WHERE employee_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
       ORDER BY kind, valid_from`,
    )
    .all(employeeId, date, date) as SalaryComponentRow[];
}

/** Aktuelles Monatsbrutto (Summe der Monatswerte aller heute gültigen Komponenten). */
export function currentMonthlyGross(employee: EmployeeRow, date: string): number {
  return componentsAt(employee.id, date).reduce(
    (sum, c) => sum + monthlyCents(c.kind, c.amount_cents, employee.weekly_hours),
    0,
  );
}

/**
 * Fügt eine Gehaltskomponente ein und schließt die offene Vorgängerzeile
 * gleicher Art (valid_to = Vortag) — lückenlose Historie. MUSS innerhalb einer
 * Transaktion aufgerufen werden. Überschneidungs-Check → 409:
 * - vorhandene Zeile gleicher Art beginnt am/nach dem neuen Stichtag, oder
 * - eine bereits geschlossene Zeile gleicher Art reicht über den Stichtag hinaus.
 */
export function insertSalaryComponent(
  employeeId: number,
  kind: string,
  amountCents: number,
  validFrom: string,
  note: string | null,
): SalaryComponentRow {
  const db = getDb();
  const laterOrEqual = db
    .prepare(
      `SELECT 1 FROM salary_components WHERE employee_id = ? AND kind = ? AND valid_from >= ?`,
    )
    .get(employeeId, kind, validFrom);
  if (laterOrEqual) {
    throw conflict(
      'Es existiert bereits eine Komponente dieser Art mit gleichem oder späterem Gültigkeitsbeginn',
    );
  }
  const closedOverlap = db
    .prepare(
      `SELECT 1 FROM salary_components
       WHERE employee_id = ? AND kind = ? AND valid_to IS NOT NULL AND valid_to >= ?`,
    )
    .get(employeeId, kind, validFrom);
  if (closedOverlap) {
    throw conflict('Der Gültigkeitsbeginn überschneidet sich mit einer bereits geschlossenen Komponente');
  }
  // Offene Vorgängerzeile lückenlos schließen (valid_to = Vortag).
  db.prepare(
    `UPDATE salary_components SET valid_to = ?
     WHERE employee_id = ? AND kind = ? AND valid_to IS NULL AND valid_from < ?`,
  ).run(addDaysIso(validFrom, -1), employeeId, kind, validFrom);
  const info = db
    .prepare(
      `INSERT INTO salary_components (employee_id, kind, amount_cents, valid_from, note)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(employeeId, kind, amountCents, validFrom, note);
  return db
    .prepare('SELECT * FROM salary_components WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as SalaryComponentRow;
}

export interface GoalRow {
  id: number;
  employee_id: number;
  title: string;
  progress: number;
  status: string;
}

/**
 * Ziele einer Mitarbeiter:in aus dem Leistungs-Modul (Kontrakt:
 * goals(id, employee_id, title, progress 0–100, status)). Nur lesend;
 * funktioniert auch, wenn die Tabelle (noch) nicht existiert → leer.
 */
export function goalsForEmployee(employeeId: number): GoalRow[] {
  if (!tableExists('goals')) return [];
  return getDb()
    .prepare('SELECT id, employee_id, title, progress, status FROM goals WHERE employee_id = ?')
    .all(employeeId) as GoalRow[];
}

export function goalById(goalId: number): GoalRow | null {
  if (!tableExists('goals')) return null;
  return (getDb()
    .prepare('SELECT id, employee_id, title, progress, status FROM goals WHERE id = ?')
    .get(goalId) ?? null) as GoalRow | null;
}

/**
 * Zielgekoppelter Auszahlungsbetrag: target_amount_cents × progress/100,
 * kaufmännisch gerundet. Fehlt das Ziel (Tabelle leer/fehlend), gilt progress 0.
 */
export function goalPayoutCents(targetCents: number, goal: GoalRow | null): number {
  const progress = Math.max(0, Math.min(100, goal?.progress ?? 0));
  return Math.round((targetCents * progress) / 100);
}
