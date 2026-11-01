/**
 * Statische Prüfung: Wer Arbeitswoche oder Ort einer Person schreibt, zählt
 * ihre kommenden Anträge neu. Der Saldo liest die gespeicherten Tage
 * (`absences/service.ts#requestDaysIn`); eine Schreibstelle ohne
 * `recountUpcomingRequests` ließe still veraltete Zahlen stehen, und kein
 * Laufzeittest, der den Weg nicht kennt, fiele darüber.
 *
 * Gesucht werden SQL-Texte und Aufrufe, die eine Zählgrundlage ändern können:
 * `UPDATE employees SET` mit dynamischer Spaltenliste oder einer Spalte aus
 * COUNTING_EMPLOYEE_COLUMNS, `UPDATE locations SET` mit dynamischer Liste
 * oder Land/Region, `DELETE FROM locations` und `setSetting(` mit
 * dynamischem Schlüssel oder `defaultBundesland`. Als dynamisch gilt auch
 * ein SQL-Text, der mit `+` weiter zusammengesetzt wird. Die umgebende
 * Funktion (Route oder Funktion auf oberster Ebene) muss
 * `recountUpcomingRequests` AUFRUFEN (gesucht im Syntaxbaum, ein Kommentar
 * zählt nicht) oder unten mit Datei und Name begründet ausgenommen sein;
 * Ausnahmen prüfen ihre Begründung, wo sie sich prüfen lässt.
 *
 * Aufruf: npx tsx src/test/placeChangeCheck.ts (Teil von npm test).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EMPLOYEE_SELF_EDITABLE_FIELDS } from '@ohrganize/shared';

// Die Module laden die Konfiguration mit; ohne eigenes Datenverzeichnis legte
// das Dateien im Entwicklungsverzeichnis an.
process.env.OHRGANIZE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohrganize-placecheck-'));
const { COUNTING_EMPLOYEE_COLUMNS } = await import('../modules/absences/service.js');
const { MIRRORED_COLUMNS } = await import('../modules/employees/contractRoutes.js');

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const counting: readonly string[] = COUNTING_EMPLOYEE_COLUMNS;

const violations: string[] = [];

/**
 * Ausnahmen: `<Datei relativ zu src>#<Funktion oder Route>` und warum dort
 * nichts zu zählen ist. Eine gleichnamige Funktion in einer anderen Datei ist
 * nicht ausgenommen.
 */
const EXEMPT: Record<string, () => string | null> = {
  // Spiegelt nur Stunden, Urlaub und Beschäftigungsart der Vertragsversion.
  'modules/employees/contractRoutes.ts#mirrorToEmployee': () =>
    MIRRORED_COLUMNS.some((c) => counting.includes(c)) ? 'MIRRORED_COLUMNS enthält eine Zählspalte' : null,
  // Schreibt nur Felder aus EMPLOYEE_SELF_EDITABLE_FIELDS.
  'modules/employees/changeRequestService.ts#decideRequest': () =>
    EMPLOYEE_SELF_EDITABLE_FIELDS.some((f) => counting.includes(f.field))
      ? 'EMPLOYEE_SELF_EDITABLE_FIELDS enthält eine Zählspalte'
      : null,
  // Das Schema der Route nennt nur DATEV-Schlüssel.
  'core/settingsRoutes.ts#put /api/settings/datev': () => null,
};

/** Ruft die Funktion `recountUpcomingRequests` auf (Syntaxbaum, nicht Text)? */
function callsRecount(fn: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'recountUpcomingRequests') {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(fn);
  return found;
}

/** Wird dieser Text per `+` weiter zusammengesetzt? */
function concatenated(node: ts.Node): boolean {
  const parent = node.parent;
  return !!parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['test', 'seed', 'scripts', 'migrations'].includes(entry.name)) continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('smoke.ts')) {
      out.push(full);
    }
  }
  return out;
}

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'route']);

/** Route-Handler: Funktionsargument von `<x>.<verb>('/api/…', …)`. */
function routeOf(node: ts.Node): string | null {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  if (!VERBS.has(call.expression.name.text)) return null;
  const first = call.arguments[0];
  return first && ts.isStringLiteralLike(first) ? `${call.expression.name.text} ${first.text}` : null;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}

/** Umgebende Route, sonst die äußerste Funktion; dazu ihr Name für die Ausnahmen. */
function enclosing(node: ts.Node): { fn: ts.Node; name: string } | null {
  let outer: ts.Node | null = null;
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!isFunctionLike(p)) continue;
    const route = routeOf(p);
    if (route) return { fn: p, name: route };
    outer = p;
  }
  if (!outer) return null;
  if (ts.isFunctionDeclaration(outer) && outer.name) return { fn: outer, name: outer.name.text };
  if (outer.parent && ts.isVariableDeclaration(outer.parent) && ts.isIdentifier(outer.parent.name)) {
    return { fn: outer, name: outer.parent.name.text };
  }
  return { fn: outer, name: '(anonym)' };
}

/** Kann dieser SQL-Text oder Aufruf eine Zählgrundlage ändern? */
function placeWrite(node: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node) || ts.isTemplateExpression(node)) {
    const text = node.getText();
    const dynamic = ts.isTemplateExpression(node) || concatenated(node);
    const mentions = (cols: readonly string[]) => cols.some((c) => new RegExp(`\\b${c}\\b`).test(text));
    if (/UPDATE\s+employees\s+SET/i.test(text) && (dynamic || mentions(counting))) return 'UPDATE employees';
    if (/UPDATE\s+locations\s+SET/i.test(text) && (dynamic || mentions(['country', 'bundesland']))) return 'UPDATE locations';
    if (/DELETE\s+FROM\s+locations/i.test(text)) return 'DELETE FROM locations';
    return null;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'setSetting') {
    const key = node.arguments[0];
    if (!key || !ts.isStringLiteralLike(key) || key.text === 'defaultBundesland') return 'setSetting';
  }
  return null;
}

let checked = 0;
for (const file of sourceFiles(srcDir)) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/employees|locations|setSetting/.test(text)) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = path.relative(srcDir, file).replace(/\\/g, '/');
  const visit = (node: ts.Node) => {
    const what = placeWrite(node);
    if (what) {
      checked += 1;
      const owner = enclosing(node);
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const where = `${rel}:${line} (${what}${owner ? ` in ${owner.name}` : ''})`;
      if (!owner) {
        violations.push(`${where}: außerhalb einer Funktion`);
      } else if (!callsRecount(owner.fn)) {
        const exempt = EXEMPT[`${rel}#${owner.name}`];
        if (!exempt) violations.push(`${where}: ohne recountUpcomingRequests und ohne Ausnahme`);
        else {
          const broken = exempt();
          if (broken) violations.push(`${where}: Ausnahme gilt nicht mehr (${broken})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (checked < 5) violations.push(`nur ${checked} Schreibstellen gefunden; erkennt die Prüfung die Muster noch?`);

if (violations.length > 0) {
  console.error('placeChangeCheck: Schreibstellen für Arbeitswoche oder Ort ohne Neuzählung:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`placeChangeCheck: ${checked} Schreibstellen geprüft, alle zählen neu oder sind begründet ausgenommen.`);
