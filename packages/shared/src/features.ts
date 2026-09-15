/**
 * Feature-Schluessel: Lizenzschalter INNERHALB eines Builds.
 *
 * Zwei Achsen, die nicht verwechselt werden duerfen:
 *   Edition  = Build-Inhalt. Was nicht zur Edition gehoert, ist im Bundle
 *              nicht enthalten (packages/shared/src/variants).
 *   Feature  = Schalter im Build. Der Code ist da, die signierte Lizenz
 *              entscheidet, ob er freigeschaltet ist (LicensePayload.features).
 *
 * Massgeschneiderte Kundenfunktionen werden als Feature im Hauptprodukt
 * gebaut (z. B. `kunde.musterfirma.export`), hier registriert und ueber die
 * Lizenz freigeschaltet. Keine Kunden-Branches.
 *
 * Regeln:
 *   - Eine Lizenz ohne `features` (v1, Testphase, keine Datei, v2 ohne Feld)
 *     schaltet ALLES frei (`hasFeature(null, key)` ist true). Nur eine v2-Datei
 *     mit `features` schraenkt ein.
 *   - Unbekannte Routen sind offen (fail open); die Bereichspruefung dahinter
 *     bleibt fail closed. Ein Feature sperrt genau die Praefixe, die es
 *     nennt, und nur so konkret wie ROUTE_AREAS (ein Praefix wie `/api/me`
 *     wuerde das ganze Portal sperren).
 *   - Unbekannte Schluessel in einer Lizenz werden ignoriert.
 *
 * Die Registry ist zu Beginn leer. Ein Feature anlegen heisst: Eintrag hier,
 * Routen im Backend unter dem genannten Praefix, Seiten in der App unter den
 * genannten Pfaden, ggf. Widget-Schluessel.
 */
import { FEATURE_KEY_PATTERN } from './license.js';

export interface FeatureDef {
  /** Schluessel wie in der Lizenzdatei (FEATURE_KEY_PATTERN). */
  key: string;
  /** Anzeigename, erscheint in der 403-Meldung und auf der Lizenzseite. */
  label: string;
  description?: string;
  /** Routen-Praefixe im Backend (req.routeOptions.url), die ohne das Feature 403 liefern. */
  routes: readonly string[];
  /** Pfade der Desktop-App (layout/nav.ts), die ohne das Feature nicht erscheinen. */
  navPaths?: readonly string[];
  /** Dashboard-Widgets (dashboardConfig.ts WidgetKey), die ohne das Feature nicht angeboten werden. */
  widgets?: readonly string[];
  /** true, wenn auch Portal-Routen (/api/me/...) betroffen sind. */
  portal: boolean;
  /** Pfade des Portals, die ohne das Feature nicht erscheinen. */
  portalPaths?: readonly string[];
}

/** Registry aller Feature-Schluessel des Produkts. Zu Beginn leer; siehe Kopf. */
export const FEATURES: readonly FeatureDef[] = [];

export { FEATURE_KEY_PATTERN };

/** Laengster passender Praefix gewinnt; null, wenn keine Funktion die Route sperrt. */
export function featureForRoute(route: string, registry: readonly FeatureDef[] = FEATURES): FeatureDef | null {
  let best: FeatureDef | null = null;
  let bestLen = -1;
  for (const def of registry) {
    for (const prefix of def.routes) {
      if (route === prefix || route.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
        if (prefix.length > bestLen) {
          best = def;
          bestLen = prefix.length;
        }
      }
    }
  }
  return best;
}

/** Funktion, die einen Client-Pfad sperrt (Navigation, Palette, Routen); null = frei. */
export function featureForPath(
  path: string,
  registry: readonly FeatureDef[] = FEATURES,
  which: 'navPaths' | 'portalPaths' = 'navPaths',
): FeatureDef | null {
  for (const def of registry) {
    for (const p of def[which] ?? []) {
      if (path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`)) return def;
    }
  }
  return null;
}

/** null oder undefined = alles an (keine Einschraenkung durch die Lizenz). */
export function hasFeature(features: readonly string[] | null | undefined, key: string): boolean {
  if (features === null || features === undefined) return true;
  return features.includes(key);
}

/** Ist der Pfad mit dieser Feature-Menge erreichbar? */
export function pathAllowedByFeatures(
  path: string,
  features: readonly string[] | null | undefined,
  registry: readonly FeatureDef[] = FEATURES,
  which: 'navPaths' | 'portalPaths' = 'navPaths',
): boolean {
  const def = featureForPath(path, registry, which);
  return def === null || hasFeature(features, def.key);
}

/** Ist das Widget mit dieser Feature-Menge anbietbar? */
export function widgetAllowedByFeatures(
  widgetKey: string,
  features: readonly string[] | null | undefined,
  registry: readonly FeatureDef[] = FEATURES,
): boolean {
  for (const def of registry) {
    if (def.widgets?.includes(widgetKey) && !hasFeature(features, def.key)) return false;
  }
  return true;
}
