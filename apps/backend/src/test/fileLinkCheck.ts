/**
 * Statische Prüfung: Jede Route, die eine Datei-ID aus dem Request annimmt,
 * gibt sie an `assertMayLinkFiles` (core/files.ts) oder, bei
 * Mitarbeiterfotos, an einen Wächter mit `assertUsableAsPhoto`. Ohne den
 * Aufruf zieht eine Rolle Dateien fremder Bereiche in ihren eigenen: Die
 * Verknüpfung stellt die Datei auch in den Bereich des neuen Datensatzes,
 * und beim Signieren genügt ein Bereich (CLAUDE.md, Dateien).
 *
 * Datei-ID heißt: ein Feld `*file_id`/`*file_ids` in einem zod-Schema. Je
 * Modul werden alle Schemas aufgelöst, auf jeder Ebene (auch innerhalb des
 * Plugins), gleichnamige zusammengeführt, Ableitungen über `.partial()`,
 * `.omit()`, `.pick()` usw. und eingebettete Schemas eingeschlossen. Eine
 * Route ist jeder Aufruf `<irgendwas>.get|post|put|patch|delete('/...')`
 * und `<irgendwas>.route({ url, ... })`, also auch in eingekapselten
 * Plugins. Nennt eine Route ein Schema mit solchen Feldern (oder definiert
 * sie selbst), muss sie jedes Feld in einem `assertMayLinkFiles(...)`-Aufruf
 * nennen (über beliebig viele Zeilen) oder einen Fotowächter aufrufen, der
 * das Feld kennt.
 *
 * Grenzen: Ein Feld, das eine Datei-ID unter anderem Namen trägt, sieht die
 * Prüfung nicht. Ein `.omit()` direkt in der Route nimmt kein Feld heraus
 * (vorsichtig: eher eine Pflicht zu viel als eine zu wenig).
 *
 * Aufruf: npx tsx src/test/fileLinkCheck.ts (Teil von npm test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const FILE_FIELD = /file_ids?$/;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export interface SourceText {
  name: string;
  text: string;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function keyOf(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** Wurzel einer Methodenkette: `z.object(...).partial()` ergibt `z`, `fooSchema.omit(...)` ergibt `fooSchema`. */
