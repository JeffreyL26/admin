import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COUNTRY_LABELS,
  isCountryCode,
  isRegionOf,
  regionsFor,
  type CountryCode,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { badRequest, parse } from './errors.js';
import { getAllSettings, setSetting } from './settings.js';
import { holidaysForYear } from './holidays.js';
import { audit } from './audit.js';

/**
 * Land der Installation: Es kommt aus der Variante (Build), nie aus einer
 * Kundeneinstellung. Wer eine andere Ausgabe braucht, bekommt einen anderen
 * Installer.
 */
function countryFromQuery(raw: string | undefined): CountryCode {
  if (raw === undefined || raw === '') return VARIANT.country;
  if (!isCountryCode(raw)) throw badRequest(`Unbekanntes Land: ${raw}`);
  return raw;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({ settings: getAllSettings() }));

  app.put('/api/settings', async (req) => {
    const body = parse(
      z.object({
        companyName: z.string().min(1).optional(),
        // Region des Firmensitzes: gegen den Katalog des Variantenlandes
        // geprueft. Die fruehere Laengenpruefung liess jede zweistellige Eingabe
        // durch und damit eine Feiertagsrechnung, die still nichts fand.
        defaultBundesland: z
          .string()
          .refine((v) => isRegionOf(VARIANT.country, v), {
            message: `Unbekannte Region für ${COUNTRY_LABELS[VARIANT.country]}`,
          })
          .optional(),
        carryoverDeadline: z.string().regex(/^\d{2}-\d{2}$/).optional(),
        surveyMinParticipants: z.number().int().min(2).optional(),
        portalShowOthersSickness: z.boolean().optional(),
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

  /**
   * Regionen eines Landes (Vorgabe: Land der Variante). Nachschlagewerk fuer
   * Auswahlfelder; ohne Bereichsrecht erreichbar (permissions.ts
   * ALWAYS_ALLOWED), weil sonst jede Rolle ohne Einstellungsrecht ein leeres
   * Auswahlfeld saehe.
   */
  app.get('/api/regions', async (req) => {
    const country = countryFromQuery((req.query as { country?: string }).country);
    return {
      country,
      country_label: COUNTRY_LABELS[country],
      regions: regionsFor(country),
    };
  });

  /** Alias der Vorgaenger-Fassung; liefert die Regionen des Variantenlandes. */
  app.get('/api/bundeslaender', async () => ({ bundeslaender: regionsFor(VARIANT.country) }));

  app.get('/api/holidays/:year/:land', async (req) => {
    const { year, land } = req.params as { year: string; land: string };
    const country = countryFromQuery((req.query as { country?: string }).country);
    if (!isRegionOf(country, land)) throw badRequest(`Unbekannte Region: ${land}`);
    return { holidays: holidaysForYear(Number(year), country, land) };
  });
}
