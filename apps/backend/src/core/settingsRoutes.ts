import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from './errors.js';
import { getAllSettings, setSetting } from './settings.js';
import { BUNDESLAENDER, holidaysForYear, type Bundesland } from './holidays.js';
import { audit } from './audit.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({ settings: getAllSettings() }));

  app.put('/api/settings', async (req) => {
    const body = parse(
      z.object({
        companyName: z.string().min(1).optional(),
        defaultBundesland: z.string().length(2).optional(),
        carryoverDeadline: z.string().regex(/^\d{2}-\d{2}$/).optional(),
        surveyMinParticipants: z.number().int().min(2).optional(),
        datevBeraterNr: z.string().optional(),
        datevMandantenNr: z.string().optional(),
      }),
      req.body,
    );
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) setSetting(key, value);
    }
    audit(req, 'update', 'settings', undefined, body);
    return { settings: getAllSettings() };
  });

  app.get('/api/bundeslaender', async () => ({ bundeslaender: BUNDESLAENDER }));

  app.get('/api/holidays/:year/:land', async (req) => {
    const { year, land } = req.params as { year: string; land: string };
    return { holidays: holidaysForYear(Number(year), land as Bundesland) };
  });
}
