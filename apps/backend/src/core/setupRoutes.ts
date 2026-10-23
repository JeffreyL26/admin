import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ADMIN_AREAS, SETUP_STEPS, permits, type AdminArea, type SetupStatus } from '@ohrganize/shared';
import { getDb } from '../db/db.js';
import { forbidden } from './errors.js';
import { permissionsFor } from './permissions.js';

/**
 * Stand des Einrichtungs-Assistenten, abgeleitet aus den Daten (nur SELECTs).
 * Wer einen Schritt ueber die normalen Seiten erledigt, sieht ihn im
 * Assistenten trotzdem als erledigt. Gespeichert werden nur zwei Merker in
 * `setup_confirmations`, die sich nicht aus den Daten ergeben: die
 * Bestaetigung der Abwesenheitsarten (Zeile `abwesenheit`) und dass ein Konto
 * die Einrichtung uebernommen hat (Zeile `assistent`). Beide gelten fuer die
 * ganze Installation, damit ein weiterer Arbeitsplatz oder ein weiteres
 * Konto nicht erneut gefragt wird.
 *
 * SICHERHEIT: `/api/setup` steht in ALWAYS_ALLOWED (permissions.ts), der globale
 * Hook prueft hier also KEINEN Bereich. Wie beim Dashboard (dashboardRoutes.ts)
 * passiert die Pruefung deshalb im Handler, Block fuer Block: Gesperrte Bloecke
 * werden nicht abgefragt und FEHLEN in der Antwort, statt mit 0 gefuellt zu
 * werden. Eine Null waere eine Falschaussage; ein fehlendes Feld liest der
 * Client als "kein Recht".
 */
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

    const status: SetupStatus = {
      allowed_areas: ADMIN_AREAS.filter(may),
      instance,
      assistant_started: count(`SELECT COUNT(*) n FROM setup_confirmations WHERE step = 'assistent'`) > 0,
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
      status.absence_confirmed =
        count(`SELECT COUNT(*) n FROM setup_confirmations WHERE step = 'abwesenheit'`) > 0;
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

  // Ein Konto hat die Einrichtung uebernommen: Willkommen gesehen, Assistent
  // geoeffnet oder Karte ausgeblendet. Danach bieten Karte und Willkommen sie
  // keinem weiteren Konto an (Statusfeld assistant_started). Recht wie fuer den
  // Assistenten selbst: mindestens ein Schritt bearbeitbar, geprueft hier, weil
  // der globale Hook unter /api/setup keinen Bereich prueft. Idempotent und
  // ohne Audit: Es aendert keine Fachdaten, nur ob die Karte erscheint.
  app.post('/api/setup/started', async (req) => {
    const permissions = permissionsFor(req.user.admin_role_id);
    if (!SETUP_STEPS.some((d) => permits(permissions[d.area], 'bearbeiten'))) throw forbidden();
    getDb().prepare(`INSERT OR IGNORE INTO setup_confirmations (step) VALUES ('assistent')`).run();
    return { assistant_started: true };
  });
}
