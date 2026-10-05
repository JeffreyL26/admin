import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { parse, conflict, notFound } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { getAllSettings, getSetting } from '../../core/settings.js';
import { MINIJOB_LIMIT_CENTS, formatMoney, localeFor, currencyFor, type PayrollFlag } from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { decimalComma, payrollExporter } from './payrollExport/index.js';
import {
  assertMonth,
  goalById,
  goalPayoutCents,
  monthBounds,
  monthlyCents,
  tableColumns,
  tableExists,
  type EmployeeRow,
  type SalaryComponentRow,
} from './lib.js';

/** Geldbetrag im Format des Variantenlandes (Sprachkennung und Waehrung). */
const money = (cents: number): string =>
  formatMoney(cents, localeFor(VARIANT.country), currencyFor(VARIANT.country));

interface PayrollRunRow {
  id: number;
  month: string;
  status: string;
  notes: string | null;
  created_at: string;
}

interface PayrollItemRow {
  id: number;
  run_id: number;
  employee_id: number;
  /** employees.personnel_number, ersatzweise die Profil-ID als Text (siehe getItems). */
  personnel_number: string;
  gross_cents: number;
  bonus_cents: number;
  total_cents: number;
  components_json: string;
  bonuses_json: string;
  flags_json: string;
  warnings_json: string;
  unpaid_absence_days: number;
}

/** Kalendertage-Überlappung zweier ISO-Intervalle (einschließlich). */
function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (from > to) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

interface AbsenceInterval {
  start: string;
  end: string;
}

/**
 * Defensive Integration mit dem Abwesenheits-Modul (paralleles Modul, Schema
 * nicht Teil des Kontrakts): liest genehmigte absence_requests per LEFT JOIN
 * auf die Abwesenheitsart und erkennt „unbezahlt"/„krank" heuristisch über
 * gängige Spaltennamen. Fehlen Tabellen/Spalten → leeres Ergebnis (robust
 * gegen leere/fehlende Befüllung).
 */
function absenceIntervals(kindFilter: 'unbezahlt' | 'krank'): Map<number, AbsenceInterval[]> {
  const result = new Map<number, AbsenceInterval[]>();
  try {
    if (!tableExists('absence_requests')) return result;
    const cols = tableColumns('absence_requests');
    const startCol = ['start_date', 'from_date', 'date_from'].find((c) => cols.includes(c));
    const endCol = ['end_date', 'to_date', 'date_to'].find((c) => cols.includes(c));
    if (!startCol || !endCol || !cols.includes('employee_id')) return result;
    const statusCond = cols.includes('status') ? `r.status = 'genehmigt'` : '1=1';

    // Art-Erkennung: bevorzugt über absence_types (Kategorie/Bezahlt-Flag),
    // sonst über eine kind-/category-Spalte direkt am Antrag.
    let typeCond = '1=0';
    let join = '';
    const typeFk = ['absence_type_id', 'type_id'].find((c) => cols.includes(c));
    if (typeFk && tableExists('absence_types')) {
      const tCols = tableColumns('absence_types');
      const parts: string[] = [];
      if (kindFilter === 'unbezahlt') {
        if (tCols.includes('paid')) parts.push('t.paid = 0');
        if (tCols.includes('is_paid')) parts.push('t.is_paid = 0');
        if (tCols.includes('unpaid')) parts.push('t.unpaid = 1');
      }
      for (const c of ['category', 'kind', 'code', 'name']) {
        if (tCols.includes(c)) parts.push(`LOWER(t.${c}) LIKE '%${kindFilter}%'`);
      }
      if (parts.length) {
        join = `LEFT JOIN absence_types t ON t.id = r.${typeFk}`;
        typeCond = parts.join(' OR ');
      }
    } else {
      const parts: string[] = [];
      for (const c of ['category', 'kind', 'type']) {
        if (cols.includes(c)) parts.push(`LOWER(r.${c}) LIKE '%${kindFilter}%'`);
      }
      if (parts.length) typeCond = parts.join(' OR ');
    }
    if (typeCond === '1=0') return result;

    // Kinderkrankentage laufen über Kinderkrankengeld und zählen NICHT in die
    // 6-Wochen-Entgeltfortzahlung — das Abwesenheitsmodul weist sie über
    // sick_notes.child_sick getrennt aus (dort fließen sie ebenfalls nicht in
    // sick_pay_exceeded ein). Ohne diesen Ausschluss verschmölze die
    // 42-Tage-Kette eigene Erkrankung und „Kind krank" (beide matchen
    // LIKE '%krank%') und das Flag lohnfortzahlung_ende erschiene zu früh.
    let childSickCond = '';
    if (kindFilter === 'krank' && cols.includes('id') && tableExists('sick_notes')) {
      const sCols = tableColumns('sick_notes');
      if (sCols.includes('absence_request_id') && sCols.includes('child_sick')) {
        childSickCond = ` AND NOT EXISTS (SELECT 1 FROM sick_notes sn
           WHERE sn.absence_request_id = r.id AND sn.child_sick = 1)`;
      }
    }

    const rows = getDb()
      .prepare(
        `SELECT r.employee_id, r.${startCol} AS start, r.${endCol} AS end
         FROM absence_requests r ${join}
         WHERE ${statusCond} AND (${typeCond})${childSickCond}`,
      )
      .all() as { employee_id: number; start: string; end: string }[];
    for (const row of rows) {
      if (!row.start || !row.end) continue;
      const list = result.get(row.employee_id) ?? [];
      list.push({ start: row.start, end: row.end });
      result.set(row.employee_id, list);
    }
  } catch {
    // Fremdschema unbekannt/abweichend → keine Abwesenheitsdaten (bewusst leise).
  }
  return result;
}

