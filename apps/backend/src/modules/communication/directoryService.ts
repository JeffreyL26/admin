/**
 * Mitarbeiterverzeichnis: EINE Abfrage fuer beide Seiten.
 *
 * Die HR-Seite (GET /api/communication/directory) und das Portal
 * (GET /api/me/directory, modules/me/communicationRoutes.ts) lesen hier
 * dieselbe Feldsichtbarkeit (`directory_field_visibility`), dieselbe
 * Positivliste dienstlicher Felder und dieselben Filter. Wer nur eine Seite
 * aendert, laesst Verzeichnis und Portal auseinanderlaufen; deshalb steht die
 * Logik nicht mehr in routes.ts.
 *
 * DATENSCHUTZ: harte Positivliste dienstlicher Felder, niemals SELECT *.
 * Private Daten (Adresse, IBAN, Steuer, SV, Geburtsdatum, private Kontakte)
 * sind bewusst NICHT Teil der Abfrage. Unsichtbare Felder werden HIER
 * serverseitig entfernt; sie tauchen weder in der Antwort noch in Suche oder
 * Filter auf (eine Suche ueber ein verborgenes Feld verriete seinen Inhalt).
 */
import { getDb } from '../../db/db.js';
import { signPhotoUrl } from '../../core/files.js';
import { audienceMemberSql } from './audience.js';

export const DIRECTORY_FIELDS = [
  'email',
  'phone',
  'photo',
  'job_title',
  'department',
  'team',
  'location',
  'skills',
] as const;
export type DirectoryField = (typeof DIRECTORY_FIELDS)[number];

export type DirectoryVisibility = Record<DirectoryField, boolean>;

/** Sichtbarkeit je Feld; ein Feld ohne Zeile gilt als sichtbar. */
export function getFieldVisibility(): DirectoryVisibility {
  const rows = getDb()
    .prepare('SELECT field_key, visible FROM directory_field_visibility')
    .all() as { field_key: string; visible: number }[];
  const map = Object.fromEntries(rows.map((r) => [r.field_key, r.visible === 1]));
  return Object.fromEntries(DIRECTORY_FIELDS.map((f) => [f, map[f] ?? true])) as DirectoryVisibility;
}

/**
 * Skills/Employee-Skills gehoeren dem Leistungs-Modul (Kontrakt: skills(id,
 * name), employee_skills(employee_id, skill_id, level)). Wir lesen nur und
 * funktionieren auch, wenn die Tabellen (noch) nicht existieren oder leer sind.
 */
function skillTablesExist(): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('skills', 'employee_skills')",
    )
    .get() as { c: number };
  return row.c === 2;
}

export interface DirectoryFilters {
  search?: string;
  department_id?: number;
  location_id?: number;
  skill?: string;
}

/** Eintrag des Verzeichnisses; Felder fehlen, wenn sie ausgeblendet sind. */
export interface DirectoryEntry {
  id: number;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  email?: string | null;
  phone?: string | null;
  photo_file_id?: number | null;
  photo_thumb_file_id?: number | null;
  /**
   * Vorschaubild (sonst Original), befristet signiert und innerhalb eines
   * Zeitfensters stabil (signPhotoUrl in core/files.ts).
   */
  photo_url?: string | null;
  department_name?: string | null;
  team_name?: string | null;
  location_name?: string | null;
  skills?: { name: string; level: number }[];
}

interface DirectoryRow {
  id: number;
  first_name: string;
  last_name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  photo_file_id: number | null;
  photo_thumb_file_id: number | null;
  department_name: string | null;
  team_name: string | null;
  location_name: string | null;
}

/**
 * Aktive Mitarbeitende, gefiltert und auf die sichtbaren Felder projiziert.
 *
 * Suche: Name immer, Jobtitel und E-Mail nur, wenn das Feld sichtbar ist.
 * Filter auf ein ausgeblendetes Feld (Abteilung, Standort, Skills) werden
 * ignoriert, sonst liesse sich ueber die Trefferzahl ablesen, was die Karte
 * verschweigt. Der Abteilungsfilter schliesst Unterabteilungen ein, mit
 * derselben Baumlogik wie die Zielgruppe 'abteilung' (audience.ts).
 */
export function queryDirectory(filters: DirectoryFilters): {
  employees: DirectoryEntry[];
  fields: DirectoryVisibility;
} {
  const db = getDb();
  const vis = getFieldVisibility();
  const hasSkills = skillTablesExist();

  const where: string[] = ["e.status = 'aktiv'"];
  const params: unknown[] = [];
  if (filters.search) {
    const like = `%${filters.search}%`;
    const terms = ["e.first_name LIKE ?", "e.last_name LIKE ?", "(e.first_name || ' ' || e.last_name) LIKE ?"];
    params.push(like, like, like);
    if (vis.job_title) {
      terms.push('e.job_title LIKE ?');
      params.push(like);
    }
    if (vis.email) {
      terms.push('e.email LIKE ?');
      params.push(like);
    }
    where.push(`(${terms.join(' OR ')})`);
  }
  if (filters.department_id && vis.department) {
    const subtree = audienceMemberSql({ audience_type: 'abteilung', audience_id: filters.department_id });
    where.push(subtree.sql);
    params.push(...subtree.params);
  }
  if (filters.location_id && vis.location) {
    where.push('e.location_id = ?');
    params.push(filters.location_id);
  }
  if (filters.skill && vis.skills) {
    if (!hasSkills) return { employees: [], fields: vis };
    where.push(
      'e.id IN (SELECT es.employee_id FROM employee_skills es JOIN skills s ON s.id = es.skill_id WHERE s.name LIKE ?)',
    );
    params.push(`%${filters.skill}%`);
  }

  const rows = db
    .prepare(
      `SELECT e.id, e.first_name, e.last_name, e.job_title, e.email, e.phone, e.photo_file_id,
              e.photo_thumb_file_id, d.name AS department_name, t.name AS team_name, l.name AS location_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN teams t ON t.id = e.team_id
       LEFT JOIN locations l ON l.id = e.location_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.last_name, e.first_name`,
    )
    .all(...params) as DirectoryRow[];

  // Skills je Mitarbeiter:in (LEFT-JOIN-Semantik: leere Tabellen sind ok).
  const skillMap = new Map<number, { name: string; level: number }[]>();
  if (vis.skills && hasSkills && rows.length > 0) {
    const skillRows = db
      .prepare(
        `SELECT es.employee_id, s.name, es.level
         FROM employee_skills es JOIN skills s ON s.id = es.skill_id
         ORDER BY s.name`,
      )
      .all() as { employee_id: number; name: string; level: number }[];
    for (const s of skillRows) {
      const list = skillMap.get(s.employee_id) ?? [];
      list.push({ name: s.name, level: s.level });
      skillMap.set(s.employee_id, list);
    }
  }

  const employees = rows.map((r) => {
    const emp: DirectoryEntry = { id: r.id, first_name: r.first_name, last_name: r.last_name };
    if (vis.job_title) emp.job_title = r.job_title;
    if (vis.email) emp.email = r.email;
    if (vis.phone) emp.phone = r.phone;
    if (vis.photo) {
      emp.photo_file_id = r.photo_file_id;
      emp.photo_thumb_file_id = r.photo_thumb_file_id;
      emp.photo_url = signPhotoUrl(r);
    }
    if (vis.department) emp.department_name = r.department_name;
    if (vis.team) emp.team_name = r.team_name;
    if (vis.location) emp.location_name = r.location_name;
    if (vis.skills) emp.skills = skillMap.get(r.id) ?? [];
    return emp;
  });

  return { employees, fields: vis };
}
