#!/usr/bin/env node
/**
 * Prueft die unverhandelbaren Prinzipien aus CLAUDE.md, soweit sie sich
 * statisch pruefen lassen. Teil von `npm test`.
 *
 *   1. Keine Gedankenstriche in neuem Text: Das Skript prueft nur, dass
 *      CLAUDE.md die Regel nennt und der Pre-commit-Hook sie erzwingt; die
 *      eigentliche Pruefung ist scripts/check-dashes.mjs.
 *   2. Portal-Adresse ist <kunde>.ohrganize.com: Das Einrichtungsskript
 *      lehnt andere Domains ohne -EigeneDomain ab, und weder Doku noch
 *      Betriebsdateien nennen eine fremde Beispieldomain.
 *   3. Daten sind synchron: Beide Clients laden bei Fokus, Wiederverbindung
 *      und (nach hoechstens 500 ms) bei jedem Mount neu. Ein abweichendes
 *      staleTime oder abgeschaltetes Neuladen steht nur mit einem Kommentar
 *      `sync-ausnahme: <Grund>` direkt darueber oder in derselben Zeile.
 *
 * Aufruf: node scripts/check-principles.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const fail = (msg) => problems.push(msg);

function walk(dir, visit) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, visit);
    else visit(rel);
  }
}

// --- CLAUDE.md nennt die Prinzipien --------------------------------------
const claude = read('CLAUDE.md');
for (const needle of ['Unverhandelbare Prinzipien', 'check-dashes', '<kunde>.ohrganize.com', 'sync-ausnahme']) {
  if (!claude.includes(needle)) fail(`CLAUDE.md nennt "${needle}" nicht (Abschnitt Unverhandelbare Prinzipien).`);
}

// --- 1. Gedankenstriche: Hook vorhanden -----------------------------------
if (!fs.existsSync(path.join(root, '.githooks/pre-commit'))) fail('.githooks/pre-commit fehlt (erzwingt check-dashes).');
else if (!read('.githooks/pre-commit').includes('check-dashes')) fail('.githooks/pre-commit ruft check-dashes nicht auf.');
if (!read('package.json').includes('check-principles.mjs')) fail('package.json: check-principles.mjs fehlt in "test".');
if (!read('package.json').includes('check-dashes.mjs --base HEAD')) fail('package.json: check-dashes.mjs --base HEAD fehlt in "test".');

// --- 2. Portal-Adresse -----------------------------------------------------
const setup = read('deploy/windows/setup-server.ps1');
if (!setup.includes('EigeneDomain') || !setup.includes('ohrganize\.com')) {
  fail('deploy/windows/setup-server.ps1: Die Pruefung auf <kunde>.ohrganize.com samt -EigeneDomain fehlt.');
}
const DOMAIN_ARG = /-Domain\s+'([^'$]+)'/g;
const FOREIGN_EXAMPLE = /portal\.firma\.de/;
for (const dir of ['deploy', 'docs']) {
  walk(dir, (rel) => {
    if (!/\.(md|ps1|sh|conf|example|service)$|Caddyfile$/.test(rel)) return;
    const text = read(rel);
    if (FOREIGN_EXAMPLE.test(text)) fail(`${rel}: Beispieldomain portal.firma.de; die Portal-Adresse ist <kunde>.ohrganize.com.`);
    for (const m of text.matchAll(DOMAIN_ARG)) {
      if (!/^[a-z0-9-]+\.ohrganize\.com$/.test(m[1]) && !/-EigeneDomain/.test(text.slice(m.index, m.index + 200))) {
        fail(`${rel}: -Domain '${m[1]}' ist nicht <kunde>.ohrganize.com.`);
      }
    }
  });
}

// --- 3. Synchrone Daten ----------------------------------------------------
for (const app of ['apps/renderer/src/App.tsx', 'apps/web/src/App.tsx']) {
  const text = read(app);
  if (!/refetchOnWindowFocus:\s*true/.test(text)) fail(`${app}: refetchOnWindowFocus: true fehlt im QueryClient.`);
  if (!/refetchOnReconnect:\s*true/.test(text)) fail(`${app}: refetchOnReconnect: true fehlt im QueryClient.`);
  const m = /staleTime:\s*(\d[\d_]*)/.exec(text.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (!m || Number(m[1].replace(/_/g, '')) > 500) fail(`${app}: staleTime im QueryClient fehlt oder liegt ueber 500 ms.`);
}

const MARKER = 'sync-ausnahme:';
const OPTION = /\b(staleTime|refetchOnMount|refetchOnWindowFocus|refetchOnReconnect)\s*:\s*([^,}\n]+)/;
for (const dir of ['apps/renderer/src', 'apps/web/src']) {
  walk(dir, (rel) => {
    if (!/\.tsx?$/.test(rel) || /\/App\.tsx$/.test(rel)) return;
    const lines = read(rel).split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      const m = OPTION.exec(line);
      if (!m) return;
      const [, name, value] = m;
      const v = value.trim();
      const fine =
        (name === 'staleTime' && /^\d+$/.test(v) && Number(v) <= 500) ||
        (name !== 'staleTime' && (v === 'true' || v === "'always'"));
      if (fine) return;
      const context = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      if (!context.includes(MARKER)) {
        fail(`${rel}:${i + 1}: ${name}: ${v} ohne Kommentar "${MARKER} <Grund>" (Prinzip: Daten sind synchron).`);
      }
    });
  });
}

if (problems.length) {
  console.error('check-principles: Verstoesse gegen die Prinzipien aus CLAUDE.md:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-principles: ok (Gedankenstriche, Portal-Adresse, synchrone Daten).');
