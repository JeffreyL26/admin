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
import { forbidden } from './errors.js';
import { effectiveFeatures, licenseStatusPublic } from './license.js';
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

/** Was Rechte und Uebernahme vom Konto brauchen (req.user oder Eigentuemer). */
interface SetupAccount {
  id: number;
  role: string;
  admin_role_id?: number | null;
}

/** Eigentuemer der Einrichtung, dazu was ueber "nur vorlaeufig" entscheidet. */
interface SetupOwnerAccount extends SetupAccount {
  employee_id: number | null;
  is_start_account: number;
}

/**
 * Darf das Konto die Einrichtung uebernehmen oder behalten? Admin-Konto mit
 * mindestens einem Schritt, den es im Assistenten sieht (dieselbe Funktion wie
 * der Client: Recht, Variante, Lizenzfeature). Fuer das abfragende Konto
 * reicht `req.user`: Der globale Hook liest es bei jeder Anfrage frisch aus
 * `users`, eine geaenderte Rolle wirkt also sofort. `permissions` gibt der
 * Statushandler herein, der sie fuer seine Bloecke ohnehin berechnet.
 */
function mayClaim(
  account: Pick<SetupAccount, 'role' | 'admin_role_id'>,
  permissions?: ReturnType<typeof permissionsFor>,
): boolean {
  if (account.role !== 'admin') return false;
  // Erst nach der Rollenpruefung: Fuer ein Portal-Konto waere die Abfrage umsonst.
  const rights = permissions ?? permissionsFor(account.admin_role_id);
  const features = effectiveFeatures();
  return (
    visibleSetupStepKeys(
      (area) => areaOpen(VARIANT, area, rights[area], 'bearbeiten'),
      VARIANT,
      features === 'all' ? null : [...features],
    ).length > 0
  );
}

/**
 * Haelt der Eigentuemer die Einrichtung nur vorlaeufig? Das Startkonto des
 * Betreibers (Kennzeichen `is_start_account` aus ensureDefaultAdmin, Migration
 * `009_start_account`; nicht die Adresse, die nach dem Loeschen neu vergeben
 * werden kann) wird nach der Inbetriebnahme geloescht (docs/inbetriebnahme.md
 * 5), damit die HR sie dann uebernimmt. Ist es mit einem Personalprofil
 * verknuepft, nutzt es eine Person selbst (ein Kunde behaelt es), und es zaehlt
 * wie jedes persoenliche Konto.
 */
function holdsProvisionally(owner: SetupOwnerAccount): boolean {
  return owner.is_start_account === 1 && owner.employee_id === null;
}

/**
 * Wem gehoert die Einrichtung aus Sicht des Kontos `viewerId`
 * (`viewerMayClaim`: mayClaim dieses Kontos)? Ein Eigentuemer zaehlt nur,
 * solange er sie noch uebernehmen duerfte: Bekommt sein Konto eine Rolle ohne
 * Assistentenschritt, ist sie wieder frei, sonst saehe sie niemand mehr. Haelt
 * das Startkonto sie nur vorlaeufig, gilt sie fuer jedes andere Konto als frei
 * (es gibt hoechstens ein Startkonto, eindeutiger Teilindex in Migration
 * `009_start_account`; ein anderes Konto ist also nie selbst eins).
 */
function ownerFor(owner: SetupOwnerAccount | undefined, viewerId: number, viewerMayClaim: boolean): SetupOwner {
  if (!owner) return 'none';
  if (owner.id === viewerId) return viewerMayClaim ? 'self' : 'none';
  if (holdsProvisionally(owner) || !mayClaim(owner)) return 'none';
  return 'other';
}

/**
 * Beide Merker samt Konto des Eigentuemers in EINER Abfrage (der Status wird
 * bei jedem Fokus geholt). `owner` fehlt, wenn niemand uebernommen hat oder
 * das Konto geloescht wurde (user_id NULL).
 */
function loadMarks(): { absenceConfirmed: boolean; owner: SetupOwnerAccount | undefined } {
  const rows = getDb()
    .prepare(
      `SELECT sc.step, u.id, u.role, u.admin_role_id, u.employee_id, u.is_start_account
       FROM setup_confirmations sc LEFT JOIN users u ON u.id = sc.user_id`,
    )
    .all() as ({ step: string } & Omit<SetupOwnerAccount, 'id'> & { id: number | null })[];
  const assistant = rows.find((r) => r.step === 'assistent');
  return {
    absenceConfirmed: rows.some((r) => r.step === 'abwesenheit'),
    // Ohne Konto (LEFT JOIN ohne Treffer) sind alle Kontofelder NULL.
    owner:
      assistant && assistant.id !== null
        ? {
            id: assistant.id,
            role: assistant.role,
            admin_role_id: assistant.admin_role_id,
            employee_id: assistant.employee_id,
            is_start_account: assistant.is_start_account,
          }
        : undefined,
  };
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

    const marks = loadMarks();
    const viewerMayClaim = mayClaim(req.user, permissions);
    const owner = ownerFor(marks.owner, req.user.id, viewerMayClaim);
    const status: SetupStatus = {
      allowed_areas: ADMIN_AREAS.filter(may),
      instance,
      assistant_owner: owner,
      // Dieselbe Pruefung wie POST /api/setup/started, samt Nur-Lese-Betrieb
      // (dort 403 LICENSE_EXPIRED): Kein Client muss sie nachbauen.
      assistant_claimable: owner === 'none' && viewerMayClaim && !licenseStatusPublic().read_only,
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
      status.absence_confirmed = marks.absenceConfirmed;
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
  // nur vorlaeufig beim Startkonto). Danach bieten Karte und Willkommen sie nur noch diesem
  // Konto an. Recht wie fuer den Assistenten (mayClaim), geprueft hier, weil der
  // globale Hook unter /api/setup keinen Bereich prueft. Pruefen und Schreiben in
  // einer Transaktion, damit zwei gleichzeitige Uebernahmen nicht beide
  // gewinnen. Idempotent und ohne Audit: Es aendert keine Fachdaten, nur wem die
  // Karte erscheint. Die Antwort nennt den Stand danach.
  app.post('/api/setup/started', async (req) => {
    if (!mayClaim(req.user)) throw forbidden();
    const viewerId = req.user.id;
    const db = getDb();
    const owner = inTransaction(() => {
      if (ownerFor(loadMarks().owner, viewerId, true) === 'none') {
        db.prepare(
          `INSERT INTO setup_confirmations (step, user_id) VALUES ('assistent', ?)
           ON CONFLICT(step) DO UPDATE SET user_id = excluded.user_id, confirmed_at = datetime('now')`,
        ).run(viewerId);
      }
      return ownerFor(loadMarks().owner, viewerId, true);
    });
    return { assistant_owner: owner };
  });
}