/** Angrenzende/überlappende Intervalle zu Perioden zusammenführen. */
function mergeIntervals(intervals: AbsenceInterval[]): AbsenceInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start));
  const merged: AbsenceInterval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    const lastEndPlus1 = last
      ? new Date(Date.parse(`${last.end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
      : '';
    if (last && iv.start <= lastEndPlus1) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

interface AssembledItem {
  employee: EmployeeRow;
  gross_cents: number;
  bonus_cents: number;
  total_cents: number;
  components: { kind: string; amount_cents: number; monthly_cents: number }[];
  bonuses: { id: number; kind: string; title: string; payout_cents: number }[];
  flags: PayrollFlag[];
  warnings: string[];
  unpaid_absence_days: number;
}

/**
 * Stellt die Bewegungsdaten eines Monats zusammen.
 *
 * DOKUMENTIERTE VEREINFACHUNGEN:
 * - Komponenten, die im Monat (auch nur teilweise) gültig sind, gehen mit dem
 *   VOLLEN Monatswert ein — keine anteilige Berechnung. Bei einer Änderung
 *   mitten im Monat zählt die neueste Zeile je Art (kein Doppelzählen).
 * - Stundenlohn: Cent/Stunde × Wochenstunden × 4,33, keine Ist-Stunden.
 * - Unbezahlte Abwesenheiten mindern das Brutto NICHT automatisch; sie werden
 *   als Tagesanzahl + Flag für die Sachbearbeitung ausgewiesen.
 */
function assembleMonth(month: string): AssembledItem[] {
  const db = getDb();
  const { start, end } = monthBounds(month);
  const employees = (db
    .prepare(
      `SELECT * FROM employees
       WHERE employee_type != 'freiberufler'
         AND (hire_date IS NULL OR hire_date <= ?)
         AND (exit_date IS NULL OR exit_date >= ?)
         AND NOT (status = 'ausgeschieden' AND exit_date IS NULL)
       ORDER BY last_name, first_name`,
    )
    .all(end, start) as EmployeeRow[]);

  const unpaidByEmployee = absenceIntervals('unbezahlt');
  const sickByEmployee = absenceIntervals('krank');

  // Sammelabfragen statt drei Queries je Person (Muster wie absenceIntervals):
  // better-sqlite3 läuft synchron im einzigen Node-Prozess — während der
  // Zusammenstellung wartet jeder andere Request, auch das Portal. Die
  // Gruppierung im Speicher hält die Reihenfolge der ORDER-BY-Klauseln, auf
  // die die Auswertung unten (neueste Zeile je Art) angewiesen ist.
  const componentsByEmployee = new Map<number, SalaryComponentRow[]>();
  const componentRows = db
    .prepare(
      `SELECT * FROM salary_components
       WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
       ORDER BY kind, valid_from DESC`,
    )
    .all([end, start]) as SalaryComponentRow[];
  for (const r of componentRows) {
    const list = componentsByEmployee.get(r.employee_id) ?? [];
    list.push(r);
    componentsByEmployee.set(r.employee_id, list);
  }

  interface MonthBonusRow {
    id: number;
    employee_id: number;
    kind: string;
    title: string;
    amount_cents: number | null;
    target_amount_cents: number | null;
    goal_id: number | null;
  }
  const bonusesByEmployee = new Map<number, MonthBonusRow[]>();
  const monthBonusRows = db
    .prepare(`SELECT * FROM bonuses WHERE payout_month = ? AND status = 'freigegeben'`)
    .all(month) as MonthBonusRow[];
  for (const b of monthBonusRows) {
    const list = bonusesByEmployee.get(b.employee_id) ?? [];
    list.push(b);
    bonusesByEmployee.set(b.employee_id, list);
  }

  const changedEmployeeIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT c.employee_id FROM salary_components c
           WHERE c.valid_from >= ? AND c.valid_from <= ?
             AND EXISTS (SELECT 1 FROM salary_components p
                         WHERE p.employee_id = c.employee_id AND p.kind = c.kind
                           AND p.valid_from < c.valid_from)`,
        )
        .all([start, end]) as { employee_id: number }[]
    ).map((r) => r.employee_id),
  );

  return employees.map((e) => {
    // Im Monat aktive Komponenten; je Art nur die neueste Zeile (voller Monatswert).
    const rows = componentsByEmployee.get(e.id) ?? [];
    const byKind = new Map<string, SalaryComponentRow>();
    for (const r of rows) if (!byKind.has(r.kind)) byKind.set(r.kind, r);
    const components = [...byKind.values()].map((c) => ({
      kind: c.kind,
      amount_cents: c.amount_cents,
      monthly_cents: monthlyCents(c.kind, c.amount_cents, e.weekly_hours),
      valid_from: c.valid_from,
    }));
    const gross = components.reduce((s, c) => s + c.monthly_cents, 0);

    // Freigegebene Boni mit payout_month = Monat.
    const bonusRows = bonusesByEmployee.get(e.id) ?? [];
    const bonuses = bonusRows.map((b) => ({
      id: b.id,
      kind: b.kind,
      title: b.title,
      payout_cents: b.goal_id
        ? b.amount_cents ?? goalPayoutCents(b.target_amount_cents ?? 0, goalById(b.goal_id))
        : b.amount_cents ?? 0,
    }));
    const bonusCents = bonuses.reduce((s, b) => s + b.payout_cents, 0);

    // Bewegungs-Flags.
    const flags: PayrollFlag[] = [];
    if (e.hire_date && e.hire_date >= start && e.hire_date <= end) flags.push('neueintritt');
    if (e.exit_date && e.exit_date >= start && e.exit_date <= end) flags.push('austritt');
    if (changedEmployeeIds.has(e.id)) flags.push('gehaltsaenderung');

    let unpaidDays = 0;
    for (const iv of unpaidByEmployee.get(e.id) ?? []) {
      unpaidDays += overlapDays(iv.start, iv.end, start, end);
    }
    if (unpaidDays > 0) flags.push('unbezahlte_abwesenheit');

    // Ende Lohnfortzahlung: eine zusammenhängende Krankheitsperiode, die bis
    // zum Monatsende bereits mehr als 42 Kalendertage am Stück umfasst.
    const sickPeriods = mergeIntervals(sickByEmployee.get(e.id) ?? []);
    const beyond42 = sickPeriods.some((p) => {
      if (p.start > end || p.end < start) return false;
      const effectiveEnd = p.end < end ? p.end : end;
      return overlapDays(p.start, effectiveEnd, p.start, effectiveEnd) > 42;
    });
    if (beyond42) flags.push('lohnfortzahlung_ende');

    // Prüfungen → Warnungen.
    const warnings: string[] = [];
    if (!e.iban) warnings.push('Fehlende IBAN');
    if (!e.tax_id) warnings.push('Fehlende Steuer-ID');
    if (!e.social_security_number) warnings.push('Fehlende SV-Nummer');
    // Minijob-Grenze: dynamische Geringfuegigkeitsgrenze aus
    // MINIJOB_LIMIT_CENTS. Betraege ueber formatMoney im Format des
    // Variantenlandes, damit die Zahl im Text nicht zweimal gepflegt wird.
    if (e.employee_type === 'minijob' && gross + bonusCents > MINIJOB_LIMIT_CENTS) {
      warnings.push(
        `Minijob-Grenze überschritten (${money(gross + bonusCents)} > ${money(MINIJOB_LIMIT_CENTS)})`,
      );
    }

    return {
      employee: e,
      gross_cents: gross,
      bonus_cents: bonusCents,
      total_cents: gross + bonusCents,
      components,
      bonuses,
      flags,
      warnings,
      unpaid_absence_days: unpaidDays,
    };
  });
}

