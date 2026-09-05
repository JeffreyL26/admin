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
} from '@ohrganize/shared';
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
  ['/api/leadership', 'fuehrung'],
];

/**
 * Routen, deren Zugriff nicht an einem Rechtebereich hängt, sondern an der
 * PERSON: Die Führungsfunktion (/api/leadership/me/*) steht genau den Konten
 * offen, deren Personalprofil als Führungskraft freigeschaltet ist
 * (Tabelle leadership_leaders) — unabhängig von der Admin-Rolle, sonst könnte
 * eine Führungskraft ohne HR-Bereiche ihr Team nicht bewerten. Die Prüfung
 * macht das Modul selbst in einem Plugin-Hook (modules/leadership/routes.ts,
 * requireLeader), der für JEDE Route unter diesem Präfix läuft; zusätzlich
 * liefert es ausschließlich Daten aus dem eigenen Zuständigkeitsbereich.
 * Hier wird nur die Bereichsprüfung übersprungen. Eintragen NUR für Präfixe,
 * die im Modul einen solchen Hook haben.
 */
const SELF_GATED = ['/api/leadership/me'];

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

/**
 * POST-Routen, die fachlich reine LESEvorgänge sind: Sie stellen eine
 * kurzlebige signierte Download-URL aus und ändern nichts. POST steht dort nur,
 * damit der Link nicht selbst in einem Query-String (und damit im Proxy-Log)
 * landet. Ohne diese Ausnahme scheitert jede Nur-Lese-Rolle am Herunterladen
 * genau der Dokumente, die sie einsehen darf.
 *
 * Eintragen NUR, wenn die Route wirklich nichts schreibt.
 */
const READ_ONLY_POST_ROUTES: ReadonlySet<string> = new Set([
  '/api/compensation/certificates/:id/sign',
]);

/** Lesen genügt für GET/HEAD und die Signierrouten, alles andere verlangt Bearbeiten. */
function neededFor(method: string, route: string): 'lesen' | 'bearbeiten' {
  if (method === 'GET' || method === 'HEAD') return 'lesen';
  if (READ_ONLY_POST_ROUTES.has(route)) return 'lesen';
  return 'bearbeiten';
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
  if (SELF_GATED.some((p) => route === p || route.startsWith(`${p}/`))) return;

  const needed = neededFor(req.method, route);

  // Nur der Upload selbst, NICHT der ganze /api/files-Baum. Vorher galt der
  // Sonderfall auch für POST /api/files/:id/sign — und weil files.id
  // AUTOINCREMENT und damit durchzählbar ist, kam jedes Konto mit irgendeinem
  // Bearbeitungsrecht an JEDE Datei: Entgeltbescheinigungen, Verträge,
  // AU-Bescheinigungen, Bewerbungsunterlagen. Bitte nicht wieder auf
  // startsWith('/api/files/') aufweichen.
  if (route === '/api/files') {
    const anyArea = ADMIN_AREAS.some((a) => permits(permissions[a], needed));
    if (!anyArea) throw forbidden('Für diese Aktion fehlt Ihnen die Berechtigung.');
    return;
  }

  // Signieren einer Datei: Der zuständige Fachbereich hängt an der Datei, nicht
  // an der Route, und ist hier deshalb nicht bestimmbar. Die Prüfung
  // ('lesen' im Bereich der referenzierenden Fachtabelle) macht der Handler in
  // core/files.ts — siehe assertMayReadFile(). Diese Zeile ist kein Freibrief.
  if (route === '/api/files/:id/sign') return;

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
