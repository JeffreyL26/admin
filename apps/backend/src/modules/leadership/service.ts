/**
 * Fachlogik des Moduls Führung & Bewertung.
 *
 * Drei Dinge laufen hier zusammen:
 *  1. Zuständigkeit: Welche Mitarbeitenden gehören zu einer Führungskraft?
 *     Automatisch aus der Organisation (manager_id, Abteilungsleitung inklusive
 *     Unterabteilungen, Teamleitung) plus manuelle Zuweisungen und Ausnahmen,
 *     siehe `scopeFor`. Das ist die EINZIGE Stelle, an der Zuständigkeit
 *     bestimmt wird; Routen, Report und Status fragen alle hier nach.
 *  2. Bewertungen: Upsert je (Führungskraft, Person, Kategorie, Zeitraum) mit
 *     unveränderlichem Protokoll (`saveRatings`).
 *  3. Report: Verteilung der Gesamtbewertung je Führungskraft (`buildReport`).
 */
import type { FastifyRequest } from 'fastify';
import {
  RATING_PERIOD_LABELS,
  RATING_SCALES,
  isValidPeriodKey,
  normalizedScore,
  periodForDate,
  periodFromKey,
  periodKindOfKey,
  recentPeriods,
  scaleLevelLabel,
  scaleLevelsBestFirst,
  scoreTone,
  type AssignmentCreateResponse,
  type EmployeeRatingsResponse,
  type Leader,
  type BreakdownCell,
  type BreakdownRow,
  type LeaderBreakdown,
  type LeaderCreateResponse,
  type LeaderStatus,
  type MyTeamResponse,
  type LeaderTeamResponse,
  type LeadershipAssignment,
  type LeadershipAssignmentInput,
  type LeadershipLookup,
  type LeadershipReport,
  type LeadershipSettings,
  type LeadershipSettingsPatch,
  type Rating,
  type RatingCategory,
  type RatingCategoryInput,
  type RatingDetail,
  type RatingHistoryEntry,
  type RatingPeriod,
  type RatingScaleKey,
  type RatingsSaveRequest,
  type ReportDistributionEntry,
  type ReportLeaderRow,
  type ScopeSource,
  type TeamMember,
  type TeamScopeSummary,
} from '@ohrganize/shared';
import { getDb, inTransaction } from '../../db/db.js';
import { audit } from '../../core/audit.js';
import { todayIso } from '../../core/dates.js';
import { signDownloadUrl } from '../../core/files.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

interface SettingsRow extends LeadershipSettings {
  id: number;
}

export function getSettings(): LeadershipSettings {
  const row = getDb().prepare('SELECT * FROM leadership_settings WHERE id = 1').get() as
    | SettingsRow
    | undefined;
  if (!row) throw new Error('leadership_settings fehlt: Migration 310_leadership_ratings nicht gelaufen?');
  const { id: _id, ...settings } = row;
  return settings;
}

export function updateSettings(req: FastifyRequest, patch: LeadershipSettingsPatch): LeadershipSettings {
  const sets: string[] = [];
  const params: Record<string, unknown> = {};
  const boolKeys = [
    'uniform_scale',
    'allow_mutual',
    'auto_direct_reports',
    'auto_department_head',
    'auto_team_lead',
  ] as const;
  for (const key of boolKeys) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key] ? 1 : 0;
    }
  }
  if (patch.period !== undefined) {
    sets.push('period = @period');
    params.period = patch.period;
  }
  if (patch.scale !== undefined) {
    sets.push('scale = @scale');
    params.scale = patch.scale;
  }
  if (sets.length === 0) throw badRequest('Keine Änderungen übergeben');
  const before = getSettings();
  const pairsBefore = pairKeys(mutualPairs());
  sets.push("updated_at = datetime('now')");
  const after = inTransaction(() => {
    getDb().prepare(`UPDATE leadership_settings SET ${sets.join(', ')} WHERE id = 1`).run(params);
    const next = getSettings();
    if (next.allow_mutual === 0) {
      // Ausschluss erst möglich, wenn kein Paar mehr besteht, sonst stünde
      // in den Einstellungen etwas, das die Daten längst verletzen.
      if (before.allow_mutual === 1) {
        const pairs = mutualPairs();
        if (pairs.length > 0) {
          throw conflict(
            `Gegenseitige Verantwortung kann nicht ausgeschlossen werden, solange Paare bestehen: ${pairs.map((p) => p.label).join(', ')}. ` +
              'Nehmen Sie eine Seite über eine Ausnahme heraus oder lassen Sie gegenseitige Verantwortung zu.',
          );
        }
      } else {
        // Eine zusätzliche automatische Quelle kann neue Paare erzeugen.
        assertMutualAllowed(pairsBefore, 0, 'Diese Einstellung');
      }
    }
    return next;
  });
  audit(req, 'update', 'leadership_settings', 1, { before, after });
  return after;
}

// ---------------------------------------------------------------------------
// Zeiträume
// ---------------------------------------------------------------------------

export function currentPeriod(settings: LeadershipSettings = getSettings()): RatingPeriod {
  return periodForDate(todayIso(), settings.period);
}

/**
 * Zeitraum aus dem Query-Parameter. Ohne Angabe der aktuelle; sonst muss der
 * Schlüssel zur eingestellten Kadenz passen: ein Quartalsschlüssel bei
 * monatlicher Bewertung ist keine Bewertungsperiode.
 */
export function resolvePeriod(param: unknown, settings: LeadershipSettings): RatingPeriod {
  if (param === undefined || param === null || param === '') return currentPeriod(settings);
  if (typeof param !== 'string' || !isValidPeriodKey(param, settings.period)) {
    throw badRequest(
      `Ungültiger Zeitraum. Erwartet wird ein Schlüssel der eingestellten Kadenz (${RATING_PERIOD_LABELS[settings.period]}).`,
    );
  }
  // Untere Schranke: Die Aufschlüsselung blättert von hier aus rückwärts
  // (recentPeriods) und liefe bei Jahr 0001 unter das Jahr 0000, mit einem
  // 500er statt einer verständlichen Meldung. Ein Personalsystem braucht
  // keine Zeiträume vor 1900.
  if (Number(param.slice(0, 4)) < 1900) {
    throw badRequest('Zeiträume vor dem Jahr 1900 sind nicht vorgesehen.');
  }
  return periodFromKey(param);
}

// ---------------------------------------------------------------------------
// Kategorien
// ---------------------------------------------------------------------------

interface CategoryRow {
  id: number;
  name: string;
  description: string | null;
  sort_order: number;
  active: number;
  is_overall: number;
  scale: RatingScaleKey | null;
  created_at: string;
  rating_count: number;
}

