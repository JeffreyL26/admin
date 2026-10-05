import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
import { assertUsableAsPhoto, detachUnreferencedFile, removeDetachedBlob } from '../../core/files.js';
import { assertSeatsAvailable } from '../../core/license.js';
import {
  EMPLOYEE_COLUMNS,
  assertExitNotBeforeHire,
  assertTypeRules,
  bulkBodySchema,
  employeeBodySchema,
  employeePatchSchema,
} from './validation.js';

/**
 * Mehrfachauswahl in den Filtern: „Vollzeit ODER Werkstudent“. Der Client
 * schickt kommagetrennt (`employee_type=vollzeit,werkstudent`) oder als
 * wiederholten Parameter — beides landet hier als Liste. Ein leerer Wert
 * bedeutet „kein Filter“, nicht „nichts anzeigen“.
 */
const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  });

const numberList = csvList.transform((v) =>
  v?.map(Number).filter((n) => Number.isInteger(n) && n > 0),
);

/** Sortierfelder der Liste. Bewusst eine Whitelist — der Wert geht ins SQL. */
const SORT_COLUMNS = {
  last_name: 'e.last_name COLLATE NOCASE',
  first_name: 'e.first_name COLLATE NOCASE',
  personnel_number: 'e.personnel_number COLLATE NOCASE',
  hire_date: 'e.hire_date',
  job_title: 'e.job_title COLLATE NOCASE',
  department: 'd.name COLLATE NOCASE',
} as const;

/**
 * Optimistische Sperre für den Stammdaten-PATCH: Der Client schickt den
 * `updated_at`-Stand mit, auf dem seine Eingaben basieren. Ohne den Vergleich
 * überschreiben sich zwei parallel editierende Arbeitsplätze kommentarlos
 * (Lost Update). Das Feld ist bewusst KEIN Spaltenkandidat — EMPLOYEE_COLUMNS
 * kennt es nicht, employeePatchSchema streift es ab.
 */
const concurrencySchema = z.object({
  expected_updated_at: z.string().nullish(),
});

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: csvList,
  employee_type: csvList,
  job_title: csvList,
  department_id: numberList,
  team_id: numberList,
  location_id: numberList,
  sort: z.enum(Object.keys(SORT_COLUMNS) as [keyof typeof SORT_COLUMNS]).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  fields: z.enum(['lite', 'full']).optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;

const BASE_SELECT = `
  SELECT e.*,
         d.name AS department_name,
         t.name AS team_name,
         l.name AS location_name,
         l.bundesland AS location_bundesland,
         m.first_name || ' ' || m.last_name AS manager_name
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN teams t ON t.id = e.team_id
  LEFT JOIN locations l ON l.id = e.location_id
  LEFT JOIN employees m ON m.id = e.manager_id
`;

/** Alle für die Suche relevanten Felder (Name, Kontakt, Ort, Steuer/SV, Orga). */
const SEARCH_FIELDS = [
  "e.first_name", "e.last_name", "e.first_name || ' ' || e.last_name",
  'e.email', 'e.private_email', 'e.phone', 'e.private_phone',
  'e.private_street', 'e.private_zip', 'e.private_city',
  'e.job_title', 'e.iban', 'e.tax_id', 'e.social_security_number',
  'e.health_insurance', 'd.name', 't.name', 'l.name', 'l.city',
];

function queryEmployees(query: ListQuery): Record<string, unknown>[] {
  const where: string[] = [];
  const params: unknown[] = [];

  // Mehrere Werte je Filter werden mit IN verodert, verschiedene Filter mit AND
  // verknüpft: „(Vollzeit ODER Werkstudent) UND Abteilung Technik“.
  const inFilter = (column: string, values: (string | number)[] | undefined) => {
    if (!values?.length) return;
    where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  };
  inFilter('e.status', query.status);
  inFilter('e.employee_type', query.employee_type);
  inFilter('e.department_id', query.department_id);
  inFilter('e.team_id', query.team_id);
  inFilter('e.location_id', query.location_id);
  inFilter('e.job_title', query.job_title);

  if (query.search) {
    const like = `%${query.search.toLowerCase()}%`;
    where.push(`(${SEARCH_FIELDS.map((f) => `lower(coalesce(${f}, '')) LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < SEARCH_FIELDS.length; i++) params.push(like);
  }

  // Sortierung aus der Whitelist; der Name als zweites Kriterium hält die
  // Reihenfolge bei Gleichstand stabil (sonst springen Zeilen beim Neuladen).
  const column = SORT_COLUMNS[query.sort ?? 'last_name'];
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  const tieBreak =
    query.sort === 'first_name'
      ? 'e.last_name COLLATE NOCASE'
      : 'e.first_name COLLATE NOCASE';
  // NULLs (z. B. fehlende Personalnummer) ans Ende, unabhängig von der Richtung.
  const nullsLast = `CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`;

  const sql = `${BASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${nullsLast}, ${column} ${dir}, ${tieBreak} ${dir}`;
  return getDb().prepare(sql).all(...params) as Record<string, unknown>[];
}

