/**
 * Self-Service: Organigramm im Mitarbeitenden-Portal (/api/me/org-tree).
 *
 * Bewusst KEIN eigener Baumaufbau: es ist exakt dasselbe Abteilungs-Organigramm
 * wie in der HR-Administration (`buildOrgTree()` aus modules/employees/orgRoutes),
 * damit beide Clients nie auseinanderlaufen (Entscheidung D11 der Spezifikation).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { OrgTreeNode } from '@hrmonic/shared';
import { buildOrgTree } from '../employees/orgRoutes.js';
import { requireEmployee } from './lib.js';

/**
 * Projektion auf genau die Felder des Vertrags `OrgTreeNode`.
 *
 * Warum überhaupt projizieren, obwohl der Inhalt unbedenklich ist? `buildOrgTree()`
 * baut die Knoten aus `SELECT d.*` bzw. `SELECT t.*` — heute kommt dadurch nur ein
 * zusätzliches `created_at` mit, künftige Spalten auf `departments`/`teams`
 * (Kostenstelle, Budget, interne Notizen) würden aber ungefragt ins Portal
 * durchschlagen. Die Aufzählung hier ist die Zugriffsgrenze: Abteilungs- und
 * Teamnamen, Leitungspersonen und Mitarbeiterzahlen sind unbedenklich (sie stehen
 * ohnehin im Mitarbeitendenverzeichnis), alles Weitere muss bewusst ergänzt werden.
 * Die Zuordnung läuft rein im Speicher — keine zusätzliche Abfrage je Knoten.
 */
function toPortalNode(node: OrgTreeNode): OrgTreeNode {
  return {
    id: node.id,
    name: node.name,
    parent_id: node.parent_id,
    head_employee_id: node.head_employee_id,
    head_name: node.head_name,
    employee_count: node.employee_count,
    total_employee_count: node.total_employee_count,
    teams: node.teams.map((team) => ({
      id: team.id,
      name: team.name,
      department_id: team.department_id,
      lead_employee_id: team.lead_employee_id,
      lead_name: team.lead_name,
      employee_count: team.employee_count,
    })),
    children: node.children.map(toPortalNode),
  };
}

export const meOrgRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/me/org-tree', async (req) => {
    // Zugriffsgrenze zuerst: nur Accounts mit aktivem Personalprofil.
    requireEmployee(req);
    const { tree, unassigned_count } = buildOrgTree();
    return { tree: tree.map(toPortalNode), unassigned_count };
  });
};