function getRun(id: number): PayrollRunRow {
  const run = getDb().prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id) as
    | PayrollRunRow
    | undefined;
  if (!run) throw notFound('Abrechnungslauf nicht gefunden');
  return run;
}

/**
 * Zeilen eines Laufs samt Personalnummer. Betriebe ohne gepflegte
 * Personalnummer (Spalte freiwillig, Migration 104) bekommen die Profil-ID,
 * damit CSV, LODAS und Bescheinigung immer denselben Schluessel tragen.
 */
function getItems(runId: number): (PayrollItemRow & { first_name: string; last_name: string; employee_type: string })[] {
  return getDb()
    .prepare(
      `SELECT i.*, e.first_name, e.last_name, e.employee_type,
              COALESCE(e.personnel_number, CAST(i.employee_id AS TEXT)) AS personnel_number
       FROM payroll_items i JOIN employees e ON e.id = i.employee_id
       WHERE i.run_id = ? ORDER BY e.last_name, e.first_name`,
    )
    .all(runId) as (PayrollItemRow & { first_name: string; last_name: string; employee_type: string })[];
}

function itemToJson(i: PayrollItemRow & { first_name?: string; last_name?: string; employee_type?: string }) {
  return {
    ...i,
    components: JSON.parse(i.components_json),
    bonuses: JSON.parse(i.bonuses_json),
    flags: JSON.parse(i.flags_json),
    warnings: JSON.parse(i.warnings_json),
    components_json: undefined,
    bonuses_json: undefined,
    flags_json: undefined,
    warnings_json: undefined,
  };
}

