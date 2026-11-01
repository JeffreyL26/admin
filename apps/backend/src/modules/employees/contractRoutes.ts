import type { FastifyInstance } from 'fastify';
import { contractCorrectable, contractState, formatDate } from '@ohrganize/shared';
import { assertExecutiveAccess } from '../../core/executiveGate.js';
import { getDb, inTransaction } from '../../db/db.js';
import { audit, auditSystem } from '../../core/audit.js';
import { addDaysIso, todayIso } from '../../core/dates.js';
import { AppError, badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { assertMayLinkFiles } from '../../core/files.js';
import {
  ENTITLEMENT_EMPLOYEE_COLUMNS,
  freezeEntitlementInputs,
  recountUpcomingRequests,
  unfreezeReopenedContract,
} from '../absences/service.js';

/** Was freezeEntitlementInputs vor einer Aenderung der Akte festgehalten hat (fuer den Audit-Eintrag). */
type Frozen = ReturnType<typeof freezeEntitlementInputs>;

/** Audit-Feld `frozen`, nur wenn etwas festgehalten wurde. */
export function frozenDetails(frozen: Frozen | null): { frozen?: Frozen } {
  return frozen && (frozen.contracts.length > 0 || frozen.gaps.length > 0) ? { frozen } : {};
}
import {
  assertTypeRules,
  assertWeeklyHoursWithinRule,
  contractBodySchema,
  contractPatchSchema,
  settleWorkSchedule,
  type ContractBody,
} from './validation.js';

interface ContractRow {
  id: number;
  employee_id: number;
  contract_type: string;
  employee_type: string | null;
  valid_from: string;
  valid_to: string | null;
  probation_end: string | null;
  notice_period_weeks: number | null;
  weekly_hours: number | null;
  annual_leave_days: number | null;
  /** Arbeitswoche dieser Version (Migration 118); beides NULL = nicht hinterlegt. */
  work_weekdays: string | null;
  work_days_per_week: number | null;
  fixed_term_reason: string | null;
  document_file_id: number | null;
  note: string | null;
  /** 1: geplante Version, Spiegelung auf employees steht zum Beginn noch aus. */
  mirror_pending: number;
  /** Grund, warum die faellige Spiegelung scheiterte (Migration 117); sonst null. */
  mirror_error: string | null;
  created_at: string;
}

const CONTRACT_COLUMNS = [
  'contract_type', 'employee_type', 'valid_from', 'valid_to', 'probation_end', 'notice_period_weeks',
  'weekly_hours', 'annual_leave_days', 'work_weekdays', 'work_days_per_week', 'fixed_term_reason',
  'document_file_id', 'note',
] as const;

/**
 * Felder, die die aktuelle Version auf employees spiegelt (mirrorToEmployee)
 * und die umgekehrt das Personalformular auf sie zurückschreibt
 * (syncCurrentContract).
 */
export const MIRRORED_COLUMNS = [
  'weekly_hours', 'annual_leave_days', 'employee_type', 'work_weekdays', 'work_days_per_week',
] as const;

/** Die Arbeitswoche wandert immer als Paar (feste Tage und Zahl gehoeren zusammen). */
const SCHEDULE_COLUMNS = ['work_weekdays', 'work_days_per_week'] as const;

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
 * Version, die heute gilt: begonnen und nicht abgelaufen, bei mehreren die
 * zuletzt begonnene. Eine geplante Version (Beginn kuenftig) gilt noch nicht.
 */
function contractInEffect(employeeId: number, today = todayIso()): ContractRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM contracts WHERE employee_id = @employee_id AND valid_from <= @today AND ${CURRENT_SQL}
       ORDER BY valid_from DESC, id DESC LIMIT 1`,
    )
    .get({ employee_id: employeeId, today }) as ContractRow | undefined;
}

/**
 * Wochenstunden/Urlaubsanspruch und Beschaeftigungsart der aktuellen
 * Vertragsversion auf employees spiegeln, dort liegt die eine Quelle für alle
 * anderen Module.
 *
 * Vorher laufen die Typregeln der Person ueber den gespiegelten Stand: Ein
 * Vertrag mit 30 Wochenstunden fuer eine Werkstudentin liesse sich sonst
 * anlegen und schriebe still einen Wert in die Personalakte, den der
 * Stammdaten-PATCH mit 400 abweist. Mit `apply: false` nur pruefen (eine
 * geplante Version: Fehler zeigen sich beim Anlegen, geschrieben wird zum
 * Beginn). Aendert sich eine Grundlage des Urlaubsanspruchs, haelt
 * freezeEntitlementInputs vorher fest, was bisher aus der Akte rechnete;
 * das Ergebnis gehoert in den Audit-Eintrag des Aufrufers (frozenDetails).
 */
function mirrorToEmployee(
  employeeId: number,
  contract: {
    weekly_hours?: number | null;
    annual_leave_days?: number | null;
    employee_type?: string | null;
    work_weekdays?: string | null;
    work_days_per_week?: number | null;
  },
  apply = true,
  today = todayIso(),
): Frozen | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const mirrored: Record<string, unknown> = {};
  if (contract.employee_type !== null && contract.employee_type !== undefined) {
    sets.push('employee_type = ?');
    params.push(contract.employee_type);
    mirrored.employee_type = contract.employee_type;
  }
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
  // Arbeitswoche als Paar; eine Version ohne Angabe (beides leer) laesst die
  // Akte stehen.
  const scheduleGiven = SCHEDULE_COLUMNS.some((c) => contract[c] !== null && contract[c] !== undefined);
  if (scheduleGiven) {
    for (const c of SCHEDULE_COLUMNS) {
      sets.push(`${c} = ?`);
      params.push(contract[c] ?? null);
      mirrored[c] = contract[c] ?? null;
    }
  }
  if (sets.length === 0) return null;
  const employee = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as
    | Record<string, unknown>
    | undefined;
  if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
  // Nur blockieren, was die Spiegelung SELBST verursacht: Verstoesst schon der
  // heutige Stand der Personalakte gegen die Typregeln (etwa eine fehlende
  // IBAN), liegt das nicht am Vertrag; dann nur die gespiegelten Felder
  // gegen die Stundenobergrenze pruefen, statt das Anlegen zu sperren.
  let preexisting = false;
  try {
    assertTypeRules(employee);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    preexisting = true;
  }
  try {
    // Ohne gespiegelte Stunden bleibt der Bestand unangetastet, also auch
    // nichts zu pruefen: Ein Vertrag, der nur Urlaubstage aendert, darf an
    // zu hohen Altstunden nicht scheitern.
    const merged = { ...employee, ...mirrored };
    if (!preexisting) assertTypeRules(merged);
    else if (mirrored.weekly_hours !== undefined || mirrored.employee_type !== undefined) {
      assertWeeklyHoursWithinRule(merged);
    }
  } catch (e) {
    if (e instanceof AppError) {
      throw badRequest(
        `Die Vertragsdaten passen nicht zu den Stammdaten der Person: ${e.message}. Bitte Wochenstunden bzw. Urlaubstage im Vertrag anpassen oder zuerst den Mitarbeitertyp ändern.`,
        e.details,
      );
    }
    throw e;
  }
  if (!apply) return null;
  // Frueherer Anspruch bleibt: Was bisher aus der Akte rechnete, behaelt ihre Werte.
  const frozen = ENTITLEMENT_EMPLOYEE_COLUMNS.some(
    (c) => c in mirrored && (employee[c] ?? null) !== (mirrored[c] ?? null),
  )
    ? freezeEntitlementInputs(employeeId, today)
    : null;
  getDb()
    .prepare(`UPDATE employees SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...params, employeeId);
  // Neue Arbeitswoche: kommende Antraege zaehlen nach ihr (absences/service.ts).
  if (scheduleGiven && SCHEDULE_COLUMNS.some((c) => (employee[c] ?? null) !== (mirrored[c] ?? null))) {
    recountUpcomingRequests([employeeId]);
  }
  return frozen;
}

