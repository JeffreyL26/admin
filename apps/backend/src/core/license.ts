/**
 * Lizenzzustand und Durchsetzung.
 *
 * Die Lizenz ist eine signierte Datei im Datenverzeichnis (Format und Prüfung:
 * licenseCodec.ts, Vertrauensanker: licenseKeys.ts). Dieses Modul beantwortet
 * drei Fragen: In welchem Zustand ist die Installation (licenseStatus), darf
 * dieser Request schreiben (assertLicenseAllows) und ist noch ein Platz frei
 * (assertSeatsAvailable). Dazu das Einspielen einer neuen Datei und der
 * Lizenzbericht.
 *
 * Zeitbasis ist ausschließlich die lokale Systemuhr (todayIso). Ein
 * Wasserzeichen gegen zurückgestellte Uhren gibt es nur als Stolperdraht
 * (clock_warning), nicht als Riegel: Ein Administrator mit Zugriff auf die
 * Datenbank könnte es zurücksetzen, und Windows verstellt Uhren auch von selbst
 * (Secure Time Seeding) — ein harter Riegel träfe zuerst den ehrlichen Kunden.
 *
 * Was der Nur-Lese-Betrieb bedeutet: GET/HEAD bleiben offen (Einsicht, Export,
 * signierte Downloads), ebenso Anmeldung, Passwortwechsel und das Einspielen
 * einer neuen Lizenz. Jeder andere Schreibzugriff antwortet 403 LICENSE_EXPIRED.
 * „Nur-Lese“ heißt nicht „unveränderlich“: Audit-Zeilen, Login-Drosselung und
 * die Statusbuchung des DATEV-Exports schreiben weiterhin — bewusst, denn der
 * Export ist genau das, was ein abgelaufener Kunde noch braucht.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import {
  LICENSE_CLOCK_WARNING_TEXT,
  LICENSE_ERROR_CODES,
  LICENSE_FORMAT_VERSION,
  PORTAL_READ_ONLY_TEXT,
  daysBetweenIso,
  describeLicense,
  formatDate,
  licenseMessage,
  type LicenseDescribable,
  type LicensePayload,
  type LicenseReport,
  type LicenseState,
  type LicenseStatus,
  type LicenseStatusPublic,
} from '@ohrganize/shared';
import { config } from '../config.js';
import { getDb } from '../db/db.js';
import { auditStandalone } from './audit.js';
import { addDaysIso, todayIso } from './dates.js';
import { AppError } from './errors.js';
import { TRUSTED_LICENSE_KEYS_RAW } from './licenseKeys.js';
import { deriveLicenseState, variantMismatchReason, type LicenseCore } from './licenseState.js';
import {
  LicenseFormatError,
  publicKeyFrom,
  verifyLicenseText,
  type TrustedLicenseKey,
} from './licenseCodec.js';
import { APP_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Vertrauensanker
// ---------------------------------------------------------------------------

let trustedKeysCache: TrustedLicenseKey[] | null = null;

/** Eingebaute Schlüssel — oder, nur für Tests, der eine aus der Umgebung. */
function trustedKeys(): TrustedLicenseKey[] {
  if (trustedKeysCache) return trustedKeysCache;
  trustedKeysCache = config.licensePublicKeyOverride
    ? [{ kid: 'test', publicKey: publicKeyFrom(config.licensePublicKeyOverride) }]
    : TRUSTED_LICENSE_KEYS_RAW.map((k) => ({ kid: k.kid, publicKey: publicKeyFrom(k.publicKey) }));
  return trustedKeysCache;
}

// ---------------------------------------------------------------------------
// Installation (Migration 004_license, genau eine Zeile)
// ---------------------------------------------------------------------------

interface InstallationRow {
  installation_id: string;
  created_at: string;
  licensed_at: string | null;
  last_seen_date: string | null;
}

function getInstallation(): InstallationRow {
  const row = getDb()
    .prepare('SELECT installation_id, created_at, licensed_at, last_seen_date FROM installation WHERE id = 1')
    .get() as InstallationRow | undefined;
  if (!row) throw new Error('Tabelle installation ist leer — Migration 004_license fehlt.');
  return row;
}