const CATEGORY_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM leadership_ratings r WHERE r.category_id = c.id) AS rating_count
  FROM rating_categories c`;

const CATEGORY_ORDER = 'ORDER BY c.is_overall DESC, c.sort_order, c.name COLLATE NOCASE';

function categoryToApi(row: CategoryRow, settings: LeadershipSettings): RatingCategory {
  return {
    ...row,
    effective_scale: settings.uniform_scale === 1 || !row.scale ? settings.scale : row.scale,
  };
}

/** Alle Kategorien (Gesamtbewertung zuerst); `activeOnly` für die Bewertungsmaske. */
export function listCategories(activeOnly = false, settings = getSettings()): RatingCategory[] {
  const rows = getDb()
    .prepare(`${CATEGORY_SELECT} ${activeOnly ? 'WHERE c.active = 1' : ''} ${CATEGORY_ORDER}`)
    .all() as CategoryRow[];
  return rows.map((r) => categoryToApi(r, settings));
}

export function getCategory(id: number, settings = getSettings()): RatingCategory {
  const row = getDb().prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id) as CategoryRow | undefined;
  if (!row) throw notFound('Bewertungskategorie nicht gefunden');
  return categoryToApi(row, settings);
}

export function overallCategory(settings = getSettings()): RatingCategory {
  const row = getDb().prepare(`${CATEGORY_SELECT} WHERE c.is_overall = 1`).get() as CategoryRow | undefined;
  if (!row) throw new Error('Keine Gesamtbewertungs-Kategorie vorhanden');
  return categoryToApi(row, settings);
}

function assertCategoryNameFree(name: string, exceptId?: number): void {
  const clash = getDb()
    .prepare('SELECT id FROM rating_categories WHERE name = ? COLLATE NOCASE AND id != ?')
    .get([name, exceptId ?? -1]);
  if (clash) throw conflict(`Es gibt bereits eine Kategorie mit dem Namen „${name}“.`);
}

export function createCategory(req: FastifyRequest, input: RatingCategoryInput): RatingCategory {
  assertCategoryNameFree(input.name);
  const next = (
    getDb().prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM rating_categories').get() as {
      n: number;
    }
  ).n;
  const info = getDb()
    .prepare(
      `INSERT INTO rating_categories (name, description, sort_order, active, scale)
       VALUES (@name, @description, @sort_order, @active, @scale)`,
    )
    .run({
      name: input.name,
      description: input.description ?? null,
      sort_order: next,
      active: input.active === false ? 0 : 1,
      scale: input.scale ?? null,
    });
  const id = Number(info.lastInsertRowid);
  audit(req, 'create', 'rating_category', id, { name: input.name });
  return getCategory(id);
}

export function updateCategory(
  req: FastifyRequest,
  id: number,
  patch: Partial<RatingCategoryInput>,
): RatingCategory {
  const existing = getCategory(id);
  if (patch.name !== undefined) assertCategoryNameFree(patch.name, id);
  if (existing.is_overall === 1 && patch.active === false) {
    throw conflict('Die Gesamtbewertung kann nicht deaktiviert werden: sie ist die Grundlage des Reports.');
  }
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.name !== undefined) {
    sets.push('name = @name');
    params.name = patch.name;
  }
  if (patch.description !== undefined) {
    sets.push('description = @description');
    params.description = patch.description ?? null;
  }
  if (patch.scale !== undefined) {
    sets.push('scale = @scale');
    params.scale = patch.scale ?? null;
  }
  if (patch.active !== undefined) {
    sets.push('active = @active');
    params.active = patch.active ? 1 : 0;
  }
  if (sets.length === 0) throw badRequest('Keine Änderungen übergeben');
  getDb().prepare(`UPDATE rating_categories SET ${sets.join(', ')} WHERE id = @id`).run(params);
  audit(req, 'update', 'rating_category', id, { before: existing.name, changed: patch });
  return getCategory(id);
}

export function deleteCategory(req: FastifyRequest, id: number): void {
  const existing = getCategory(id);
  if (existing.is_overall === 1) {
    throw conflict('Die Gesamtbewertung kann nicht gelöscht werden: sie ist die Grundlage des Reports.');
  }
  if ((existing.rating_count ?? 0) > 0) {
    throw conflict(
      `„${existing.name}“ wurde bereits ${existing.rating_count === 1 ? 'einmal' : `${existing.rating_count}-mal`} bewertet. ` +
        'Deaktivieren Sie die Kategorie stattdessen: das Protokoll bleibt so nachvollziehbar.',
    );
  }
  getDb().prepare('DELETE FROM rating_categories WHERE id = ?').run(id);
  audit(req, 'delete', 'rating_category', id, { name: existing.name });
}

/** Neue Reihenfolge: die Liste muss alle Kategorien genau einmal enthalten. */
export function reorderCategories(req: FastifyRequest, ids: number[]): RatingCategory[] {
  const existing = (getDb().prepare('SELECT id FROM rating_categories').all() as { id: number }[]).map(
    (r) => r.id,
  );
  const wanted = new Set(ids);
  if (wanted.size !== ids.length || existing.length !== ids.length || existing.some((id) => !wanted.has(id))) {
    throw badRequest('Die Reihenfolge muss jede Kategorie genau einmal enthalten.');
  }
  inTransaction(() => {
    const update = getDb().prepare('UPDATE rating_categories SET sort_order = ? WHERE id = ?');
    ids.forEach((id, index) => update.run([index + 1, id]));
  });
  audit(req, 'reorder', 'rating_category', undefined, { ids });
  return listCategories(false);
}

// ---------------------------------------------------------------------------
// Führungskräfte
// ---------------------------------------------------------------------------

interface LeaderRow extends Omit<Leader, 'team_size'> {}

const LEADER_SELECT = `
  SELECT l.employee_id, e.first_name, e.last_name, e.personnel_number, e.job_title, e.status,
         e.photo_file_id, d.name AS department_name, l.auto_scope, l.note, l.created_at,
         gu.name AS granted_by_name, u.id AS user_id, u.email AS user_email,
         (SELECT COUNT(*) FROM leadership_assignments a WHERE a.leader_employee_id = l.employee_id) AS assignment_count
  FROM leadership_leaders l
  JOIN employees e ON e.id = l.employee_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN users gu ON gu.id = l.granted_by_user_id
  LEFT JOIN users u ON u.employee_id = l.employee_id AND u.role = 'admin'`;

export function isLeaderEmployee(employeeId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM leadership_leaders WHERE employee_id = ?').get(employeeId);
}

export function loadLeader(employeeId: number): Leader {
  const row = getDb().prepare(`${LEADER_SELECT} WHERE l.employee_id = ?`).get(employeeId) as
    | LeaderRow
    | undefined;
  if (!row) throw notFound('Diese Person ist nicht als Führungskraft freigeschaltet');
  return { ...row, team_size: scopeFor(employeeId).size };
}

export function listLeaders(): Leader[] {
  const rows = getDb()
    .prepare(`${LEADER_SELECT} ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`)
    .all() as LeaderRow[];
  return rows.map((r) => ({ ...r, team_size: scopeFor(r.employee_id).size }));
}

export function grantLeader(
  req: FastifyRequest,
  employeeId: number,
  opts: { auto_scope?: boolean; note?: string | null },
): LeaderCreateResponse {
  const employee = getDb()
    .prepare('SELECT id, status, first_name, last_name FROM employees WHERE id = ?')
    .get(employeeId) as { id: number; status: string; first_name: string; last_name: string } | undefined;
  if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
  if (employee.status !== 'aktiv') {
    throw badRequest('Nur aktive Mitarbeitende können als Führungskraft freigeschaltet werden.');
  }
  if (isLeaderEmployee(employeeId)) {
    throw conflict(`${employee.first_name} ${employee.last_name} ist bereits als Führungskraft freigeschaltet.`);
  }
  const settings = getSettings();
  const warnings: string[] = [];
  const before = pairKeys(mutualPairs());
  inTransaction(() => {
    getDb()
      .prepare(
        `INSERT INTO leadership_leaders (employee_id, auto_scope, note, granted_by_user_id)
         VALUES (@employee_id, @auto_scope, @note, @granted_by)`,
      )
      .run({
        employee_id: employeeId,
        auto_scope: opts.auto_scope === false ? 0 : 1,
        note: opts.note ?? null,
        granted_by: req.user.id,
      });
    // Gegenseitige Verantwortung kann schon aus der Organisation entstehen
    // (A ist Vorgesetzte:r von B, B leitet die Abteilung von A). Ist sie nicht
    // zugelassen, scheitert die Freischaltung mit Erklärung statt still eine
    // verbotene Konstellation anzulegen. Die Transaktion rollt zurück.
    warnings.push(...assertMutualAllowed(before, settings.allow_mutual, 'Die Freischaltung'));
  });
  audit(req, 'grant', 'leadership_leader', employeeId, {
    name: `${employee.first_name} ${employee.last_name}`,
    auto_scope: opts.auto_scope !== false,
  });
  return { leader: loadLeader(employeeId), warnings };
}

export function updateLeader(
  req: FastifyRequest,
  employeeId: number,
  patch: { auto_scope?: boolean; note?: string | null },
): { leader: Leader; warnings: string[] } {
  loadLeader(employeeId);
  const sets: string[] = [];
  const params: Record<string, unknown> = { employee_id: employeeId };
  if (patch.auto_scope !== undefined) {
    sets.push('auto_scope = @auto_scope');
    params.auto_scope = patch.auto_scope ? 1 : 0;
  }
  if (patch.note !== undefined) {
    sets.push('note = @note');
    params.note = patch.note ?? null;
  }
  if (sets.length === 0) throw badRequest('Keine Änderungen übergeben');
  const settings = getSettings();
  const before = pairKeys(mutualPairs());
  const warnings: string[] = [];
  inTransaction(() => {
    getDb()
      .prepare(`UPDATE leadership_leaders SET ${sets.join(', ')} WHERE employee_id = @employee_id`)
      .run(params);
    // Das Einschalten der Automatik kann Paare erzeugen: gleiche Regel wie
    // beim Freischalten.
    if (patch.auto_scope !== undefined) {
      warnings.push(...assertMutualAllowed(before, settings.allow_mutual, 'Die Änderung der Zuständigkeit'));
    }
  });
  audit(req, 'update', 'leadership_leader', employeeId, { changed: patch });
  return { leader: loadLeader(employeeId), warnings };
}

/**
 * Freischaltung entziehen. Bewertungen und Protokoll bleiben erhalten; die
 * manuellen Zuweisungen der Führungskraft fallen mit (FK-Kaskade auf
 * leadership_leaders). Ein erneutes Freischalten startet ohne sie. Die Zahl
 * steht im Audit und in der Bestätigung der Einrichtung.
 */
export function revokeLeader(req: FastifyRequest, employeeId: number): void {
  const leader = loadLeader(employeeId);
  getDb().prepare('DELETE FROM leadership_leaders WHERE employee_id = ?').run(employeeId);
  audit(req, 'revoke', 'leadership_leader', employeeId, {
    name: `${leader.first_name} ${leader.last_name}`,
    removed_assignments: leader.assignment_count,
  });
}

// ---------------------------------------------------------------------------
// Zuständigkeit
// ---------------------------------------------------------------------------

/**
 * Abteilung(en) samt aller Unterabteilungen. Der Tiefen-Deckel schützt vor
 * einer Endlosschleife, sollte je ein Zyklus in `departments.parent_id`
 * entstehen (orgRoutes verhindert ihn, aber ein Report darf daran nicht hängen).
 */
const DEPARTMENT_TREE_CTE = `
  WITH RECURSIVE sub(id, depth) AS (
    SELECT id, 0 FROM departments WHERE %ROOT%
    UNION ALL
    SELECT d.id, sub.depth + 1 FROM departments d JOIN sub ON d.parent_id = sub.id WHERE sub.depth < 50
  )`;

function activeEmployeesInDepartments(rootCondition: string, param: number): number[] {
  return (
    getDb()
      .prepare(
        `${DEPARTMENT_TREE_CTE.replace('%ROOT%', rootCondition)}
         SELECT DISTINCT e.id FROM employees e
         WHERE e.department_id IN (SELECT id FROM sub) AND e.status = 'aktiv'`,
      )
      .all(param) as { id: number }[]
  ).map((r) => r.id);
}

interface AssignmentRow {
  id: number;
  leader_employee_id: number;
  kind: 'include' | 'exclude';
  target_employee_id: number | null;
  target_department_id: number | null;
  target_team_id: number | null;
  target_role_id: number | null;
  valid_from: string | null;
  valid_to: string | null;
  note: string | null;
  created_by_user_id: number | null;
  created_at: string;
}

/** Aktive Mitarbeitende, die ein Zuweisungsziel heute umfasst. */
function resolveTargetMembers(a: AssignmentRow): number[] {
  const db = getDb();
  if (a.target_employee_id !== null) {
    const row = db
      .prepare(`SELECT id FROM employees WHERE id = ? AND status = 'aktiv'`)
      .get(a.target_employee_id) as { id: number } | undefined;
    return row ? [row.id] : [];
  }
  if (a.target_department_id !== null) {
    return activeEmployeesInDepartments('id = ?', a.target_department_id);
  }
  if (a.target_team_id !== null) {
    return (
      db
        .prepare(`SELECT id FROM employees WHERE team_id = ? AND status = 'aktiv'`)
        .all(a.target_team_id) as { id: number }[]
    ).map((r) => r.id);
  }
  if (a.target_role_id !== null) {
    return (
      db
        .prepare(
          `SELECT e.id FROM employees e
           JOIN employee_roles er ON er.employee_id = e.id
           WHERE er.role_id = ? AND e.status = 'aktiv'`,
        )
        .all(a.target_role_id) as { id: number }[]
    ).map((r) => r.id);
  }
  return [];
}

/**
 * Zuständigkeitsbereich einer Führungskraft: Map Mitarbeiter-ID → Quellen.
 *
 * Reihenfolge: erst die automatischen Quellen (sofern für die Führungskraft
 * und unternehmensweit eingeschaltet), dann manuelle Ergänzungen, zuletzt
 * Ausnahmen: eine Ausnahme schlägt immer, egal woher die Zuordnung kam.
 * Die Führungskraft selbst ist nie enthalten, ausgeschiedene Personen auch
 * nicht. Zeitlich begrenzte Zuweisungen gelten am Stichtag `asOf` (heute).
 */
export function scopeFor(leaderId: number, asOf: string = todayIso()): Map<number, ScopeSource[]> {
  const db = getDb();
  const leader = db
    .prepare('SELECT auto_scope FROM leadership_leaders WHERE employee_id = ?')
    .get(leaderId) as { auto_scope: number } | undefined;
  const result = new Map<number, ScopeSource[]>();
  if (!leader) return result;

  const add = (id: number, source: ScopeSource) => {
    if (id === leaderId) return;
    const list = result.get(id) ?? [];
    if (!list.includes(source)) list.push(source);
    result.set(id, list);
  };

  if (leader.auto_scope === 1) {
    const settings = getSettings();
    if (settings.auto_direct_reports === 1) {
      const rows = db
        .prepare(`SELECT id FROM employees WHERE manager_id = ? AND status = 'aktiv'`)
        .all(leaderId) as { id: number }[];
      for (const r of rows) add(r.id, 'direkt');
    }
    if (settings.auto_department_head === 1) {
      for (const id of activeEmployeesInDepartments('head_employee_id = ?', leaderId)) add(id, 'abteilung');
    }
    if (settings.auto_team_lead === 1) {
      const rows = db
        .prepare(
          `SELECT e.id FROM employees e JOIN teams t ON t.id = e.team_id
           WHERE t.lead_employee_id = ? AND e.status = 'aktiv'`,
        )
        .all(leaderId) as { id: number }[];
      for (const r of rows) add(r.id, 'team');
    }
  }

  const assignments = db
    .prepare(
      `SELECT * FROM leadership_assignments
       WHERE leader_employee_id = @leader
         AND (valid_from IS NULL OR valid_from <= @asOf)
         AND (valid_to IS NULL OR valid_to >= @asOf)
       ORDER BY id`,
    )
    .all({ leader: leaderId, asOf }) as AssignmentRow[];
  for (const a of assignments) {
    if (a.kind !== 'include') continue;
    for (const id of resolveTargetMembers(a)) add(id, 'zugewiesen');
  }
  for (const a of assignments) {
    if (a.kind !== 'exclude') continue;
    for (const id of resolveTargetMembers(a)) result.delete(id);
  }
  return result;
}

/**
 * Personen im Bereich der Führungskraft, die ihrerseits (als Führungskraft)
 * für sie zuständig sind: „gegenseitige Verantwortung“.
 */
export function mutualPartners(
  leaderId: number,
): { employee_id: number; first_name: string; last_name: string }[] {
  const scope = scopeFor(leaderId);
  const partners: { employee_id: number; first_name: string; last_name: string }[] = [];
  for (const memberId of scope.keys()) {
    if (!isLeaderEmployee(memberId)) continue;
    if (!scopeFor(memberId).has(leaderId)) continue;
    const row = getDb()
      .prepare('SELECT first_name, last_name FROM employees WHERE id = ?')
      .get(memberId) as { first_name: string; last_name: string };
    partners.push({ employee_id: memberId, ...row });
  }
  return partners.sort((a, b) => a.last_name.localeCompare(b.last_name, 'de'));
}

/** Alle gegenseitigen Paare (a < b) über sämtliche Führungskräfte. */
export function mutualPairs(): { a: number; b: number; label: string }[] {
  const db = getDb();
  const leaders = (db.prepare('SELECT employee_id FROM leadership_leaders').all() as { employee_id: number }[]).map(
    (r) => r.employee_id,
  );
  const scopes = new Map(leaders.map((id) => [id, scopeFor(id)] as const));
  const nameOf = (id: number) => {
    const row = db.prepare('SELECT first_name, last_name FROM employees WHERE id = ?').get(id) as
      | { first_name: string; last_name: string }
      | undefined;
    return row ? `${row.first_name} ${row.last_name}` : `#${id}`;
  };
  const pairs: { a: number; b: number; label: string }[] = [];
  for (const a of leaders) {
    for (const b of leaders) {
      if (a >= b) continue;
      if (scopes.get(a)!.has(b) && scopes.get(b)!.has(a)) {
        pairs.push({ a, b, label: `${nameOf(a)} ↔ ${nameOf(b)}` });
      }
    }
  }
  return pairs;
}