function chainRoot(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isCallExpression(e) ||
    ts.isPropertyAccessExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Ist `node` das Objekt in `.omit({...})` bzw. `.pick({...})`? Dessen Schlüssel sind keine Felder. */
function omitOrPick(node: ts.Node): 'omit' | 'pick' | null {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  if (!call.arguments.some((arg) => arg === node)) return null;
  const method = call.expression.name.text;
  return method === 'omit' || method === 'pick' ? method : null;
}

/** Prüft ein Modul (alle seine Dateien gemeinsam); liefert die Route-Feld-Paare und die ungeprüften. */
export function checkModule(files: SourceText[]): { routeFields: number; unchecked: string[] } {
  const sources = files.map((f) => ({
    name: f.name,
    sf: ts.createSourceFile(f.name, f.text, ts.ScriptTarget.Latest, true),
  }));

  // Alle Deklarationen auf jeder Ebene, gleichnamige bleiben alle erhalten.
  const decls: { name: string; init: ts.Expression }[] = [];
  const functions = new Map<string, ts.Node[]>();
  const addFunction = (name: string, node: ts.Node) => functions.set(name, [...(functions.get(name) ?? []), node]);
  for (const { sf } of sources) {
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        decls.push({ name: n.name.text, init: n.initializer });
        if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) addFunction(n.name.text, n.initializer);
      }
      if (ts.isFunctionDeclaration(n) && n.name) addFunction(n.name.text, n);
    });
  }

  // Schemas: Kette mit Wurzel `z` oder einem anderen Schema (bis zum Fixpunkt).
  const schemaDecls = new Set<(typeof decls)[number]>();
  const schemaNames = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      if (schemaDecls.has(d)) continue;
      const root = chainRoot(d.init);
      if (ts.isIdentifier(root) && (root.text === 'z' || schemaNames.has(root.text))) {
        schemaDecls.add(d);
        schemaNames.add(d.name);
        changed = true;
      }
    }
  }
  const isSchemaExpr = (expr: ts.Expression) => {
    const root = chainRoot(expr);
    return ts.isIdentifier(root) && (root.text === 'z' || schemaNames.has(root.text));
  };
  /** Datei-ID-Felder, die ein Knoten selbst als zod-Feld definiert. */
  const ownFields = (node: ts.Node) => {
    const found = new Set<string>();
    walk(node, (n) => {
      if (!ts.isPropertyAssignment(n) || omitOrPick(n.parent)) return;
      const key = keyOf(n.name);
      if (key && FILE_FIELD.test(key) && isSchemaExpr(n.initializer)) found.add(key);
    });
    return found;
  };

  // Felder je Schemaname: eigene plus geerbte, gefiltert durch omit/pick.
  const fieldsByName = new Map<string, Set<string>>();
  const fieldsOf = (name: string) => {
    let set = fieldsByName.get(name);
    if (!set) fieldsByName.set(name, (set = new Set()));
    return set;
  };
  for (const d of schemaDecls) for (const f of ownFields(d.init)) fieldsOf(d.name).add(f);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of schemaDecls) {
      const omitted = new Set<string>();
      const picked = new Set<string>();
      const referenced = new Set<string>();
      walk(d.init, (n) => {
        const kind = ts.isObjectLiteralExpression(n) ? omitOrPick(n) : null;
        if (kind && ts.isObjectLiteralExpression(n)) {
          for (const p of n.properties) {
            const key = p.name && keyOf(p.name);
            if (key) (kind === 'omit' ? omitted : picked).add(key);
          }
        }
        if (ts.isIdentifier(n) && n.text !== d.name && schemaNames.has(n.text)) referenced.add(n.text);
      });
      const own = fieldsOf(d.name);
      for (const ref of referenced) {
        for (const f of fieldsOf(ref)) {
          if (own.has(f) || omitted.has(f) || (picked.size > 0 && !picked.has(f))) continue;
          own.add(f);
          changed = true;
        }
      }
    }
  }

  // Fotowächter: Funktionen, die assertUsableAsPhoto aufrufen; sie kennen die
  // Felder, die sie als Zeichenkette nennen.
  const photoGuards = new Map<string, Set<string>>();
  for (const [name, nodes] of functions) {
    for (const node of nodes) {
      let usesPhotoCheck = false;
      const known = new Set<string>();
      walk(node, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'assertUsableAsPhoto') usesPhotoCheck = true;
        if (ts.isStringLiteral(n) && FILE_FIELD.test(n.text)) known.add(n.text);
      });
      if (usesPhotoCheck) photoGuards.set(name, new Set([...(photoGuards.get(name) ?? []), ...known]));
    }
  }

  let routeFields = 0;
  const unchecked: string[] = [];
  for (const { name: fileName, sf } of sources) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const method = n.expression.name.text;
      const first = n.arguments[0];
      let url: string | undefined;
      if (ROUTE_METHODS.has(method) && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        if (first.text.startsWith('/')) url = first.text;
      } else if (method === 'route' && first && ts.isObjectLiteralExpression(first)) {
        const urlProp = first.properties.find((p) => ts.isPropertyAssignment(p) && keyOf(p.name) === 'url');
        if (urlProp && ts.isPropertyAssignment(urlProp)) url = urlProp.initializer.getText(sf);
      }
      if (url === undefined) return;

      // Die Route samt Handlern, die nur als Name übergeben werden.
      const parts: ts.Node[] = [n];
      for (const arg of n.arguments) if (ts.isIdentifier(arg)) parts.push(...(functions.get(arg.text) ?? []));

      const required = new Set<string>();
      const linkArgs: string[] = [];
      const calls = new Set<string>();
      for (const part of parts) {
        for (const f of ownFields(part)) required.add(f);
        walk(part, (m) => {
          if (ts.isIdentifier(m) && schemaNames.has(m.text)) for (const f of fieldsOf(m.text)) required.add(f);
          if (ts.isCallExpression(m) && ts.isIdentifier(m.expression)) {
            if (m.expression.text === 'assertMayLinkFiles') linkArgs.push(m.arguments.map((a) => a.getText(sf)).join(' '));
            else calls.add(m.expression.text);
          }
        });
      }
      for (const field of required) {
        routeFields += 1;
        const linked = linkArgs.some((args) => new RegExp(`\\b${field}\\b`).test(args));
        const guarded = [...calls].some((c) => photoGuards.get(c)?.has(field));
        if (!linked && !guarded) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          unchecked.push(`${fileName}:${line + 1} ${method.toUpperCase()} ${url} -> ${field}`);
        }
      }
    });
  }
  return { routeFields, unchecked };
}

