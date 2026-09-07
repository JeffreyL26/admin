import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EMPLOYEE_SELF_EDITABLE_FIELDS } from '@ohrganize/shared';
import { parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { requireEmployee } from './lib.js';
import {
  changeRequestCreateSchema,
  createRequest,
  listForEmployee,
  withdrawRequest,
} from '../employees/changeRequestService.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
function idParam(req: FastifyRequest): number {
  return parse(idParamSchema, req.params).id;
}

/**
 * Änderungsanträge zu den EIGENEN Stammdaten — Sicht des Portals.
 *
 * Das Portal schreibt nie direkt in `employees`: Die Personalakte ist die
 * Grundlage für Abrechnung und Meldungen. Beantragt wird hier, entschieden in
 * der Personalabteilung (`/api/employees/change-requests`). Die Prüfung der
 * Felder und die Statusübergänge stehen gemeinsam in
 * `employees/changeRequestService.ts`, damit beide Seiten nicht auseinanderlaufen.
 *
 * `employee_id` kommt IMMER aus `requireEmployee` und nie aus dem Body —
 * dieselbe Regel wie bei Dokumenten und Abwesenheiten.
 */
export const meChangeRequestRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Beantragbare Felder samt Bezeichnung, Eingabeart und Vertraulichkeit.
   * Das Portal baut sein Formular daraus, statt die Liste zu kopieren.
   */
  app.get('/api/me/change-request-fields', async (req) => {
    requireEmployee(req);
    return { fields: EMPLOYEE_SELF_EDITABLE_FIELDS };
  });

  app.get('/api/me/change-requests', async (req) => {
    const emp = requireEmployee(req);
    return { requests: listForEmployee(emp.id) };
  });

  app.post('/api/me/change-requests', async (req, reply) => {
    const emp = requireEmployee(req);
    const body = parse(changeRequestCreateSchema, req.body);
    const request = createRequest(emp.id, req.user.id, body);
    // Im Protokoll stehen nur die NAMEN der Felder, nicht die Werte: Der
    // Antrag selbst enthält sie bereits, und im audit_log stünde die neue
    // Bankverbindung sonst ein zweites Mal — an einer Stelle, die auch die
    // Systemverwaltung liest.
    audit(req, 'me.change_request.create', 'employee', emp.id, {
      request_id: request.id,
      fields: request.fields.map((f) => f.field),
    });
    reply.code(201);
    return { request };
  });

  app.post('/api/me/change-requests/:id/withdraw', async (req) => {
    const emp = requireEmployee(req);
    const id = idParam(req);
    const request = withdrawRequest(id, emp.id);
    audit(req, 'me.change_request.withdraw', 'employee', emp.id, { request_id: id });
    return { request };
  });
};