function toLite(row: Record<string, unknown>) {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    employee_type: row.employee_type,
    status: row.status,
    job_title: row.job_title,
    department_id: row.department_id,
    team_id: row.team_id,
    location_id: row.location_id,
  };
}

/**
 * Team und Abteilung muessen zusammenpassen: Ein Team mit Abteilung gehoert nur
 * zu Personen dieser Abteilung. Teams ohne Abteilung (`teams.department_id`
 * ist nullable) passen zu jeder Zuordnung. Erwartet den gemergten Stand
 * (Bestand plus Aenderung), damit auch ein reiner Abteilungswechsel auffaellt.
 */
export function assertTeamMatchesDepartment(employee: {
  team_id?: unknown;
  department_id?: unknown;
}): void {
  const teamId = employee.team_id;
  if (typeof teamId !== 'number') return;
  const db = getDb();
  const team = db
    .prepare(
      `SELECT t.name, t.department_id, d.name AS department_name
       FROM teams t LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ?`,
    )
    .get(teamId) as { name: string; department_id: number | null; department_name: string | null } | undefined;
  if (!team) throw notFound('Team nicht gefunden');
  if (team.department_id === null) return;
  const departmentId = employee.department_id;
  if (departmentId === team.department_id) return;
  const chosen =
    typeof departmentId === 'number'
      ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(departmentId) as { name: string } | undefined)
      : undefined;
  throw badRequest(
    `Das Team „${team.name}“ gehört zur Abteilung „${team.department_name ?? ''}“, ${
      chosen ? `nicht zu „${chosen.name}“` : 'die Person hat aber keine Abteilung'
    }. Bitte Team und Abteilung gemeinsam setzen.`,
    { field: 'team_id' },
  );
}

/**
 * Das Vorschaubild gehoert zum aktuellen Foto (Migration 111). Ein neues oder
 * entferntes Foto nimmt das bisherige Vorschaubild mit, sofern der Client
 * kein neues mitschickt; sonst zeigten Listen und Karten weiter das alte
 * Bild. Ein Vorschaubild ohne Foto gibt es nicht. Ergaenzt `patch` um
 * `photo_thumb_file_id: null`, deshalb VOR der Spaltenauswahl aufrufen; beim
 * PATCH mit dem Bestand.
 */
function settlePhotoThumb(
  patch: { photo_file_id?: number | null; photo_thumb_file_id?: number | null },
  existing?: Record<string, unknown>,
): void {
  const photoChanged =
    patch.photo_file_id !== undefined && patch.photo_file_id !== (existing?.photo_file_id ?? null);
  if (photoChanged && patch.photo_thumb_file_id === undefined && existing?.photo_thumb_file_id) {
    patch.photo_thumb_file_id = null;
  }
  const photo = patch.photo_file_id !== undefined ? patch.photo_file_id : existing?.photo_file_id;
  const thumb = patch.photo_thumb_file_id !== undefined ? patch.photo_thumb_file_id : existing?.photo_thumb_file_id;
  if (thumb && !photo) {
    throw badRequest('Ein Vorschaubild ist nur zusammen mit einem Foto möglich.', { field: 'photo_thumb_file_id' });
  }
}

/**
 * Neue Datei-IDs der Fotospalten pruefen (assertUsableAsPhoto in
 * core/files.ts), unveraenderte nicht: Eine ID, die schon in einer der beiden
 * Fotospalten DIESER Person steht, bleibt zulaessig, damit das Formular mit
 * bestehendem Foto speicherbar bleibt.
 */