/**
 * Arbeitswoche und Jahresurlaub einer neuen Version, die der Rumpf nicht
 * nennt: aus der Personalakte. So traegt jede Version die Werte, mit denen
 * der Urlaubsanspruch ihren Zeitraum rechnet; eine Version ohne sie rechnete
 * spaeter mit den dann aktuellen Werten der Akte. Wochenstunden bleiben, wie
 * sie kommen (sie spiegeln und pruefen die Typregeln, der Anspruch braucht sie
 * nicht).
 */
function fillFromEmployee(employeeId: number, body: ContractBody): void {
  const e = getDb()
    .prepare('SELECT annual_leave_days, work_weekdays, work_days_per_week FROM employees WHERE id = ?')
    .get(employeeId) as Pick<ContractRow, 'annual_leave_days' | 'work_weekdays' | 'work_days_per_week'> | undefined;
  if (!e) return;
  if (body.work_weekdays === undefined && body.work_days_per_week === undefined) {
    body.work_weekdays = e.work_weekdays;
    body.work_days_per_week = e.work_days_per_week;
  }
  if (body.annual_leave_days === undefined) body.annual_leave_days = e.annual_leave_days;
}

/**
 * Geplante Versionen, deren Beginn erreicht ist, auf employees spiegeln
 * (`mirror_pending`, Migration 116). Je Person die zuletzt begonnene; aeltere
 * faellige sind damit erledigt. Laeuft beim Start des Moduls und stuendlich,
 * Protokoll ohne Konto `contract.mirrored`. Passen die Werte nicht mehr zu
 * den Typregeln der Person, bleibt die Version offen und traegt den Grund
 * (`mirror_error`, die Akte zeigt ihn); sie wird bei jedem Lauf erneut
 * versucht und gilt, sobald die Stammdaten passen. Protokolliert
 * (`contract.mirror_failed`) wird nur ein neuer Grund, nicht jede Stunde.
 * Mit `employeeIds` nur für diese Personen: nach dem Speichern ihrer
 * Stammdaten, damit eine daran gescheiterte Version sofort gilt, sobald sie
 * passt (nicht erst beim nächsten stündlichen Lauf).
 * Liefert die IDs der gespiegelten Versionen.
 */
