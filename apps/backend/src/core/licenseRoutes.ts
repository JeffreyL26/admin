/**
 * Lizenz-Routen der Administration (Bereich `einstellungen`, siehe
 * permissions.ts ROUTE_AREAS). Das Einspielen ist ein JSON-PUT mit dem
 * Dateiinhalt als Text — keine Multipart-Route und ausdrücklich NICHT über
 * POST /api/files: Die Lizenz gehört nicht in die files-Tabelle, und der
 * Upload muss auch im Nur-Lese-Betrieb funktionieren (core/license.ts,
 * LICENSE_OPEN_ROUTES).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LICENSE_FILE_MAX_BYTES } from '@ohrganize/shared';
import { parse } from './errors.js';
import { installLicense, licenseReport, licenseStatus } from './license.js';

export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/license', async () => ({ license: licenseStatus() }));

  app.put('/api/license', async (req) => {
    const body = parse(
      z.object({
        // Dieselbe Grenze prüft der Client vor dem Lesen der Datei (shared).
        license: z.string().min(1).max(LICENSE_FILE_MAX_BYTES),
      }),
      req.body,
    );
    return { license: installLicense(req, body.license) };
  });

  // Als Datei-Download, damit die Administration ihn einer Verlängerung
  // beilegen kann. Inhalt: Kennungen und Zahlen, keine Personendaten.
  app.get('/api/license/report', async (req, reply) => {
    const report = licenseReport();
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="ohrganize-lizenzbericht-${report.generated_at.slice(0, 10)}.json"`,
    );
    reply.header('Cache-Control', 'no-store, private');
    return JSON.stringify(report, null, 2);
  });
}
