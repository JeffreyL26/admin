/**
 * Smoke-Test der Variantenbindung: Health nennt die Variante, eine v2-Lizenz
 * fremder Ausgabe wird beim Upload abgelehnt (400, Meldung nennt beide
 * Ausgaben) und im Datenverzeichnis als invalid_reason gemeldet, ohne die
 * Testphase zu beenden; OHRGANIZE_VARIANT mit fremder Kennung laesst das
 * Backend nicht starten (Kindprozess, weil config.ts beim Import prueft).
 *
 * Aufruf: tsx src/test/variantSmoke.ts (Teil von npm test).
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-variante-'));
process.env.OHRGANIZE_DATA_DIR = dataDir;
process.env.OHRGANIZE_LOG_LEVEL = 'silent';
delete process.env.OHRGANIZE_VARIANT;

const testKeys = crypto.generateKeyPairSync('ed25519');
{
  const der = testKeys.publicKey.export({ format: 'der', type: 'spki' });
  process.env.OHRGANIZE_LICENSE_PUBLIC_KEY = der.subarray(der.length - 32).toString('base64');
}

const { VARIANT } = await import('@variant-manifest');
const { AREA_MODULES, LICENSE_FILE_NAME, MODULE_KEYS, VARIANTS, DEFAULT_VARIANT_ID, areaOpen, parseVariantId, validateRegistry, variantFor } =
  await import('@ohrganize/shared');
const { buildServer } = await import('../server.js');
const { closeDb } = await import('../db/db.js');
const { firstAdminLogin } = await import('./adminSession.js');
const { signLicensePayload } = await import('../core/licenseCodec.js');
const { invalidateLicenseCaches } = await import('../core/license.js');
const { addDaysIso, todayIso } = await import('../core/dates.js');
type LicensePayload = import('@ohrganize/shared').LicensePayload;

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------- Register --
check('Register: Vorgabe-Variante existiert', VARIANTS.some((v) => v.id === DEFAULT_VARIANT_ID), DEFAULT_VARIANT_ID);
check('Dev-Verdrahtung ist die Vorgabe-Variante', VARIANT.id === DEFAULT_VARIANT_ID, VARIANT.id);
check('parseVariantId', JSON.stringify(parseVariantId('de-vollversion')) === JSON.stringify({ country: 'DE', edition: 'vollversion' }) && parseVariantId('xx-1') === null);
check('variantFor kennt die Vorgabe', variantFor(VARIANT.country, VARIANT.edition)?.id === VARIANT.id);
// Negativproben am Register: Die Vorgabe-Variante wurde schon beim Import geprueft,
// deshalb hier abgewandelte Kopien, die validateRegistry ablehnen muss.
const registryWith = (modules: string[]) => ({
  default: 'de-probe',
  variants: [{ id: 'de-probe', country: 'DE', edition: 'probe', label: 'Probe', modules }],
});
const rejects = (modules: string[], pattern: RegExp) => {
  try {
    validateRegistry(registryWith(modules));
    return 'angenommen';
  } catch (e) {
    return pattern.test((e as Error).message) ? true : (e as Error).message;
  }
};
const full = [...MODULE_KEYS] as string[];
for (const required of ['employees', 'admin', 'absences', 'me']) {
  const r = rejects(full.filter((m) => m !== required), /ist Pflicht/);
  check(`Register ohne ${required} wird abgelehnt`, r === true, r);
}
// Die Abhaengigkeitsregel ist heute von der Pflichtpruefung verdeckt; mit eigenen Regeln greift sie.
try {
  validateRegistry(registryWith(full.filter((m) => m !== 'absences')), { required: [], dependencies: { me: ['absences'] } });
  check('Abhaengigkeit me braucht absences greift', false, 'angenommen');
} catch (e) {
  check('Abhaengigkeit me braucht absences greift', /braucht "absences"/.test((e as Error).message), (e as Error).message);
}
// can() der Desktop-App: Ein fehlendes Modul ist auch bei Vollzugriff zu.
const ohneVerguetung = { modules: full.filter((m) => m !== 'compensation') as typeof MODULE_KEYS[number][] };
check('areaOpen: fehlendes Modul ist zu', !areaOpen(ohneVerguetung, 'verguetung', 'bearbeiten'));
check('areaOpen: vorhandenes Modul mit Recht ist offen', areaOpen(ohneVerguetung, 'personal', 'lesen'));
check('areaOpen: Einstellungen ohne Modulbindung', areaOpen(ohneVerguetung, 'einstellungen', 'lesen'));
check('areaOpen: ohne Recht zu', !areaOpen(ohneVerguetung, 'personal', 'kein'));
const leadership = rejects([...full, 'leadership'], /unbekanntes Modul "leadership"/);
check('Register mit eigenem Modul leadership wird abgelehnt', leadership === true, leadership);
check('Register mit allen Modulen wird angenommen', rejects(full, /./) === 'angenommen');
check('Leistung und Fuehrung sind ein Modul', AREA_MODULES.leistung === 'performance' && AREA_MODULES.fuehrung === 'performance', AREA_MODULES);

// -------------------------------------------------------------- Server --
const app = await buildServer();
const health = await app.inject({ method: 'GET', url: '/api/health' });
check('Health nennt die Variante', health.json().variant?.id === VARIANT.id && health.json().variant?.country === VARIANT.country && health.json().variant?.edition === VARIANT.edition, health.json().variant);
check('Health nennt das Label', health.json().variant?.label === VARIANT.label);

const { auth } = await firstAdminLogin(app, check);
const status = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
const installationId = status.json().license.installation_id as string;
const today = todayIso();

function license(over: Partial<LicensePayload>): string {
  const payload: LicensePayload = {
    v: 2, license_id: crypto.randomUUID(), kid: 'test', customer: 'Variante GmbH', customer_id: 'variante',
    installation_id: installationId, kind: 'standard', issued_at: today, valid_from: today,
    valid_until: addDaysIso(today, 100), grace_days: 14, warn_days: 30, max_users: null, notice: null,
    edition: VARIANT.edition, country: VARIANT.country, ...over,
  };
  return signLicensePayload(payload, testKeys.privateKey);
}
const put = (text: string) => app.inject({ method: 'PUT', url: '/api/license', headers: auth, payload: { license: text } });

const wrongEdition = await put(license({ edition: 'fremd' }));
check('Upload fremder Edition → 400 LICENSE_INVALID', wrongEdition.statusCode === 400 && wrongEdition.json().error?.code === 'LICENSE_INVALID', wrongEdition.json());
check('Meldung nennt beide Ausgaben', new RegExp(`fremd.*${VARIANT.label}`).test(wrongEdition.json().error?.message ?? ''), wrongEdition.json().error?.message);
const wrongCountry = await put(license({ country: VARIANT.country === 'DE' ? 'AT' : 'DE' }));
check('Upload fremden Landes → 400', wrongCountry.statusCode === 400 && /Ausgabe/.test(wrongCountry.json().error?.message ?? ''), wrongCountry.json());
const stillTrial = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Testphase läuft weiter', stillTrial.json().license?.state === 'trial', stillTrial.json().license);

// Fremde Datei direkt im Datenverzeichnis: Grund sichtbar, Testphase bleibt.
fs.writeFileSync(path.join(dataDir, LICENSE_FILE_NAME), `${license({ edition: 'fremd' })}\n`);
invalidateLicenseCaches();
const foreignFile = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
check('Fremde Datei im Datenverzeichnis: trial mit invalid_reason', foreignFile.json().license?.state === 'trial' && /Ausgabe/.test(foreignFile.json().license?.invalid_reason ?? ''), foreignFile.json().license);
fs.rmSync(path.join(dataDir, LICENSE_FILE_NAME), { force: true });
invalidateLicenseCaches();

const right = await put(license({}));
check('Passende v2-Lizenz wird angenommen', right.statusCode === 200 && right.json().license?.edition === VARIANT.edition, right.json());
const v1 = await put(license({ v: 1, edition: undefined, country: undefined, issued_at: addDaysIso(today, 1) }));
check('v1-Datei ist variantenneutral', v1.statusCode === 200 && v1.json().license?.edition === null, v1.json());

await app.close();
closeDb();

// ------------------------------------------- Startpruefung (Kindprozess) --
const here = path.dirname(fileURLToPath(import.meta.url));
const probe = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then(() => process.exit(0), () => process.exit(3))"], {
  cwd: path.resolve(here, '../..'),
  env: { ...process.env, OHRGANIZE_VARIANT: 'at-fremd', OHRGANIZE_DATA_DIR: dataDir },
  encoding: 'utf8',
});
check('OHRGANIZE_VARIANT mit fremder Kennung verhindert den Start', probe.status === 3, { status: probe.status, stderr: probe.stderr?.slice(0, 300) });
const probeOk = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then(() => process.exit(0), () => process.exit(3))"], {
  cwd: path.resolve(here, '../..'),
  env: { ...process.env, OHRGANIZE_VARIANT: VARIANT.id, OHRGANIZE_DATA_DIR: dataDir },
  encoding: 'utf8',
});
check('OHRGANIZE_VARIANT mit passender Kennung startet', probeOk.status === 0, { status: probeOk.status, stderr: probeOk.stderr?.slice(0, 300) });

try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  // Windows haelt WAL-Dateien gelegentlich noch kurz.
}
if (failures > 0) {
  console.error(`${failures} Varianten-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Varianten-Checks bestanden.');
