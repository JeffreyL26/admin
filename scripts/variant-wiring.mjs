#!/usr/bin/env node
/**
 * Erzeugt aus dem Variantenregister (packages/shared/src/variants/registry.json)
 * je App die Verdrahtungsdateien einer Variante:
 *
 *   apps/backend/src/variants/<id>.ts            backendModules (Fastify-Plugins)
 *   apps/renderer/src/variants/<id>.ts           variantRoutes (react-router)
 *   apps/web/src/variants/<id>.tsx               portalRoutes (react-router)
 *   dazu je App <id>.manifest.ts (nur VARIANT, ohne Modul-Importe) und
 *   default.ts / default.manifest.ts (Re-Export der Vorgabe-Variante)
 *
 * Die Dateien importieren NUR die Module der Variante statisch; nicht
 * importierter Code landet nicht im Bundle. Der Build zeigt den Alias
 * @variant (und @variant-manifest) per OHRGANIZE_VARIANT auf die passende
 * Datei; Dev-Betrieb und Typecheck nehmen default.ts.
 *
 * Die Dateien sind im Repo versioniert, damit tsc, tsx und Vite ohne
 * Vorlauf funktionieren. Nach jeder Aenderung am Register oder an dieser
 * Tabelle: `npm run variants:gen`, und `npm run variants:check` (Teil der
 * Abnahme) meldet, wenn der Stand im Repo nicht zum Register passt.
 *
 * Aufruf: node scripts/variant-wiring.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const registryPath = path.join(root, 'packages/shared/src/variants/registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

// ---------------------------------------------------------------------------
// Modultabellen je App. Neue Module: hier eintragen UND in MODULE_KEYS
// (packages/shared/src/variants/index.ts) UND in ROUTE_AREAS (permissions.ts).
// ---------------------------------------------------------------------------

/** Fastify-Plugins je Modul, in Registrierungsreihenfolge. */
const BACKEND = [
  { module: 'employees', name: 'employeesModule', from: '../modules/employees/routes.js' },
  { module: 'absences', name: 'absencesModule', from: '../modules/absences/routes.js' },
  { module: 'performance', name: 'performanceModule', from: '../modules/performance/routes.js' },
  { module: 'compensation', name: 'compensationModule', from: '../modules/compensation/routes.js' },
  { module: 'communication', name: 'communicationModule', from: '../modules/communication/routes.js' },
  { module: 'recruiting', name: 'recruitingModule', from: '../modules/recruiting/routes.js' },
  { module: 'admin', name: 'adminModule', from: '../modules/admin/routes.js' },
  { module: 'leadership', name: 'leadershipModule', from: '../modules/leadership/routes.js' },
  { module: 'me', name: 'meModule', from: '../modules/me/routes.js' },
  // Teilrouten des Portals, die an einem optionalen Modul haengen.
  { module: 'me', requires: 'compensation', name: 'meSalaryRoutes', from: '../modules/me/salaryRoutes.js' },
  { module: 'me', requires: 'communication', name: 'meCommunicationRoutes', from: '../modules/me/communicationRoutes.js' },
  { module: 'me', requires: 'performance', name: 'mePerformanceRoutes', from: '../modules/me/performanceRoutes.js' },
];

/** Routenlisten der Desktop-App je Modul, in Router-Reihenfolge. */
const RENDERER = [
  { module: 'employees', name: 'employeesRoutes', from: '../features/employees/routes' },
  { module: 'recruiting', name: 'recruitingRoutes', from: '../features/recruiting/routes' },
  { module: 'absences', name: 'absencesRoutes', from: '../features/absences/routes' },
  { module: 'performance', name: 'performanceRoutes', from: '../features/performance/routes' },
  { module: 'compensation', name: 'compensationRoutes', from: '../features/compensation/routes' },
  { module: 'communication', name: 'communicationRoutes', from: '../features/communication/routes' },
  { module: 'admin', name: 'adminRoutes', from: '../features/admin/routes' },
  { module: 'leadership', name: 'leadershipRoutes', from: '../features/leadership/routes' },
];

/** Seiten des Portals, die an einem optionalen Modul haengen (Basisseiten stehen in App.tsx). */
const WEB = [
  { module: 'absences', path: '/antraege', name: 'RequestsPage', from: '../pages/RequestsPage' },
  { module: 'absences', path: '/antraege/neu', name: 'NewRequestPage', from: '../pages/NewRequestPage' },
  { module: 'absences', path: '/krankmeldung', name: 'SickNotePage', from: '../pages/SickNotePage' },
  { module: 'absences', path: '/kalender', name: 'CalendarPage', from: '../pages/CalendarPage' },
  { module: 'compensation', path: '/gehalt', name: 'SalaryPage', from: '../pages/SalaryPage' },
  { module: 'performance', path: '/entwicklung', name: 'DevelopmentPage', from: '../pages/DevelopmentPage' },
  { module: 'communication', path: '/gespraeche', name: 'MeetingsPage', from: '../pages/MeetingsPage' },
  { module: 'communication', path: '/kollegen', name: 'ColleaguesPage', from: '../pages/ColleaguesPage' },
];

const HEADER = (id) =>
  `// GENERIERT aus packages/shared/src/variants/registry.json durch scripts/variant-wiring.mjs.\n` +
  `// Nicht von Hand aendern. Nach einer Aenderung am Register: npm run variants:gen\n` +
  `// Variante: ${id}\n`;