// ---------------------------------------------------------------------------
// Selbsttest: Die Lücken, die eine zeilenbasierte Prüfung hatte, müssen hier
// auffallen, und legitime Fälle dürfen es nicht.
// ---------------------------------------------------------------------------
const SELF_TESTS: { label: string; files: Record<string, string>; unchecked: number }[] = [
  {
    label: 'Schema innerhalb des Plugins, Route ohne Prüfung',
    files: {
      'routes.ts': `export const mod = async (app) => {
  const inviteSchema = z.object({ title: z.string(), attachment_file_id: z.number() });
  app.post('/api/x', async (req) => { const body = parse(inviteSchema, req.body); save(body); });
};`,
    },
    unchecked: 1,
  },
  {
    label: 'gleichnamige Schemas in zwei Dateien eines Moduls',
    files: {
      'a.ts': `const listSchema = z.object({ q: z.string() });
export const a = async (app) => { app.post('/api/a', async (req) => parse(listSchema, req.body)); };`,
      'b.ts': `const listSchema = z.object({ doc_file_id: z.number() });`,
    },
    unchecked: 1,
  },
  {
    label: 'Route auf anderer Instanz und über app.route',
    files: {
      'routes.ts': `const docSchema = z.object({ file_id: z.number() });
export const mod = async (app) => {
  await app.register(async (scoped) => {
    scoped.patch('/api/docs/:id', async (req) => parse(docSchema, req.body));
  });
  app.route({ method: 'POST', url: '/api/docs', handler: async (req) => parse(docSchema, req.body) });
};`,
    },
    unchecked: 2,
  },
  {
    label: 'Aufruf über mehrere Zeilen, abgeleitetes Schema, Handler als Name',
    files: {
      'routes.ts': `const docSchema = z.object({ file_id: z.number(), cv_file_id: z.number() });
const docPatchSchema = docSchema.partial();
async function update(req) {
  const patch = parse(docPatchSchema, req.body);
  assertMayLinkFiles(
    req,
    [patch.file_id, patch.cv_file_id],
  );
}
export const mod = async (app) => { app.patch('/api/docs/:id', update); };`,
    },
    unchecked: 0,
  },
  {
    label: 'omit nimmt das Feld heraus, Antwortobjekte sind kein Schema, Fotowächter zählt',
    files: {
      'routes.ts': `const docSchema = z.object({ file_id: z.number(), title: z.string() });
const titleSchema = docSchema.omit({ file_id: true });
const personSchema = z.object({ photo_file_id: z.number() });
function guardPhoto(body) { for (const f of ['photo_file_id']) assertUsableAsPhoto(body[f]); }
export const mod = async (app) => {
  app.patch('/api/docs/:id/title', async (req) => parse(titleSchema, req.body));
  app.get('/api/docs', async () => ({ docs: rows.map((r) => ({ file_id: r.file_id })) }));
  app.post('/api/people', async (req) => { const body = parse(personSchema, req.body); guardPhoto(body); });
};`,
    },
    unchecked: 0,
  },
];

const selfTestFailures: string[] = [];
for (const t of SELF_TESTS) {
  const result = checkModule(Object.entries(t.files).map(([name, text]) => ({ name, text })));
  if (result.unchecked.length !== t.unchecked) {
    selfTestFailures.push(`${t.label}: erwartet ${t.unchecked}, gefunden ${JSON.stringify(result.unchecked)}`);
  }
}
if (selfTestFailures.length > 0) {
  console.error(`fileLinkCheck: Selbsttest gescheitert:\n${selfTestFailures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Die echten Module
// ---------------------------------------------------------------------------
const modulesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../modules');
let routeFields = 0;
const unchecked: string[] = [];
for (const entry of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(modulesRoot, entry.name);
  const files = (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.endsWith('smoke.ts'))
    .map((f) => ({ name: `${entry.name}/${f.split(path.sep).join('/')}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const result = checkModule(files);
  routeFields += result.routeFields;
  unchecked.push(...result.unchecked);
}

// Untergrenze gegen eine Prüfung, die still nichts mehr findet (21 Route-Feld-
// Paare beim Einführen; neue Verknüpfungsrouten heben die Zahl nur an).
if (routeFields < 21) {
  console.error(`fileLinkCheck: nur ${routeFields} Route-Feld-Paare gefunden, die Prüfung greift nicht.`);
  process.exit(1);
}
if (unchecked.length > 0) {
  console.error(
    `fileLinkCheck: ${unchecked.length} Datei-ID(s) aus dem Request ohne Prüfung:\n` +
      unchecked.map((u) => `  ${u}`).join('\n') +
      '\nVor dem Verknüpfen assertMayLinkFiles(req, [...]) aufrufen (core/files.ts); Mitarbeiterfotos über assertUsableAsPhoto.',
  );
  process.exit(1);
}
console.log(`fileLinkCheck: alle ${routeFields} Datei-IDs aus Requests gehen vor dem Verknüpfen durch eine Prüfung.`);
