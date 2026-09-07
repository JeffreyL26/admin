import { z } from 'zod';
import {
  EMPLOYEE_SELF_EDITABLE_FIELDS,
  maskConfidential,
  selfEditableField,
  type EmployeeChangeRequest,
  type EmployeeChangeRequestField,
  type EmployeeChangeRequestForHr,
  type EmployeeSelfEditableField,
} from '@ohrganize/shared';
import { getDb, inTransaction } from '../../db/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';

/**
 * Änderungsanträge zu den eigenen Stammdaten.
 *
 * Der Ablauf hat ZWEI Eintrittspunkte — das Portal (`/api/me/change-requests`,
 * Mitarbeitende stellen den Antrag) und die Personalabteilung
 * (`/api/employees/change-requests`, sie entscheidet). Beide Seiten laufen
 * durch diese Datei, damit Feld-Allowlist, Normalisierung und
 * Statusübergänge nicht in zwei Modulen auseinanderlaufen — dasselbe Muster
 * wie `absences/service.ts#createRequest`.
 */

/** Nur diese Felder sind beantragbar. Alles andere ist ein 400. */
const FELDER = new Map<string, EmployeeSelfEditableField>(
  EMPLOYEE_SELF_EDITABLE_FIELDS.map((f) => [f.field, f]),
);

/**
 * Prüft und normalisiert EINEN Feldwert.
 *
 * Leerer String bedeutet „Feld leeren" und wird zu NULL — sonst stünde in der
 * Personalakte später ein leerer String, den keine Abfrage als „nicht
 * gesetzt" erkennt.
 */
function normalize(feld: EmployeeSelfEditableField, roh: string | null): string | null {
  if (roh === null) return null;
  let wert = roh.trim();
  if (wert === '') return null;

  switch (feld.input) {
    case 'email':
      wert = wert.toLowerCase();
      if (!z.string().email().safeParse(wert).success) {
        throw badRequest(`„${feld.label}" ist keine gültige E-Mail-Adresse.`);
      }
      break;
    case 'zip':
      if (!/^[0-9]{4,10}$/.test(wert)) {
        throw badRequest(`„${feld.label}" darf nur Ziffern enthalten (4 bis 10 Stellen).`);
      }
      break;
    case 'tel':
      if (!/^[0-9+()/\s-]{3,40}$/.test(wert)) {
        throw badRequest(`„${feld.label}" enthält unzulässige Zeichen.`);
      }
      break;
    case 'iban':
      // Leerzeichen sind auf Kontoauszügen üblich und werden hier still
      // entfernt, statt die Eingabe abzulehnen.
      wert = wert.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(wert)) {
        throw badRequest('Die IBAN hat nicht das erwartete Format (z. B. DE02120300000000202051).');
      }
      break;
    case 'bic':
      wert = wert.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(wert)) {
        throw badRequest('Der BIC hat nicht das erwartete Format (8 oder 11 Zeichen).');
      }
      break;
    default:
      break;
  }
  if (wert.length > feld.maxLength) {
    throw badRequest(`„${feld.label}" darf höchstens ${feld.maxLength} Zeichen lang sein.`);
  }
  return wert;
}

export const changeRequestCreateSchema = z.object({
  // Werte kommen als Objekt {spalte: wert}. null heißt „Feld leeren".
  fields: z.record(z.string(), z.string().nullable()),
  note: z.string().trim().max(1000).optional(),
});

export const changeRequestDecisionSchema = z.object({
  decision: z.enum(['genehmigt', 'abgelehnt']),
  decision_note: z.string().trim().max(1000).optional(),
});

