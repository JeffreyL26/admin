import type { FastifyInstance } from 'fastify';
import { employeesModule } from './employees/routes.js';
import { absencesModule } from './absences/routes.js';
import { performanceModule } from './performance/routes.js';
import { compensationModule } from './compensation/routes.js';
import { communicationModule } from './communication/routes.js';
import { recruitingModule } from './recruiting/routes.js';
import { adminModule } from './admin/routes.js';

// Jedes Fachmodul lebt vollständig in seinem eigenen Ordner und wird hier
// einmalig registriert — diese Datei bleibt nach der Scaffold-Phase stabil.
export async function registerModules(app: FastifyInstance): Promise<void> {
  await app.register(employeesModule);
  await app.register(absencesModule);
  await app.register(performanceModule);
  await app.register(compensationModule);
  await app.register(communicationModule);
  await app.register(recruitingModule);
  await app.register(adminModule);
}
