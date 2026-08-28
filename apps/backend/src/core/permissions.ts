/**
 * Abgestufte Rechte innerhalb der HR-Administration.
 *
 * Die Zuordnung Route -> Bereich liegt bewusst zentral und nicht verstreut in
 * den Modulen: Der globale Hook in server.ts ist die einzige Sicherheitsgrenze,
 * und eine Route, die hier niemand einträgt, ist damit automatisch gesperrt
 * statt versehentlich offen (fail closed). Wer ein neues Modul anlegt, trägt
 * seinen Präfix hier ein — sonst antwortet es mit 403 und der Fehler fällt
 * sofort auf, statt Daten preiszugeben.
 */
import type { FastifyRequest } from 'fastify';
import {
  ADMIN_AREAS,
  FULL_ACCESS,
  permits,
  type AdminArea,
  type AdminPermissions,
  type PermissionLevel,
} from '@hrmonic/shared';
import { getDb } from '../db/db.js';
import { forbidden } from './errors.js';

/**
 * Präfix -> Bereich. Die Reihenfolge entscheidet: Der erste passende Eintrag
 * gewinnt, deshalb stehen die spezielleren Präfixe oben (die Benutzerverwaltung
 * liegt unter /api/admin und darf nicht in 'verwaltung' fallen).
 */
const ROUTE_AREAS: ReadonlyArray<readonly [string, AdminArea]> = [
  ['/api/admin/admin-roles', 'benutzer'],
  ['/api/admin/users', 'benutzer'],
  ['/api/admin', 'verwaltung'],
  ['/api/employees', 'personal'],
  ['/api/departments', 'personal'],
  ['/api/teams', 'personal'],
  ['/api/locations', 'personal'],
  ['/api/contracts', 'personal'],
  ['/api/documents', 'personal'],
  ['/api/org', 'personal'],
  ['/api/absences', 'abwesenheit'],
  ['/api/performance', 'leistung'],
  ['/api/compensation', 'verguetung'],
  ['/api/recruiting', 'recruiting'],
  ['/api/communication', 'kommunikation'],
  ['/api/settings', 'einstellungen'],
];

/**
 * Routen, die jede:r Admin unabhängig von der Rolle erreichen darf:
 * Nachschlagewerte und die eigene Startseite. Sie geben keine Fachdaten preis,
 * die nicht ohnehin über einen erlaubten Bereich sichtbar wären — das Dashboard
 * blendet Kacheln fehlender Bereiche selbst aus.
 */
const ALWAYS_ALLOWED = ['/api/dashboard', '/api/holidays', '/api/bundeslaender'];

export interface PermissionSubject {
  id: number;
  role: string;
  admin_role_id?: number | null;
}

/**
 * Rechte eines Kontos. Ohne zugewiesene Rolle gilt Vollzugriff — so bleibt eine
 * bestehende Installation nach dem Update unverändert benutzbar und ein frisch
 * angelegtes Konto sperrt sich nicht selbst aus. Fehlt für einen Bereich die
 * Zeile, gilt 'kein'.
 */
export function permissionsFor(adminRoleId: number | null | undefined): AdminPermissions {
  if (adminRoleId == null) return { ...FULL_ACCESS };
  const rows = getDb()
    .prepare('SELECT area, level FROM admin_role_permissions WHERE role_id = ?')
    .all(adminRoleId) as { area: string; level: PermissionLevel }[];
  const byArea = new Map(rows.map((r) => [r.area, r.level]));
  return Object.fromEntries(
    ADMIN_AREAS.map((a) => [a, byArea.get(a) ?? 'kein']),
  ) as AdminPermissions;
}

/** Lesen genügt für GET/HEAD, alles andere verlangt Bearbeiten. */
function neededFor(method: string): 'lesen' | 'bearbeiten' {
  return method === 'GET' || method === 'HEAD' ? 'lesen' : 'bearbeiten';
}

function areaFor(route: string): AdminArea | null {
  for (const [prefix, area] of ROUTE_AREAS) {
    if (route === prefix || route.startsWith(`${prefix}/`)) return area;
  }
  return null;
}

/**
 * Wirft 403, wenn die Rolle des Kontos die Route nicht abdeckt.
 *
 * `/api/files` ist der Sonderfall: Der Datei-Upload wird aus mehreren Bereichen
 * heraus benutzt (Dokumente, Bescheinigungen, Bewerbungen). Er hängt deshalb
 * nicht an einem Bereich, sondern verlangt, dass das Konto überhaupt irgendwo
 * schreiben darf — die fachliche Route, die die Datei danach verknüpft, prüft
 * ihren eigenen Bereich ohnehin.
 */
export function assertRouteAllowed(req: FastifyRequest, permissions: AdminPermissions): void {
  const route = req.routeOptions.url ?? req.url;
  if (ALWAYS_ALLOWED.some((p) => route === p || route.startsWith(`${p}/`))) return;

  const needed = neededFor(req.method);

  if (route === '/api/files' || route.startsWith('/api/files/')) {
    const anyArea = ADMIN_AREAS.some((a) => permits(permissions[a], needed));
    if (!anyArea) throw forbidden('Für diese Aktion fehlt Ihnen die Berechtigung.');
    return;
  }

  const area = areaFor(route);
  if (area === null) {
    // Unbekannte Route: gesperrt statt geraten. Fällt beim ersten Aufruf auf.
    throw forbidden('Für diesen Bereich ist keine Berechtigung hinterlegt.');
  }
  if (!permits(permissions[area], needed)) {
    throw forbidden(
      needed === 'lesen'
        ? 'Für diesen Bereich haben Sie keine Berechtigung.'
        : 'Sie dürfen diesen Bereich nur einsehen, nicht bearbeiten.',
    );
  }
}