/** Aktive Personalprofile — dieselbe Zahl wie die Kopfzahl auf dem Dashboard. */
function countActiveEmployees(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM employees WHERE status = 'aktiv'`).get() as {
    n: number;
  };
  return row.n;
}

// ---------------------------------------------------------------------------
// Datei laden (mit Cache über mtime/Größe)
// ---------------------------------------------------------------------------

interface LoadedLicense {
  exists: boolean;
  payload: LicensePayload | null;
  /** Deutsch, für die Administration; null wenn payload gesetzt oder keine Datei. */
  invalidReason: string | null;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

let fileCache: { stamp: FileStamp | null; loaded: LoadedLicense } | null = null;

/**
 * Journal fuer Ereignisse ohne Request (Dateiwechsel im Datenverzeichnis).
 * server.ts setzt ihn direkt nach der Fastify-Erzeugung; vorher (Werkzeuge,
 * Tests ohne Server) bleibt es still.
 */
let licenseLogger: FastifyBaseLogger | null = null;
export function setLicenseLogger(log: FastifyBaseLogger | null): void {
  licenseLogger = log;
}

/**
 * Zuletzt gesehene Lizenz-ID der Datei (null = keine brauchbare Datei,
 * undefined = noch nie geladen). Aendert sie sich ausserhalb von
 * installLicense, hat jemand die Datei im Datenverzeichnis getauscht oder
 * entfernt; das landet als Zeile mit user_id NULL im Audit-Log, weil audit()
 * ein Request-Objekt verlangt.
 */
let observedLicenseId: string | null | undefined = undefined;
/** Von installLicense gesetzt, damit der eigene Tausch nicht als Fremdwechsel zaehlt. */
let expectedLicenseId: string | null | undefined = undefined;

function noteFileChange(previous: string | null, next: string | null, loaded: LoadedLicense): void {
  const details = {
    previous_license_id: previous,
    license_id: next,
    customer_id: loaded.payload?.customer_id ?? null,
    valid_until: loaded.payload?.valid_until ?? null,
    invalid_reason: loaded.invalidReason,
    exists: loaded.exists,
  };
  try {
    getDb()
      .prepare('INSERT INTO audit_log (user_id, action, entity, details) VALUES (NULL, ?, ?, ?)')
      .run('license.file_changed', 'license', JSON.stringify(details));
  } catch (err) {
    licenseLogger?.warn(`Audit-Zeile zum Lizenzdateiwechsel konnte nicht geschrieben werden: ${(err as Error).message}`);
  }
  const what = !loaded.exists
    ? 'Die Lizenzdatei wurde aus dem Datenverzeichnis entfernt.'
    : loaded.payload
      ? `Die Lizenzdatei im Datenverzeichnis wurde getauscht (jetzt Lizenz ${next}, gültig bis ${formatDate(loaded.payload.valid_until)}).`
      : `Die Lizenzdatei im Datenverzeichnis wurde getauscht und ist unbrauchbar: ${loaded.invalidReason}`;
  licenseLogger?.warn(`${what} Der Wechsel kam nicht über Einstellungen → Lizenz.`);
}

function statLicenseFile(): FileStamp | null {
  try {
    const st = fs.statSync(config.licensePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function loadLicenseFile(): LoadedLicense {
  const stamp = statLicenseFile();
  if (fileCache && sameStamp(fileCache.stamp, stamp)) return fileCache.loaded;

  let loaded: LoadedLicense;
  if (stamp === null) {
    loaded = { exists: false, payload: null, invalidReason: null };
  } else {
    try {
      const text = fs.readFileSync(config.licensePath, 'utf8');
      loaded = { exists: true, payload: verifyLicenseText(text, trustedKeys()), invalidReason: null };
    } catch (err) {
      const reason =
        err instanceof LicenseFormatError
          ? err.message
          : 'Die Lizenzdatei konnte nicht gelesen werden.';
      loaded = { exists: true, payload: null, invalidReason: reason };
    }
  }
  fileCache = { stamp, loaded };

  const licenseId = loaded.payload?.license_id ?? null;
  if (observedLicenseId !== undefined && observedLicenseId !== licenseId && expectedLicenseId !== licenseId) {
    noteFileChange(observedLicenseId, licenseId, loaded);
  }
  observedLicenseId = licenseId;
  expectedLicenseId = undefined;
  return loaded;
}

/**
 * Nächster Zugriff liest Datei und Zustand neu. Intern nach dem Einspielen;
 * exportiert für Tests, die die Datei direkt ins Datenverzeichnis schreiben
 * (Grenzfälle wie „Datei gelöscht“ oder „alter Stand zurückgespielt“, die
 * über den Upload absichtlich nicht erreichbar sind).
 */
export function invalidateLicenseCaches(): void {
  fileCache = null;
  coreCache = null;
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

/**
 * Cache je Kalendertag und Dateistand. Die Datei wird höchstens alle fünf
 * Sekunden neu gestat()et — ein Request-Sturm soll nicht in Dateisystemaufrufe
 * münden, ein Einspielen (invalidateLicenseCaches) wirkt sofort.
 */
let coreCache: { day: string; checkedAt: number; core: LicenseCore } | null = null;
const STAT_INTERVAL_MS = 5_000;

function licenseCore(): LicenseCore {
  const today = todayIso();
  const now = Date.now();
  if (coreCache && coreCache.day === today && now - coreCache.checkedAt < STAT_INTERVAL_MS) {
    return coreCache.core;
  }
  // Dateistand prüfen; unverändert ⇒ nur den Zeitstempel auffrischen.
  const previousLoaded = fileCache?.loaded;
  const loaded = loadLicenseFile();
  if (coreCache && coreCache.day === today && previousLoaded === loaded) {
    coreCache.checkedAt = now;
    return coreCache.core;
  }
  const core = computeCore(today, loaded);
  coreCache = { day: today, checkedAt: now, core };
  return core;
}

function computeCore(today: string, loaded: LoadedLicense): LicenseCore {
  const inst = getInstallation();
  const variant = config.variant;
  if (!config.licenseEnforced) {
    return deriveLicenseState({ today, variant, enforced: false, installation: inst, loaded, clockWarning: false }).core;
  }
  const clockWarning = advanceLastSeen(inst, today);
  const derived = deriveLicenseState({ today, variant, enforced: true, installation: inst, loaded, clockWarning });
  if (derived.markLicensed) {
    // Erste gueltige Lizenz dieser Datenbank: Testphase damit endgueltig vorbei.
    getDb().prepare(`UPDATE installation SET licensed_at = datetime('now') WHERE id = 1`).run();
  }
  return derived.core;
}

/**
 * Stolperdraht: merkt sich den größten je gesehenen Kalendertag (nur vorwärts)
 * und meldet, wenn die Uhr dahinter zurückgefallen ist. Ein Tag Toleranz, weil
 * ein einmal in die Zukunft gesprungener Wert sonst tagelang warnen würde.
 */
function advanceLastSeen(inst: InstallationRow, today: string): boolean {
  if (inst.last_seen_date === null || today > inst.last_seen_date) {
    getDb().prepare('UPDATE installation SET last_seen_date = ? WHERE id = 1').run(today);
    return false;
  }
  return daysBetweenIso(today, inst.last_seen_date) > 1;
}

// ---------------------------------------------------------------------------
// Öffentliche Sicht
// ---------------------------------------------------------------------------

/** Vollständiger Zustand für die Administration (inkl. Platzzählung). */
export function licenseStatus(): LicenseStatus {
  const core = licenseCore();
  const p = core.payload;
  return {
    state: core.state,
    read_only: core.read_only,
    warning: core.warning,
    days_left: core.days_left,
    valid_until: core.valid_until,
    grace_until: core.grace_until,
    perpetual: core.perpetual,
    issued_at: core.issued_at,
    edition: p?.edition ?? null,
    country: p?.country ?? null,
    features: effectiveFeatureList(core),
    terms: p?.terms ?? null,
    headline: p?.headline ?? null,
    customer: p?.customer ?? null,
    license_id: p?.license_id ?? null,
    kind: p?.kind ?? null,
    max_users: p?.max_users ?? null,
    seats_used: countActiveEmployees(),
    installation_id: core.installation_id,
    notice: p?.notice ?? null,
    invalid_reason: core.invalid_reason,
    clock_warning: core.clock_warning,
  };
}

/** Für Portal-Konten: nur, ob Änderungen gerade möglich sind. */
export function licenseStatusPublic(): LicenseStatusPublic {
  const core = licenseCore();
  return { read_only: core.read_only, features: effectiveFeatureList(core) };
}

/**
 * Freigeschaltete Funktionen: 'all' in Entwicklung, Testphase ohne Datei
 * und bei einer Datei ohne `features` (v1 oder v2 ohne Feld); sonst die
 * Menge der Datei, auch im Nur-Lese-Betrieb. Das Feature-Gate (Phase 3)
 * fragt hier nach.
 */
export function effectiveFeatures(): ReadonlySet<string> | 'all' {
  const core = licenseCore();
  if (core.state === 'entwicklung' || !core.payload || core.payload.features === undefined) return 'all';
  return new Set(core.payload.features);
}

function effectiveFeatureList(core: LicenseCore): string[] | null {
  if (core.state === 'entwicklung' || !core.payload || core.payload.features === undefined) return null;
  return [...core.payload.features];
}

/** Was Login und /api/auth/me mitliefern — je nach Systemzugang. */
export function licenseForRole(role: string): LicenseStatus | LicenseStatusPublic {
  return role === 'admin' ? licenseStatus() : licenseStatusPublic();
}

/**
 * Wert des Antwort-Headers — nur für angemeldete Konten gesetzt (server.ts).
 * Die Administration bekommt den Zustand; Portal-Konten erfahren nur, ob
 * Änderungen möglich sind. Öffentliche Antworten (Health, Login-Fehler,
 * signierte Downloads) tragen keinen Header: Ob der Arbeitgeber in der
 * Testphase, in der Kulanz oder abgelaufen ist, geht Unangemeldete nichts an.
 */
export function licenseHeaderValueFor(role: string): LicenseState {
  const core = licenseCore();
  if (role === 'admin') return core.state;
  return core.read_only ? 'expired' : 'valid';
}

// ---------------------------------------------------------------------------
// Durchsetzung
// ---------------------------------------------------------------------------

/**
 * Schreibende Routen, die im Nur-Lese-Betrieb offen bleiben. Alle drei
 * Signierrouten geben nur eine kurzlebige Download-URL aus (POST, damit der
 * Link nicht im Query-String landet); Passwortwechsel und Lizenz-Upload sind
 * die Wege zurück in den Normalbetrieb. Öffentliche Routen (Login, Health,
 * signierter Download) erreichen das Gate gar nicht erst.
 *
 * Route-Muster wie in req.routeOptions.url (mit `:id`), nicht die konkrete URL.
 */
export const LICENSE_OPEN_ROUTES: ReadonlySet<string> = new Set([
  '/api/auth/me',
  '/api/auth/password',
  // Sitzungsverlängerung (core/auth.ts): Ohne sie meldete der Nur-Lese-Betrieb
  // jede Sitzung nach Ablauf ihres Tokens ab, obwohl Lesen erlaubt bleibt.
  '/api/auth/refresh',
  '/api/license',
  '/api/files/:id/sign',
  '/api/compensation/certificates/:id/sign',
  '/api/me/documents/:id/download',
  '/api/me/announcements/:id/attachments/:fileId/sign',
  // Konto-Widerruf bleibt möglich: Der Lesezugriff steht im Nur-Lese-Betrieb
  // ALLEN bestehenden Konten offen — also muss ein ausgeschiedenes oder
  // kompromittiertes Konto weiterhin gelöscht, zurückgesetzt (entwertet alle
  // Sitzungen) oder seiner Rolle entzogen werden können. Das Muster deckt
  // DELETE und PATCH; Anlegen (POST /api/admin/users) bleibt gesperrt. Die
  // Rechteprüfung (benutzer: bearbeiten) greift danach unverändert.
  '/api/admin/users/:id',
  '/api/admin/users/:id/reset-password',
]);

/** Sicht des gemeinsamen Textbausteins auf den Kern (ohne Platzzaehlung). */
function describable(core: LicenseCore): LicenseDescribable {
  return {
    state: core.state,
    warning: core.warning,
    days_left: core.days_left,
    valid_until: core.valid_until,
    grace_until: core.grace_until,
    perpetual: core.perpetual,
    license_id: core.payload?.license_id ?? null,
    kind: core.payload?.kind ?? null,
    invalid_reason: core.invalid_reason,
  };
}

/** Meldung fuer abgewiesene Schreibzugriffe: Ursache, Nur-Lese-Erklaerung, Handlung (aus @ohrganize/shared). */
function readOnlyMessage(core: LicenseCore): string {
  return licenseMessage(describable(core));
}

/**
 * Gate für den globalen Hook: lässt Lesezugriffe und die offenen Routen durch,
 * lehnt im Nur-Lese-Betrieb alles andere mit 403 LICENSE_EXPIRED ab.
 */
export function assertLicenseAllows(method: string, route: string, role: string): void {
  if (method === 'GET' || method === 'HEAD') return;
  if (LICENSE_OPEN_ROUTES.has(route)) return;
  const core = licenseCore();
  if (!core.read_only) return;
  throw new AppError(
    403,
    LICENSE_ERROR_CODES.EXPIRED,
    role === 'admin' ? readOnlyMessage(core) : PORTAL_READ_ONLY_TEXT,
  );
}

/**
 * Platz-Obergrenze: Wird an genau den Stellen aufgerufen, die aktive
 * Personalprofile anlegen oder reaktivieren (employeeRoutes: POST, PATCH,
 * bulk; recruiting: hire). `additional` = wie viele Profile der Aufruf aktiv
 * machen würde. Ohne max_users in der Lizenz (oder ohne Lizenz) gibt es keine
 * Grenze — die Testphase ist bewusst unbegrenzt.
 */
export function assertSeatsAvailable(additional: number): void {
  if (additional <= 0) return;
  const core = licenseCore();
  const max = core.payload?.max_users ?? null;
  if (max === null) return;
  const used = countActiveEmployees();
  if (used + additional > max) {
    throw new AppError(
      409,
      LICENSE_ERROR_CODES.SEATS_EXCEEDED,
      `Die Lizenz umfasst ${max} aktive Personalprofile; derzeit sind ${used} aktiv` +
        (additional > 1 ? `, ${additional} weitere passen nicht mehr hinein.` : '.') +
        ' Für weitere Profile ist eine Erweiterung der Lizenz nötig (Einstellungen → Lizenz).',
    );
  }
}

// ---------------------------------------------------------------------------
// Einspielen
// ---------------------------------------------------------------------------

/**
 * Prüft eine neue Lizenzdatei vollständig, BEVOR sie geschrieben wird, und
 * ersetzt die alte atomar. Regeln: Signatur und Format; Bindung an diese
 * Installation; nicht bereits über die Kulanz hinaus abgelaufen; und monoton —
 * eine Datei mit früherem Ablauf als die eingespielte wird abgelehnt, damit
 * ein alter Mail-Anhang eine bezahlte Laufzeit nie verkürzen kann.
 */
export function installLicense(req: FastifyRequest, text: string): LicenseStatus {
  let payload: LicensePayload;
  try {
    payload = verifyLicenseText(text, trustedKeys());
  } catch (err) {
    if (err instanceof LicenseFormatError) {
      throw new AppError(400, LICENSE_ERROR_CODES.INVALID, err.message);
    }
    throw err;
  }

  const inst = getInstallation();
  const mismatch = variantMismatchReason(payload, config.variant);
  if (mismatch) throw new AppError(400, LICENSE_ERROR_CODES.INVALID, mismatch);
  if (payload.installation_id !== null && payload.installation_id !== inst.installation_id) {
    throw new AppError(
      400,
      LICENSE_ERROR_CODES.INVALID,
      `Diese Lizenz ist für eine andere Installation ausgestellt (${payload.installation_id}). ` +
        `Die Installations-ID dieses Systems lautet ${inst.installation_id} — bitte dem Anbieter mitteilen.`,
    );
  }

  const today = todayIso();
  if (addDaysIso(payload.valid_until, payload.grace_days) < today) {
    throw new AppError(
      400,
      LICENSE_ERROR_CODES.INVALID,
      `Diese Lizenz ist bereits abgelaufen (gültig bis ${formatDate(payload.valid_until)}).`,
    );
  }

  const current = licenseCore().payload;
  if (current && payload.issued_at < current.issued_at) {
    // Auch bei gleichem Ablaufdatum: Eine früher ausgestellte Datei (alter
    // Anhang) darf eine später ausgestellte (z. B. mit geänderter Platzzahl)
    // nicht wieder verdrängen. Gleicher Tag bleibt erlaubt.
    throw new AppError(
      400,
      LICENSE_ERROR_CODES.INVALID,
      `Die eingespielte Lizenz wurde später ausgestellt (${formatDate(current.issued_at)}); ` +
        `eine ältere Datei (ausgestellt ${formatDate(payload.issued_at)}) wird nicht übernommen.`,
    );
  }
  if (current && payload.issued_at === current.issued_at && payload.valid_until < current.valid_until) {
    // Eine SPAETER ausgestellte Datei darf kuerzer laufen (kostenfrei
    // unbefristet wird durch ein Abo abgeloest, ein Vertrag wird gekuerzt);
    // der Schutz gegen alte Anhaenge liegt im Ausstelltag. Nur am selben Tag
    // gilt weiter "nicht kuerzer", weil dann nichts die Reihenfolge belegt.
    throw new AppError(
      400,
      LICENSE_ERROR_CODES.INVALID,
      `Die eingespielte Lizenz läuft bereits länger (bis ${formatDate(current.valid_until)}) und wurde am selben Tag ausgestellt; ` +
        `eine kürzere (bis ${formatDate(payload.valid_until)}) wird nicht übernommen.`,
    );
  }

  // Atomar: erst daneben schreiben, dann umbenennen — ein Absturz mittendrin
  // hinterlässt die alte Datei vollständig, nie eine halbe neue.
  const tmp = path.join(config.dataDir, `.${path.basename(config.licensePath)}.tmp`);
  fs.writeFileSync(tmp, `${text.replace(/\s+/g, '')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, config.licensePath);
  expectedLicenseId = payload.license_id;
  invalidateLicenseCaches();

  auditStandalone(req, 'license.install', 'license', undefined, {
    license_id: payload.license_id,
    previous_license_id: current?.license_id ?? null,
    customer_id: payload.customer_id,
    kind: payload.kind,
    v: payload.v,
    valid_until: payload.valid_until,
    max_users: payload.max_users,
    edition: payload.edition ?? null,
    country: payload.country ?? null,
    features: payload.features ?? null,
    billing: payload.terms?.billing ?? null,
  });
  return licenseStatus();
}

