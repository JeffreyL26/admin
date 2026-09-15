/**
 * Gemeinsame Aliasaufloesung fuer die Vite-Builds (Renderer, Portal) und den
 * Desktop-Build: Welche Variante wird gebaut, und auf welche Datei zeigen
 * @variant und @variant-manifest?
 *
 * Variante: OHRGANIZE_VARIANT, sonst `default` aus dem Register. Unbekannte
 * Kennungen brechen ab, fehlende Verdrahtungsdateien ebenfalls (dann fehlt
 * `npm run variants:gen`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readRegistry() {
  return JSON.parse(fs.readFileSync(path.join(repo, 'packages/shared/src/variants/registry.json'), 'utf8'));
}

/** Kennung der zu bauenden Variante (env oder Vorgabe), geprueft gegen das Register. */
export function resolveVariantId(env = process.env) {
  const registry = readRegistry();
  const id = (env.OHRGANIZE_VARIANT ?? '').trim() || registry.default;
  if (!registry.variants.some((v) => v.id === id)) {
    throw new Error(`Unbekannte Variante "${id}". Bekannt: ${registry.variants.map((v) => v.id).join(', ')}.`);
  }
  return id;
}

export function variantById(id) {
  const v = readRegistry().variants.find((x) => x.id === id);
  if (!v) throw new Error(`Unbekannte Variante "${id}".`);
  return v;
}

/**
 * Aliasse fuer eine App: appDir ist das Verzeichnis mit src/variants/.
 * wiringExt: '.ts' (Backend, Renderer) oder '.tsx' (Portal).
 */
export function variantAliases(appDir, { wiringExt = '.ts', env = process.env } = {}) {
  const id = resolveVariantId(env);
  const wiring = path.join(appDir, 'src/variants', `${id}${wiringExt}`);
  const manifest = path.join(appDir, 'src/variants', `${id}.manifest.ts`);
  for (const f of [wiring, manifest]) {
    if (!fs.existsSync(f)) {
      throw new Error(`Verdrahtungsdatei fehlt: ${f}. Bitte "npm run variants:gen" ausfuehren.`);
    }
  }
  return { '@variant': wiring, '@variant-manifest': manifest };
}