function assertNewPhotoFiles(
  patch: { photo_file_id?: number | null; photo_thumb_file_id?: number | null },
  userId: number,
  existing?: Record<string, unknown>,
): void {
  const current = [existing?.photo_file_id, existing?.photo_thumb_file_id];
  for (const field of ['photo_file_id', 'photo_thumb_file_id'] as const) {
    const fileId = patch[field];
    if (fileId && !current.includes(fileId)) assertUsableAsPhoto(fileId, userId, field);
  }
}

/**
 * Alle Dateien, die an einer Person haengen. Die Fachzeilen verschwinden per
 * ON DELETE CASCADE mit dem Profil, die `files`-Zeilen und Blobs aber nicht:
 * Ohne diesen Schritt blieben Foto, Vertraege, Dokumente und Nachweise ueber
 * eine signierte URL weiter abrufbar (Loeschersuchen nach Art. 17 DSGVO).
 */
function fileIdsOfEmployee(employeeId: number): number[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT photo_file_id AS file_id FROM employees WHERE id = @id AND photo_file_id IS NOT NULL
       UNION SELECT photo_thumb_file_id FROM employees WHERE id = @id AND photo_thumb_file_id IS NOT NULL
       UNION SELECT document_file_id FROM contracts WHERE employee_id = @id AND document_file_id IS NOT NULL
       UNION SELECT file_id FROM documents WHERE employee_id = @id
       UNION SELECT s.certificate_file_id FROM sick_notes s
         JOIN absence_requests r ON r.id = s.absence_request_id
         WHERE r.employee_id = @id AND s.certificate_file_id IS NOT NULL
       UNION SELECT certificate_file_id FROM training_registrations
         WHERE employee_id = @id AND certificate_file_id IS NOT NULL
       UNION SELECT file_id FROM freelancer_invoices WHERE employee_id = @id AND file_id IS NOT NULL
       UNION SELECT file_id FROM certificates WHERE employee_id = @id AND file_id IS NOT NULL`,
    )
    .all({ id: employeeId }) as { file_id: number }[];
  return rows.map((r) => r.file_id);
}

export function getEmployeeOr404(id: number): Record<string, unknown> {
  const row = getDb()
    .prepare(`${BASE_SELECT} WHERE e.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw notFound('Mitarbeiter:in nicht gefunden');
  return row;
}

/** Reporting-Line: Vorgesetztenkette von der Person bis zur Spitze (max. 20 Stufen). */
function reportingLine(employeeId: number): { id: number; name: string; job_title: string | null }[] {
  const db = getDb();
  const line: { id: number; name: string; job_title: string | null }[] = [];
  let current = db
    .prepare('SELECT id, manager_id, first_name, last_name, job_title FROM employees WHERE id = ?')
    .get(employeeId) as
    | { id: number; manager_id: number | null; first_name: string; last_name: string; job_title: string | null }
    | undefined;
  const seen = new Set<number>([employeeId]);
  while (current?.manager_id && line.length < 20) {
    if (seen.has(current.manager_id)) break; // defensiv gegen Zyklen
    const mgr = db
      .prepare('SELECT id, manager_id, first_name, last_name, job_title FROM employees WHERE id = ?')
      .get(current.manager_id) as typeof current | undefined;
    if (!mgr) break;
    seen.add(mgr.id);
    line.push({ id: mgr.id, name: `${mgr.first_name} ${mgr.last_name}`, job_title: mgr.job_title });
    current = mgr;
  }
  return line;
}