// ---------------------------------------------------------------------------
// Bericht und Start
// ---------------------------------------------------------------------------

/** Zahlen und Kennungen für den Anbieter — der Kunde lädt ihn selbst herunter. */
export function licenseReport(): LicenseReport {
  const status = licenseStatus();
  const p = licenseCore().payload;
  return {
    generated_at: new Date().toISOString(),
    installation_id: status.installation_id,
    license_id: status.license_id,
    customer_id: p?.customer_id ?? null,
    state: status.state,
    valid_until: status.valid_until,
    seats_used: status.seats_used,
    max_users: status.max_users,
    server_version: APP_VERSION,
    license_format: LICENSE_FORMAT_VERSION,
    edition: status.edition,
    country: status.country,
  };
}

/**
 * Eine Zeile ins Journal beim Start, sobald etwas Aufmerksamkeit verdient.
 * Text aus describeLicense, damit Journal, Banner und Fehlermeldung dieselbe
 * Diagnose stellen. Ein Startlog ohne Warnung: gueltig ohne Warnfrist.
 */
export function logLicenseAtStartup(log: FastifyBaseLogger): void {
  const s = licenseStatus();
  if (s.state === 'entwicklung') return;
  const d = describeLicense(s);
  const tail = s.invalid_reason && s.state !== 'expired' ? ` Lizenzdatei unbrauchbar: ${s.invalid_reason}` : '';
  switch (s.state) {
    case 'valid':
      if (s.warning) log.warn(`${d.headline} ${d.detail}`.trim());
      else if (s.invalid_reason) log.warn(tail.trim());
      break;
    case 'trial':
    case 'grace':
      log.warn(`${d.headline} ${d.detail}${tail}`);
      break;
    case 'expired':
      log.warn(`NUR-LESE-BETRIEB: ${readOnlyMessage(licenseCore())}`);
      break;
  }
  if (s.clock_warning) log.warn(LICENSE_CLOCK_WARNING_TEXT);
}
