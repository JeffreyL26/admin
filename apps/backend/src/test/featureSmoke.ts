/**
 * Smoke-Test des Feature-Gates (core/featureGate.ts, shared/features.ts):
 * reine Funktionen (Praefixtreffer, fail open, 'all'), dann gegen eine
 * Wegwerf-Datenbank mit Test-Registry: v1-Lizenz erlaubt alles, v2 ohne
 * Feature liefert 403 LICENSE_FEATURE_MISSING, v2 mit Feature 200,
 * Testphase ohne Datei 200. Zuletzt die Registry-Regeln: Praefixe beginnen
 * mit /api/ und liegen nicht in den offenen Lizenzrouten.
 *
 * Aufruf: tsx src/test/featureSmoke.ts (Teil von npm test).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-feature-'));
process.env.OHRGANIZE_DATA_DIR = dataDir;
process.env.OHRGANIZE_LOG_LEVEL = 'silent';

const testKeys = crypto.generateKeyPairSync('ed25519');
{
  const der = testKeys.publicKey.export({ format: 'der', type: 'spki' });
  process.env.OHRGANIZE_LICENSE_PUBLIC_KEY = der.subarray(der.length - 32).toString('base64');
}

const { FEATURES, featureForRoute, hasFeature, pathAllowedByFeatures, widgetAllowedByFeatures } = await import('@ohrganize/shared');
const { assertFeatureAllowed, overrideFeatureRegistryForTests } = await import('../core/featureGate.js');
const { buildServer } = await import('../server.js');
const { closeDb } = await import('../db/db.js');
const { firstAdminLogin } = await import('./adminSession.js');
const { signLicensePayload } = await import('../core/licenseCodec.js');
const { addDaysIso, todayIso } = await import('../core/dates.js');
type LicensePayload = import('@ohrganize/shared').LicensePayload;
type FeatureDef = import('@ohrganize/shared').FeatureDef;

let failures = 0;
function check(label: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
}

// ------------------------------------------------------ reine Funktionen --
const registry: FeatureDef[] = [
  { key: 'test.export', label: 'Personalexport', routes: ['/api/employees/export.csv'], navPaths: ['/personal/export'], widgets: ['headcount'], portal: false },
  { key: 'test.recruiting', label: 'Recruiting', routes: ['/api/recruiting'], portal: false },
];
check('Registry ist zu Beginn leer', FEATURES.length === 0, FEATURES);
check('featureForRoute: exakter Treffer', featureForRoute('/api/employees/export.csv', registry)?.key === 'test.export');
check('featureForRoute: Praefix mit Unterpfad', featureForRoute('/api/recruiting/jobs/:id', registry)?.key === 'test.recruiting');
check('featureForRoute: kein Treffer bei aehnlichem Praefix', featureForRoute('/api/recruitingx', registry) === null);
check('featureForRoute: unbekannte Route ist frei', featureForRoute('/api/employees', registry) === null);
check('hasFeature: null = alles an', hasFeature(null, 'test.export') && hasFeature(undefined, 'x'));
check('hasFeature: Menge entscheidet', hasFeature(['test.export'], 'test.export') && !hasFeature([], 'test.export'));
check('pathAllowedByFeatures: Navigation', pathAllowedByFeatures('/personal/export/csv', null, registry) && !pathAllowedByFeatures('/personal/export', [], registry));
check('widgetAllowedByFeatures', widgetAllowedByFeatures('headcount', null, registry) && !widgetAllowedByFeatures('headcount', ['other.key'], registry) && widgetAllowedByFeatures('birthdays', [], registry));

function gateThrows(route: string, features: ReadonlySet<string> | 'all'): string | null {
  try {
    assertFeatureAllowed('GET', route, features, registry);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'ERR';
  }
}
check("Gate: 'all' laesst alles durch", gateThrows('/api/recruiting', 'all') === null);
check('Gate: fail open fuer unbekannte Route', gateThrows('/api/employees', new Set()) === null);
check('Gate: fehlendes Feature -> LICENSE_FEATURE_MISSING', gateThrows('/api/recruiting/jobs', new Set()) === 'LICENSE_FEATURE_MISSING');
check('Gate: vorhandenes Feature -> frei', gateThrows('/api/recruiting/jobs', new Set(['test.recruiting'])) === null);
try {
  assertFeatureAllowed('GET', '/api/recruiting', new Set(), registry);
} catch (err) {
  const msg = (err as Error).message;
  const dash = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  check('Gate-Meldung nennt die Funktion und hat keinen Gedankenstrich', /Recruiting/.test(msg) && !dash.test(msg), msg);
}

// Registry-Regeln fuer die echte Registry
const { LICENSE_OPEN_ROUTES } = await import('../core/license.js');
for (const def of FEATURES) {
  for (const r of def.routes) {
    check(`Registry ${def.key}: Praefix ${r} beginnt mit /api/`, r.startsWith('/api/'));
    check(`Registry ${def.key}: Praefix ${r} ist keine offene Lizenzroute`, !LICENSE_OPEN_ROUTES.has(r));
    check(`Registry ${def.key}: Praefix ${r} sperrt nicht das ganze Portal`, r !== '/api/me' && r !== '/api/me/');
  }
}

// -------------------------------------------------------- gegen Server --
overrideFeatureRegistryForTests(registry);
const app = await buildServer();
const { auth } = await firstAdminLogin(app, check);
const today = todayIso();
const status = await app.inject({ method: 'GET', url: '/api/license', headers: auth });
const installationId = status.json().license.installation_id as string;

function license(over: Partial<LicensePayload>): string {
  const payload: LicensePayload = {
    v: 1, license_id: crypto.randomUUID(), kid: 'test', customer: 'Feature GmbH', customer_id: 'feature',
    installation_id: installationId, kind: 'standard', issued_at: today, valid_from: today,
    valid_until: addDaysIso(today, 100), grace_days: 14, warn_days: 30, max_users: null, notice: null, ...over,
  };
  return signLicensePayload(payload, testKeys.privateKey);
}
const put = (text: string) => app.inject({ method: 'PUT', url: '/api/license', headers: auth, payload: { license: text } });
const exportCsv = () => app.inject({ method: 'GET', url: '/api/employees/export.csv', headers: auth });
const employees = () => app.inject({ method: 'GET', url: '/api/employees', headers: auth });

check('Testphase ohne Datei: Export offen (200)', (await exportCsv()).statusCode === 200);
const v1 = await put(license({}));
check('v1-Lizenz angenommen', v1.statusCode === 200, v1.json());
check('v1: Export offen, features null', (await exportCsv()).statusCode === 200 && v1.json().license.features === null);

const v2None = await put(license({ v: 2, issued_at: addDaysIso(today, 1), edition: 'vollversion', country: 'DE', features: [] }));
check('v2 ohne Feature angenommen', v2None.statusCode === 200 && Array.isArray(v2None.json().license.features), v2None.json());
const blocked = await exportCsv();
check('v2 ohne Feature: Export 403 LICENSE_FEATURE_MISSING', blocked.statusCode === 403 && blocked.json().error?.code === 'LICENSE_FEATURE_MISSING', blocked.json());
check('v2 ohne Feature: Meldung nennt Personalexport', /Personalexport/.test(blocked.json().error?.message ?? ''), blocked.json());
check('v2 ohne Feature: andere Route bleibt offen', (await employees()).statusCode === 200);
const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
check('/api/auth/me liefert die Feature-Liste', Array.isArray(me.json().license?.features) && me.json().license.features.length === 0, me.json().license);

const v2With = await put(license({ v: 2, issued_at: addDaysIso(today, 2), edition: 'vollversion', country: 'DE', features: ['test.export'] }));
check('v2 mit Feature angenommen', v2With.statusCode === 200, v2With.json());
check('v2 mit Feature: Export 200', (await exportCsv()).statusCode === 200);
check('v2 mit Feature: Recruiting weiter gesperrt', (await app.inject({ method: 'GET', url: '/api/recruiting/jobs', headers: auth })).statusCode === 403);
check('v2 mit unbekanntem Schluessel: Server ignoriert ihn', (await put(license({ v: 2, issued_at: addDaysIso(today, 3), edition: 'vollversion', country: 'DE', features: ['test.export', 'kunde.unbekannt.x'] }))).statusCode === 200);

await app.close();
closeDb();
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  // Windows haelt WAL-Dateien gelegentlich noch kurz.
}
if (failures > 0) {
  console.error(`${failures} Feature-Checks fehlgeschlagen`);
  process.exit(1);
}
console.log('Alle Feature-Checks bestanden.');
