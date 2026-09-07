/**
 * Modul Führung & Bewertung: HTTP-Schicht.
 *
 * Zwei Zugänge, zwei Gates:
 *
 * 1. `/api/leadership/me/*`: die FÜHRUNGSFUNKTION. Der globale Hook
 *    (core/permissions.ts, SELF_GATED) überspringt hier die Bereichsprüfung;
 *    stattdessen prüft der preHandler des eingekapselten Plugins unten, dass
 *    das Personalprofil des Kontos als Führungskraft freigeschaltet und aktiv
 *    ist. Jede Route liefert ausschließlich Daten aus dem eigenen
 *    Zuständigkeitsbereich (service.assertInScope). Einzige Ausnahme ist
 *    `/me/status`: Es antwortet jedem Admin-Konto, damit die Oberfläche weiß,
 *    ob sie „Mein Team“ anbieten soll.
 *
 * 2. Alles andere unter `/api/leadership/*`: die VERWALTUNG (Freischaltungen,
 *    Zuständigkeiten, Skala, Kategorien, Report). Sie hängt am Rechtebereich
 *    `fuehrung`, den der globale Hook wie überall durchsetzt (GET = lesen,
 *    sonst bearbeiten).
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RATING_PERIOD_KINDS, RATING_SCALE_KEYS, permits } from '@ohrganize/shared';
import { forbidden, parse } from '../../core/errors.js';
import { permissionsFor } from '../../core/permissions.js';
import { isoDateString } from '../../core/validation.js';
import * as service from './service.js';

// ---------------------------------------------------------------------------
// Schemata
// ---------------------------------------------------------------------------

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const employeeParamSchema = z.object({ employeeId: z.coerce.number().int().positive() });
const periodQuerySchema = z.object({ period: z.string().max(10).optional() });

/**
 * Zusätzlich zur Zeitraumwahl: Spaltenzahl der Report-Aufschlüsselung.
 * Der Service deckelt den Wert nochmals (BREAKDOWN_COLUMNS_MAX); hier steht
 * die Grenze, damit unsinnige Eingaben schon als 400 auffallen.
 */
const breakdownQuerySchema = periodQuerySchema.extend({
  columns: z.coerce.number().int().min(1).max(service.BREAKDOWN_COLUMNS_MAX).optional(),
});

/**
 * Zweiter Pfadparameter der Detail-Route. Er heißt `memberId` und nicht
 * `employeeId`, weil das erste Segment (`/leaders/:employeeId/…`) diesen Namen
 * schon trägt: find-my-way verlangt an derselben Baumposition denselben
 * Parameternamen, sonst scheitert die Registrierung.
 */
const memberParamSchema = z.object({ memberId: z.coerce.number().int().positive() });

const settingsPatchSchema = z.object({
  period: z.enum(RATING_PERIOD_KINDS).optional(),
  uniform_scale: z.boolean().optional(),
  scale: z.enum(RATING_SCALE_KEYS).optional(),
  allow_mutual: z.boolean().optional(),
  auto_direct_reports: z.boolean().optional(),
  auto_department_head: z.boolean().optional(),
  auto_team_lead: z.boolean().optional(),
});

const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich').max(80),
  description: z.string().trim().max(300).nullish(),
  scale: z.enum(RATING_SCALE_KEYS).nullish(),
  active: z.boolean().optional(),
});
const categoryPatchSchema = categoryCreateSchema.partial();
const reorderSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });

const leaderCreateSchema = z.object({
  employee_id: z.number().int().positive(),
  auto_scope: z.boolean().optional(),
  note: z.string().trim().max(400).nullish(),
});
const leaderPatchSchema = z.object({
  auto_scope: z.boolean().optional(),
  note: z.string().trim().max(400).nullish(),
});

const assignmentSchema = z.object({
  kind: z.enum(['include', 'exclude']),
  target_type: z.enum(['employee', 'department', 'team', 'role']),
  target_id: z.number().int().positive(),
  valid_from: isoDateString.nullish(),
  valid_to: isoDateString.nullish(),
  note: z.string().trim().max(400).nullish(),
});