function markExported(req: FastifyRequest, run: PayrollRunRow, format: string): void {
  if (run.status === 'offen') {
    throw conflict('Der Lauf muss vor dem Export geprüft werden');
  }
  if (run.status !== 'exportiert') {
    // Statuswechsel und Audit-Eintrag in einem Commit.
    inTransaction(() => {
      getDb().prepare(`UPDATE payroll_runs SET status = 'exportiert' WHERE id = ?`).run(run.id);
      audit(req, 'payroll_run.export', 'payroll_run', run.id, {
        month: run.month,
        format,
        old_status: run.status,
        new_status: 'exportiert',
      });
    });
  }
}

export async function payrollRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/compensation/payroll-runs', async () => {
    const runs = getDb()
      .prepare(
        `SELECT r.*, COUNT(i.id) AS item_count,
                COALESCE(SUM(i.total_cents), 0) AS total_cents,
                COALESCE(SUM(json_array_length(i.warnings_json)), 0) AS warning_count
         FROM payroll_runs r LEFT JOIN payroll_items i ON i.run_id = r.id
         GROUP BY r.id ORDER BY r.month DESC`,
      )
      .all();
    return { runs };
  });

  // Lauf anlegen: stellt die Bewegungsdaten des Monats zusammen. Je Monat
  // maximal ein Lauf (409).
  app.post('/api/compensation/payroll-runs', async (req, reply) => {
    const body = parse(
      z.object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Monat muss das Format JJJJ-MM haben'),
        notes: z.string().trim().max(500).optional().nullable(),
      }),
      req.body,
    );
    assertMonth(body.month);
    const db = getDb();
    if (db.prepare('SELECT 1 FROM payroll_runs WHERE month = ?').get(body.month)) {
      throw conflict(`Für ${body.month} existiert bereits ein Abrechnungslauf`);
    }
    const items = assembleMonth(body.month);
    const runId = inTransaction(() => {
      const info = db
        .prepare('INSERT INTO payroll_runs (month, notes) VALUES (?, ?)')
        .run(body.month, body.notes ?? null);
      const id = Number(info.lastInsertRowid);
      const insert = db.prepare(
        `INSERT INTO payroll_items
           (run_id, employee_id, gross_cents, bonus_cents, total_cents,
            components_json, bonuses_json, flags_json, warnings_json, unpaid_absence_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        insert.run(
          id,
          item.employee.id,
          item.gross_cents,
          item.bonus_cents,
          item.total_cents,
          JSON.stringify(item.components),
          JSON.stringify(item.bonuses),
          JSON.stringify(item.flags),
          JSON.stringify(item.warnings),
          item.unpaid_absence_days,
        );
      }
      audit(req, 'payroll_run.create', 'payroll_run', id, {
        month: body.month,
        item_count: items.length,
        warning_count: items.reduce((s, i) => s + i.warnings.length, 0),
      });
      return id;
    });
    reply.status(201);
    return { run: getRun(runId), items: getItems(runId).map(itemToJson) };
  });

  app.get('/api/compensation/payroll-runs/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const run = getRun(id);
    return { run, items: getItems(id).map(itemToJson) };
  });

  // Statuswechsel nur vorwärts: offen → geprueft → exportiert.
  app.post('/api/compensation/payroll-runs/:id/status', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(z.object({ status: z.enum(['geprueft', 'exportiert']) }), req.body);
    const run = getRun(id);
    const allowed: Record<string, string[]> = {
      offen: ['geprueft'],
      geprueft: ['exportiert'],
      exportiert: [],
    };
    if (!allowed[run.status]?.includes(body.status)) {
      throw conflict(`Statuswechsel von „${run.status}" nach „${body.status}" ist nicht möglich`);
    }
    inTransaction(() => {
      getDb().prepare('UPDATE payroll_runs SET status = ? WHERE id = ?').run(body.status, id);
      audit(req, 'payroll_run.status', 'payroll_run', id, {
        month: run.month,
        old_status: run.status,
        new_status: body.status,
      });
    });
    return { run: getRun(id) };
  });

  // Verwerfen: nur offene Laeufe. Ein geprueft oder exportiert markierter Lauf
  // ist Grundlage einer Abrechnung beim Steuerberater und bleibt als Snapshot
  // erhalten. Die Items fallen per CASCADE weg; ein neuer Lauf desselben
  // Monats stellt die Bewegungsdaten dann aus dem aktuellen Stand zusammen.
  app.delete('/api/compensation/payroll-runs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const run = getRun(id);
    if (run.status !== 'offen') {
      throw conflict('Nur offene Abrechnungsläufe können verworfen werden');
    }
    const itemCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM payroll_items WHERE run_id = ?').get(id) as { n: number }
    ).n;
    inTransaction(() => {
      getDb().prepare('DELETE FROM payroll_runs WHERE id = ?').run(id);
      audit(req, 'payroll_run.delete', 'payroll_run', id, {
        month: run.month,
        status: run.status,
        item_count: itemCount,
      });
    });
    reply.status(204);
  });

  /**
   * Lohnexport im Format des Variantenlandes. Der Pfad nennt weiterhin
   * `datev`, weil Oberflaeche und Lesezeichen ihn so kennen; den Inhalt
   * liefert der Adapter `lodas` aus payrollExport/ (Registry je Land).
   * Der Export setzt den Lauf-Status auf 'exportiert' (Voraussetzung:
   * geprueft).
   */
  app.get('/api/compensation/payroll-runs/:id/export.datev', async (req, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const run = getRun(id);
    const exporter = payrollExporter('lodas');
    markExported(req, run, exporter.id);
    const body = exporter.render(run, getItems(id), getAllSettings());
    reply
      .header('Content-Type', exporter.contentType)
      .header('Content-Disposition', `attachment; filename="${exporter.filename(run)}"`);
    return reply.send(body);
  });

  // Generischer CSV-Export (UTF-8 mit BOM, Semikolon) — setzt Status auf
  // 'exportiert' (Voraussetzung: geprüft).
  app.get('/api/compensation/payroll-runs/:id/export.csv', async (req, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const run = getRun(id);
    markExported(req, run, 'csv');
    const items = getItems(id);
    const esc = (v: string | number | null | undefined) => {
      const s = String(v ?? '');
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      [
        'Personalnummer',
        'Nachname',
        'Vorname',
        'Monat',
        'Monatsbrutto_EUR',
        'Boni_EUR',
        'Gesamt_EUR',
        'Unbez_Abwesenheitstage',
        'Flags',
        'Warnungen',
      ].join(';'),
    ];
    for (const i of items) {
      rows.push(
        [
          esc(i.personnel_number),
          esc(i.last_name),
          esc(i.first_name),
          run.month,
          decimalComma(i.gross_cents),
          decimalComma(i.bonus_cents),
          decimalComma(i.total_cents),
          i.unpaid_absence_days,
          esc((JSON.parse(i.flags_json) as string[]).join(', ')),
          esc((JSON.parse(i.warnings_json) as string[]).join(', ')),
        ].join(';'),
      );
    }
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="abrechnung_${run.month}.csv"`);
    return reply.send('﻿' + rows.join('\r\n') + '\r\n');
  });
}
