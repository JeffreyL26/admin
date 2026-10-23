import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ADMIN_AREAS,
  areaOpen,
  permits,
  visibleSetupStepKeys,
  type AdminArea,
  type SetupOwner,
  type SetupStatus,
} from '@ohrganize/shared';
import { VARIANT } from '@variant-manifest';
import { getDb } from '../db/db.js';
import { DEFAULT_ADMIN_EMAIL } from './auth.js';
import { forbidden } from './errors.js';
import { effectiveFeatures } from './license.js';
import { permissionsFor } from './permissions.js';

/**
 * Stand des Einrichtungs-Assistenten, abgeleitet aus den Daten (nur SELECTs).
 * Wer einen Schritt ueber die normalen Seiten erledigt, sieht ihn im
 * Assistenten trotzdem als erledigt. Gespeichert werden nur zwei Merker in
 * `setup_confirmations`, die sich nicht aus den Daten ergeben: die
 * Bestaetigung der Abwesenheitsarten (Zeile `abwesenheit`, fuer die
 * Installation) und welches Konto die Einrichtung uebernommen hat (Zeile
 * `assistent` mit `user_id`). Ein weiterer Arbeitsplatz fragt so nicht erneut,
 * und eine neue HR-Person bekommt die Einrichtung nicht vorgesetzt.
 *
 * SICHERHEIT: `/api/setup` steht in ALWAYS_ALLOWED (permissions.ts), der globale
 * Hook prueft hier also KEINEN Bereich. Wie beim Dashboard (dashboardRoutes.ts)
 * passiert die Pruefung deshalb im Handler, Block fuer Block: Gesperrte Bloecke
 * werden nicht abgefragt und FEHLEN in der Antwort, statt mit 0 gefuellt zu
 * werden. Eine Null waere eine Falschaussage; ein fehlendes Feld liest der
 * Client als "kein Recht".
 */

/**
 * Darf das Konto die Einrichtung uebernehmen? Mindestens ein Schritt, den es im
 * Assistenten sieht (dieselbe Funktion wie der Client: Recht, Variante,
 * Lizenzfeature), und nicht das Startkonto des Betreibers.
 */
function mayClaim(req: FastifyRequest): boolean {
  const permissions = permissionsFor(req.user.admin_role_id);
  const features = effectiveFeatures();
  const visible = visibleSetupStepKeys(
    (area) => areaOpen(VARIANT, area, permissions[area], 'bearbeiten'),
    VARIANT,
    features === 'all' ? null : [...features],
  );
  if (visible.length === 0) return false;
  const row = getDb().prepare('SELECT email FROM users WHERE id = ?').get(req.user.id) as
    | { email: string }
    | undefined;
  return row !== undefined && row.email.toLowerCase() !== DEFAULT_ADMIN_EMAIL;
}

