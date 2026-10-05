import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { parse, badRequest, conflict, notFound } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { getEmployee, goalById, goalPayoutCents, goalsForEmployee, tableExists, type GoalRow } from './lib.js';

const bonusSchema = z
  .object({
    employee_id: z.number().int().positive(),
    kind: z.enum(['zielbonus', 'provision', 'einmalzahlung']),
    title: z.string().trim().min(1, 'Ein Titel ist Pflicht'),
    amount_cents: z.number().int().positive().optional().nullable(),
    target_amount_cents: z.number().int().positive().optional().nullable(),
    goal_id: z.number().int().positive().optional().nullable(),
    payout_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Monat muss das Format JJJJ-MM haben'),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .superRefine((b, ctx) => {
    if (b.goal_id) {
      if (!b.target_amount_cents) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['target_amount_cents'],
          message: 'Bei Zielkopplung ist ein Zielbetrag (100 %) Pflicht',
        });
      }
    } else if (!b.amount_cents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount_cents'],
        message: 'Ohne Zielkopplung ist ein fester Betrag Pflicht',
      });
    }
  });

interface BonusRow {
  id: number;
  employee_id: number;
  kind: string;
  title: string;
  amount_cents: number | null;
  target_amount_cents: number | null;
  goal_id: number | null;
  payout_month: string;
  status: string;
  note: string | null;
  created_at: string;
}

/**
 * Bonus + serverseitig berechneter Auszahlungsbetrag. Bei Zielkopplung:
 * payout_cents = target_amount_cents × goals.progress/100 (Ziel via LEFT-
 * JOIN-Semantik — fehlt das Ziel oder die Tabelle, gilt progress 0).
 * `preloadedGoal`: von der Liste bereits mitgelesenes Ziel (null = keins);
 * ohne Angabe wird es hier nachgeschlagen (Einzelzugriffe).
 */
function withPayout<T extends BonusRow>(
  bonus: T,
  preloadedGoal?: GoalRow | null,
): T & {
  payout_cents: number;
  goal: GoalRow | null;
} {
  const goal = preloadedGoal !== undefined ? preloadedGoal : bonus.goal_id ? goalById(bonus.goal_id) : null;
  const payout = bonus.goal_id
    ? bonus.amount_cents ?? goalPayoutCents(bonus.target_amount_cents ?? 0, goal)
    : bonus.amount_cents ?? 0;
  return { ...bonus, payout_cents: payout, goal };
}

/**
 * Vom Abrechnungslauf eingefrorener Auszahlungsbetrag dieses Bonus, falls für
 * den Auszahlungsmonat bereits ein Lauf existiert (payroll_items.bonuses_json).
 * Der DATEV-/CSV-Export übermittelt genau diesen Snapshot an den Steuerberater
 * — ändert sich der Zielfortschritt danach, muss der beim Auszahlen
 * eingefrorene Betrag trotzdem dem exportierten entsprechen. Deshalb hat der
 * Snapshot Vorrang vor der Live-Berechnung aus dem Ziel.
 */
function snapshotPayoutCents(bonus: BonusRow): number | null {
  const item = getDb()
    .prepare(
      `SELECT i.bonuses_json FROM payroll_items i
       JOIN payroll_runs r ON r.id = i.run_id
       WHERE r.month = ? AND i.employee_id = ?`,
    )
    .get([bonus.payout_month, bonus.employee_id]) as { bonuses_json: string } | undefined;
  if (!item) return null;
  const entry = (JSON.parse(item.bonuses_json) as { id: number; payout_cents: number }[]).find(
    (b) => b.id === bonus.id,
  );
  return entry?.payout_cents ?? null;
}

