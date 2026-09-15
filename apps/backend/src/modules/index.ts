import type { FastifyInstance } from 'fastify';
import { backendModules } from '@variant';

// Jedes Fachmodul lebt vollstaendig in seinem eigenen Ordner. Welche Module
// dieser Build enthaelt, entscheidet die Variante: Der Alias @variant zeigt
// auf src/variants/<id>.ts (erzeugt aus packages/shared/src/variants/
// registry.json), und nur die dort importierten Module landen im Bundle.
// Diese Datei bleibt stabil; neue Module traegt scripts/variant-wiring.mjs ein.
export async function registerModules(app: FastifyInstance): Promise<void> {
  for (const plugin of backendModules) {
    await app.register(plugin);
  }
}
