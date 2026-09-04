import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound, parse } from '../../core/errors.js';
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
    inTransaction(() => {
      const update = db.prepare(
        `UPDATE employees SET ${fields.map(([k]) => `${k} = ?`).join(', ')},
         updated_at = datetime('now') WHERE id = ?`,
      );
      for (const id of ids) {
        const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!existing) throw notFound(`Mitarbeiter:in mit ID ${id} nicht gefunden`);
        assertTypeRules({ ...existing, ...set });
        update.run(...fields.map(([, v]) => v), id);
      }
    });
    audit(req, 'bulk_update', 'employee', undefined, { ids, set });
    return { updated: ids.length };
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
    assertTypeRules(body);
    // Beim Anlegen kommen beide Datumsfelder frisch aus der Eingabe — hier
    // darf die Reihenfolge-Prüfung immer laufen (sie greift nur, wenn beide
    // gesetzt sind).
    assertExitNotBeforeHire(body);
    assertPersonnelNumberFree(body.personnel_number);
    const cols = EMPLOYEE_COLUMNS.filter((c) => body[c] !== undefined);
    const info = getDb()
      .prepare(
        `INSERT INTO employees (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      )
      .run(...cols.map((c) => body[c] ?? null));
    const id = Number(info.lastInsertRowid);
    audit(req, 'create', 'employee', id, { name: `${body.first_name} ${body.last_name}` });
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
    assertPersonnelNumberFree(patch.personnel_number, id);
    getDb()
      .prepare(
        `UPDATE employees SET ${cols.map((c) => `${c} = ?`).join(', ')},
         updated_at = datetime('now') WHERE id = ?`,
      )
      .run(...cols.map((c) => patch[c] ?? null), id);
    audit(req, 'update', 'employee', id, { changed: Object.fromEntries(cols.map((c) => [c, patch[c]])) });
    return { employee: getEmployeeOr404(id) };
  });

  app.delete('/api/employees/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = getDb()
      .prepare('SELECT first_name, last_name FROM employees WHERE id = ?')
      .get(id) as { first_name: string; last_name: string } | undefined;
    if (!existing) throw notFound('Mitarbeiter:in nicht gefunden');
    try {
      getDb().prepare('DELETE FROM employees WHERE id = ?').run(id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('SQLITE_CONSTRAINT')) {
        throw conflict(
          'Mitarbeiter:in wird von anderen Modulen referenziert. Bitte stattdessen den Status auf „ausgeschieden“ setzen',
        );
      }
      throw e;
    }
    audit(req, 'delete', 'employee', id, {
      name: `${existing.first_name} ${existing.last_name}`,
    });
    reply.status(204);
  });
}