interface RequestRow {
  id: number;
  employee_id: number;
  status: string;
  note: string | null;
  requested_by_user_id: number | null;
  decided_by_user_id: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

interface FieldRow {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

/**
 * Baut die Feldliste für die Antwort. `maskiert` steuert, ob vertrauliche
 * Werte gekürzt werden — im Portal ja, in der Personalabteilung nein.
 */
function feldListe(requestId: number, maskiert: boolean): EmployeeChangeRequestField[] {
  const rows = getDb()
    .prepare('SELECT field, old_value, new_value FROM employee_change_request_fields WHERE request_id = ? ORDER BY id')
    .all(requestId) as FieldRow[];
  return rows.map((r) => {
    const feld = selfEditableField(r.field);
    const vertraulich = maskiert && feld?.confidential === true;
    return {
      field: r.field,
      label: feld?.label ?? r.field,
      old_value: vertraulich ? maskConfidential(r.old_value) : r.old_value,
      new_value: vertraulich ? maskConfidential(r.new_value) : r.new_value,
      ...(vertraulich ? { masked: true } : {}),
    };
  });
}

function toApi(row: RequestRow, maskiert: boolean): EmployeeChangeRequest {
  return {
    id: row.id,
    employee_id: row.employee_id,
    status: row.status as EmployeeChangeRequest['status'],
    note: row.note,
    decided_at: row.decided_at,
    decision_note: row.decision_note,
    created_at: row.created_at,
    fields: feldListe(row.id, maskiert),
  };
}

export function getRequestRow(id: number): RequestRow {
  const row = getDb().prepare('SELECT * FROM employee_change_requests WHERE id = ?').get(id) as
    | RequestRow
    | undefined;
  if (!row) throw notFound('Änderungsantrag nicht gefunden');
  return row;
}

/** Anträge einer Person, neueste zuerst. Für das Portal: maskiert. */
export function listForEmployee(employeeId: number): EmployeeChangeRequest[] {
  const rows = getDb()
    .prepare('SELECT * FROM employee_change_requests WHERE employee_id = ? ORDER BY created_at DESC, id DESC')
    .all(employeeId) as RequestRow[];
  return rows.map((r) => toApi(r, true));
}

/** Anträge für die Personalabteilung — mit Namen und ungekürzten Werten. */
export function listForHr(filter: { status?: string; employee_id?: number }): EmployeeChangeRequestForHr[] {
  const bedingungen: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    bedingungen.push('r.status = ?');
    params.push(filter.status);
  }
  if (filter.employee_id) {
    bedingungen.push('r.employee_id = ?');
    params.push(filter.employee_id);
  }
  const where = bedingungen.length ? `WHERE ${bedingungen.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT r.*, e.first_name, e.last_name, e.personnel_number,
              ru.name AS requested_by_name, du.name AS decided_by_name
       FROM employee_change_requests r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN users ru ON ru.id = r.requested_by_user_id
       LEFT JOIN users du ON du.id = r.decided_by_user_id
       ${where}
       ORDER BY CASE r.status WHEN 'beantragt' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC`,
    )
    .all(params) as (RequestRow & {
    first_name: string;
    last_name: string;
    personnel_number: string | null;
    requested_by_name: string | null;
    decided_by_name: string | null;
  })[];
  return rows.map((r) => ({
    ...toApi(r, false),
    first_name: r.first_name,
    last_name: r.last_name,
    personnel_number: r.personnel_number,
    requested_by_name: r.requested_by_name,
    decided_by_name: r.decided_by_name,
  }));
}

/**
 * Legt einen Antrag an. Genau EIN offener Antrag je Person: Zwei offene
 * Anträge könnten dasselbe Feld auf verschiedene Werte setzen, und welcher
 * gewinnt, hinge dann an der Reihenfolge der Genehmigungen.
 */
export function createRequest(
  employeeId: number,
  userId: number | null,
  eingabe: z.infer<typeof changeRequestCreateSchema>,
): EmployeeChangeRequest {
  const db = getDb();
  const offen = db
    .prepare("SELECT id FROM employee_change_requests WHERE employee_id = ? AND status = 'beantragt'")
    .get(employeeId) as { id: number } | undefined;
  if (offen) {
    throw conflict(
      'Es liegt bereits ein offener Änderungsantrag vor. Bitte ziehen Sie ihn zurück oder warten Sie die Entscheidung ab.',
    );
  }

  const eintraege = Object.entries(eingabe.fields);
  if (eintraege.length === 0) throw badRequest('Bitte mindestens ein Feld ändern.');

  // Aktuellen Stand EINMAL lesen: Er wird als old_value festgehalten und
  // entscheidet, ob sich überhaupt etwas ändert.
  const spalten = [...FELDER.keys()];
  const aktuell = db
    .prepare(`SELECT ${spalten.join(', ')} FROM employees WHERE id = ?`)
    .get(employeeId) as Record<string, string | null> | undefined;
  if (!aktuell) throw notFound('Personalprofil nicht gefunden');

  const zuSpeichern: { field: string; old_value: string | null; new_value: string | null }[] = [];
  for (const [name, roh] of eintraege) {
    const feld = FELDER.get(name);
    if (!feld) throw badRequest(`Das Feld „${name}" kann nicht selbst beantragt werden.`);
    const neu = normalize(feld, roh);
    const alt = aktuell[name] ?? null;
    if ((alt ?? '') === (neu ?? '')) continue; // unverändert – nicht mitschleppen
    zuSpeichern.push({ field: name, old_value: alt, new_value: neu });
  }
  if (zuSpeichern.length === 0) {
    throw badRequest('Die angegebenen Werte entsprechen bereits dem hinterlegten Stand.');
  }

  let neueId = 0;
  inTransaction(() => {
    const info = db
      .prepare(
        `INSERT INTO employee_change_requests (employee_id, note, requested_by_user_id)
         VALUES (?, ?, ?)`,
      )
      .run(employeeId, eingabe.note ?? null, userId);
    neueId = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      'INSERT INTO employee_change_request_fields (request_id, field, old_value, new_value) VALUES (?, ?, ?, ?)',
    );
    for (const f of zuSpeichern) stmt.run(neueId, f.field, f.old_value, f.new_value);
  });
  return toApi(getRequestRow(neueId), true);
}

