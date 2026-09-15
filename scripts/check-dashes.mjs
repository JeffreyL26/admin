#!/usr/bin/env node
/**
 * Prueft Textdateien auf Gedankenstriche (Halbgeviertstrich U+2013 und
 * Geviertstrich U+2014). Der Anbieter will keine davon in UI-Texten, Doku,
 * Skriptausgaben und Kommentaren; drei UI-Konventionen bleiben erlaubt:
 *
 *   1. Leerwert in Tabellenzellen: ein einzelner Geviertstrich in Anfuehrungs-
 *      zeichen ('x', "x", `x`) oder zwischen > und < im JSX.
 *   2. Klammer um den Platzhalter leerer Auswahlfelder: Geviertstrich,
 *      Leerzeichen, 1 bis 40 Zeichen, Leerzeichen, Geviertstrich.
 *   3. Datumsspannen: TT.MM. oder TT.MM.JJJJ, Leerzeichen, Halbgeviertstrich,
 *      Leerzeichen, Ziffer oder ${ (und das Codemuster } - ${ mit
 *      Halbgeviertstrich).
 *
 * Aufrufe:
 *   node scripts/check-dashes.mjs --base <ref>     nur NEU HINZUGEKOMMENE Zeilen
 *                                                   seit <ref> (git diff -U0)
 *   node scripts/check-dashes.mjs --staged          nur hinzugekommene Zeilen im Index
 *   node scripts/check-dashes.mjs <pfad> [...]      ganze Dateien
 *   node scripts/check-dashes.mjs --base <ref> --all  ganze Dateien, die sich seit
 *                                                   <ref> geaendert haben
 *
 * Bestehende Gedankenstriche im Bestand werden vom Anbieter von Hand entfernt;
 * dieses Skript verhindert, dass neue dazukommen. Deshalb ist der Diff-Modus
 * die Vorgabe der Phasenabnahme (`npm run check:dashes -- --base main`).
 *
 * Die Zeichen selbst stehen hier nur als Codepunkte (fromCharCode), damit das
 * Skript seine eigene Pruefung besteht. Kein Kommentar-Opt-out.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const ANY_DASH = new RegExp(`[${EN}${EM}]`, 'g');

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mjs', '.cjs', '.js', '.md', '.sh', '.ps1', '.yml', '.yaml', '.txt', '.html',
  '.conf', '.service', '.timer', '.example', '.json', '.css',
]);

/**
 * Erlaubte Muster. Jede Fundstelle wird gegen diese Liste geprueft; eine
 * Fundstelle gilt als erlaubt, wenn sie vollstaendig innerhalb eines Treffers
 * eines dieser Muster liegt.
 */
const ALLOWED = [
  // 1. Leerwert: Geviertstrich allein in Anfuehrungszeichen oder zwischen > und <
  new RegExp(`(['"\`])${EM}\\1`, 'g'),
  new RegExp(`>${EM}<`, 'g'),
  // 2. Klammer leerer Auswahlfelder: Geviertstrich, Text, Geviertstrich
  new RegExp(`${EM} [^${EM}\\n]{1,40} ${EM}`, 'g'),
  // 3. Datumsspanne: TT.MM.[JJJJ], Halbgeviertstrich, Ziffer oder Platzhalter
  new RegExp(`\\d{2}\\.\\d{2}\\.(?:\\d{4})? ${EN} (?=\\d|\\$\\{)`, 'g'),
  new RegExp(`\\} ${EN} \\$?\\{`, 'g'),
];

function usage(message) {
  if (message) console.error(`Fehler: ${message}`);
  console.error(
    'Aufruf: node scripts/check-dashes.mjs --base <ref> [--all] | --staged | <pfad> [...]',
  );
  process.exit(2);
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function git(args) {
  const res = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(res.stderr || `git ${args.join(' ')} fehlgeschlagen`);
    process.exit(2);
  }
  return res.stdout;
}

