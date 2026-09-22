import type { FastifyInstance } from 'fastify';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { addDaysIso, todayIso } from '../../core/dates.js';
import { AppError, badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { assertTypeRules, contractBodySchema, contractPatchSchema, type ContractBody } from './validation.js';

interface ContractRow {
  id: number;
  employee_id: number;
  contract_type: string;
  valid_from: string;
  valid_to: string | null;
  probation_end: string | null;
  notice_period_weeks: number | null;
  weekly_hours: number | null;
  annual_leave_days: number | null;
  fixed_term_reason: string | null;
  document_file_id: number | null;
  note: string | null;
  created_at: string;
}

const CONTRACT_COLUMNS = [
  'contract_type', 'valid_from', 'valid_to', 'probation_end', 'notice_period_weeks',
  'weekly_hours', 'annual_leave_days', 'fixed_term_reason', 'document_file_id', 'note',
] as const;

function assertEmployee(id: number): void {
  const row = getDb().prepare('SELECT id FROM employees WHERE id = ?').get(id);
  if (!row) throw notFound('Mitarbeiter:in nicht gefunden');
}

function getContract(id: number): ContractRow {
  const row = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id) as
    | ContractRow
    | undefined;
  if (!row) throw notFound('Vertrag nicht gefunden');
  return row;
}

/**
 * „Aktuell“ ist eine Vertragsversion, die noch nicht abgelaufen ist: offen
 * (valid_to NULL) oder befristet mit Ende heute oder spaeter. Eine Befristung
 * allein macht eine Version also nicht zur Historie; das ist der Unterschied
 * zur frueheren Pruefung auf `valid_to IS NULL`, die befristete Vertraege
 * nie spiegelte und nie korrigieren liess.
 */
const CURRENT_SQL = '(valid_to IS NULL OR valid_to >= @today)';

function isCurrent(contract: Pick<ContractRow, 'valid_to'>, today = todayIso()): boolean {
  return contract.valid_to === null || contract.valid_to >= today;
}

/** Juengste Version einer Person (spaetester Beginn, bei Gleichstand die zuletzt angelegte). */
function newestContract(employeeId: number): ContractRow | undefined {
  return getDb()
    .prepare('SELECT * FROM contracts WHERE employee_id = ? ORDER BY valid_from DESC, id DESC LIMIT 1')
    .get(employeeId) as ContractRow | undefined;
}

/**
 * Wochenstunden/Urlaubsanspruch der aktuellen Vertragsversion auf employees
 * spiegeln, dort liegt die eine Quelle für alle anderen Module.
 *
 * Vorher laufen die Typregeln der Person ueber den gespiegelten Stand: Ein
 * Vertrag mit 30 Wochenstunden fuer eine Werkstudentin liesse sich sonst
 * anlegen und schriebe still einen Wert in die Personalakte, den der
 * Stammdaten-PATCH mit 400 abweist.
 */
