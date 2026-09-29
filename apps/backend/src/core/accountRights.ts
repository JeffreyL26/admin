/**
 * Rang eines Kontos: was es tatsächlich darf, und ob die Person, die sein
 * Passwort ausgegeben hat, das auch durfte. EINE Stelle für zwei Regeln:
 *
 * 1. **Niemand gibt Rechte, die er selbst nicht hat, und niemand fasst ein
 *    Konto an, das mehr darf als er selbst** (Rolle, Verknüpfung, Passwort,
 *    Löschen; `assertWithinOwnRights`). Die Admin-Rolle beschreibt dabei nicht
 *    alles: Ein Desktop-Konto, dessen Personalprofil als Führungskraft
 *    freigeschaltet ist, bewertet über „Mein Team“ und liest dort freigegebene
 *    Gesprächsprotokolle, unabhängig von seiner Rolle. `effectiveRights`
 *    rechnet das als `fuehrung: bearbeiten` und, solange es die Protokolle
 *    lesen darf, `kommunikation: lesen` hinzu. Damit verlangt jeder Eingriff in
 *    so ein Konto (Passwort zurücksetzen, Profil verknüpfen oder lösen, Rolle
 *    ändern, löschen) genau diese Rechte, ohne eigene Regel je Route.
 * 2. **Wer ein Passwort ausgegeben hat, kennt es womöglich noch**
 *    (core/credentials.ts). Bekommt ein Konto später mehr Rechte, muss diese
 *    Person sie gehabt haben (`assertMayRaise`), sonst gibt zuerst jemand, der
 *    sie hat, das Passwort neu aus. Sonst wäre ein selbst angelegtes Konto,
 *    das eine berechtigte Person später befördert, ein Strohmann.
 *
 * Rechte eines Kontos steigen an genau diesen Stellen, jede ruft
 * `assertMayRaise` auf: Konto verknüpfen und Rolle zuweisen
 * (`PATCH /api/admin/users/:id`), Rolle erweitern
 * (`PATCH /api/admin/admin-roles/:id`, für jedes Mitglied), Profil als
 * Führungskraft freischalten (leadership/service.ts `grantLeader`). Das gilt
 * auch für eine Herabstufung, die das Lesen der Protokolle erst öffnet (siehe
 * `mayReadProtocols`). Eine neue solche Stelle gehört dazu; beim Anlegen
 * eines Kontos genügt Regel 1, denn die anlegende Person gibt das Passwort
 * selbst aus.
 *
 * Bewusst per SQL im Core: Die Benutzerverwaltung importiert keine Fachmodule.
 */