/** Spalten (1-basiert) aller unerlaubten Gedankenstriche einer Zeile. */
function offendingColumns(line) {
  const allowedRanges = [];
  for (const re of ALLOWED) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      allowedRanges.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  const hits = [];
  ANY_DASH.lastIndex = 0;
  let m;
  while ((m = ANY_DASH.exec(line)) !== null) {
    const at = m.index;
    const covered = allowedRanges.some(([a, b]) => at >= a && at < b);
    if (!covered) hits.push(at + 1);
  }
  return hits;
}

function checkLines(file, lines) {
  const findings = [];
  for (const { lineNo, text } of lines) {
    const cols = offendingColumns(text);
    if (cols.length) findings.push({ file, lineNo, cols, text });
  }
  return findings;
}

function wholeFile(file) {
  const abs = path.resolve(root, file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return [];
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split(/\r?\n/).map((text, i) => ({ lineNo: i + 1, text }));
  return checkLines(file, lines);
}

/** Hinzugekommene Zeilen aus `git diff -U0`, je Datei mit Zeilennummer der neuen Fassung. */
function addedLinesFromDiff(diffArgs) {
  const out = git(['diff', '-U0', '--diff-filter=ACMR', '--no-color', ...diffArgs]);
  const perFile = new Map();
  let current = null;
  let newLine = 0;
  for (const raw of out.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).replace(/^b\//, '').trim();
      current = name === '/dev/null' ? null : name;
      if (current && !perFile.has(current)) perFile.set(current, []);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) {
      perFile.get(current).push({ lineNo: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // entfernte Zeile bzw. "No newline at end of file": zaehlt nicht in der neuen Fassung
    } else {
      newLine++;
    }
  }
  return perFile;
}

function untrackedFiles() {
  return git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function changedFiles(diffArgs) {
  return git(['diff', '--name-only', '--diff-filter=ACMR', ...diffArgs])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let base = null;
let staged = false;
let all = false;
const paths = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base') {
    base = argv[++i] ?? usage('--base braucht eine Referenz');
  } else if (a === '--staged') {
    staged = true;
  } else if (a === '--all') {
    all = true;
  } else if (a === '--help' || a === '-h') {
    usage();
  } else if (a.startsWith('--')) {
    usage(`Unbekannte Option ${a}`);
  } else {
    paths.push(a);
  }
}
if ((base || staged) && paths.length) usage('Entweder --base/--staged oder Pfade, nicht beides');
if (!base && !staged && !paths.length) usage('Nichts zu pruefen');

let findings = [];
let mode;
if (paths.length) {
  mode = 'Dateien';
  for (const p of paths) {
    const rel = path.relative(root, path.resolve(root, p)).replace(/\\/g, '/');
    const abs = path.resolve(root, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const stack = [abs];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (isTextFile(full)) {
            findings.push(...wholeFile(path.relative(root, full).replace(/\\/g, '/')));
          }
        }
      }
    } else if (isTextFile(rel)) {
      findings.push(...wholeFile(rel));
    }
  }
} else {
  const diffArgs = staged ? ['--staged'] : [base];
  if (all) {
    mode = `geaenderte Dateien seit ${staged ? 'Index' : base}`;
    for (const f of changedFiles(diffArgs)) if (isTextFile(f)) findings.push(...wholeFile(f));
  } else {
    mode = `neue Zeilen seit ${staged ? 'Index' : base}`;
    for (const [file, lines] of addedLinesFromDiff(diffArgs)) {
      if (isTextFile(file)) findings.push(...checkLines(file, lines));
    }
  }
  // Noch nicht versionierte Dateien kennt git diff nicht; sie sind komplett neu
  // und werden deshalb ganz geprueft (nur im Arbeitsbaum, nicht bei --staged).
  if (!staged) {
    for (const f of untrackedFiles()) if (isTextFile(f)) findings.push(...wholeFile(f));
  }
}

if (findings.length === 0) {
  console.log(`check-dashes: keine Gedankenstriche (${mode}).`);
  process.exit(0);
}
for (const f of findings) {
  const marked = f.text.replace(ANY_DASH, (c) => (c === EN ? '<U+2013>' : '<U+2014>'));
  console.log(`${f.file}:${f.lineNo}:${f.cols.join(',')}  ${marked.trim()}`);
}
console.error(`check-dashes: ${findings.length} Zeile(n) mit Gedankenstrichen (${mode}).`);
process.exit(1);
