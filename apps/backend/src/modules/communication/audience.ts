import { z } from 'zod';
import { DISTRIBUTION_MEMBER_TYPES, type DistributionMemberType } from '@ohrganize/shared';
import { getDb } from '../../db/db.js';
import { badRequest } from '../../core/errors.js';

/**
 * Zielgruppen von Ankuendigungen und Umfragen: audience_type + audience_id
 * (NULL bei 'alle'). Diese Datei ist die EINZIGE Stelle, die entscheidet, wer
 * zu einer Zielgruppe gehoert. Die HR-Seite (Empfaengerzahl, Anzeigename)
 * und die Portalseite (was sieht diese Person?) lesen beide hier, sonst
 * zaehlte die Verwaltung Empfaenger, die das Portal nie erreicht.
 *
 * Regeln:
 *   - 'abteilung' schliesst Unterabteilungen ein (departments.parent_id).
 *   - 'verteiler' ist ein von der HR gepflegter Verteiler
 *     (distribution_lists + distribution_list_members) aus Abteilungen
 *     (wieder samt Unterabteilungen), Teams, Standorten und Personen.
 *   - Nur aktive Personalprofile zaehlen und sehen.
 */
export const AUDIENCE_TYPES = ['alle', 'abteilung', 'team', 'standort', 'verteiler'] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

// Mitgliedsarten der Verteiler kommen aus @ohrganize/shared (eine Quelle fuer
// zod-Enum, Labels und Picker); hier nur durchgereicht.
export { DISTRIBUTION_MEMBER_TYPES };
export type { DistributionMemberType };

export const audienceShape = {
  audience_type: z.enum(AUDIENCE_TYPES),
  audience_id: z.number().int().positive().nullable(),
};

export interface Audience {
  audience_type: AudienceType;
  audience_id: number | null;
}

/** Konsistenzpruefung audience_type <-> audience_id (nach dem Zod-Parse). */
export function checkAudience(v: Audience): void {
  if (v.audience_type === 'alle' && v.audience_id !== null) {
    throw badRequest('Bei Zielgruppe „Alle Mitarbeitenden“ darf keine audience_id gesetzt sein');
  }
  if (v.audience_type !== 'alle' && v.audience_id === null) {
    throw badRequest('Für diese Zielgruppe ist eine audience_id erforderlich');
  }
  if (v.audience_type !== 'alle' && audienceName(v.audience_type, v.audience_id) === null) {
    throw badRequest('Die gewählte Zielgruppe existiert nicht (mehr)');
  }
}

// ---------------------------------------------------------------------------
// SQL-Bausteine
// ---------------------------------------------------------------------------

/** Alle Abteilungs-IDs unterhalb (und einschliesslich) der uebergebenen Wurzeln. */
const SUBTREE_SQL = (rootsSql: string) => `
  WITH RECURSIVE sub(id) AS (
    ${rootsSql}
    UNION
    SELECT d.id FROM departments d JOIN sub ON d.parent_id = sub.id
  )
  SELECT id FROM sub`;

/** Mitglieder eines Verteilers einer Art. */
const LIST_MEMBERS_SQL = (memberType: DistributionMemberType) =>
  `SELECT member_id FROM distribution_list_members WHERE list_id = ? AND member_type = '${memberType}'`;

/**
 * WHERE-Bedingung „Mitarbeitende e gehoert zur Zielgruppe“, mit Platzhaltern.
 * Der Tabellenalias `e` ist Vertrag.
 */
export function audienceMemberSql(audience: Audience): { sql: string; params: unknown[] } {
  const id = audience.audience_id;
  switch (audience.audience_type) {
    case 'alle':
      return { sql: '1 = 1', params: [] };
    case 'abteilung':
      return { sql: `e.department_id IN (${SUBTREE_SQL('SELECT ?')})`, params: [id] };
    case 'team':
      return { sql: 'e.team_id = ?', params: [id] };
    case 'standort':
      return { sql: 'e.location_id = ?', params: [id] };
    case 'verteiler':
      return {
        sql: `(
          e.id IN (${LIST_MEMBERS_SQL('mitarbeiter')})
          OR e.team_id IN (${LIST_MEMBERS_SQL('team')})
          OR e.location_id IN (${LIST_MEMBERS_SQL('standort')})
          OR e.department_id IN (${SUBTREE_SQL(LIST_MEMBERS_SQL('abteilung'))})
        )`,
        params: [id, id, id, id],
      };
  }
}