/** CSV-Zelle für deutsches Excel (Semikolon-Separator) escapen. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  'id', 'personnel_number', 'first_name', 'last_name', 'email', 'phone', 'birth_date',
  'private_street', 'private_zip', 'private_city', 'private_phone', 'private_email',
  'iban', 'bic', 'tax_id', 'tax_class', 'church_tax', 'child_allowances',
  'social_security_number', 'health_insurance',
  'employee_type', 'status', 'job_title',
  'department_name', 'team_name', 'location_name', 'manager_name',
  'hire_date', 'exit_date', 'weekly_hours', 'annual_leave_days',
];

export async function employeeRoutes(app: FastifyInstance): Promise<void> {
  // Vorhandene Titel als Filterwerte — damit sich z. B. alle Leitungsrollen
  // quer über die Abteilungen zeigen lassen. Bewusst aus dem Bestand statt aus
  // einer gepflegten Liste: Titel entstehen beim Anlegen frei, eine getrennte
  // Stammdatenpflege liefe sofort auseinander.
  // Muss VOR '/api/employees/:id' stehen, sonst greift die Parameter-Route.
  app.get('/api/employees/job-titles', async () => {
    const rows = getDb()
      .prepare(
        `SELECT job_title AS title, COUNT(*) AS count FROM employees
         WHERE job_title IS NOT NULL AND trim(job_title) != ''
         GROUP BY job_title ORDER BY job_title COLLATE NOCASE`,
      )
      .all() as { title: string; count: number }[];
    return { job_titles: rows };
  });

  // Liste inkl. Suche/Filter/Sortierung; fields=lite ist Kontrakt für andere Module.
  app.get('/api/employees', async (req) => {
    const query = parse(listQuerySchema, req.query ?? {});
    const rows = queryEmployees(query);
    if (query.fields === 'lite') return { employees: rows.map(toLite) };
    return { employees: rows };
  });

  // CSV-Export (BOM + Semikolon für deutsches Excel), gleiche Filter wie die Liste.
  app.get('/api/employees/export.csv', async (req, reply) => {
    const query = parse(listQuerySchema, req.query ?? {});
    const rows = queryEmployees(query);
    const lines = [
      CSV_COLUMNS.join(';'),
      ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(';')),
    ];
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="mitarbeitende.csv"');
    return '﻿' + lines.join('\r\n');
  });

  // Massenbearbeitung: nur die freigegebenen Felder, transaktional, auditiert.
  app.post('/api/employees/bulk', async (req) => {
    const { ids, set } = parse(bulkBodySchema, req.body);
    const fields = Object.entries(set).filter(([, v]) => v !== undefined);
    if (fields.length === 0) throw badRequest('Keine Felder zum Setzen angegeben');

    const db = getDb();
    // Platzgrenze der Lizenz (core/license.ts): zählt, wie viele der gewählten
    // Profile durch dieses Set von 'ausgeschieden' auf 'aktiv' wechseln würden.
    if (set.status === 'aktiv') {
      const reactivating = ids.filter((id) => {
        const row = db.prepare('SELECT status FROM employees WHERE id = ?').get(id) as
          | { status: string }
          | undefined;
        return row?.status === 'ausgeschieden';
      }).length;
      assertSeatsAvailable(reactivating);
    }
    let teamsCleared = 0;
    inTransaction(() => {
      const update = db.prepare(
        `UPDATE employees SET ${fields.map(([k]) => `${k} = ?`).join(', ')},
         updated_at = datetime('now') WHERE id = ?`,
      );
      const clearTeam = db.prepare('UPDATE employees SET team_id = NULL WHERE id = ?');
      for (const id of ids) {
        const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!existing) throw notFound(`Mitarbeiter:in mit ID ${id} nicht gefunden`);
        const merged: Record<string, unknown> = { ...existing, ...set };
        // Reiner Abteilungswechsel: Ein Team der alten Abteilung passt nicht
        // mehr und wird geloest, statt den ganzen Vorgang abzubrechen (das
        // Personalformular setzt das Team beim Abteilungswechsel ebenso zurueck).
        let clearsTeam = false;
        if (set.department_id !== undefined && set.team_id === undefined && typeof existing.team_id === 'number') {
          const team = db.prepare('SELECT department_id FROM teams WHERE id = ?').get(existing.team_id) as
            | { department_id: number | null }
            | undefined;
          if (team && team.department_id !== null && team.department_id !== set.department_id) {
            merged.team_id = null;
            clearsTeam = true;
          }
        }
        assertTypeRules(merged);
        if (set.team_id !== undefined || set.department_id !== undefined) {
          try {
            assertTeamMatchesDepartment(merged);
          } catch (e) {
            if (e instanceof Error) {
              throw badRequest(`${existing.first_name} ${existing.last_name}: ${e.message}`, { employee_id: id });
            }
            throw e;
          }
        }
        update.run(...fields.map(([, v]) => v), id);
        if (clearsTeam) {
          clearTeam.run(id);
          teamsCleared++;
        }
      }
      audit(req, 'bulk_update', 'employee', undefined, { ids, set, teams_cleared: teamsCleared });
    });
    return { updated: ids.length, teams_cleared: teamsCleared };
  });

  app.get('/api/employees/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const employee = getEmployeeOr404(id);
    return { employee, reporting_line: reportingLine(id) };
  });

  /**
   * Doppelte Personalnummer vorab abfangen. Der partielle UNIQUE-Index würde
   * sonst als roher SQLite-Fehler durchschlagen — hier wird daraus eine
   * Meldung, die sagt, wem die Nummer schon gehört.
   */
  function assertPersonnelNumberFree(value: unknown, exceptId?: number): void {
    if (typeof value !== 'string' || value.trim() === '') return;
    const clash = getDb()
      .prepare(
        `SELECT id, first_name, last_name FROM employees
         WHERE personnel_number = ? AND id != ?`,
      )
      .get([value.trim(), exceptId ?? -1]) as
      | { id: number; first_name: string; last_name: string }
      | undefined;
    if (clash) {
      throw conflict(
        `Die Personalnummer „${value.trim()}“ ist bereits ${clash.first_name} ${clash.last_name} zugeordnet.`,
      );
    }
  }

  app.post('/api/employees', async (req, reply) => {
    const body = parse(employeeBodySchema, req.body);
    settlePhotoThumb(body);
    assertNewPhotoFiles(body, req.user.id);
    assertTypeRules(body);
    // Beim Anlegen kommen beide Datumsfelder frisch aus der Eingabe — hier
    // darf die Reihenfolge-Prüfung immer laufen (sie greift nur, wenn beide
    // gesetzt sind).
    assertExitNotBeforeHire(body);
    assertTeamMatchesDepartment(body);
    assertPersonnelNumberFree(body.personnel_number);
    // Platzgrenze der Lizenz (core/license.ts) — nur ein aktives Profil zählt.
    if (body.status === 'aktiv') assertSeatsAvailable(1);
    const cols = EMPLOYEE_COLUMNS.filter((c) => body[c] !== undefined);
    // Profil und Audit-Eintrag in EINER Transaktion: kein Stand ohne Protokoll.
    const id = inTransaction(() => {
      const info = getDb()
        .prepare(
          `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
        .run(...cols.map((c) => body[c] ?? null));
      const newId = Number(info.lastInsertRowid);
      audit(req, 'create', 'employee', newId, { name: `${body.first_name} ${body.last_name}` });
      return newId;
    });
    reply.status(201);
    return { employee: getEmployeeOr404(id) };
  });

  app.patch('/api/employees/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw notFound('Mitarbeiter:in nicht gefunden');
    // Der Vergleich VOR dem UPDATE genügt: better-sqlite3 arbeitet synchron im
    // einzigen Prozess, zwischen Lesen und Schreiben läuft kein zweiter Request.
    const { expected_updated_at } = parse(concurrencySchema, req.body);
    if (expected_updated_at != null && expected_updated_at !== existing.updated_at) {
      throw conflict(
        'Der Datensatz wurde zwischenzeitlich von jemand anderem geändert. Bitte laden Sie die Personalakte neu und übernehmen Sie Ihre Änderungen erneut.',
      );
    }
    const patch = parse(employeePatchSchema, req.body);
    settlePhotoThumb(patch, existing);
    assertNewPhotoFiles(patch, req.user.id, existing);
    const cols = EMPLOYEE_COLUMNS.filter((c) => patch[c] !== undefined);
    if (cols.length === 0) throw badRequest('Keine Änderungen übergeben');
    assertTypeRules({ ...existing, ...patch });
    // Nur prüfen, wenn das Patch eines der Datumsfelder tatsächlich setzt:
    // Eine Bestandszeile mit Altlast (exit < hire) bleibt sonst für jede
    // unbeteiligte Änderung (z. B. Telefonnummer) gesperrt — das Feld-Diffing
    // des Clients schickt unveränderte Datumsfelder gar nicht mehr mit.
    if (patch.hire_date !== undefined || patch.exit_date !== undefined) {
      assertExitNotBeforeHire({ ...existing, ...patch });
    }
    // Wie oben: nur pruefen, wenn Team oder Abteilung angefasst werden, sonst
    // sperrte eine Altlast jede unbeteiligte Aenderung.
    if (patch.team_id !== undefined || patch.department_id !== undefined) {
      assertTeamMatchesDepartment({ ...existing, ...patch });
    }
    assertPersonnelNumberFree(patch.personnel_number, id);
    // Reaktivierung belegt einen Platz der Lizenz.
    if (existing.status === 'ausgeschieden' && patch.status === 'aktiv') assertSeatsAvailable(1);
    // Ersetztes oder entferntes Foto samt Vorschaubild aufraeumen, sofern
    // nirgends sonst verknuepft; der Audit-Eintrag nennt die Dateien.
    const replacedOf = (column: 'photo_file_id' | 'photo_thumb_file_id') => {
      const replaced = existing[column] as number | null | undefined;
      return patch[column] !== undefined && replaced && replaced !== patch[column] ? replaced : null;
    };
    const replacedFiles = [replacedOf('photo_file_id'), replacedOf('photo_thumb_file_id')];
    // Aenderung, Entfernen der Dateieintraege und Audit in EINER Transaktion;
    // die Blobs auf der Platte erst nach dem Commit, sie nimmt kein Rollback
    // zurueck (detachUnreferencedFile/removeDetachedBlob in core/files.ts).
    const detached = inTransaction(() => {
      getDb()
        .prepare(
          `UPDATE employees SET ${cols.map((c) => `${c} = ?`).join(', ')},
           updated_at = datetime('now') WHERE id = ?`,
        )
        .run(...cols.map((c) => patch[c] ?? null), id);
      const [removedFile, removedThumb] = replacedFiles.map((fileId) =>
        fileId ? detachUnreferencedFile(fileId) : null,
      );
      audit(req, 'update', 'employee', id, {
        changed: Object.fromEntries(cols.map((c) => [c, patch[c]])),
        ...(removedFile ? { removed_file: { id: removedFile.id, sha256: removedFile.sha256 } } : {}),
        ...(removedThumb ? { removed_thumb_file: { id: removedThumb.id, sha256: removedThumb.sha256 } } : {}),
      });
      return [removedFile, removedThumb];
    });
    for (const file of detached) removeDetachedBlob(file);
    return { employee: getEmployeeOr404(id) };
  });

  app.delete('/api/employees/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb()
      .prepare('SELECT first_name, last_name FROM employees WHERE id = ?')
      .get(id) as { first_name: string; last_name: string } | undefined;
    if (!existing) throw notFound('Mitarbeiter:in nicht gefunden');
    // Dateien VOR dem DELETE einsammeln: Die Fachzeilen (Vertraege, Dokumente,
    // Nachweise) fallen per CASCADE mit dem Profil, danach weiss niemand mehr,
    // welche Dateien dazugehoerten. Alle Fremdschluessel auf employees tragen
    // CASCADE oder SET NULL, ein Constraint-Fehler ist hier nicht mehr moeglich.
    const fileIds = fileIdsOfEmployee(id);
    // Loeschen, Entfernen der Dateieintraege und Audit in EINER Transaktion;
    // die Blobs auf der Platte erst nach dem Commit, sie nimmt kein Rollback
    // zurueck (detachUnreferencedFile/removeDetachedBlob in core/files.ts).
    const detached = inTransaction(() => {
      getDb().prepare('DELETE FROM employees WHERE id = ?').run(id);
      // Erst NACH dem DELETE: Vorher hielte die Referenzpruefung jede Datei
      // fuer weiterhin gebraucht. Eine Datei, die noch anderswo verknuepft ist
      // (z. B. dieselbe Vorlage bei einer zweiten Person), bleibt stehen.
      const removed = fileIds.map((fileId) => detachUnreferencedFile(fileId)).filter((f) => f !== null);
      audit(req, 'delete', 'employee', id, {
        name: `${existing.first_name} ${existing.last_name}`,
        files_deleted: removed.length,
        files_kept: fileIds.length - removed.length,
      });
      return removed;
    });
    for (const file of detached) removeDetachedBlob(file);
    reply.status(204);
  });
}