export function mirrorDueContracts(today = todayIso(), employeeIds?: readonly number[]): number[] {
  const db = getDb();
  return inTransaction(() => {
    const due = db
      .prepare(
        `SELECT * FROM contracts WHERE mirror_pending = 1 AND valid_from <= ?
         ${employeeIds ? 'AND employee_id IN (SELECT value FROM json_each(?))' : ''}
         ORDER BY employee_id, valid_from DESC, id DESC`,
      )
      .all(employeeIds ? [today, JSON.stringify(employeeIds)] : [today]) as ContractRow[];
    const setState = db.prepare('UPDATE contracts SET mirror_pending = ?, mirror_error = ? WHERE id = ?');
    const mirrored: number[] = [];
    const seen = new Set<number>();
    for (const c of due) {
      if (seen.has(c.employee_id) || !isCurrent(c, today)) {
        setState.run(0, null, c.id);
        continue;
      }
      seen.add(c.employee_id);
      try {
        const frozen = mirrorToEmployee(c.employee_id, c, true, today);
        setState.run(0, null, c.id);
        mirrored.push(c.id);
        // Eine wieder geltende Vorversion, deren Spiegelung erst jetzt gelingt:
        // festgehaltene Felder gleich der Akte wieder leer (sonst leer, nichts zu tun).
        const unfrozen = unfreezeReopenedContract(c.id, today);
        auditSystem(
          'contract.mirrored',
          'contract',
          {
            employee_id: c.employee_id,
            valid_from: c.valid_from,
            ...frozenDetails(frozen),
            ...(unfrozen.length ? { unfrozen } : {}),
          },
          c.id,
        );
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        if (c.mirror_error === e.message) continue;
        setState.run(1, e.message, c.id);
        auditSystem('contract.mirror_failed', 'contract', { employee_id: c.employee_id, reason: e.message }, c.id);
      }
    }
    return mirrored;
  });
}

export interface ContractSync {
  /** Angepasste Version mit altem und neuem Wert je Feld; der Aufrufer protokolliert sie. */
  synced?: { id: number; changed: Record<string, { from: unknown; to: unknown }> };
  /** Hinweis für die Oberfläche, wenn eine geplante Version besteht (sie bleibt unangetastet). */
  notice?: string;
}

/**
 * Gegenrichtung der Spiegelung: Ändern Personalformular oder Sammeländerung
 * Beschäftigungsart, Wochenstunden oder Urlaubstage, gilt das als Korrektur
 * der aktuellen Vertragsversion (wie PATCH /api/contracts/:id). Sonst zeigte
 * die Vertragshistorie weiter den alten Stand, und der Korrekturdialog
 * belegte ihn vor. Eine Änderung ab einem Datum ist eine neue Version.
 *
 * Angepasst wird die Version, die HEUTE gilt; die Personalakte spiegelt
 * genau sie (geplante Versionen erst zum Beginn, mirrorDueContracts). Eine
 * geplante Version bleibt unangetastet, sonst ueberschriebe die Korrektur
 * still die geplante Aenderung; ab ihrem Beginn gelten ihre Werte, und
 * `notice` sagt das. Läuft in der Transaktion der Personaländerung; das
 * Audit schreibt der Aufrufer in derselben Transaktion (Eintrag `update` an
 * `contract`).
 */
