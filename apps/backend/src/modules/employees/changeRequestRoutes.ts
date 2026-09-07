import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EMPLOYEE_SELF_EDITABLE_FIELDS } from '@ohrganize/shared';
import { parse } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import {
  changeRequestDecisionSchema,
  decideRequest,
  getRequestRow,
  listForHr,
  openRequestCount,
} from './changeRequestService.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
function idParam(req: FastifyRequest): number {
  return parse(idParamSchema, req.params).id;
}

const listQuerySchema = z.object({
  status: z.enum(['beantragt', 'genehmigt', 'abgelehnt', 'zurueckgezogen']).optional(),
  employee_id: z.coerce.number().int().positive().optional(),
});

/**
 * Änderungsanträge zu Stammdaten — Sicht der Personalabteilung.
 *
 * Liegt unter `/api/employees/*` und hängt damit am Rechtebereich `personal`
 * (ROUTE_AREAS in core/permissions.ts): Wer die Personalakte bearbeiten darf,
 * entscheidet auch über Anträge auf ihre Änderung. Ein eigener Bereich wäre
 * eine Rechtestufe, die niemand pflegt.
 */
export async function employeeChangeRequestRoutes(app: FastifyInstance): Promise<void> {
  /** Welche Felder überhaupt beantragbar sind — für die Anzeige. */
  app.get('/api/employees/change-request-fields', async () => ({
    fields: EMPLOYEE_SELF_EDITABLE_FIELDS,
  }));

  app.get('/api/employees/change-requests', async (req) => {
    const q = parse(listQuerySchema, req.query);
    return { requests: listForHr(q), open_count: openRequestCount() };
  });

  app.post('/api/employees/change-requests/:id/decide', async (req) => {
    const id = idParam(req);
    const body = parse(changeRequestDecisionSchema, req.body);
    const row = getRequestRow(id);
    // Zweiter Arm des Vier-Augen-Prinzips: Ein Konto der Personalabteilung MIT
    // verknüpftem Personalprofil darf den Antrag zum EIGENEN Profil nicht
    // genehmigen — auch dann nicht, wenn ihn jemand anderes gestellt hat.
    const istEigenesProfil = req.user.employee_id !== null && req.user.employee_id === row.employee_id;
    const { request, applied } = decideRequest(id, req.user.id, body, istEigenesProfil);
    audit(
      req,
      body.decision === 'genehmigt' ? 'employee_change_request.approve' : 'employee_change_request.reject',
      'employee',
      row.employee_id,
      {
        request_id: id,
        decision_note: body.decision_note ?? null,
        // Was tatsächlich überschrieben wurde — inklusive des Stands
        // unmittelbar vor dem Schreiben, nicht des Stands bei Antragstellung.
        applied,
      },
    );
    return { request };
  });
}