function pairKeys(pairs: { a: number; b: number }[]): Set<string> {
  return new Set(pairs.map((p) => `${p.a}-${p.b}`));
}

/**
 * Gegenseitige Verantwortung durchsetzen: an JEDER Stelle, die Zuständigkeit
 * verändert (Freischaltung, Zuweisung, Ausnahme entfernen, Automatik
 * umschalten, Einstellungen). Innerhalb der Transaktion aufrufen: Ein Verstoß
 * wirft 409 und rollt die Änderung zurück. Nur NEUE Paare zählen; bereits
 * bestehende wurden beim Entstehen gemeldet. Liefert Hinweise, wenn Paare
 * zugelassen sind.
 */
function assertMutualAllowed(before: Set<string>, allowMutual: number, context: string): string[] {
  const fresh = mutualPairs().filter((p) => !before.has(`${p.a}-${p.b}`));
  if (fresh.length === 0) return [];
  const names = fresh.map((p) => p.label).join(', ');
  if (allowMutual === 0) {
    throw conflict(
      `${context} würde eine gegenseitige Verantwortung erzeugen (${names}). ` +
        'Gegenseitige Verantwortung ist in den Einstellungen nicht zugelassen. Nehmen Sie eine Seite über eine Ausnahme heraus oder lassen Sie sie zu.',
    );
  }
  return [`Gegenseitige Verantwortung: ${names}.`];
}