const ratingsSaveSchema = z.object({
  period_key: z.string().min(4).max(10),
  ratings: z
    .array(
      z.object({
        category_id: z.number().int().positive(),
        score: z.number().int(),
        comment: z.string().max(4000),
      }),
    )
    .min(1, 'Mindestens ein Bewertungsblock ist erforderlich')
    .max(50),
});

function idParam(req: FastifyRequest): number {
  return parse(idParamSchema, req.params).id;
}

function employeeParam(req: FastifyRequest): number {
  return parse(employeeParamSchema, req.params).employeeId;
}

/**
 * Fotos in Verwaltungsantworten nur, wenn das Konto sie auch selbst signieren
 * dürfte (Bereich `personal`, siehe core/files.ts assertMayReadFile), sonst
 * weitete `fuehrung: lesen` still auf Mitarbeiterfotos aus.
 */
function photoView(req: FastifyRequest): service.ViewOptions {
  return { photos: permits(permissionsFor(req.user.admin_role_id ?? null).personal, 'lesen') };
}

function periodOf(req: FastifyRequest) {
  const settings = service.getSettings();
  const { period } = parse(periodQuerySchema, req.query ?? {});
  return { settings, period: service.resolvePeriod(period, settings) };
}

// ---------------------------------------------------------------------------
// Gate der Führungsfunktion
// ---------------------------------------------------------------------------

/**
 * Personal-ID der handelnden Führungskraft oder 403. Bewusst pro Request aus
 * der Datenbank: Ein Entzug der Freischaltung wirkt sofort, nicht erst nach
 * Ablauf des Tokens, dieselbe Regel wie für Rollenentzug im globalen Hook.
 */
function requireLeader(req: FastifyRequest): number {
  if ((req.user.employee_id ?? null) === null) {
    throw forbidden(
      'Für dieses Konto ist kein Personalprofil hinterlegt. Die Führungsfunktion setzt ein verknüpftes Profil voraus.',
    );
  }
  const leaderId = service.leaderEmployeeIdFor(req.user);
  if (leaderId === null) {
    throw forbidden('Die Führungsfunktion ist für Ihr Konto nicht freigeschaltet.');
  }
  return leaderId;
}

