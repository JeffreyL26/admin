/**
 * Statische Prüfung: Jeder Aufruf von `audit(...)` steht innerhalb des
 * Callbacks einer Transaktion (`inTransaction(() => ...)` oder
 * `<db>.transaction(() => ...)`). Fachliche Änderung und Audit-Eintrag
 * gehören in EINEN Commit (CLAUDE.md, Konventionen, Audit); als getrennte
 * Commits bliebe nach einem Absturz dazwischen eine Änderung ohne Protokoll.
 * Einträge ohne fachliche Änderung (Anmeldung, Fehlversuch, Signatur,
 * Lizenzdatei) schreiben über `auditStandalone(...)` und sind ausgenommen.
 *
 * Ergänzt die Laufzeitprüfung in core/audit.ts: Die fängt jeden Aufruf
 * außerhalb einer Transaktion, aber nur auf Wegen, die ein Test durchläuft;
 * diese Prüfung sieht jede Stelle im Quelltext.
 *
 * Aufruf: npx tsx src/test/auditTransactionCheck.ts (Teil von npm test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'seed' || entry.name === 'scripts') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('smoke.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Ist `node` ein Funktionsargument von inTransaction(...) bzw. x.transaction(...)? */
function isTransactionCallback(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression)) return false;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'inTransaction';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'transaction';
  return false;
}

const violations: string[] = [];
let checked = 0;
for (const file of sourceFiles(srcDir)) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('audit(')) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'audit') {
      checked += 1;
      let inside = false;
      for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        if (isTransactionCallback(p)) {
          inside = true;
          break;
        }
      }
      if (!inside) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        violations.push(`${path.relative(srcDir, file)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (checked === 0) {
  console.error('auditTransactionCheck: keinen einzigen audit()-Aufruf gefunden, die Prüfung greift nicht.');
  process.exit(1);
}
if (violations.length > 0) {
  console.error(
    `auditTransactionCheck: ${violations.length} audit()-Aufruf(e) ausserhalb einer Transaktion:\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\nÄnderung und audit() in dieselbe inTransaction(() => ...) legen; Einträge ohne fachliche ' +
      'Änderung über auditStandalone().',
  );
  process.exit(1);
}
console.log(`auditTransactionCheck: alle ${checked} audit()-Aufrufe stehen in einer Transaktion.`);