/** Rückzug durch die antragstellende Person. Nur solange offen. */
export function withdrawRequest(id: number, employeeId: number): EmployeeChangeRequest {
  const row = getRequestRow(id);
  // 404 statt 403 bei fremden Anträgen: Ein 403 verriete, dass es den Antrag
  // gibt (gleiche Regel wie bei den Dokumenten im Self-Service).
  if (row.employee_id !== employeeId) throw notFound('Änderungsantrag nicht gefunden');
  if (row.status !== 'beantragt') throw conflict('Der Antrag wurde bereits entschieden.');
  getDb().prepare("UPDATE employee_change_requests SET status = 'zurueckgezogen' WHERE id = ?").run(id);
  return toApi(getRequestRow(id), true);
}

export interface DecisionResult {
  request: EmployeeChangeRequestForHr;
  /** Was tatsächlich geschrieben wurde — für das Audit-Protokoll. */
  applied: { field: string; from: string | null; to: string | null }[];
}

/**
 * Entscheidet über einen Antrag und schreibt bei Genehmigung die Personalakte.
 *
 * Vier-Augen-Prinzip wie bei Abwesenheiten und Gehaltsanträgen: Wer den
 * Antrag gestellt hat, genehmigt ihn nicht selbst. Das ist kein theoretischer
 * Fall — ein Konto der Personalabteilung MIT verknüpftem Personalprofil kann
 * beides (siehe docs/web-portal.md). Ablehnen bleibt erlaubt, das ist ein
 * Rückzug und kein Entscheid zugunsten der eigenen Sache.
 */
export function decideRequest(
  id: number,
  userId: number,
  entscheidung: z.infer<typeof changeRequestDecisionSchema>,
  istEigenesProfil: boolean,
): DecisionResult {
  const db = getDb();
  const row = getRequestRow(id);
  if (row.status !== 'beantragt') throw conflict('Der Antrag wurde bereits entschieden.');
  if (entscheidung.decision === 'genehmigt' && (row.requested_by_user_id === userId || istEigenesProfil)) {
    throw badRequest(
      'Eigene Änderungsanträge dürfen nicht selbst genehmigt werden. Bitte lassen Sie den Antrag von einer anderen Person der Personalabteilung prüfen.',
    );
  }
  if (entscheidung.decision === 'abgelehnt' && !entscheidung.decision_note) {
    throw badRequest('Bitte begründen Sie die Ablehnung — die Begründung wird im Portal angezeigt.');
  }

  const felder = db
    .prepare('SELECT field, old_value, new_value FROM employee_change_request_fields WHERE request_id = ? ORDER BY id')
    .all(id) as FieldRow[];

  const applied: DecisionResult['applied'] = [];
  inTransaction(() => {
    if (entscheidung.decision === 'genehmigt') {
      // Die SET-Klausel entsteht ausschließlich aus der Allowlist — der
      // Feldname aus der Datenbank wird NICHT ungeprüft ins SQL gehängt.
      const erlaubt = felder.filter((f) => FELDER.has(f.field));
      if (erlaubt.length !== felder.length) {
        throw badRequest('Der Antrag enthält ein Feld, das nicht mehr beantragbar ist.');
      }
      if (erlaubt.length > 0) {
        // Stand JETZT lesen (nicht old_value): Er kann sich seit der
        // Antragstellung geändert haben und gehört so ins Protokoll.
        const jetzt = db
          .prepare(`SELECT ${[...FELDER.keys()].join(', ')} FROM employees WHERE id = ?`)
          .get(row.employee_id) as Record<string, string | null>;
        const setKlausel = erlaubt.map((f) => `${f.field} = ?`).join(', ');
        db.prepare(`UPDATE employees SET ${setKlausel}, updated_at = datetime('now') WHERE id = ?`).run([
          ...erlaubt.map((f) => f.new_value),
          row.employee_id,
        ]);
        for (const f of erlaubt) {
          applied.push({ field: f.field, from: jetzt[f.field] ?? null, to: f.new_value });
        }
      }
    }
    db.prepare(
      `UPDATE employee_change_requests
       SET status = ?, decided_by_user_id = ?, decided_at = datetime('now'), decision_note = ?
       WHERE id = ?`,
    ).run(entscheidung.decision, userId, entscheidung.decision_note ?? null, id);
  });

  const aktualisiert = listForHr({ employee_id: row.employee_id }).find((r) => r.id === id)!;
  return { request: aktualisiert, applied };
}

/** Offene Anträge — für Dashboard-Kachel und Zähler in der Navigation. */
export function openRequestCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM employee_change_requests WHERE status = 'beantragt'")
    .get() as { n: number };
  return row.n;
}