import type { FastifyRequest } from 'fastify';
import {
  ADMIN_AREAS,
  ADMIN_AREA_LABELS,
  moduleEnabled,
  permits,
  type AdminArea,
  type AdminPermissions,
  type PermissionLevel,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { getDb } from '../db/db.js';
import { conflict, forbidden } from './errors.js';
import { permissionsFor } from './permissions.js';
import { parseIssuerRights } from './credentials.js';

const LEADERSHIP_IN_VARIANT = moduleEnabled(VARIANT, 'leadership');
/** Gibt es in dieser Ausgabe Gesprächsprotokolle für die Führung? */
const PROTOCOLS_IN_VARIANT = LEADERSHIP_IN_VARIANT && moduleEnabled(VARIANT, 'communication');

/** Stufen als Zahl, um „höher?“ vergleichen zu können. */
export function rank(level: PermissionLevel): number {
  return level === 'bearbeiten' ? 2 : level === 'lesen' ? 1 : 0;
}

/** Rechte eines Kontos ohne jede Admin-Berechtigung (Portal-Konten). */
export const NO_ACCESS: AdminPermissions = Object.fromEntries(
  ADMIN_AREAS.map((a) => [a, 'kein' as PermissionLevel]),
) as AdminPermissions;

/**
 * Bereiche, deren Bearbeitungsrecht die Eingaben von `scopeFor`
 * (leadership/service.ts) verändert oder die eigenen Rechte nachträglich
 * senken lässt: Vorgesetzte, Abteilungs- und Teamleitung (personal;
 * recruiting beim Einstellen), Fachrollen (verwaltung,
 * /api/admin/employees/:id/roles), Freischaltung, Zuweisungen und Automatik
 * (fuehrung) sowie die eigene Rolle (benutzer: erst Bereich formen, dann das
 * Recht in der eigenen Rolle senken). Wer bei `scopeFor` eine Eingabe
 * ergänzt, prüft hier, welcher Bereich sie schreibt.
 */
export const SCOPE_SHAPING_AREAS = ['personal', 'verwaltung', 'fuehrung', 'recruiting', 'benutzer'] as const;

/**
 * Selbstschutz beim LESEN der Gesprächsprotokolle über „Mein Team“: Wer die
 * eigene Zuständigkeit mitgestalten kann, bekommt sie nur, wenn er sie
 * ohnehin lesen darf (`kommunikation: lesen`). Die Sperren an den einzelnen
 * Schreibstellen können nicht jede Eingabe von `scopeFor` abdecken. Die Rolle
 * „Führungskraft“ (alle Bereiche `kein`) ist nicht betroffen.
 *
 * Folge für den Rang: Senkt jemand die Rechte einer Führungskraft so, dass sie
 * nichts mehr formen kann, liest sie ab dann Protokolle. Das zählt als
 * Rechteerhöhung (`effectiveRights`), verlangt also `kommunikation` bei der
 * handelnden Person und bei der, die das Passwort ausgegeben hat. Wer so
 * herabstuft, übernimmt den Bereich, den die Führungskraft vorher selbst
 * geformt haben kann.
 */
export function mayReadProtocols(rolePermissions: AdminPermissions): boolean {
  return (
    permits(rolePermissions.kommunikation, 'lesen') ||
    !SCOPE_SHAPING_AREAS.some((area) => permits(rolePermissions[area], 'bearbeiten'))
  );
}

/** `mayReadProtocols` für die Admin-Rolle eines Kontos. */
export function mayReadProtocolsAsLeader(adminRoleId: number | null): boolean {
  return mayReadProtocols(permissionsFor(adminRoleId));
}

/**
 * Ist das Personalprofil als Führungskraft freigeschaltet? Bewusst ohne Blick
 * auf den Status: Ein inaktives Profil öffnet „Mein Team“ zwar nicht, wird es
 * aber wieder aktiv, stiegen die Rechte sonst an einer Stelle (Personal), die
 * keine Rangprüfung kennt.
 */
export function isReleasedLeader(employeeId: number | null | undefined): boolean {
  if (employeeId === null || employeeId === undefined) return false;
  return !!getDb().prepare('SELECT 1 FROM leadership_leaders WHERE employee_id = ?').get(employeeId);
}

export interface AccountState {
  role: string;
  admin_role_id: number | null;
  employee_id: number | null;
}

export interface Account extends AccountState {
  id: number;
  email: string;
  name: string;
}

/** Desktop-Konto des Profils (nur dieses öffnet „Mein Team“), sonst undefined. */
export function desktopAccountOf(employeeId: number): Account | undefined {
  return getDb()
    .prepare(
      "SELECT id, email, name, role, admin_role_id, employee_id FROM users WHERE employee_id = ? AND role = 'admin'",
    )
    .get(employeeId) as Account | undefined;
}

/**
 * Rechte, die ein Konto tatsächlich ausübt: Admin-Rolle plus Führungsfunktion
 * (siehe Kopfkommentar). `admin_role_id = NULL` heißt nur bei role 'admin'
 * Vollzugriff; ein Portal-Konto hat keine Rolle und keinerlei Admin-Rechte und
 * öffnet „Mein Team“ nie. Für Vorher/Nachher-Vergleiche lassen sich Rolle
 * (`rolePermissions`) und Freischaltung (`leader`) vorgeben.
 */
export function effectiveRights(
  account: AccountState,
  opts: { rolePermissions?: AdminPermissions; leader?: boolean } = {},
): AdminPermissions {
  if (account.role !== 'admin') return { ...NO_ACCESS };
  const role = opts.rolePermissions ?? permissionsFor(account.admin_role_id);
  const rights = { ...role };
  const leader = opts.leader ?? isReleasedLeader(account.employee_id);
  if (!leader || !LEADERSHIP_IN_VARIANT) return rights;
  rights.fuehrung = 'bearbeiten';
  if (PROTOCOLS_IN_VARIANT && mayReadProtocols(role) && rank(rights.kommunikation) < rank('lesen')) {
    rights.kommunikation = 'lesen';
  }
  return rights;
}

/** Rechte der handelnden Person (ihre Admin-Rolle). */
export function ownRights(req: FastifyRequest): AdminPermissions {
  return permissionsFor(req.user.admin_role_id ?? null);
}

/** Was `storeIssuedPassword` festhält, wenn die handelnde Person ein Passwort ausgibt. */
export function issuerRightsOf(req: FastifyRequest): AdminPermissions | null {
  return (req.user.admin_role_id ?? null) === null ? null : ownRights(req);
}

function areaList(areas: AdminArea[]): string {
  return areas.map((a) => ADMIN_AREA_LABELS[a]).join(', ');
}

/**
 * Regel 1: 403, wenn `levels` in einem Bereich über die eigenen Rechte geht.
 * Schützt beide Richtungen: niemand vergibt mehr, als er hat, und niemand
 * beschneidet, löscht oder übernimmt (Passwort) ein ranghöheres Konto.
 */
export function assertWithinOwnRights(
  req: FastifyRequest,
  levels: Partial<AdminPermissions>,
  message: string,
): void {
  const own = ownRights(req);
  const exceeded = ADMIN_AREAS.filter((a) => rank(levels[a] ?? 'kein') > rank(own[a]));
  if (exceeded.length > 0) throw forbidden(`${message} Betroffene Bereiche: ${areaList(exceeded)}.`);
}

/** Eine Rechteänderung an einem bestehenden Konto. */
export interface RightsChange {
  account: { id: number; name: string };
  before: AdminPermissions;
  after: AdminPermissions;
}

function raisedAreas(change: RightsChange): AdminArea[] {
  return ADMIN_AREAS.filter((a) => rank(change.after[a]) > rank(change.before[a]));
}

/**
 * Regel 2 für jede Stelle, an der bestehende Konten mehr Rechte bekommen.
 * Für jeden gestiegenen Bereich muss
 * - die handelnde Person ihn selbst haben (403, `actorMessage`), und
 * - die Person, die das Passwort des Kontos zuletzt ausgegeben hat, ihn bei
 *   der Ausgabe gehabt haben (409: das Konto ist in Ordnung, nur sein Passwort
 *   ist in den falschen Händen gewesen).
 */
export function assertMayRaise(req: FastifyRequest, changes: RightsChange[], actorMessage: string): void {
  const raised = changes.map((c) => ({ change: c, areas: raisedAreas(c) })).filter((r) => r.areas.length > 0);
  if (raised.length === 0) return;

  const own = ownRights(req);
  const actorLacks = new Set<AdminArea>();
  for (const { change, areas } of raised) {
    for (const a of areas) if (rank(change.after[a]) > rank(own[a])) actorLacks.add(a);
  }
  if (actorLacks.size > 0) {
    throw forbidden(`${actorMessage} Betroffene Bereiche: ${areaList(ADMIN_AREAS.filter((a) => actorLacks.has(a)))}.`);
  }

  const stmt = getDb().prepare('SELECT credentials_issuer_rights FROM users WHERE id = ?');
  const names: string[] = [];
  const issuerLacks = new Set<AdminArea>();
  for (const { change, areas } of raised) {
    const row = stmt.get(change.account.id) as { credentials_issuer_rights: string | null } | undefined;
    const issuer = parseIssuerRights(row?.credentials_issuer_rights ?? null);
    if (issuer === null) continue;
    const lacks = areas.filter((a) => rank(change.after[a]) > rank(issuer[a]));
    if (lacks.length === 0) continue;
    names.push(change.account.name);
    for (const a of lacks) issuerLacks.add(a);
  }
  if (names.length > 0) {
    const areas = areaList(ADMIN_AREAS.filter((a) => issuerLacks.has(a)));
    throw conflict(
      `Das Passwort von ${names.map((n) => `„${n}“`).join(', ')} hat jemand ohne die Rechte ${areas} ausgegeben ` +
        'und kennt es womöglich noch. Mehr Rechte bekommt das Konto erst, wenn jemand mit diesen Rechten und der ' +
        'Benutzerverwaltung das Passwort unter Verwaltung → Benutzer & Rechte zurückgesetzt hat.',
    );
  }
}
