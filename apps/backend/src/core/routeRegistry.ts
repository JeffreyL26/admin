import type { FastifyInstance } from 'fastify';

/**
 * Kundenausgabe dronivo: Methode und Pfad jeder registrierten Route, damit
 * src/test/smoke.ts die schreibenden Portalrouten gegen PORTAL_OPEN_WRITES und
 * PORTAL_ABSENCE_WRITES einordnen kann (packages/shared/src/dronivo.ts), auch
 * Routen aus Plugins mit Praefix, die scripts/check-dronivo.mjs im Quelltext
 * nicht sieht.
 *
 * Nur im Quelltextbetrieb (Tests, Entwicklung). Die gebuendelten Fassungen
 * (apps/backend/scripts/build.mjs setzt OHRGANIZE_BUNDLED per define) halten
 * keine Liste; esbuild entfernt den Rest als toten Code.
 */
export interface RegisteredRoute {
  method: string;
  url: string;
}

const ROUTES = new WeakMap<FastifyInstance, RegisteredRoute[]>();

/** Vor der ersten Route aufrufen, sonst fehlen die frueheren. */
export function trackRoutes(app: FastifyInstance): void {
  if (process.env.OHRGANIZE_BUNDLED === '1') return;
  const routes: RegisteredRoute[] = [];
  ROUTES.set(app, routes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });
}

/** Die erfasste Liste; null, wenn die Instanz nicht erfasst wurde (gebuendelt). */
export function registeredRoutes(app: FastifyInstance): readonly RegisteredRoute[] | null {
  return ROUTES.get(app) ?? null;
}