async function leaderRoutes(app: FastifyInstance): Promise<void> {
  // Gilt für JEDE Route dieses Plugins: neue Routen sind damit automatisch
  // gesperrt, bis das Konto als Führungskraft freigeschaltet ist.
  app.addHook('preHandler', async (req) => {
    requireLeader(req);
  });

  app.get('/api/leadership/me/team', async (req) => {
    const leaderId = requireLeader(req);
    const { settings, period } = periodOf(req);
    return service.myTeam(leaderId, period, settings);
  });

  app.get('/api/leadership/me/employees/:id', async (req) => {
    const leaderId = requireLeader(req);
    const { period } = periodOf(req);
    return service.teamMemberDetail(leaderId, idParam(req), period);
  });

  app.put('/api/leadership/me/employees/:id/ratings', async (req) => {
    const leaderId = requireLeader(req);
    const body = parse(ratingsSaveSchema, req.body);
    return { ratings: service.saveRatings(req, leaderId, idParam(req), body) };
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const leadershipModule: FastifyPluginAsync = async (app) => {
  // Status: für jedes Admin-Konto beantwortbar (kein Leader-Gate), damit die
  // Sidebar „Mein Team“ nur denen zeigt, die es auch benutzen können.
  app.get('/api/leadership/me/status', async (req) => service.leaderStatus(req.user));

  await app.register(leaderRoutes);

  // ------------------------------------------------------ Einstellungen --
  // mutual_pairs: bestehende gegenseitige Verantwortung, auch die aus
  // Organisationsänderungen, die keine Schreibstelle des Moduls sehen konnte.
  app.get('/api/leadership/settings', async () => ({
    settings: service.getSettings(),
    mutual_pairs: service.mutualPairs(),
  }));

  app.put('/api/leadership/settings', async (req) => ({
    settings: service.updateSettings(req, parse(settingsPatchSchema, req.body)),
  }));

  // --------------------------------------------------------- Kategorien --
  app.get('/api/leadership/categories', async () => ({ categories: service.listCategories(false) }));

  app.post('/api/leadership/categories', async (req, reply) => {
    const category = service.createCategory(req, parse(categoryCreateSchema, req.body));
    reply.status(201);
    return { category };
  });

  // Vor `/categories/:id`, damit „reorder“ nicht als ID gelesen wird.
  app.post('/api/leadership/categories/reorder', async (req) => ({
    categories: service.reorderCategories(req, parse(reorderSchema, req.body).ids),
  }));

  app.patch('/api/leadership/categories/:id', async (req) => ({
    category: service.updateCategory(req, idParam(req), parse(categoryPatchSchema, req.body)),
  }));

  app.delete('/api/leadership/categories/:id', async (req, reply) => {
    service.deleteCategory(req, idParam(req));
    reply.status(204);
  });

  // ----------------------------------------------------- Führungskräfte --
  app.get('/api/leadership/leaders', async () => ({ leaders: service.listLeaders() }));

  app.post('/api/leadership/leaders', async (req, reply) => {
    const body = parse(leaderCreateSchema, req.body);
    const result = service.grantLeader(req, body.employee_id, {
      auto_scope: body.auto_scope,
      note: body.note,
    });
    reply.status(201);
    return result;
  });

  app.get('/api/leadership/leaders/:employeeId/team', async (req) => {
    const { period } = periodOf(req);
    return service.leaderTeam(employeeParam(req), period, photoView(req));
  });

  app.patch('/api/leadership/leaders/:employeeId', async (req) =>
    service.updateLeader(req, employeeParam(req), parse(leaderPatchSchema, req.body)),
  );

  app.delete('/api/leadership/leaders/:employeeId', async (req, reply) => {
    service.revokeLeader(req, employeeParam(req));
    reply.status(204);
  });

  // Aufschlüsselung des Report-Widgets: verantwortete Personen mit ihrer
  // Gesamtbewertung je Zeitraum (ohne Kommentare; die holt die Detail-Route).
  app.get('/api/leadership/leaders/:employeeId/breakdown', async (req) => {
    const settings = service.getSettings();
    const q = parse(breakdownQuerySchema, req.query ?? {});
    const period = service.resolvePeriod(q.period, settings);
    return service.leaderBreakdown(employeeParam(req), period, q.columns ?? service.BREAKDOWN_COLUMNS_DEFAULT);
  });

  // Eine Bewertung vollständig: alle Kategorien des Zeitraums mit Kommentaren
  // plus Protokoll: Grundlage des Detail-Pop-ups im Report.
  app.get('/api/leadership/leaders/:employeeId/employees/:memberId/ratings', async (req) => {
    const { period } = periodOf(req);
    const memberId = parse(memberParamSchema, req.params).memberId;
    return service.ratingDetail(employeeParam(req), memberId, period);
  });

  app.post('/api/leadership/leaders/:employeeId/assignments', async (req, reply) => {
    const result = service.createAssignment(req, employeeParam(req), parse(assignmentSchema, req.body));
    reply.status(201);
    return result;
  });

  app.delete('/api/leadership/assignments/:id', async (req, reply) => {
    service.deleteAssignment(req, idParam(req));
    reply.status(204);
  });

  // Auswahllisten der Einrichtung: im Bereich fuehrung, siehe service.lookup.
  app.get('/api/leadership/lookup', async () => service.lookup());

  // ------------------------------------------------ Report und Einsicht --
  app.get('/api/leadership/report', async (req) => {
    const { period } = periodOf(req);
    return service.buildReport(period, photoView(req));
  });

  app.get('/api/leadership/employees/:id/ratings', async (req) =>
    service.employeeRatings(idParam(req)),
  );
};