interface MemberRow {
  id: number;
  first_name: string;
  last_name: string;
  personnel_number: string | null;
  job_title: string | null;
  employee_type: string;
  status: string;
  hire_date: string | null;
  email: string | null;
  phone: string | null;
  photo_file_id: number | null;
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
}

const MEMBER_SELECT = `
  SELECT e.id, e.first_name, e.last_name, e.personnel_number, e.job_title, e.employee_type,
         e.status, e.hire_date, e.email, e.phone, e.photo_file_id,
         d.name AS department_name, t.name AS team_name, l.name AS location_name
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN teams t ON t.id = e.team_id
  LEFT JOIN locations l ON l.id = e.location_id`;

/**
 * Mitglieder des Zuständigkeitsbereichs mit Stammdaten fürs Widget und dem
 * Bewertungsstand im Zeitraum. Fotos kommen als signierte URL mit. Die
 * Führungskraft hat nicht zwingend das Recht `personal`, könnte also
 * /api/files/:id/sign selbst nicht aufrufen.
 */
/**
 * Anzeigeoptionen der Verwaltungsrouten. `photos: false` unterdrückt signierte
 * Foto-URLs: Ein Konto mit `fuehrung: lesen`, aber ohne `personal`, bekäme die
 * Fotos über POST /api/files/:id/sign nicht (assertMayReadFile), dann darf
 * der Report sie auch nicht mitliefern. Die Führungsfunktion (/me/*) liefert
 * die Fotos des eigenen Bereichs bewusst immer.
 */
export interface ViewOptions {
  photos?: boolean;
}

export function teamMembers(
  leaderId: number,
  period: RatingPeriod,
  scope: Map<number, ScopeSource[]> = scopeFor(leaderId),
  view: ViewOptions = {},
): TeamMember[] {
  const ids = [...scope.keys()];
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `${MEMBER_SELECT} WHERE e.id IN (${ids.map(() => '?').join(',')})
       ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`,
    )
    .all(ids) as MemberRow[];

  const ratingRows = db
    .prepare(
      `SELECT r.employee_id, r.score, r.scale, r.updated_at, c.is_overall
       FROM leadership_ratings r JOIN rating_categories c ON c.id = r.category_id
       WHERE r.leader_employee_id = @leader AND r.period_key = @period`,
    )
    .all({ leader: leaderId, period: period.key }) as {
    employee_id: number;
    score: number;
    scale: RatingScaleKey;
    updated_at: string;
    is_overall: number;
  }[];
  const byEmployee = new Map<
    number,
    { overall: { score: number; scale: RatingScaleKey } | null; count: number; last: string | null }
  >();
  for (const r of ratingRows) {
    const entry = byEmployee.get(r.employee_id) ?? { overall: null, count: 0, last: null };
    entry.count += 1;
    if (r.is_overall === 1) entry.overall = { score: r.score, scale: r.scale };
    if (entry.last === null || r.updated_at > entry.last) entry.last = r.updated_at;
    byEmployee.set(r.employee_id, entry);
  }

  return rows.map((row) => {
    const stats = byEmployee.get(row.id);
    const mutual = isLeaderEmployee(row.id) && scopeFor(row.id).has(leaderId) ? 1 : 0;
    return {
      ...row,
      photo_url: view.photos !== false && row.photo_file_id ? signDownloadUrl(row.photo_file_id) : null,
      sources: scope.get(row.id) ?? [],
      mutual,
      overall: stats?.overall ?? null,
      rated_categories: stats?.count ?? 0,
      last_rated_at: stats?.last ?? null,
    };
  });
}