function mirrorToEmployee(
  employeeId: number,
  contract: { weekly_hours?: number | null; annual_leave_days?: number | null },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  const mirrored: Record<string, unknown> = {};
  if (contract.weekly_hours !== null && contract.weekly_hours !== undefined) {
    sets.push('weekly_hours = ?');
    params.push(contract.weekly_hours);
    mirrored.weekly_hours = contract.weekly_hours;
  }
  if (contract.annual_leave_days !== null && contract.annual_leave_days !== undefined) {
    sets.push('annual_leave_days = ?');
    params.push(contract.annual_leave_days);
    mirrored.annual_leave_days = contract.annual_leave_days;
  }
  if (sets.length === 0) return;
  const employee = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as
    | Record<string, unknown>
    | undefined;
  if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
  try {
    assertTypeRules({ ...employee, ...mirrored });
  } catch (e) {
    if (e instanceof AppError) {
      throw badRequest(
        `Die Vertragsdaten passen nicht zu den Stammdaten der Person: ${e.message}. Bitte Wochenstunden bzw. Urlaubstage im Vertrag anpassen oder zuerst den Mitarbeitertyp ändern.`,
        e.details,
      );
    }
    throw e;
  }
  getDb()
    .prepare(`UPDATE employees SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...params, employeeId);
}

function validateRange(body: Pick<ContractBody, 'valid_from' | 'valid_to'>): void {
  if (body.valid_to && body.valid_to < body.valid_from) {
    throw badRequest('valid_to darf nicht vor valid_from liegen');
  }
}

export async function contractRoutes(app: FastifyInstance): Promise<void> {
  // Vertragshistorie eines Mitarbeitenden (neueste Version zuerst).
  app.get('/api/employees/:id/contracts', async (req) => {
    const employeeId = Number((req.params as { id: string }).id);
    assertEmployee(employeeId);
    const contracts = getDb()
      .prepare('SELECT * FROM contracts WHERE employee_id = ? ORDER BY valid_from DESC, id DESC')
      .all(employeeId);
    return { contracts };
  });

  // Neue Vertragsversion: schließt eine noch laufende Vorversion (valid_to =
  // Vortag des neuen Beginns), überschreibt nie. Eine befristete Vorversion,
  // die ohnehin vor dem neuen Beginn endet, bleibt unangetastet.
  app.post('/api/employees/:id/contracts', async (req, reply) => {
    const employeeId = Number((req.params as { id: string }).id);
    assertEmployee(employeeId);
    const body = parse(contractBodySchema, req.body);
    validateRange(body);

    const db = getDb();
    const today = todayIso();
    const id = inTransaction(() => {
      const current = db
        .prepare(
          `SELECT * FROM contracts WHERE employee_id = @employee_id AND ${CURRENT_SQL}
           ORDER BY valid_from DESC, id DESC LIMIT 1`,
        )
        .get({ employee_id: employeeId, today }) as ContractRow | undefined;
      if (current) {
        if (body.valid_from <= current.valid_from) {
          throw conflict(
            `Die neue Vertragsversion muss nach dem Beginn der aktuellen Version (${current.valid_from}) starten`,
          );
        }
        // Nur kuerzen, nie verlaengern: Endet die Vorversion schon vor dem
        // neuen Beginn, bleibt ihr Ende stehen.
        const cutoff = addDaysIso(body.valid_from, -1);
        if (current.valid_to === null || current.valid_to > cutoff) {
          db.prepare('UPDATE contracts SET valid_to = ? WHERE id = ?').run(cutoff, current.id);
        }
      }
      const info = db
        .prepare(
          `INSERT INTO contracts (employee_id, ${CONTRACT_COLUMNS.join(', ')})
           VALUES (?, ${CONTRACT_COLUMNS.map(() => '?').join(', ')})`,
        )
        .run(employeeId, ...CONTRACT_COLUMNS.map((c) => body[c] ?? null));
      const newId = Number(info.lastInsertRowid);
      if (isCurrent({ valid_to: body.valid_to ?? null }, today)) mirrorToEmployee(employeeId, body);
      return newId;
    });

    audit(req, 'create', 'contract', id, {
      employee_id: employeeId,
      contract_type: body.contract_type,
      valid_from: body.valid_from,
    });
    reply.status(201);
    return { contract: getContract(id) };
  });

  // Korrektur ausschließlich der aktuellen Version (juengste Version, nicht
  // abgelaufen; offen oder befristet). Abgelaufene und abgeloeste Versionen
  // sind Historie und unveränderlich.
  app.patch('/api/contracts/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getContract(id);
    const today = todayIso();
    if (!isCurrent(existing, today)) {
      throw conflict(
        'Nur die aktuelle Vertragsversion kann korrigiert werden. Abgelaufene Versionen sind Historie',
      );
    }
    if (newestContract(existing.employee_id)?.id !== id) {
      throw conflict(
        'Nur die aktuelle Vertragsversion kann korrigiert werden. Diese Version wurde bereits von einer neueren abgelöst',
      );
    }
    const patch = parse(contractPatchSchema, req.body);
    const cols = CONTRACT_COLUMNS.filter((c) => patch[c] !== undefined);
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    const merged = { ...existing, ...patch } as ContractRow;
    validateRange(merged);

    const db = getDb();
    inTransaction(() => {
      if (patch.valid_from !== undefined && patch.valid_from !== existing.valid_from) {
        const prev = db
          .prepare(
            `SELECT * FROM contracts WHERE employee_id = ? AND id != ? AND valid_to IS NOT NULL
             ORDER BY valid_from DESC LIMIT 1`,
          )
          .get(existing.employee_id, id) as ContractRow | undefined;
        if (prev) {
          if (patch.valid_from <= prev.valid_from) {
            throw conflict(
              `valid_from muss nach dem Beginn der Vorversion (${prev.valid_from}) liegen`,
            );
          }
          db.prepare('UPDATE contracts SET valid_to = ? WHERE id = ?').run(
            addDaysIso(patch.valid_from, -1),
            prev.id,
          );
        }
      }
      db.prepare(`UPDATE contracts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...cols.map((c) => patch[c] ?? null),
        id,
      );
      if (isCurrent({ valid_to: merged.valid_to ?? null }, today)) {
        mirrorToEmployee(existing.employee_id, merged);
      }
    });

    audit(req, 'update', 'contract', id, {
      employee_id: existing.employee_id,
      changed: Object.fromEntries(cols.map((c) => [c, patch[c]])),
    });
    return { contract: getContract(id) };
  });
}