/** Anzahl der aktiven Mitarbeitenden in der Zielgruppe. */
export function countAudience(audienceType: AudienceType, audienceId: number | null): number {
  const { sql, params } = audienceMemberSql({ audience_type: audienceType, audience_id: audienceId });
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM employees e WHERE e.status = 'aktiv' AND ${sql}`)
    .get(...params) as { c: number };
  return row.c;
}

const NAME_TABLE: Record<Exclude<AudienceType, 'alle'>, string> = {
  abteilung: 'departments',
  team: 'teams',
  standort: 'locations',
  verteiler: 'distribution_lists',
};

/** Anzeigename der Zielgruppe (NULL bei 'alle' oder wenn die Einheit fehlt). */
export function audienceName(audienceType: AudienceType, audienceId: number | null): string | null {
  if (audienceType === 'alle' || audienceId === null) return null;
  const row = getDb()
    .prepare(`SELECT name FROM ${NAME_TABLE[audienceType]} WHERE id = ?`)
    .get(audienceId) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Name und Empfaengerzahl fuer die Listen-Routen mit einer FESTEN Zahl von
 * Abfragen, unabhaengig von der Laenge der Liste: Namen und direkte Kopfzahlen
 * je Einheit kommen aus je einer Sammelabfrage, die Unterabteilungen werden
 * ueber die Elternbeziehung in JavaScript aufsummiert. Nur Verteiler werden
 * je Verteiler gezaehlt (und gemerkt), denn ihre Mitgliedslogik mischt die
 * Einheiten; davon gibt es eine Handvoll, nicht Tausende. Die Listen wachsen
 * ueber die Betriebsjahre unbegrenzt, deshalb keine Abfrage je Zeile.
 */
export function audienceResolver(): (a: Audience) => { audience_name: string | null; recipients: number } {
  const db = getDb();
  const nameMap = (table: string): Map<number, string> =>
    new Map(
      (db.prepare(`SELECT id, name FROM ${table}`).all() as { id: number; name: string }[]).map(
        (r) => [r.id, r.name] as const,
      ),
    );
  const countMap = (column: string): Map<number, number> =>
    new Map(
      (
        db
          .prepare(
            `SELECT ${column} AS id, COUNT(*) AS c FROM employees
             WHERE status = 'aktiv' AND ${column} IS NOT NULL GROUP BY ${column}`,
          )
          .all() as { id: number; c: number }[]
      ).map((r) => [r.id, r.c] as const),
    );
  const names: Record<Exclude<AudienceType, 'alle'>, Map<number, string>> = {
    abteilung: nameMap('departments'),
    team: nameMap('teams'),
    standort: nameMap('locations'),
    verteiler: nameMap('distribution_lists'),
  };
  const direct = {
    abteilung: countMap('department_id'),
    team: countMap('team_id'),
    standort: countMap('location_id'),
  };
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'aktiv'").get() as { c: number }
  ).c;

  // Kinder je Abteilung, damit die Kopfzahl einer Abteilung ihre
  // Unterabteilungen einschliesst (gleiche Semantik wie SUBTREE_SQL).
  const children = new Map<number, number[]>();
  for (const d of db.prepare('SELECT id, parent_id FROM departments WHERE parent_id IS NOT NULL').all() as {
    id: number;
    parent_id: number;
  }[]) {
    const list = children.get(d.parent_id) ?? [];
    list.push(d.id);
    children.set(d.parent_id, list);
  }
  const subtreeCache = new Map<number, number>();
  const subtreeCount = (id: number, seen: Set<number> = new Set()): number => {
    const hit = subtreeCache.get(id);
    if (hit !== undefined) return hit;
    if (seen.has(id)) return 0; // Ring in parent_id (assertNoCycle verhindert ihn; doppelter Boden)
    seen.add(id);
    let sum = direct.abteilung.get(id) ?? 0;
    for (const child of children.get(id) ?? []) sum += subtreeCount(child, seen);
    subtreeCache.set(id, sum);
    return sum;
  };
  const listCache = new Map<number, number>();

  return (a) => {
    if (a.audience_type === 'alle') return { audience_name: null, recipients: total };
    const id = a.audience_id;
    if (id === null) return { audience_name: null, recipients: 0 };
    const audience_name = names[a.audience_type].get(id) ?? null;
    if (audience_name === null) return { audience_name: null, recipients: 0 };
    let recipients: number;
    switch (a.audience_type) {
      case 'abteilung':
        recipients = subtreeCount(id);
        break;
      case 'team':
        recipients = direct.team.get(id) ?? 0;
        break;
      case 'standort':
        recipients = direct.standort.get(id) ?? 0;
        break;
      case 'verteiler': {
        let c = listCache.get(id);
        if (c === undefined) {
          c = countAudience('verteiler', id);
          listCache.set(id, c);
        }
        recipients = c;
      }
    }
    return { audience_name, recipients };
  };
}

// ---------------------------------------------------------------------------
// Sicht der Person (Portal, Dashboard)
// ---------------------------------------------------------------------------

/**
 * Filter „diese Zeile richtet sich an die Person“ fuer Tabellen mit den
 * Spalten audience_type/audience_id. `alias` ist der Tabellenalias der
 * Ankuendigungs- bzw. Umfragetabelle.
 *
 * Aufgeloest wird von der Person aus: ihre Abteilung samt allen
 * uebergeordneten (eine Zielgruppe auf die Oberabteilung erreicht sie), ihr
 * Team, ihr Standort und jeder Verteiler, der eine dieser Einheiten oder sie
 * selbst enthaelt. Daraus entsteht eine flache IN-Bedingung; das ist dieselbe
 * Mitgliedslogik wie audienceMemberSql, nur von der anderen Seite gelesen.
 * Ein inaktives oder fehlendes Profil erreicht nichts.
 */
export function audienceOfEmployeeSql(alias: string, employeeId: number): { sql: string; params: unknown[] } {
  const db = getDb();
  const emp = db
    .prepare("SELECT department_id, team_id, location_id FROM employees WHERE id = ? AND status = 'aktiv'")
    .get(employeeId) as { department_id: number | null; team_id: number | null; location_id: number | null } | undefined;
  if (!emp) return { sql: '0 = 1', params: [] };

  const departments =
    emp.department_id === null
      ? []
      : (
          db
            .prepare(
              `WITH RECURSIVE up(id) AS (
                 SELECT ?
                 UNION
                 SELECT d.parent_id FROM departments d JOIN up ON d.id = up.id WHERE d.parent_id IS NOT NULL
               )
               SELECT id FROM up`,
            )
            .all(emp.department_id) as { id: number }[]
        ).map((r) => r.id);

  const inList = (ids: number[]) => (ids.length === 0 ? '(NULL)' : `(${ids.map(() => '?').join(', ')})`);

  const lists = (
    db
      .prepare(
        `SELECT DISTINCT list_id FROM distribution_list_members
         WHERE (member_type = 'mitarbeiter' AND member_id = ?)
            OR (member_type = 'team' AND member_id = ?)
            OR (member_type = 'standort' AND member_id = ?)
            OR (member_type = 'abteilung' AND member_id IN ${inList(departments)})`,
      )
      .all(employeeId, emp.team_id ?? -1, emp.location_id ?? -1, ...departments) as { list_id: number }[]
  ).map((r) => r.list_id);

  const a = alias;
  return {
    sql: `(
      ${a}.audience_type = 'alle'
      OR (${a}.audience_type = 'abteilung' AND ${a}.audience_id IN ${inList(departments)})
      OR (${a}.audience_type = 'team' AND ${a}.audience_id = ?)
      OR (${a}.audience_type = 'standort' AND ${a}.audience_id = ?)
      OR (${a}.audience_type = 'verteiler' AND ${a}.audience_id IN ${inList(lists)})
    )`,
    params: [...departments, emp.team_id ?? -1, emp.location_id ?? -1, ...lists],
  };
}

/** Gehoert die (aktive) Person zur Zielgruppe? */
export function employeeInAudience(employeeId: number, audience: Audience): boolean {
  const { sql, params } = audienceMemberSql(audience);
  const row = getDb()
    .prepare(`SELECT 1 AS x FROM employees e WHERE e.id = ? AND e.status = 'aktiv' AND ${sql}`)
    .get(employeeId, ...params);
  return row !== undefined;
}
