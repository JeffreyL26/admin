import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COUNTRY_LABELS,
  DATEV_LOHNART_KEYS,
  isCountryCode,
  isRegionOf,
  isValidAusfallschluessel,
  isValidBeraterNr,
  isValidLohnart,
  isValidMandantenNr,
  regionsFor,
  type CountryCode,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { inTransaction } from '../db/db.js';
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
      }),
      req.body,
    );
    // Alle Werte samt Audit-Eintrag in EINER Transaktion.
    inTransaction(() => {
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) setSetting(key, value);
      }
      audit(req, 'update', 'settings', undefined, body);
    });
    return { settings: getAllSettings() };
  });

  /**
   * Einstellungen des DATEV-Lohnexports, eigene Route statt PUT
   * /api/settings: Sie steht in LICENSE_OPEN_ROUTES (core/license.ts), weil
   * der Export im Nur-Lese-Betrieb offen bleibt und ein gesperrter Export
   * sonst nicht zu beheben waere. Bereich wie alle Einstellungen
   * (`einstellungen: bearbeiten`). Nummern duerfen leer bleiben (dann sperrt
   * der Pruefbericht), aber nicht falsch; Lohnarten und Ausfallschluessel
   * pruefen nur die Form, welche Nummer richtig ist, weiss das Lohnbuero.
   * Beide Zuordnungen werden mit dem Gespeicherten zusammengefuehrt: Ein
   * Aufruf, der nur einen Schluessel nennt, loescht die anderen nicht (leer
   * heisst „keine Nummer“).
   */
  app.put('/api/settings/datev', async (req) => {
    const body = parse(
      z.object({
        datevBeraterNr: z
          .string()
          .trim()
          .refine((v) => v === '' || isValidBeraterNr(v), { message: 'Beraternummer: 4 bis 7 Ziffern' })
          .optional(),
        datevMandantenNr: z
          .string()
          .trim()
          .refine((v) => v === '' || isValidMandantenNr(v), { message: 'Mandantennummer: 1 bis 5 Ziffern' })
          .optional(),
        datevProgramm: z.enum(['lodas', 'lug']).optional(),
        datevBetrieblichePnr: z.boolean().optional(),
        datevFestbezuege: z.enum(['stammdaten', 'bewegungsdaten']).optional(),
        datevVertragsstunden: z.boolean().optional(),
        datevLohnarten: z
          .record(z.string(), z.string().trim().refine((v) => v === '' || isValidLohnart(v), 'Lohnart: 1 bis 4 Ziffern'))
          .refine((m) => Object.keys(m).every((k) => (DATEV_LOHNART_KEYS as string[]).includes(k)), {
            message: 'Unbekannter Lohnart-Schlüssel',
          })
          .optional(),
        datevAusfallschluessel: z
          .record(
            z.string().regex(/^\d{1,9}$/, 'Schlüssel ist die id der Abwesenheitsart'),
            z.string().trim().refine((v) => v === '' || isValidAusfallschluessel(v), {
              message: 'Ausfallschlüssel: 1 bis 4 Buchstaben oder Ziffern',
            }),
          )
          .refine((m) => Object.keys(m).length <= 500, { message: 'Zu viele Abwesenheitsarten' })
          .optional(),
      }),
      req.body,
    );
    const stored = getAllSettings();
    const next: Record<string, unknown> = { ...body };
    if (body.datevLohnarten) next.datevLohnarten = { ...stored.datevLohnarten, ...body.datevLohnarten };
    if (body.datevAusfallschluessel) {
      next.datevAusfallschluessel = { ...stored.datevAusfallschluessel, ...body.datevAusfallschluessel };
    }
    inTransaction(() => {
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) setSetting(key, value);
      }
      audit(req, 'update', 'settings', undefined, body);
    });
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
