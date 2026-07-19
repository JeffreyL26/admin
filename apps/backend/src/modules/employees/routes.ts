import type { FastifyPluginAsync } from 'fastify';
import { employeeRoutes } from './employeeRoutes.js';
import { contractRoutes } from './contractRoutes.js';
import { orgRoutes } from './orgRoutes.js';
import { documentRoutes } from './documentRoutes.js';

// Modul: Personalverwaltung & Stammdaten.
// Mitarbeiterdatenbank, Vertragshistorie, Organisationsstruktur, Dokumente.
export const employeesModule: FastifyPluginAsync = async (app) => {
  await employeeRoutes(app);
  await contractRoutes(app);
  await orgRoutes(app);
  await documentRoutes(app);
};