function manifestFile(id) {
  return (
    HEADER(id) +
    `import { variantById } from '@ohrganize/shared';\n\n` +
    `export const VARIANT_ID = '${id}';\n` +
    `/** Zeichenkette im Bundle fuer scripts/check-variant.mjs. */\n` +
    `export const VARIANT_MARKER = 'OHRGANIZE_VARIANT:${id}';\n` +
    `export const VARIANT = variantById(VARIANT_ID);\n`
  );
}

function backendFile(v) {
  const entries = BACKEND.filter((e) => v.modules.includes(e.module) && (!e.requires || v.modules.includes(e.requires)));
  const imports = entries.map((e) => `import { ${e.name} } from '${e.from}';`).join('\n');
  return (
    HEADER(v.id) +
    `import type { FastifyPluginAsync } from 'fastify';\n` +
    `${imports}\n\n` +
    `export * from './${v.id}.manifest.js';\n\n` +
    `/** Plugins dieser Variante in Registrierungsreihenfolge (modules/index.ts). */\n` +
    `export const backendModules: FastifyPluginAsync[] = [\n` +
    entries.map((e) => `  ${e.name},`).join('\n') +
    `\n];\n`
  );
}

function rendererFile(v) {
  const entries = RENDERER.filter((e) => v.modules.includes(e.module));
  const imports = entries.map((e) => `import { ${e.name} } from '${e.from}';`).join('\n');
  return (
    HEADER(v.id) +
    `import type { RouteObject } from 'react-router-dom';\n` +
    `${imports}\n\n` +
    `export * from './${v.id}.manifest';\n\n` +
    `/** Seiten der Fachmodule dieser Variante (router.tsx haengt Dashboard und Einstellungen an). */\n` +
    `export const variantRoutes: RouteObject[] = [\n` +
    entries.map((e) => `  ...${e.name},`).join('\n') +
    `\n];\n`
  );
}

function webFile(v) {
  const entries = WEB.filter((e) => v.modules.includes(e.module));
  const seen = new Set();
  const imports = entries
    .filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
    .map((e) => `import { ${e.name} } from '${e.from}';`)
    .join('\n');
  return (
    HEADER(v.id) +
    `import React from 'react';\n` +
    `import type { RouteObject } from 'react-router-dom';\n` +
    `${imports}\n\n` +
    `export * from './${v.id}.manifest';\n\n` +
    `/** Seiten optionaler Module dieser Variante (App.tsx haengt die Basisseiten an). */\n` +
    `export const portalRoutes: RouteObject[] = [\n` +
    entries.map((e) => `  { path: '${e.path}', element: <${e.name} /> },`).join('\n') +
    `\n];\n`
  );
}

function defaultFile(target, ext) {
  return (
    `// GENERIERT durch scripts/variant-wiring.mjs: Vorgabe-Variante fuer Dev-Betrieb und Typecheck\n` +
    `// (tsconfig paths "@variant"). Der Build ersetzt den Alias per OHRGANIZE_VARIANT.\n` +
    `export * from './${target}${ext}';\n`
  );
}

// ---------------------------------------------------------------------------
const files = new Map();
for (const v of registry.variants) {
  files.set(`apps/backend/src/variants/${v.id}.manifest.ts`, manifestFile(v.id));
  files.set(`apps/backend/src/variants/${v.id}.ts`, backendFile(v));
  files.set(`apps/renderer/src/variants/${v.id}.manifest.ts`, manifestFile(v.id));
  files.set(`apps/renderer/src/variants/${v.id}.ts`, rendererFile(v));
  files.set(`apps/web/src/variants/${v.id}.manifest.ts`, manifestFile(v.id));
  files.set(`apps/web/src/variants/${v.id}.tsx`, webFile(v));
}
const d = registry.default;
files.set('apps/backend/src/variants/default.ts', defaultFile(d, '.js'));
files.set('apps/backend/src/variants/default.manifest.ts', defaultFile(`${d}.manifest`, '.js'));
files.set('apps/renderer/src/variants/default.ts', defaultFile(d, ''));
files.set('apps/renderer/src/variants/default.manifest.ts', defaultFile(`${d}.manifest`, ''));
files.set('apps/web/src/variants/default.tsx', defaultFile(d, ''));
files.set('apps/web/src/variants/default.manifest.ts', defaultFile(`${d}.manifest`, ''));

const knownIds = new Set(registry.variants.map((v) => v.id));
let problems = 0;
let written = 0;

for (const [rel, content] of files) {
  const abs = path.join(root, rel);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current === content) continue;
  if (checkOnly) {
    console.log(`${current === null ? 'FEHLT' : 'ABWEICHEND'}: ${rel}`);
    problems++;
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written++;
    console.log(`geschrieben: ${rel}`);
  }
}

// Verwaiste Dateien (Variante aus dem Register entfernt) melden bzw. loeschen.
for (const dir of ['apps/backend/src/variants', 'apps/renderer/src/variants', 'apps/web/src/variants']) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (files.has(rel)) continue;
    const id = name.replace(/\.manifest\.ts$|\.tsx?$/, '');
    if (id === 'default' || knownIds.has(id)) continue;
    if (checkOnly) {
      console.log(`VERWAIST: ${rel}`);
      problems++;
    } else {
      fs.rmSync(path.join(abs, name));
      console.log(`entfernt: ${rel}`);
    }
  }
}

if (checkOnly) {
  if (problems) {
    console.error(`variants:check: ${problems} Datei(en) passen nicht zum Register. Bitte npm run variants:gen ausfuehren.`);
    process.exit(1);
  }
  console.log(`variants:check: ${files.size} Dateien passen zum Register (${registry.variants.length} Variante(n), Vorgabe ${d}).`);
} else {
  console.log(`variants:gen: ${written} Datei(en) geschrieben, ${files.size - written} unveraendert.`);
}