function ownerFor(ownerId: number | null | undefined, userId: number): SetupOwner {
  if (ownerId === null || ownerId === undefined) return 'none';
  return ownerId === userId ? 'self' : 'other';
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/setup/status', async (req): Promise<SetupStatus> => {
    const db = getDb();
    const permissions = permissionsFor(req.user.admin_role_id);
    const may = (area: AdminArea) => permits(permissions[area], 'lesen');
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

    const row = db.prepare('SELECT installation_id FROM installation LIMIT 1').get() as
      | { installation_id: string }
      | undefined;
    const instance = createHash('sha256')
      .update(row?.installation_id ?? 'ohne-installation')
      .digest('hex')
      .slice(0, 16);

    // Beide Merker in einer Abfrage; die Tabelle hat hoechstens eine Zeile je Merker.
    const marks = new Map(
      (db.prepare('SELECT step, user_id FROM setup_confirmations').all() as { step: string; user_id: number | null }[]).map(
        (m) => [m.step, m.user_id],
      ),
    );

    const status: SetupStatus = {
      allowed_areas: ADMIN_AREAS.filter(may),
      instance,
      assistant_owner: ownerFor(marks.get('assistent'), req.user.id),
      assistant_claimable: mayClaim(req),
    };

    if (may('einstellungen')) {
      // Nur eine gespeicherte Zeile zaehlt: getAllSettings() mischt Vorgaben ein
      // und kann "nie gespeichert" nicht von "Vorgabe uebernommen" trennen.
      status.company_saved =
        count(
          `SELECT COUNT(*) n FROM app_settings WHERE key IN ('companyName', 'defaultBundesland')`,
        ) > 0;
    }

    if (may('personal')) {
      status.locations = count(`SELECT COUNT(*) n FROM locations`);
      status.departments = count(`SELECT COUNT(*) n FROM departments`);
      status.employees_active = count(`SELECT COUNT(*) n FROM employees WHERE status = 'aktiv'`);
      status.employees_with_manager = count(
        `SELECT COUNT(*) n FROM employees WHERE status = 'aktiv' AND manager_id IS NOT NULL`,
      );
    }

    if (may('abwesenheit')) {
      status.absence_types_active = count(`SELECT COUNT(*) n FROM absence_types WHERE active = 1`);
      status.absence_confirmed = marks.has('abwesenheit');
    }

    if (may('benutzer')) {
      status.admin_users = count(`SELECT COUNT(*) n FROM users WHERE role = 'admin'`);
      // Portal-Zugang hat jedes Konto mit Personalprofil: Auch ein Admin-Konto
      // mit Profil meldet sich mit denselben Zugangsdaten im Portal an. Das
      // abfragende Konto zaehlt nicht mit: Verknuepft die HR ihr EIGENES Konto
      // mit ihrem Profil, hat damit noch niemand sonst Zugang erhalten.
      status.portal_users = (
        db.prepare('SELECT COUNT(*) n FROM users WHERE employee_id IS NOT NULL AND id != ?').get(req.user.id) as {
          n: number;
        }
      ).n;
    }

    // Mitarbeitende ohne Konto sind Daten des Bereichs personal: Auch hier beide
    // Rechte, sonst erfuehre eine Rolle nur mit benutzer die Belegschaftszahl.
    if (may('benutzer') && may('personal')) {
      status.employees_without_account = count(
        `SELECT COUNT(*) n FROM employees e
         WHERE e.status = 'aktiv'
           AND NOT EXISTS(SELECT 1 FROM users u WHERE u.employee_id = e.id)`,
      );
    }

    return status;
  });

  // Schritt "abwesenheit" bestaetigt. Recht wie fuer den Schritt selbst
  // (SETUP_STEPS: abwesenheit bearbeiten), geprueft hier, weil der globale Hook
  // unter /api/setup keinen Bereich prueft. Idempotent und ohne Audit: Es
  // aendert keine Fachdaten, nur ob der Assistent den Schritt noch anbietet.
  app.post('/api/setup/absence-confirmed', async (req) => {
    if (!permits(permissionsFor(req.user.admin_role_id).abwesenheit, 'bearbeiten')) throw forbidden();
    getDb().prepare(`INSERT OR IGNORE INTO setup_confirmations (step) VALUES ('abwesenheit')`).run();
    return { absence_confirmed: true };
  });

  // Das Konto hat den Assistenten kennengelernt (Willkommen gesehen oder
  // geoeffnet) und uebernimmt die Einrichtung, sofern sie noch frei ist: Danach
  // bieten Karte und Willkommen sie nur noch diesem Konto an (assistant_owner).
  // Frei ist sie auch, wenn das Konto geloescht wurde (user_id NULL). Recht wie
  // fuer den Assistenten (mayClaim), geprueft hier, weil der globale Hook unter
  // /api/setup keinen Bereich prueft. Idempotent und ohne Audit: Es aendert keine
  // Fachdaten, nur wem die Karte erscheint. Die Antwort nennt den Stand danach.
  app.post('/api/setup/started', async (req) => {
    if (!mayClaim(req)) throw forbidden();
    const db = getDb();
    db.prepare(
      `INSERT INTO setup_confirmations (step, user_id) VALUES ('assistent', ?)
       ON CONFLICT(step) DO UPDATE SET user_id = excluded.user_id, confirmed_at = datetime('now')
       WHERE setup_confirmations.user_id IS NULL`,
    ).run(req.user.id);
    const owner = db.prepare(`SELECT user_id FROM setup_confirmations WHERE step = 'assistent'`).get() as
      | { user_id: number | null }
      | undefined;
    return { assistant_owner: ownerFor(owner?.user_id, req.user.id) };
  });
}
