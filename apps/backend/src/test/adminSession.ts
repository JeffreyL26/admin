/**
 * Erstanmeldung des Standard-Admins für die Smoke-Tests.
 *
 * WARUM ES DIESE DATEI GIBT: Bis zur Server-Härtung legte `ensureDefaultAdmin()`
 * das Konto `admin@hrmonic.de` mit dem fest verdrahteten Passwort
 * 'hrmonic2026' an — nachzulesen in README, CLAUDE.md und im gebündelten
 * server.cjs. Jede Smoke-Suite hat sich damit angemeldet. Seit M1 erzeugt das
 * Backend stattdessen ein Zufallspasswort, schreibt es mit 0600 neben
 * secret.key und erzwingt den Wechsel (`users.must_change_password`).
 *
 * Der bequeme Weg wäre gewesen, in jeder Suite HRMONIC_INITIAL_ADMIN_PASSWORD
 * zu setzen — dann liefe der Test an genau der Sperre vorbei, die für den
 * Kunden neu und heikel ist. Stattdessen geht diese Hilfsfunktion den echten
 * Weg der Erstinbetriebnahme (docs/inbetriebnahme.md, Schritt 1-2):
 *   1. generiertes Initialpasswort aus der Datei lesen,
 *   2. anmelden,
 *   3. nachweisen, dass der Wechselzwang alle übrigen Routen sperrt,
 *   4. eigenes Passwort setzen und mit dem frischen Token weiterarbeiten.
 * Jede der neun Suiten prüft damit nebenbei, dass eine frische Installation
 * überhaupt in Betrieb genommen werden kann. Bitte nicht durch eine
 * Umgebungsvariable ersetzen.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Passwort, das die Smoke-Tests nach dem erzwungenen Wechsel setzen.
 * Muss die Regeln aus core/auth.ts erfüllen: mindestens 12 Zeichen, höchstens
 * 72 Byte, und weder "hrmonic" (Produkt- und Firmenname) noch "admin"
 * (E-Mail-Lokalteil) noch eine gängige Tastenfolge enthalten.
 */
export const SMOKE_ADMIN_PASSWORD = 'Smoke-Kennwort-4711!';

type CheckFn = (label: string, ok: boolean, extra?: unknown) => void;

export interface AdminSession {
  token: string;
  auth: { authorization: string };
}

/**
 * Meldet den Standard-Admin an und schließt die Erstinbetriebnahme ab.
 * Gibt den Header für alle weiteren Requests der Suite zurück.
 */
export async function firstAdminLogin(app: FastifyInstance, check: CheckFn): Promise<AdminSession> {
  // Betreibervorgabe (HRMONIC_INITIAL_ADMIN_PASSWORD) hat Vorrang; ohne sie
  // steht das generierte Passwort in der Datei neben secret.key.
  let initialPassword = config.initialAdminPassword;
  if (!initialPassword) {
    if (!fs.existsSync(config.initialPasswordPath)) {
      throw new Error(
        `Initialpasswort nicht gefunden: ${config.initialPasswordPath}. ` +
          'Erwartet wird eine frische Wegwerf-Datenbank (HRMONIC_DATA_DIR).',
      );
    }
    initialPassword = fs.readFileSync(config.initialPasswordPath, 'utf8').trim();
  }

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@hrmonic.de', password: initialPassword },
  });
  check('Erstanmeldung mit generiertem Initialpasswort', login.statusCode === 200, login.json());
  if (login.statusCode !== 200) {
    throw new Error('Erstanmeldung fehlgeschlagen — alle weiteren Prüfungen wären wertlos.');
  }
  const firstToken = login.json().token as string;
  const firstAuth = { authorization: `Bearer ${firstToken}` };

  if (login.json().user?.must_change_password === 1) {
    // Nachweis, dass das Initialpasswort KEIN vollwertiger Zugang ist.
    const blocked = await app.inject({ method: 'GET', url: '/api/settings', headers: firstAuth });
    check(
      'Wechselzwang sperrt andere Routen (403 PASSWORD_CHANGE_REQUIRED)',
      blocked.statusCode === 403 && blocked.json()?.error?.code === 'PASSWORD_CHANGE_REQUIRED',
      blocked.json(),
    );

    const changed = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: firstAuth,
      payload: { currentPassword: initialPassword, newPassword: SMOKE_ADMIN_PASSWORD },
    });
    check('Passwortwechsel bei Erstinbetriebnahme', changed.statusCode === 200, changed.json());
    if (changed.statusCode !== 200) {
      throw new Error('Passwortwechsel fehlgeschlagen — die Suite kann nicht weiterlaufen.');
    }
    // Das alte Token ist durch sessions_valid_from soeben entwertet worden;
    // ab hier gilt ausschließlich das mitgelieferte frische Token.
    const token = changed.json().token as string;
    const auth = { authorization: `Bearer ${token}` };
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers: auth });
    check('Nach dem Wechsel voller Zugriff', after.statusCode === 200, after.json());
    return { token, auth };
  }

  return { token: firstToken, auth: firstAuth };
}