export async function bonusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/compensation/bonuses', async (req) => {
    const { status, employee_id } = req.query as { status?: string; employee_id?: string };
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) {
      conditions.push('b.status = ?');
      params.push(status);
    }
    if (employee_id) {
      conditions.push('b.employee_id = ?');
      params.push(Number(employee_id));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // Das Ziel kommt per LEFT JOIN gleich mit, statt je zielgekoppeltem Bonus
    // goalById samt tableExists abzufragen (zwei Abfragen je Zeile). Fehlt das
    // Ziel, liefert der Join NULL wie goalById. tableExists bleibt EINMAL je
    // Request: Der Kontrakt mit dem Leistungs-Modul (lib.ts) verlangt, dass die
    // Kopplung auch ohne goals-Tabelle funktioniert, und ohne sie scheiterte
    // der Join. Heute laufen alle Migrationen in jeder Variante, die Prüfung
    // ist also nur noch eine Absicherung.
    const withGoals = tableExists('goals');
    const rows = getDb()
      .prepare(
        `SELECT b.*, e.first_name, e.last_name${
          withGoals
            ? `,
                g.id AS goal_ref_id, g.employee_id AS goal_ref_employee_id, g.title AS goal_ref_title,
                g.progress AS goal_ref_progress, g.status AS goal_ref_status`
            : ''
        }
         FROM bonuses b
         JOIN employees e ON e.id = b.employee_id
         ${withGoals ? 'LEFT JOIN goals g ON g.id = b.goal_id' : ''}
         ${where}
         ORDER BY b.payout_month DESC, b.id DESC`,
      )
      .all(...params) as (BonusRow & {
      first_name: string;
      last_name: string;
      goal_ref_id?: number | null;
      goal_ref_employee_id?: number;
      goal_ref_title?: string;
      goal_ref_progress?: number;
      goal_ref_status?: string;
    })[];
    return {
      bonuses: rows.map(
        ({ goal_ref_id, goal_ref_employee_id, goal_ref_title, goal_ref_progress, goal_ref_status, ...bonus }) =>
          withPayout(
            bonus,
            goal_ref_id === null || goal_ref_id === undefined
              ? null
              : {
                  id: goal_ref_id,
                  employee_id: goal_ref_employee_id!,
                  title: goal_ref_title!,
                  progress: goal_ref_progress!,
                  status: goal_ref_status!,
                },
          ),
      ),
    };
  });

  // Ziele einer Mitarbeiter:in für die Zielkopplung (liest die goals-Tabelle
  // des Leistungs-Moduls, Kontrakt: nur lesend, robust gegen leere Tabelle).
  app.get('/api/compensation/goals', async (req) => {
    const { employee_id } = req.query as { employee_id?: string };
    if (!employee_id) throw badRequest('employee_id ist erforderlich');
    return { goals: goalsForEmployee(Number(employee_id)) };
  });

  app.post('/api/compensation/bonuses', async (req, reply) => {
    const body = parse(bonusSchema, req.body);
    const employee = getEmployee(body.employee_id);
    if (employee.employee_type === 'freiberufler') {
      throw badRequest('Freiberufliche Mitarbeiter werden über Honorare vergütet, nicht über Boni');
    }
    if (body.goal_id) {
      const goal = goalById(body.goal_id);
      if (!goal) throw badRequest('Das gewählte Ziel existiert nicht');
      if (goal.employee_id !== body.employee_id) {
        throw badRequest('Das Ziel gehört nicht zu der gewählten Mitarbeiter:in');
      }
    }
    // Bonus und Audit-Eintrag in einem Commit.
    const bonus = inTransaction(() => {
      const info = getDb()
        .prepare(
          `INSERT INTO bonuses (employee_id, kind, title, amount_cents, target_amount_cents, goal_id, payout_month, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.employee_id,
          body.kind,
          body.title,
          body.goal_id ? null : body.amount_cents ?? null,
          body.target_amount_cents ?? null,
          body.goal_id ?? null,
          body.payout_month,
          body.note ?? null,
        );
      const created = getDb()
        .prepare('SELECT * FROM bonuses WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as BonusRow;
      audit(req, 'bonus.create', 'bonus', created.id, {
        employee_id: body.employee_id,
        kind: body.kind,
        title: body.title,
        amount_cents: created.amount_cents,
        target_amount_cents: created.target_amount_cents,
        goal_id: created.goal_id,
        payout_month: created.payout_month,
      });
      return created;
    });
    reply.status(201);
    return { bonus: withPayout(bonus) };
  });

  // Status-Workflow geplant → freigegeben → ausgezahlt (auditiert). Bei
  // Auszahlung eines zielgekoppelten Bonus wird der berechnete Betrag in
  // amount_cents eingefroren (spätere Zieländerungen ändern die Zahlung nicht).
  app.post('/api/compensation/bonuses/:id/status', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = parse(z.object({ status: z.enum(['freigegeben', 'ausgezahlt']) }), req.body);
    const db = getDb();
    const bonus = db.prepare('SELECT * FROM bonuses WHERE id = ?').get(id) as BonusRow | undefined;
    if (!bonus) throw notFound('Bonus nicht gefunden');
    const allowed: Record<string, string[]> = {
      geplant: ['freigegeben'],
      freigegeben: ['ausgezahlt'],
      ausgezahlt: [],
    };
    if (!allowed[bonus.status]?.includes(body.status)) {
      throw conflict(`Statuswechsel von „${bonus.status}" nach „${body.status}" ist nicht möglich`);
    }
    let frozenAmount = bonus.amount_cents;
    if (body.status === 'ausgezahlt' && bonus.goal_id && bonus.amount_cents === null) {
      frozenAmount =
        snapshotPayoutCents(bonus) ??
        goalPayoutCents(bonus.target_amount_cents ?? 0, goalById(bonus.goal_id));
    }
    inTransaction(() => {
      db.prepare('UPDATE bonuses SET status = ?, amount_cents = ? WHERE id = ?').run(
        body.status,
        frozenAmount,
        id,
      );
      audit(req, `bonus.${body.status === 'freigegeben' ? 'approve' : 'payout'}`, 'bonus', id, {
        employee_id: bonus.employee_id,
        title: bonus.title,
        old_status: bonus.status,
        new_status: body.status,
        payout_cents: frozenAmount ?? goalPayoutCents(bonus.target_amount_cents ?? 0, bonus.goal_id ? goalById(bonus.goal_id) : null),
      });
    });
    const updated = db.prepare('SELECT * FROM bonuses WHERE id = ?').get(id) as BonusRow;
    return { bonus: withPayout(updated) };
  });

  app.delete('/api/compensation/bonuses/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const bonus = getDb().prepare('SELECT * FROM bonuses WHERE id = ?').get(id) as
      | BonusRow
      | undefined;
    if (!bonus) throw notFound('Bonus nicht gefunden');
    if (bonus.status !== 'geplant') {
      throw conflict('Nur geplante Boni können gelöscht werden');
    }
    inTransaction(() => {
      getDb().prepare('DELETE FROM bonuses WHERE id = ?').run(id);
      audit(req, 'bonus.delete', 'bonus', id, {
        employee_id: bonus.employee_id,
        title: bonus.title,
      });
    });
    reply.status(204);
  });
}