/** Wirft 403, wenn die Person nicht zum Bereich der Führungskraft gehört. */
export function assertInScope(leaderId: number, employeeId: number): Map<number, ScopeSource[]> {
  const scope = scopeFor(leaderId);
  if (!scope.has(employeeId)) {
    throw forbidden('Diese Person gehört nicht zu Ihrem Zuständigkeitsbereich.');
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Manuelle Zuweisungen
// ---------------------------------------------------------------------------

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.leader_employee_id, a.kind, a.valid_from, a.valid_to, a.note, a.created_at,
         u.name AS created_by_name,
         CASE
           WHEN a.target_employee_id IS NOT NULL THEN 'employee'
           WHEN a.target_department_id IS NOT NULL THEN 'department'
           WHEN a.target_team_id IS NOT NULL THEN 'team'
           ELSE 'role'
         END AS target_type,
         COALESCE(a.target_employee_id, a.target_department_id, a.target_team_id, a.target_role_id) AS target_id,
         COALESCE(te.first_name || ' ' || te.last_name, td.name, tt.name, tr.name, '(gelöscht)') AS target_name
  FROM leadership_assignments a
  LEFT JOIN employees te ON te.id = a.target_employee_id
  LEFT JOIN departments td ON td.id = a.target_department_id
  LEFT JOIN teams tt ON tt.id = a.target_team_id
  LEFT JOIN roles tr ON tr.id = a.target_role_id
  LEFT JOIN users u ON u.id = a.created_by_user_id`;

export function listAssignments(leaderId: number): LeadershipAssignment[] {
  return getDb()
    .prepare(`${ASSIGNMENT_SELECT} WHERE a.leader_employee_id = ? ORDER BY a.kind, a.created_at, a.id`)
    .all(leaderId) as LeadershipAssignment[];
}

function getAssignment(id: number): LeadershipAssignment {
  const row = getDb().prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(id) as
    | LeadershipAssignment
    | undefined;
  if (!row) throw notFound('Zuweisung nicht gefunden');
  return row;
}

const TARGET_TABLES = {
  employee: ['employees', 'target_employee_id', 'Mitarbeiter:in nicht gefunden'],
  department: ['departments', 'target_department_id', 'Abteilung nicht gefunden'],
  team: ['teams', 'target_team_id', 'Team nicht gefunden'],
  role: ['roles', 'target_role_id', 'Fachrolle nicht gefunden'],
} as const;

export function createAssignment(
  req: FastifyRequest,
  leaderId: number,
  input: LeadershipAssignmentInput,
): AssignmentCreateResponse {
  loadLeader(leaderId);
  const [table, column, missing] = TARGET_TABLES[input.target_type];
  if (!getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(input.target_id)) {
    throw notFound(missing);
  }
  if (input.target_type === 'employee' && input.target_id === leaderId) {
    throw badRequest('Eine Führungskraft kann sich nicht selbst zugeordnet werden.');
  }
  if (input.valid_from && input.valid_to && input.valid_from > input.valid_to) {
    throw badRequest('„Gültig bis“ darf nicht vor „Gültig ab“ liegen.');
  }
  const settings = getSettings();
  const before = pairKeys(mutualPairs());
  const warnings: string[] = [];
  const id = inTransaction(() => {
    const info = getDb()
      .prepare(
        `INSERT INTO leadership_assignments (leader_employee_id, kind, ${column}, valid_from, valid_to, note, created_by_user_id)
         VALUES (@leader, @kind, @target, @valid_from, @valid_to, @note, @user)`,
      )
      .run({
        leader: leaderId,
        kind: input.kind,
        target: input.target_id,
        valid_from: input.valid_from ?? null,
        valid_to: input.valid_to ?? null,
        note: input.note ?? null,
        user: req.user.id,
      });
    // Neue gegenseitige Verantwortung? Nur die durch DIESE Zuweisung
    // entstandene zählt. Bereits bestehende Paare wurden schon gemeldet.
    warnings.push(...assertMutualAllowed(before, settings.allow_mutual, 'Diese Zuweisung'));
    return Number(info.lastInsertRowid);
  });
  const assignment = getAssignment(id);
  audit(req, 'create', 'leadership_assignment', id, {
    leader_employee_id: leaderId,
    kind: input.kind,
    target: `${input.target_type}:${input.target_id}`,
    target_name: assignment.target_name,
  });
  return { assignment, warnings };
}

export function deleteAssignment(req: FastifyRequest, id: number): void {
  const existing = getAssignment(id);
  const settings = getSettings();
  const before = pairKeys(mutualPairs());
  inTransaction(() => {
    getDb().prepare('DELETE FROM leadership_assignments WHERE id = ?').run(id);
    // Das Entfernen einer Ausnahme holt Personen zurück in den Bereich. Das
    // kann damit ein verbotenes Paar wiederherstellen.
    assertMutualAllowed(before, settings.allow_mutual, 'Das Entfernen der Zuweisung');
  });
  audit(req, 'delete', 'leadership_assignment', id, {
    leader_employee_id: existing.leader_employee_id,
    target_name: existing.target_name,
  });
}

export function leaderTeam(
  leaderId: number,
  period: RatingPeriod,
  view: ViewOptions = {},
): LeaderTeamResponse {
  const leader = loadLeader(leaderId);
  return {
    leader,
    team: teamMembers(leaderId, period, scopeFor(leaderId), view),
    assignments: listAssignments(leaderId),
    mutual: mutualPartners(leaderId),
  };
}

// ---------------------------------------------------------------------------
// Bewertungen
// ---------------------------------------------------------------------------

const RATING_SELECT = `
  SELECT r.*, c.name AS category_name, cu.name AS created_by_name, uu.name AS updated_by_name,
         COALESCE(le.first_name || ' ' || le.last_name, '(gelöschte Führungskraft)') AS leader_name
  FROM leadership_ratings r
  JOIN rating_categories c ON c.id = r.category_id
  LEFT JOIN users cu ON cu.id = r.created_by_user_id
  LEFT JOIN users uu ON uu.id = r.updated_by_user_id
  LEFT JOIN employees le ON le.id = r.leader_employee_id`;

const RATING_ORDER = 'ORDER BY r.period_key DESC, c.is_overall DESC, c.sort_order, c.name COLLATE NOCASE';

export function ratingsFor(leaderId: number, employeeId: number, periodKey?: string): Rating[] {
  return getDb()
    .prepare(
      `${RATING_SELECT}
       WHERE r.leader_employee_id = @leader AND r.employee_id = @employee
         AND (@period IS NULL OR r.period_key = @period)
       ${RATING_ORDER}`,
    )
    .all({ leader: leaderId, employee: employeeId, period: periodKey ?? null }) as Rating[];
}

const HISTORY_SELECT = `
  SELECT h.*, c.name AS category_name, u.name AS changed_by_name
  FROM leadership_rating_history h
  JOIN rating_categories c ON c.id = h.category_id
  LEFT JOIN users u ON u.id = h.changed_by_user_id`;

export function historyFor(leaderId: number | null, employeeId: number): RatingHistoryEntry[] {
  return getDb()
    .prepare(
      `${HISTORY_SELECT}
       WHERE h.employee_id = @employee AND (@leader IS NULL OR h.leader_employee_id = @leader)
       ORDER BY h.changed_at DESC, h.id DESC`,
    )
    .all({ employee: employeeId, leader: leaderId }) as RatingHistoryEntry[];
}

/** Admin-Sicht: alle Bewertungen einer Person von allen Führungskräften. */
export function employeeRatings(employeeId: number): EmployeeRatingsResponse {
  if (!getDb().prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) {
    throw notFound('Mitarbeiter:in nicht gefunden');
  }
  const ratings = getDb()
    .prepare(`${RATING_SELECT} WHERE r.employee_id = ? ${RATING_ORDER}`)
    .all(employeeId) as Rating[];
  return { ratings, history: historyFor(null, employeeId) };
}

/** Zeiträume zur Auswahl: aktueller, die letzten zwölf, alle mit Bewertungen (gleiche Kadenz). */
function selectablePeriods(leaderId: number, employeeId: number, settings: LeadershipSettings): RatingPeriod[] {
  const current = currentPeriod(settings);
  const byKey = new Map<string, RatingPeriod>();
  for (const p of recentPeriods(current.key, 12)) byKey.set(p.key, p);
  const rated = getDb()
    .prepare(
      'SELECT DISTINCT period_key FROM leadership_ratings WHERE leader_employee_id = ? AND employee_id = ?',
    )
    .all([leaderId, employeeId]) as { period_key: string }[];
  for (const r of rated) {
    if (periodKindOfKey(r.period_key) === settings.period && !byKey.has(r.period_key)) {
      byKey.set(r.period_key, periodFromKey(r.period_key));
    }
  }
  return [...byKey.values()].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
}

export function teamMemberDetail(leaderId: number, employeeId: number, period: RatingPeriod) {
  const settings = getSettings();
  const scope = assertInScope(leaderId, employeeId);
  const single = new Map<number, ScopeSource[]>([[employeeId, scope.get(employeeId) ?? []]]);
  const [employee] = teamMembers(leaderId, period, single);
  if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');
  return {
    employee,
    period,
    current_period: currentPeriod(settings),
    periods: selectablePeriods(leaderId, employeeId, settings),
    settings: { period: settings.period, uniform_scale: settings.uniform_scale, scale: settings.scale },
    categories: listCategories(true, settings),
    ratings: ratingsFor(leaderId, employeeId, period.key),
    all_ratings: ratingsFor(leaderId, employeeId),
    history: historyFor(leaderId, employeeId),
  };
}

/**
 * Speichert die Bewertungsblöcke eines Zeitraums. Je Kategorie ein Upsert;
 * jede tatsächliche Änderung wird versioniert und protokolliert. Unveränderte
 * Blöcke erzeugen KEINE neue Version: sonst würde jedes Speichern des
 * Formulars das Protokoll mit Leerzeilen füllen.
 */
export function saveRatings(
  req: FastifyRequest,
  leaderId: number,
  employeeId: number,
  body: RatingsSaveRequest,
): Rating[] {
  const settings = getSettings();
  assertInScope(leaderId, employeeId);
  if (!isValidPeriodKey(body.period_key, settings.period)) {
    throw badRequest(
      `Ungültiger Zeitraum. Erwartet wird ein Schlüssel der eingestellten Kadenz (${RATING_PERIOD_LABELS[settings.period]}).`,
    );
  }
  const period = periodFromKey(body.period_key);
  if (period.from > todayIso()) {
    throw badRequest('Bewertungen für zukünftige Zeiträume sind nicht möglich.');
  }
  if (body.ratings.length === 0) throw badRequest('Mindestens ein Bewertungsblock ist erforderlich.');

  const db = getDb();
  // Alle Kategorien, auch inaktive: Eine bestehende Bewertung in einer
  // inzwischen deaktivierten Kategorie bleibt änderbar. Die Maske sendet
  // immer alle Blöcke, sonst wäre mit der Deaktivierung auch die
  // Gesamtbewertung eingefroren. Nur NEUE Bewertungen brauchen eine aktive
  // Kategorie.
  const categories = new Map(listCategories(false, settings).map((c) => [c.id, c]));
  const alreadyRated = new Set(
    (
      db
        .prepare(
          `SELECT category_id FROM leadership_ratings
           WHERE leader_employee_id = @leader AND employee_id = @employee AND period_key = @period`,
        )
        .all({ leader: leaderId, employee: employeeId, period: period.key }) as { category_id: number }[]
    ).map((r) => r.category_id),
  );
  const seen = new Set<number>();
  const prepared = body.ratings.map((r) => {
    if (seen.has(r.category_id)) {
      throw badRequest('Jede Kategorie kann je Zeitraum nur einmal bewertet werden.');
    }
    seen.add(r.category_id);
    const category = categories.get(r.category_id);
    if (!category) throw notFound('Bewertungskategorie nicht gefunden');
    if (category.active !== 1 && !alreadyRated.has(category.id)) {
      throw badRequest(`Die Kategorie „${category.name}“ ist deaktiviert und kann nicht neu bewertet werden.`);
    }
    const def = RATING_SCALES[category.effective_scale];
    if (!Number.isInteger(r.score) || r.score < 1 || r.score > def.max) {
      throw badRequest(`Der Wert für „${category.name}“ muss zwischen 1 und ${def.max} liegen.`);
    }
    const comment = r.comment.trim();
    if (!comment) throw badRequest(`Bitte begründen Sie die Bewertung „${category.name}“ mit einem Kommentar.`);
    return { category, score: r.score, comment };
  });

  const changed: { category: string; version: number; change_kind: string }[] = [];
  inTransaction(() => {
    for (const item of prepared) {
      const existing = db
        .prepare(
          `SELECT id, scale, score, comment, version FROM leadership_ratings
           WHERE leader_employee_id = @leader AND employee_id = @employee
             AND category_id = @category AND period_key = @period`,
        )
        .get({ leader: leaderId, employee: employeeId, category: item.category.id, period: period.key }) as
        | { id: number; scale: RatingScaleKey; score: number; comment: string; version: number }
        | undefined;
      const scale = item.category.effective_scale;

      if (existing) {
        if (existing.scale === scale && existing.score === item.score && existing.comment === item.comment) {
          continue;
        }
        const version = existing.version + 1;
        db.prepare(
          `UPDATE leadership_ratings
           SET scale = @scale, score = @score, comment = @comment, version = @version,
               updated_by_user_id = @user, updated_at = datetime('now')
           WHERE id = @id`,
        ).run({ scale, score: item.score, comment: item.comment, version, user: req.user.id, id: existing.id });
        db.prepare(
          `INSERT INTO leadership_rating_history
             (rating_id, leader_employee_id, employee_id, category_id, period_key, version, change_kind,
              scale, score, comment, previous_scale, previous_score, previous_comment, changed_by_user_id)
           VALUES (@rating_id, @leader, @employee, @category, @period, @version, 'geaendert',
                   @scale, @score, @comment, @previous_scale, @previous_score, @previous_comment, @user)`,
        ).run({
          rating_id: existing.id,
          leader: leaderId,
          employee: employeeId,
          category: item.category.id,
          period: period.key,
          version,
          scale,
          score: item.score,
          comment: item.comment,
          previous_scale: existing.scale,
          previous_score: existing.score,
          previous_comment: existing.comment,
          user: req.user.id,
        });
        changed.push({ category: item.category.name, version, change_kind: 'geaendert' });
      } else {
        const info = db
          .prepare(
            `INSERT INTO leadership_ratings
               (leader_employee_id, employee_id, category_id, period_kind, period_key, scale, score, comment,
                version, created_by_user_id, updated_by_user_id)
             VALUES (@leader, @employee, @category, @period_kind, @period, @scale, @score, @comment, 1, @user, @user)`,
          )
          .run({
            leader: leaderId,
            employee: employeeId,
            category: item.category.id,
            period_kind: period.kind,
            period: period.key,
            scale,
            score: item.score,
            comment: item.comment,
            user: req.user.id,
          });
        db.prepare(
          `INSERT INTO leadership_rating_history
             (rating_id, leader_employee_id, employee_id, category_id, period_key, version, change_kind,
              scale, score, comment, previous_scale, previous_score, previous_comment, changed_by_user_id)
           VALUES (@rating_id, @leader, @employee, @category, @period, 1, 'erstellt',
                   @scale, @score, @comment, NULL, NULL, NULL, @user)`,
        ).run({
          rating_id: Number(info.lastInsertRowid),
          leader: leaderId,
          employee: employeeId,
          category: item.category.id,
          period: period.key,
          scale,
          score: item.score,
          comment: item.comment,
          user: req.user.id,
        });
        changed.push({ category: item.category.name, version: 1, change_kind: 'erstellt' });
      }
    }
  });
  if (changed.length > 0) {
    audit(req, 'bewertung_gespeichert', 'leadership_rating', employeeId, {
      leader_employee_id: leaderId,
      period_key: period.key,
      changed,
    });
  }
  return ratingsFor(leaderId, employeeId, period.key);
}

// ---------------------------------------------------------------------------
// Status und Report
// ---------------------------------------------------------------------------

/** Ist das Konto eine freigeschaltete, aktive Führungskraft? Liefert die Personal-ID. */
export function leaderEmployeeIdFor(user: { employee_id?: number | null }): number | null {
  const employeeId = user.employee_id ?? null;
  if (employeeId === null) return null;
  const row = getDb()
    .prepare(
      `SELECT e.status FROM leadership_leaders l JOIN employees e ON e.id = l.employee_id WHERE l.employee_id = ?`,
    )
    .get(employeeId) as { status: string } | undefined;
  return row && row.status === 'aktiv' ? employeeId : null;
}

export function leaderStatus(user: { employee_id?: number | null }): LeaderStatus {
  const leaderId = leaderEmployeeIdFor(user);
  if (leaderId === null) {
    return { is_leader: false, employee_id: user.employee_id ?? null, period: null, team_size: 0, rated_count: 0 };
  }
  const settings = getSettings();
  const period = currentPeriod(settings);
  const scope = scopeFor(leaderId);
  const rated = getDb()
    .prepare(
      `SELECT DISTINCT r.employee_id FROM leadership_ratings r
       JOIN rating_categories c ON c.id = r.category_id AND c.is_overall = 1
       WHERE r.leader_employee_id = @leader AND r.period_key = @period`,
    )
    .all({ leader: leaderId, period: period.key }) as { employee_id: number }[];
  return {
    is_leader: true,
    employee_id: leaderId,
    period,
    team_size: scope.size,
    rated_count: rated.filter((r) => scope.has(r.employee_id)).length,
  };
}

/**
 * Prozentanteile nach dem Verfahren des größten Rests: Die gerundeten Anteile
 * addieren sich immer auf genau 100: ein Report mit „33 % + 33 % + 33 %“
 * wirft sonst sofort die Frage nach dem fehlenden Prozent auf.
 */
function percentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const floors = raw.map((r) => Math.floor(r));
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}

export function buildReport(period: RatingPeriod, view: ViewOptions = {}): LeadershipReport {
  const settings = getSettings();
  const category = overallCategory(settings);
  const scale = category.effective_scale;
  const levels = scaleLevelsBestFirst(scale);
  const db = getDb();

  const leaders = listLeaders().filter((l) => l.status === 'aktiv');
  const rows: ReportLeaderRow[] = leaders.map((leader) => {
    const ratings = db
      .prepare(
        `SELECT employee_id, score, scale FROM leadership_ratings
         WHERE leader_employee_id = @leader AND category_id = @category AND period_key = @period`,
      )
      .all({ leader: leader.employee_id, category: category.id, period: period.key }) as {
      employee_id: number;
      score: number;
      scale: RatingScaleKey;
    }[];
    // Offen = heutiger Bereich ohne Gesamtbewertung im Zeitraum. rated_count
    // zählt dagegen alle Bewertungen der Führungskraft im Zeitraum, auch für
    // Personen, die inzwischen nicht mehr zum Bereich gehören. Beide Zahlen
    // sind deshalb getrennt und werden nicht voneinander abgezogen.
    const ratedIds = new Set(ratings.map((r) => r.employee_id));
    const openCount = [...scopeFor(leader.employee_id).keys()].filter((id) => !ratedIds.has(id)).length;
    const onScale = ratings.filter((r) => r.scale === scale);
    const counts = levels.map((level) => onScale.filter((r) => r.score === level).length);
    const percent = percentages(counts);
    const distribution: ReportDistributionEntry[] = levels.map((score, i) => ({
      score,
      label: scaleLevelLabel(scale, score),
      tone: scoreTone(scale, score),
      count: counts[i],
      percent: percent[i],
    }));
    const average =
      onScale.length === 0
        ? null
        : onScale.reduce((sum, r) => sum + normalizedScore(scale, r.score), 0) / onScale.length;
    return {
      employee_id: leader.employee_id,
      first_name: leader.first_name,
      last_name: leader.last_name,
      job_title: leader.job_title,
      department_name: leader.department_name,
      photo_file_id: leader.photo_file_id,
      photo_url: view.photos !== false && leader.photo_file_id ? signDownloadUrl(leader.photo_file_id) : null,
      team_size: leader.team_size,
      rated_count: onScale.length,
      open_count: openCount,
      distribution,
      average_normalized: average,
      other_scale_count: ratings.length - onScale.length,
    };
  });

  return { period, current_period: currentPeriod(settings), category, scale, leaders: rows };
}

// ---------------------------------------------------------------------------
// Auswahllisten der Einrichtung
// ---------------------------------------------------------------------------

/**
 * Personen, Abteilungen, Teams und Fachrollen für Freischaltung und Zuweisung.
 * Eigener Endpunkt im Bereich `fuehrung`, weil /api/employees, /api/departments
 * und /api/admin/roles an `personal` bzw. `verwaltung` hängen. Ohne diese
 * Liste könnte ein reines Einrichtungs-Konto niemanden auswählen.
 */
export function lookup(): LeadershipLookup {
  const db = getDb();
  return {
    employees: db
      .prepare(
        `SELECT id, first_name, last_name, job_title, department_id, team_id FROM employees
         WHERE status = 'aktiv' ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE`,
      )
      .all() as LeadershipLookup['employees'],
    departments: db
      .prepare('SELECT id, name, parent_id FROM departments ORDER BY name COLLATE NOCASE')
      .all() as LeadershipLookup['departments'],
    teams: db
      .prepare('SELECT id, name, department_id FROM teams ORDER BY name COLLATE NOCASE')
      .all() as LeadershipLookup['teams'],
    roles: db
      .prepare('SELECT id, name FROM roles WHERE active = 1 ORDER BY name COLLATE NOCASE')
      .all() as LeadershipLookup['roles'],
  };
}

// ---------------------------------------------------------------------------
// Aufschlüsselung eines Report-Widgets
// ---------------------------------------------------------------------------

/** Spaltenanzahl der Aufschlüsselung: Vorgabe und Grenzen. */
export const BREAKDOWN_COLUMNS_DEFAULT = 6;
export const BREAKDOWN_COLUMNS_MAX = 12;

interface BreakdownEmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  personnel_number: string | null;
  job_title: string | null;
  status: string;
  department_name: string | null;
}

/**
 * Wer wird von dieser Führungskraft verantwortet, und wie hat sie diese
 * Personen je Zeitraum in der GESAMTBEWERTUNG eingeschätzt?
 *
 * Zeilen sind der heutige Zuständigkeitsbereich PLUS alle Personen, die in
 * einem der angezeigten Zeiträume bereits bewertet wurden (`former = 1`).
 * Ohne diese Ergänzung verschwänden abgegebene Bewertungen aus dem Report,
 * sobald sich die Organisation ändert oder eine Ausnahme greift. Im
 * Verteilungsbalken oben sind sie aber weiterhin enthalten.
 *
 * Kommentare bleiben bewusst draußen: Die Tabelle zeigt viele Zeiträume auf
 * einmal; die Texte holt erst `ratingDetail` für genau eine Zelle.
 */
export function leaderBreakdown(
  leaderId: number,
  period: RatingPeriod,
  columns: number = BREAKDOWN_COLUMNS_DEFAULT,
): LeaderBreakdown {
  const db = getDb();
  const leader = loadLeader(leaderId);
  const settings = getSettings();
  const category = overallCategory(settings);
  const count = Math.min(BREAKDOWN_COLUMNS_MAX, Math.max(1, Math.trunc(columns)));
  const periods = recentPeriods(period.key, count);
  const periodKeys = periods.map((p) => p.key);

  const scope = scopeFor(leaderId);
  // Bewertungen der Führungskraft in den angezeigten Zeiträumen: die
  // Gesamtbewertung für die Zellen, alle übrigen Kategorien nur gezählt.
  const ratings = db
    .prepare(
      `SELECT r.employee_id, r.period_key, r.score, r.scale, r.updated_at, c.is_overall
       FROM leadership_ratings r
       JOIN rating_categories c ON c.id = r.category_id
       WHERE r.leader_employee_id = ? AND r.period_key IN (${periodKeys.map(() => '?').join(',')})`,
    )
    .all([leaderId, ...periodKeys]) as {
    employee_id: number;
    period_key: string;
    score: number;
    scale: RatingScaleKey;
    updated_at: string;
    is_overall: number;
  }[];

  // Eine Zelle je (Person, Zeitraum) mit MINDESTENS EINER Bewertung, nicht
  // nur mit Gesamtbewertung. Wer in einem Zeitraum ausschließlich Leistung
  // bewertet hat, soll die Zelle trotzdem öffnen können; `score` bleibt dann
  // null und die Oberfläche zeigt statt einer Stufe die Kategorienzahl.
  const cellsByEmployee = new Map<number, Map<string, BreakdownCell>>();
  for (const r of ratings) {
    const cells = cellsByEmployee.get(r.employee_id) ?? new Map<string, BreakdownCell>();
    const cell = cells.get(r.period_key) ?? {
      period_key: r.period_key,
      score: null,
      scale: null,
      category_count: 0,
      updated_at: r.updated_at,
    };
    cell.category_count += 1;
    // Zellen-Zeitstempel ist der jüngste Stand über alle Kategorien. Der
    // Tooltip nennt ihn neben der Kategorienzahl, also muss er zu beidem passen.
    if (r.updated_at > cell.updated_at) cell.updated_at = r.updated_at;
    if (r.is_overall === 1) {
      cell.score = r.score;
      cell.scale = r.scale;
    }
    cells.set(r.period_key, cell);
    cellsByEmployee.set(r.employee_id, cells);
  }

  const ids = [...new Set([...scope.keys(), ...cellsByEmployee.keys()])];
  if (ids.length === 0) {
    return { leader: leaderSummary(leader), periods, scale: category.effective_scale, category, rows: [] };
  }

  const employees = db
    .prepare(
      `SELECT e.id, e.first_name, e.last_name, e.personnel_number, e.job_title, e.status,
              d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(ids) as BreakdownEmployeeRow[];

  const rows: BreakdownRow[] = employees.map((e) => {
    const cells = cellsByEmployee.get(e.id);
    return {
      employee_id: e.id,
      first_name: e.first_name,
      last_name: e.last_name,
      personnel_number: e.personnel_number,
      job_title: e.job_title,
      department_name: e.department_name,
      status: e.status,
      sources: scope.get(e.id) ?? [],
      former: scope.has(e.id) ? 0 : 1,
      cells: periodKeys
        .map((key) => cells?.get(key))
        .filter((c): c is BreakdownCell => c !== undefined),
    };
  });

  // Aktuell Verantwortete zuerst, dann ehemalige, innerhalb alphabetisch.
  rows.sort(
    (a, b) =>
      a.former - b.former ||
      a.last_name.localeCompare(b.last_name, 'de') ||
      a.first_name.localeCompare(b.first_name, 'de') ||
      a.employee_id - b.employee_id,
  );

  return { leader: leaderSummary(leader), periods, scale: category.effective_scale, category, rows };
}

function leaderSummary(leader: Leader): LeaderBreakdown['leader'] {
  return {
    employee_id: leader.employee_id,
    first_name: leader.first_name,
    last_name: leader.last_name,
    job_title: leader.job_title,
    department_name: leader.department_name,
  };
}

/**
 * Eine Bewertung vollständig aufgeschlüsselt: alle Kategorien des Zeitraums
 * mit Kommentaren (Gesamtbewertung zuerst) plus das Protokoll dieses
 * Zeitraums. Grundlage des Detail-Pop-ups im Report.
 *
 * `leaderId` ist die Führungskraft, deren Einschätzung gezeigt wird, nicht
 * die handelnde Person: Der Report ist die Sicht der Verwaltung auf fremde
 * Bewertungen, abgesichert über den Bereich `fuehrung`.
 */
export function ratingDetail(leaderId: number, employeeId: number, period: RatingPeriod): RatingDetail {
  const db = getDb();
  // Erst die Führungskraft: Ohne diese Prüfung beantwortete die Route jede
  // beliebige Personal-ID, und gäbe damit Stammdaten (Personalnummer, Titel,
  // Abteilung) an Konten heraus, die nur `fuehrung: lesen` haben. Sie sollen
  // sehen, was der Report zeigt, und nicht das Personalverzeichnis.
  loadLeader(leaderId);

  const ratings = ratingsFor(leaderId, employeeId, period.key);
  // Zweite Schranke: Die Person muss zum Bereich dieser Führungskraft gehören
  // ODER von ihr in diesem Zeitraum bewertet worden sein: genau die beiden
  // Fälle, die in der Aufschlüsselung als Zeile stehen.
  if (ratings.length === 0 && !scopeFor(leaderId).has(employeeId)) {
    throw notFound('Für diese Person liegt bei dieser Führungskraft keine Bewertung vor');
  }

  const employee = db
    .prepare(
      `SELECT e.id, e.first_name, e.last_name, e.personnel_number, e.job_title, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`,
    )
    .get(employeeId) as RatingDetail['employee'] | undefined;
  if (!employee) throw notFound('Mitarbeiter:in nicht gefunden');

  const leader = db
    .prepare('SELECT id AS employee_id, first_name, last_name FROM employees WHERE id = ?')
    .get(leaderId) as RatingDetail['leader'];
  const history = db
    .prepare(
      `${HISTORY_SELECT}
       WHERE h.leader_employee_id = @leader AND h.employee_id = @employee AND h.period_key = @period
       ORDER BY h.changed_at DESC, h.id DESC`,
    )
    .all({ leader: leaderId, employee: employeeId, period: period.key }) as RatingHistoryEntry[];

  return { employee, leader: leader ?? null, period, ratings, history };
}

// ---------------------------------------------------------------------------
// Übersicht der Führungsfunktion („Mein Team“)
// ---------------------------------------------------------------------------

/** Spalten der Verlaufsleiste je Person: der aktuelle Zeitraum plus drei zurück. */
export const TEAM_HISTORY_COLUMNS = 4;

/**
 * Woraus sich der Bereich zusammensetzt: Abteilungen und Teams der
 * zugeordneten Personen, absteigend nach Kopfzahl. Bewusst aus den
 * Personalprofilen abgeleitet und nicht aus der Leitungsfunktion: wer über
 * eine manuelle Zuweisung jemanden aus einer fremden Abteilung betreut, soll
 * das in der Kopfzeile sehen.
 */
export function scopeSummary(employeeIds: number[]): TeamScopeSummary {
  if (employeeIds.length === 0) return { total: 0, departments: [], teams: [] };
  const placeholders = employeeIds.map(() => '?').join(',');
  const db = getDb();
  const departments = db
    .prepare(
      `SELECT e.department_id AS id, COALESCE(d.name, 'Ohne Abteilung') AS name, COUNT(*) AS count
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id IN (${placeholders})
       GROUP BY e.department_id
       ORDER BY count DESC, name COLLATE NOCASE`,
    )
    .all(employeeIds) as TeamScopeSummary['departments'];
  const teams = db
    .prepare(
      `SELECT e.team_id AS id, t.name AS name, COUNT(*) AS count
       FROM employees e JOIN teams t ON t.id = e.team_id
       WHERE e.id IN (${placeholders})
       GROUP BY e.team_id
       ORDER BY count DESC, name COLLATE NOCASE`,
    )
    .all(employeeIds) as TeamScopeSummary['teams'];
  return { total: employeeIds.length, departments, teams };
}

/**
 * Bisherige Bewertungen je Person über mehrere Zeiträume: dieselbe Zellenform
 * wie in der Report-Aufschlüsselung (`leaderBreakdown`), damit die
 * Verlaufsleiste in „Mein Team“ und die Report-Tabelle dasselbe zeigen.
 */
function historyCells(
  leaderId: number,
  employeeIds: number[],
  periodKeys: string[],
): Map<number, BreakdownCell[]> {
  const result = new Map<number, BreakdownCell[]>();
  if (employeeIds.length === 0 || periodKeys.length === 0) return result;
  const rows = getDb()
    .prepare(
      `SELECT r.employee_id, r.period_key, r.score, r.scale, r.updated_at, c.is_overall
       FROM leadership_ratings r
       JOIN rating_categories c ON c.id = r.category_id
       WHERE r.leader_employee_id = ?
         AND r.employee_id IN (${employeeIds.map(() => '?').join(',')})
         AND r.period_key IN (${periodKeys.map(() => '?').join(',')})`,
    )
    .all([leaderId, ...employeeIds, ...periodKeys]) as {
    employee_id: number;
    period_key: string;
    score: number;
    scale: RatingScaleKey;
    updated_at: string;
    is_overall: number;
  }[];

  const byEmployee = new Map<number, Map<string, BreakdownCell>>();
  for (const r of rows) {
    const cells = byEmployee.get(r.employee_id) ?? new Map<string, BreakdownCell>();
    const cell = cells.get(r.period_key) ?? {
      period_key: r.period_key,
      score: null,
      scale: null,
      category_count: 0,
      updated_at: r.updated_at,
    };
    cell.category_count += 1;
    if (r.updated_at > cell.updated_at) cell.updated_at = r.updated_at;
    if (r.is_overall === 1) {
      cell.score = r.score;
      cell.scale = r.scale;
    }
    cells.set(r.period_key, cell);
    byEmployee.set(r.employee_id, cells);
  }
  for (const [employeeId, cells] of byEmployee) {
    result.set(
      employeeId,
      periodKeys.map((key) => cells.get(key)).filter((c): c is BreakdownCell => c !== undefined),
    );
  }
  return result;
}

/**
 * Vollständige Antwort der Führungsfunktion: eigener Bereich mit Stammdaten,
 * Bewertungsstand im Zeitraum, Bereichszusammenfassung für die Kopfzeile und
 * Verlauf je Person. Alles in EINER Antwort, weil die Seite ohne jedes Stück
 * unvollständig ist, und weil die Führungskraft nicht zwingend das Recht
 * `personal` hat, also keine zweite Quelle für Abteilungsnamen kennt.
 */
export function myTeam(leaderId: number, period: RatingPeriod, settings = getSettings()): MyTeamResponse {
  const scope = scopeFor(leaderId);
  const team = teamMembers(leaderId, period, scope);
  const historyPeriods = recentPeriods(period.key, TEAM_HISTORY_COLUMNS);
  const cells = historyCells(
    leaderId,
    team.map((m) => m.id),
    historyPeriods.map((p) => p.key),
  );
  return {
    period,
    current_period: currentPeriod(settings),
    settings: { period: settings.period, uniform_scale: settings.uniform_scale, scale: settings.scale },
    categories: listCategories(true, settings),
    team: team.map((m) => ({ ...m, history: cells.get(m.id) ?? [] })),
    scope: scopeSummary([...scope.keys()]),
    history_periods: historyPeriods,
  };
}
