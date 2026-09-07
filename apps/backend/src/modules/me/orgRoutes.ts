/**
 * Self-Service: Organigramm im Mitarbeitenden-Portal.
 *
 * - `/api/me/org-chart`: Personen-Organigramm, dieselbe Berichtslinie wie in
 *   der HR-Administration (`buildOrgChart()` aus modules/employees), nur auf
 *   das projiziert, was Kolleg:innen sehen dürfen.
 * - `/api/me/org-tree`: Abteilungsbaum (`buildOrgTree()`), im Portal heute
 *   der Abteilungsfilter des Firmenkalenders.
 *
 * Bewusst KEIN eigener Baumaufbau in beiden Fällen, damit Portal und
 * HR-Administration nie zwei verschiedene Organisationen zeigen.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { MeOrgChartPerson, OrgChartPerson, OrgTreeNode } from '@ohrganize/shared';
import { buildOrgChart, buildOrgTree } from '../employees/orgRoutes.js';
import { requireEmployee } from './lib.js';

/**
 * Projektion auf den Vertrag `MeOrgChartPerson`. Das ist die Zugriffsgrenze:
 * Was ein Organigramm an der Wand zeigt (Name, Titel, Zuordnung, Foto) sehen
 * Kolleg:innen, alles andere aus `OrgChartPerson` (E-Mail, Telefon,
 * Personalnummer, Eintrittsdatum, rohes `manager_id`) bleibt der
 * HR-Administration vorbehalten. Neue Felder dort tauchen hier deshalb nie
 * ungefragt auf.
 */
function toPortalPerson(p: OrgChartPerson): MeOrgChartPerson {
  return {
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    job_title: p.job_title,
    department_id: p.department_id,
    department_name: p.department_name,
    team_name: p.team_name,
    location_name: p.location_name,
    parent_id: p.parent_id,
    parent_source: p.parent_source,
    photo_url: p.photo_url,
  };
}

/**
 * Projektion auf genau die Felder des Vertrags `OrgTreeNode`. `buildOrgTree()`
 * baut die Knoten aus `SELECT d.*` bzw. `SELECT t.*`; künftige Spalten auf
 * `departments`/`teams` (Kostenstelle, Budget, interne Notizen) würden sonst
 * ungefragt ins Portal durchschlagen.
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
  app.get('/api/me/org-chart', async (req) => {
    // Zugriffsgrenze zuerst: nur Accounts mit aktivem Personalprofil.
    const me = requireEmployee(req);
    const { people, departments } = buildOrgChart();
    return {
      people: people.map(toPortalPerson),
      departments: departments.map((d) => ({ id: d.id, name: d.name })),
      self_id: me.id,
    };
  });

  app.get('/api/me/org-tree', async (req) => {
    requireEmployee(req);
    const { tree, unassigned_count } = buildOrgTree();
    return { tree: tree.map(toPortalNode), unassigned_count };
  });
};
