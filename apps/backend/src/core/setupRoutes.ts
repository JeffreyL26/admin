import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
import { getDb, inTransaction } from '../db/db.js';
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

interface SetupAccount {
  id: number;
  email: string;
  role: string;
  admin_role_id: number | null;
}

function loadAccount(id: number): SetupAccount | undefined {
  return getDb().prepare('SELECT id, email, role, admin_role_id FROM users WHERE id = ?').get(id) as
    | SetupAccount
    | undefined;
}

/** Startkonto des Betreibers (E-Mail-Adressen lassen sich nicht aendern). */
function isStartAccount(account: SetupAccount): boolean {
  return account.email.toLowerCase() === DEFAULT_ADMIN_EMAIL;
}

/**
 * Darf das Konto die Einrichtung uebernehmen oder behalten? Admin-Konto mit
 * mindestens einem Schritt, den es im Assistenten sieht (dieselbe Funktion wie
 * der Client: Recht, Variante, Lizenzfeature). Wird gegen das aktuelle Konto
 * geprueft, nicht gegen das Token: Eine geaenderte Rolle wirkt sofort.
 */
function mayClaim(account: SetupAccount | undefined): account is SetupAccount {
  if (!account || account.role !== 'admin') return false;
  const permissions = permissionsFor(account.admin_role_id);
  const features = effectiveFeatures();
  return (
    visibleSetupStepKeys(
      (area) => areaOpen(VARIANT, area, permissions[area], 'bearbeiten'),
      VARIANT,
      features === 'all' ? null : [...features],
    ).length > 0
  );
}

/**
 * Wem gehoert die Einrichtung aus Sicht von `viewer`? Ein Eigentuemer zaehlt
 * nur, solange er sie noch uebernehmen duerfte: Bekommt sein Konto eine Rolle
 * ohne Assistentenschritt, ist sie wieder frei, sonst saehe sie niemand mehr.
 * Das Startkonto des Betreibers haelt sie nur vorlaeufig: Fuer jedes andere
 * Konto gilt sie dann als frei, damit die HR sie nach der Inbetriebnahme
 * uebernimmt (das Startkonto wird danach geloescht, docs/inbetriebnahme.md 5).
 * Behaelt ein Kunde es bewusst, uebernimmt das erste persoenliche Konto, das
 * den Assistenten kennenlernt.
 */
function ownerFor(ownerId: number | null | undefined, viewer: SetupAccount | undefined): SetupOwner {
  if (ownerId === null || ownerId === undefined || !viewer) return 'none';
  if (ownerId === viewer.id) return mayClaim(viewer) ? 'self' : 'none';
  const owner = loadAccount(ownerId);
  if (!mayClaim(owner)) return 'none';
  if (isStartAccount(owner) && !isStartAccount(viewer)) return 'none';
  return 'other';
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

    // Uebernehmen-Duerfen zaehlt nur, solange die Einrichtung frei ist; sonst
    // spart sich der haeufig abgerufene Status die Pruefung.
    const viewer = loadAccount(req.user.id);
    const owner = ownerFor(marks.get('assistent'), viewer);
    const status: SetupStatus = {
      allowed_areas: ADMIN_AREAS.filter(may),
      instance,
      assistant_owner: owner,
      assistant_claimable: owner === 'none' && mayClaim(viewer),
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
  // geoeffnet) und uebernimmt die Einrichtung, sofern sie aus seiner Sicht frei
  // ist (ownerFor: niemand, geloeschtes Konto, Eigentuemer ohne Recht mehr, oder
  // nur das Startkonto). Danach bieten Karte und Willkommen sie nur noch diesem
  // Konto an. Recht wie fuer den Assistenten (mayClaim), geprueft hier, weil der
  // globale Hook unter /api/setup keinen Bereich prueft. Pruefen und Schreiben in
  // einer Transaktion, damit zwei gleichzeitige Uebernahmen nicht beide
  // gewinnen. Idempotent und ohne Audit: Es aendert keine Fachdaten, nur wem die
  // Karte erscheint. Die Antwort nennt den Stand danach.
  app.post('/api/setup/started', async (req) => {
    const viewer = loadAccount(req.user.id);
    if (!mayClaim(viewer)) throw forbidden();
    const db = getDb();
    const current = () =>
      (db.prepare(`SELECT user_id FROM setup_confirmations WHERE step = 'assistent'`).get() as
        | { user_id: number | null }
        | undefined)?.user_id;
    const owner = inTransaction(() => {
      if (ownerFor(current(), viewer) === 'none') {
        db.prepare(
          `INSERT INTO setup_confirmations (step, user_id) VALUES ('assistent', ?)
           ON CONFLICT(step) DO UPDATE SET user_id = excluded.user_id, confirmed_at = datetime('now')`,
        ).run(viewer.id);
      }
      return ownerFor(current(), viewer);
    });
    return { assistant_owner: owner };
  });
}
