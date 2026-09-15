#!/usr/bin/env node
/**
 * Prueft nach einem Build, dass alle Bundles zu EINER Variante gehoeren und
 * die Module ausgeschlossener Fachbereiche wirklich fehlen.
 *
 *   node scripts/check-variant.mjs --variant de-vollversion [--no-desktop] [--no-web]
 *
 * Je Bundle (apps/backend/dist/{server,cli,backup}.cjs, apps/renderer/dist/
 * assets/*.js, apps/web/dist/assets/*.js, apps/desktop/dist/main.cjs):
 *   1. der Marker OHRGANIZE_VARIANT:<id> ist enthalten,
 *   2. kein Marker einer anderen Variante ist enthalten,
 *   3. fuer Module, die die Variante nicht enthaelt, fehlen deren
 *      Routen-Zeichenketten (Backend) bzw. Seitenpfade (Clients).
 * Exit 1 bei jedem Befund.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const variantArg = argv[argv.indexOf('--variant') + 1];
const skipDesktop = argv.includes('--no-desktop');
const skipWeb = argv.includes('--no-web');

const registry = JSON.parse(fs.readFileSync(path.join(root, 'packages/shared/src/variants/registry.json'), 'utf8'));
const variantId = argv.includes('--variant') && variantArg ? variantArg : registry.default;
const variant = registry.variants.find((v) => v.id === variantId);
if (!variant) {
  console.error(`Unbekannte Variante "${variantId}". Bekannt: ${registry.variants.map((v) => v.id).join(', ')}.`);
  process.exit(2);
}
const marker = `OHRGANIZE_VARIANT:${variantId}`;

/**
 * Zeichenketten, die nur im Code eines Moduls vorkommen: Backend die
 * Routen aus den routes.ts der Module; Desktop-App API-Pfade, die nur die
 * Seiten des Moduls aufrufen (nav.ts und gemeinsame api.ts-Dateien kennen
 * Pfade aller Module und taugen deshalb nicht); Portal Ueberschriften der
 * Seiten. Ein Modul gilt als enthalten, wenn ALLE seine Zeichenketten im
 * Bundle stehen; so kippt ein einzelner Treffer in einem Kommentar den Test
 * nicht. Beim Umbenennen einer Seite hier nachziehen.
 */
const MODULE_SIGNATURES = {
  absences: {
    backend: ['/api/absences/requests', '/api/absences/types'],
    renderer: ['/api/absences/sick-notes', '/api/absences/closures'],
    web: ['Ihre Krankmeldungen', 'Gute Besserung'],
  },
  performance: {
    backend: ['/api/performance/reviews', '/api/performance/goals'],
    renderer: ['/api/performance/feedback-meetings', '/api/performance/rating-categories'],
    web: [],
  },
  leadership: {
    backend: ['/api/leadership/leaders', '/api/leadership/settings'],
    renderer: ['Die gewählte Skala gilt für jede Kategorie', 'Eigene Skalen einzelner Kategorien'],
    web: [],
  },
  compensation: {
    backend: ['/api/compensation/salaries', '/api/compensation/payroll'],
    renderer: ['/api/compensation/freelancer-invoices', '/api/compensation/payroll-runs'],
    web: ['Aktuelle Bestandteile', 'Boni und Sonderzahlungen'],
  },
  communication: {
    backend: ['/api/communication/announcements', '/api/communication/surveys'],
    renderer: ['/api/communication/channels', '/api/communication/meetings'],
    web: [],
  },
  recruiting: {
    backend: ['/api/recruiting/applications', '/api/recruiting/candidates'],
    renderer: ['/api/recruiting/postings', '/api/recruiting/candidates'],
    web: [],
  },
  me: { backend: ['/api/me/profile', '/api/me/leave-requests'], renderer: [], web: [] },
};

let problems = 0;
function problem(msg) {
  problems++;
  console.log(`FEHLER: ${msg}`);
}

function readAll(files) {
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

function jsFilesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
}

function checkBundle(label, files, kind) {
  if (files.length === 0) {
    problem(`${label}: keine Dateien gefunden (Build fehlt?).`);
    return;
  }
  const text = readAll(files);
  if (!text.includes(marker)) problem(`${label}: Marker ${marker} fehlt.`);
  const foreign = [...text.matchAll(/OHRGANIZE_VARIANT:([a-z0-9-]+)/g)].map((m) => m[1]).filter((id) => id !== variantId);
  if (foreign.length) problem(`${label}: fremde Variante(n) ${[...new Set(foreign)].join(', ')} enthalten.`);
  for (const [module, sig] of Object.entries(MODULE_SIGNATURES)) {
    if (!kind || variant.modules.includes(module)) continue;
    const hits = (sig[kind] ?? []).filter((s) => text.includes(s));
    if (hits.length === (sig[kind] ?? []).length && hits.length > 0) {
      problem(`${label}: Modul ${module} ist nicht Teil der Variante, aber enthalten (${hits.join(', ')}).`);
    }
  }
  console.log(`ok  ${label} (${files.length} Datei(en))`);
}

const backendDist = path.join(root, 'apps/backend/dist');
checkBundle('Backend server.cjs', [path.join(backendDist, 'server.cjs')].filter(fs.existsSync), 'backend');
checkBundle('Backend cli.cjs', [path.join(backendDist, 'cli.cjs')].filter(fs.existsSync), 'backend');
checkBundle('Backend backup.cjs', [path.join(backendDist, 'backup.cjs')].filter(fs.existsSync), null);
for (const extra of ['status.cjs', 'admin-reset.cjs', 'migrate-check.cjs']) {
  const f = path.join(backendDist, extra);
  if (fs.existsSync(f)) checkBundle(`Backend ${extra}`, [f], null);
}
const variantFile = path.join(backendDist, 'VARIANTE.txt');
if (fs.existsSync(variantFile) && fs.readFileSync(variantFile, 'utf8').trim() !== variantId) {
  problem(`apps/backend/dist/VARIANTE.txt nennt ${fs.readFileSync(variantFile, 'utf8').trim()}.`);
}

checkBundle('Renderer assets', jsFilesIn(path.join(root, 'apps/renderer/dist/assets')), 'renderer');
if (!skipWeb) checkBundle('Portal assets', jsFilesIn(path.join(root, 'apps/web/dist/assets')), 'web');
if (!skipDesktop) checkBundle('Desktop main.cjs', [path.join(root, 'apps/desktop/dist/main.cjs')].filter(fs.existsSync), null);

if (problems) {
  console.error(`check-variant: ${problems} Befund(e) fuer Variante ${variantId}.`);
  process.exit(1);
}
console.log(`check-variant: alle Bundles gehoeren zur Variante ${variantId} (${variant.label}).`);
