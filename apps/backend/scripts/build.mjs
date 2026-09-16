#!/usr/bin/env node
/**
 * Backend-Bundles je Variante: server.cjs (Embedding in der Desktop-App),
 * cli.cjs (Serverbetrieb), backup.cjs (Sicherung) und die Betreiberwerkzeuge
 * unter src/scripts/ (sobald vorhanden).
 *
 * Die Variante kommt aus OHRGANIZE_VARIANT (Vorgabe: default aus dem
 * Register) und wird ueber die esbuild-Aliasse @variant / @variant-manifest
 * auf src/variants/<id>.ts bzw. <id>.manifest.ts gezeigt. Nur die dort
 * importierten Module landen im Bundle.
 *
 * Optionen wie bisher: minifiziert, keep-names (Fehlermeldungen nennen
 * Funktionen), externe Sourcemaps (bleiben beim Release aussen vor),
 * better-sqlite3 extern (native Bibliothek), und der Test-Override des
 * Pruefschluessels wird per define herauskompiliert.
 *
 * Aufruf: node scripts/build.mjs   (npm run build -w apps/backend)
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');

const registry = JSON.parse(fs.readFileSync(path.join(repo, 'packages/shared/src/variants/registry.json'), 'utf8'));
const variant = (process.env.OHRGANIZE_VARIANT ?? '').trim() || registry.default;
if (!registry.variants.some((v) => v.id === variant)) {
  console.error(`Unbekannte Variante "${variant}". Bekannt: ${registry.variants.map((v) => v.id).join(', ')}.`);
  process.exit(1);
}
const wiring = path.join(root, `src/variants/${variant}.ts`);
const manifest = path.join(root, `src/variants/${variant}.manifest.ts`);
for (const f of [wiring, manifest]) {
  if (!fs.existsSync(f)) {
    console.error(`Verdrahtungsdatei fehlt: ${f}. Bitte "npm run variants:gen" ausfuehren.`);
    process.exit(1);
  }
}

const ENTRIES = [
  ['src/server.ts', 'dist/server.cjs'],
  ['src/index.ts', 'dist/cli.cjs'],
  ['src/scripts/backup.ts', 'dist/backup.cjs'],
  ['src/scripts/status.ts', 'dist/status.cjs'],
  ['src/scripts/admin-reset.ts', 'dist/admin-reset.cjs'],
  ['src/scripts/migrate-check.ts', 'dist/migrate-check.cjs'],
];

for (const [entry, out] of ENTRIES) {
  const entryPath = path.join(root, entry);
  if (!fs.existsSync(entryPath)) continue;
  await build({
    entryPoints: [entryPath],
    outfile: path.join(root, out),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    minify: true,
    keepNames: true,
    legalComments: 'none',
    sourcemap: 'external',
    logLevel: 'warning',
    define: { 'process.env.OHRGANIZE_LICENSE_PUBLIC_KEY': 'undefined' },
    alias: { '@variant': wiring, '@variant-manifest': manifest },
  });
}

fs.writeFileSync(path.join(root, 'dist/VARIANTE.txt'), `${variant}\n`);
console.log(`Backend-Bundles gebaut für Variante ${variant}.`);
