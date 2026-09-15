/**
 * Feature-Gate: zweite Achse neben der Lizenzlaufzeit. Sitzt im globalen
 * Hook (server.ts) direkt hinter assertLicenseAllows und vor dem
 * Self-Service-Zweig, damit auch /api/me/* erfasst ist. Fail open fuer
 * Routen, die kein Feature nennt; die Bereichspruefung dahinter bleibt fail
 * closed. Was freigeschaltet ist, sagt core/license.ts (effectiveFeatures):
 * 'all' ohne einschraenkende Lizenz, sonst die Menge der Datei.
 */
import { FEATURES, LICENSE_ERROR_CODES, featureForRoute, type FeatureDef } from '@ohrganize/shared';
import { config } from '../config.js';
import { AppError } from './errors.js';

let registry: readonly FeatureDef[] = FEATURES;

/**
 * Testhaken: eigene Registry, nur mit gesetztem Pruefschluessel-Override
 * (dieselbe Testgrenze wie der Lizenzschluessel; in Produktionsbundles ist
 * config.licensePublicKeyOverride per --define tot, der Haken damit wirkungslos).
 */
export function overrideFeatureRegistryForTests(defs: readonly FeatureDef[] | null): void {
  if (!config.licensePublicKeyOverride) {
    throw new Error('overrideFeatureRegistryForTests ist nur mit OHRGANIZE_LICENSE_PUBLIC_KEY (Tests) zulaessig.');
  }
  registry = defs ?? FEATURES;
}

export function activeFeatureRegistry(): readonly FeatureDef[] {
  return registry;
}

/** Wirft 403 LICENSE_FEATURE_MISSING, wenn die Route eine nicht freigeschaltete Funktion verlangt. */
export function assertFeatureAllowed(
  method: string,
  route: string,
  features: ReadonlySet<string> | 'all',
  defs: readonly FeatureDef[] = registry,
): void {
  if (features === 'all') return;
  const def = featureForRoute(route, defs);
  if (!def) return;
  if (features.has(def.key)) return;
  throw new AppError(
    403,
    LICENSE_ERROR_CODES.FEATURE_MISSING,
    `Die Funktion „${def.label}“ ist in Ihrer Lizenz nicht enthalten.`,
  );
}