export function syncCurrentContract(
  employeeId: number,
  changed: Partial<Record<string, unknown>>,
  today = todayIso(),
): ContractSync {
  // Ohne Vertragsfeld im Rumpf keine Abfrage (jeder Personal-PATCH kommt hier vorbei).
  if (!MIRRORED_COLUMNS.some((c) => changed[c] !== undefined)) return {};
  const result: ContractSync = {};
  const newest = newestContract(employeeId);
  if (newest && newest.valid_from > today && isCurrent(newest, today)) {
    result.notice = `Ab ${formatDate(newest.valid_from)} gilt die geplante Vertragsversion mit ihren eigenen Werten; die Änderung gilt bis dahin. Bitte im Tab „Vertrag“ prüfen.`;
  }
  const inEffect = contractInEffect(employeeId, today);
  if (!inEffect) return result;
  const cols = MIRRORED_COLUMNS.filter((c) => changed[c] !== undefined && changed[c] !== inEffect[c]);
  if (cols.length === 0) return result;
  getDb()
    .prepare(`UPDATE contracts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => changed[c] ?? null), inEffect.id);
  result.synced = {
    id: inEffect.id,
    changed: Object.fromEntries(cols.map((c) => [c, { from: inEffect[c], to: changed[c] ?? null }])),
  };
  return result;
}

function validateRange(body: Pick<ContractBody, 'valid_from' | 'valid_to'>): void {
  if (body.valid_to && body.valid_to < body.valid_from) {
    throw badRequest('valid_to darf nicht vor valid_from liegen');
  }
}

export async function contractRoutes(app: FastifyInstance): Promise<void> {
  // Geplante Versionen zum Beginn spiegeln: beim Start (die Migrationen sind
  // durch) und stuendlich, wie die Umfragen in communication/routes.ts.
  const dueCheck = () => {
    try {
      const mirrored = mirrorDueContracts();
      if (mirrored.length > 0) app.log.info(`${mirrored.length} geplante Vertragsversion(en) zum Beginn uebernommen.`);
    } catch (err) {
      app.log.warn(`Uebernahme geplanter Vertragsversionen gescheitert (${err instanceof Error ? err.message : String(err)}).`);
    }
  };
  dueCheck();
  const dueTimer = setInterval(dueCheck, 60 * 60 * 1000);
  dueTimer.unref();
  app.addHook('onClose', async () => clearInterval(dueTimer));

  // Vertragshistorie eines Mitarbeitenden (neueste Version zuerst).
  app.get('/api/employees/:id/contracts', async (req) => {
    const employeeId = Number((req.params as { id: string }).id);
    assertEmployee(employeeId);
    assertExecutiveAccess(req, employeeId, 'lesen');
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
    assertExecutiveAccess(req, employeeId, 'bearbeiten');
    const body = parse(contractBodySchema, req.body);
    settleWorkSchedule(body);
    fillFromEmployee(employeeId, body);
    validateRange(body);
    assertMayLinkFiles(req, [body.document_file_id]);

    const db = getDb();
    const today = todayIso();
    let frozen: Frozen | null = null;
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
      if (isCurrent({ valid_to: body.valid_to ?? null }, today)) {
        // Geplante Version: jetzt nur pruefen, gespiegelt wird zum Beginn
        // (mirrorDueContracts), sonst rechneten Lohnlauf und FTE vorzeitig damit.
        const planned = body.valid_from > today;
        frozen = mirrorToEmployee(employeeId, body, !planned, today);
        if (planned) db.prepare('UPDATE contracts SET mirror_pending = 1 WHERE id = ?').run(newId);
      }
      // Audit in derselben Transaktion: kein neuer Vertrag ohne Protokoll.
      audit(req, 'create', 'contract', newId, {
        employee_id: employeeId,
        contract_type: body.contract_type,
        valid_from: body.valid_from,
        ...frozenDetails(frozen),
      });
      return newId;
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
    assertExecutiveAccess(req, existing.employee_id, 'bearbeiten');
    const today = todayIso();
    // Dieselbe Regel wie die Oberfläche (contractState/contractCorrectable in shared).
    const newest = newestContract(existing.employee_id)?.id === id;
    if (contractState(existing, newest, today) === 'abgelaufen') {
      throw conflict(
        'Nur die aktuelle Vertragsversion kann korrigiert werden. Abgelaufene Versionen sind Historie',
      );
    }
    if (!contractCorrectable(contractState(existing, newest, today), newest)) {
      throw conflict(
        'Nur die aktuelle Vertragsversion kann korrigiert werden. Diese Version wurde bereits von einer neueren abgelöst',
      );
    }
    const patch = parse(contractPatchSchema, req.body);
    settleWorkSchedule(patch, existing);
    const cols = CONTRACT_COLUMNS.filter((c) => patch[c] !== undefined);
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    const merged = { ...existing, ...patch } as ContractRow;
    validateRange(merged);
    assertMayLinkFiles(req, [patch.document_file_id]);

    const db = getDb();
    let frozen: Frozen | null = null;
    let reopenedId: number | null = null;
    let reopened: Record<string, unknown> | null = null;
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
          const prevTo = addDaysIso(patch.valid_from, -1);
          db.prepare('UPDATE contracts SET valid_to = ? WHERE id = ?').run(prevTo, prev.id);
          // War die Vorversion abgelaufen und gilt jetzt wieder, spiegelt die
          // Akte sie (unten, nach dieser Version).
          if (prev.valid_to !== null && prev.valid_to < today && prevTo >= today) reopenedId = prev.id;
        }
      }
      db.prepare(`UPDATE contracts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...cols.map((c) => patch[c] ?? null),
        id,
      );
      // Nur spiegeln, was diese Korrektur aendert: Unveraenderte Werte stimmen
      // schon mit den Stammdaten ueberein (syncCurrentContract), ein Altwert
      // aus der Zeit davor setzte sie sonst still zurueck. Eine geplante
      // Version (Beginn kuenftig) wird nur geprueft und zum Beginn gespiegelt;
      // stand die Spiegelung noch aus und gilt die Version jetzt, geht sie ganz.
      if (isCurrent({ valid_to: merged.valid_to ?? null }, today)) {
        const planned = contractState(merged, true, today) === 'geplant';
        const changed = existing.mirror_pending === 1 && !planned
          ? Object.fromEntries(MIRRORED_COLUMNS.map((c) => [c, merged[c]]))
          : Object.fromEntries(
              MIRRORED_COLUMNS.filter((c) => patch[c] !== undefined && patch[c] !== existing[c]).map((c) => [c, patch[c]]),
            );
        // Die Arbeitswoche geht nur als Paar: Aendert sich ein Teil, beide aus der Version.
        if (SCHEDULE_COLUMNS.some((c) => c in changed)) {
          for (const c of SCHEDULE_COLUMNS) changed[c] = merged[c];
        }
        frozen = mirrorToEmployee(existing.employee_id, changed, !planned, today);
        if ((existing.mirror_pending === 1) !== planned) {
          db.prepare('UPDATE contracts SET mirror_pending = ?, mirror_error = NULL WHERE id = ?').run(planned ? 1 : 0, id);
        }
      }
      // Gilt die Vorversion wieder (der Beginn dieser Version wanderte nach
      // hinten), spiegelt die Akte sie bis zum neuen Beginn; sonst rechneten
      // Lohnlauf, FTE und kommende Antraege zu frueh mit dieser Version. Passt
      // sie nicht zu den Typregeln, bleibt sie mit Grund offen (mirror_error,
      // die Akte zeigt ihn) und wird wie eine faellige Version erneut versucht
      // (mirrorDueContracts). Danach werden ihre festgehaltenen Felder, die
      // jetzt der Akte entsprechen, wieder leer (unfreezeReopenedContract).
      if (reopenedId !== null) {
        const back = getContract(reopenedId);
        let backFrozen: Frozen | null = null;
        let mirrorError: string | null = null;
        try {
          backFrozen = mirrorToEmployee(
            existing.employee_id,
            Object.fromEntries(MIRRORED_COLUMNS.map((c) => [c, back[c]])),
            true,
            today,
          );
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          mirrorError = e.message;
          db.prepare('UPDATE contracts SET mirror_pending = 1, mirror_error = ? WHERE id = ?').run(e.message, reopenedId);
        }
        const unfrozen = unfreezeReopenedContract(reopenedId, today);
        reopened = {
          contract: reopenedId,
          ...(mirrorError ? { mirror_error: mirrorError } : {}),
          ...frozenDetails(backFrozen),
          ...(unfrozen.length ? { unfrozen } : {}),
        };
      }
      audit(req, 'update', 'contract', id, {
        employee_id: existing.employee_id,
        changed: Object.fromEntries(cols.map((c) => [c, patch[c]])),
        ...frozenDetails(frozen),
        ...(reopened ? { reopened } : {}),
      });
    });
    return { contract: getContract(id) };
  });
}
