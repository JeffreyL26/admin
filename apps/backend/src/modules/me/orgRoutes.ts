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
import { getFieldVisibility, type DirectoryVisibility } from '../communication/directoryService.js';
import { requireEmployee } from './lib.js';

/**
 * Projektion auf den Vertrag `MeOrgChartPerson`. Das ist die Zugriffsgrenze:
 * Was ein Organigramm an der Wand zeigt (Name, Titel, Zuordnung, Foto) sehen
 * Kolleg:innen, alles andere aus `OrgChartPerson` (E-Mail, Telefon,
 * Personalnummer, Eintrittsdatum, rohes `manager_id`) bleibt der
 * HR-Administration vorbehalten. Neue Felder dort tauchen hier deshalb nie
 * ungefragt auf.
 *
 * Dazu gilt die Feldsichtbarkeit des Verzeichnisses (Kommunikation →
 * Verzeichnis → Felder, communication/directoryService.ts): Was die HR dort
 * ausblendet (Foto, Jobtitel, Abteilung, Team, Standort), fehlt auch im
 * Organigramm des Portals. Sonst stuende ein Feld auf der Karte, das der
 * Dialog als „im Verzeichnis und im Organigramm des Portals“ ausgeblendet
 * verspricht. `department_id` faellt mit der Abteilung weg; der
 * Abteilungsfilter des Portals haengt daran.
 */
function toPortalPerson(p: OrgChartPerson, vis: DirectoryVisibility): MeOrgChartPerson {
  return {
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    job_title: vis.job_title ? p.job_title : null,
    department_id: vis.department ? p.department_id : null,
    department_name: vis.department ? p.department_name : null,
    team_name: vis.team ? p.team_name : null,
    location_name: vis.location ? p.location_name : null,
    parent_id: p.parent_id,
    parent_source: p.parent_source,
    photo_url: vis.photo ? p.photo_url : null,
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
    const vis = getFieldVisibility();
    return {
      people: people.map((p) => toPortalPerson(p, vis)),
      departments: vis.department ? departments.map((d) => ({ id: d.id, name: d.name })) : [],
      self_id: me.id,
    };
  });

  app.get('/api/me/org-tree', async (req) => {
    requireEmployee(req);
    const { tree, unassigned_count } = buildOrgTree();
    return { tree: tree.map(toPortalNode), unassigned_count };
  });
};
