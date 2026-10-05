// Fügt openapi/base.yaml und alle openapi/*.paths.yaml zu einer Gesamtspezifikation
// zusammen (openapi/openapi.generated.yaml). Das Zusammenfügen bleibt textuell:
// Fragmente enthalten ausschließlich einen top-level "paths:"-Block, dessen
// Inhalt eingerückt unter base.paths gehängt wird. Geprüft wird mit js-yaml
// (kommt über electron-builder mit, bewusst nicht eigens aufgenommen): erst
// jede Quelldatei für sich, dann ob das Ergebnis genau die Pfade der Quellen
// enthält. Bei einem Fehler wird nichts geschrieben; mit --check wird nur
// geprüft (Teil von npm test).
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

let yaml;
try {
  yaml = await import('js-yaml');
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  console.error('js-yaml nicht gefunden (kommt über electron-builder mit). Zuerst npm ci im Wurzelverzeichnis ausführen.');
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const dir = path.join(import.meta.dirname, '..', 'openapi');
const errors = [];

// Ein ausgeschriebenes null (null, ~) wird zu dieser Marke. Was danach noch
// null ist, hatte gar keinen Wert: fast immer der Rest eines ungequoteten
// Werts in { ... }, denn dort beendet jedes Komma den Wert, und der Rest wird
// zum Schlüssel. "{ description: Antrag angelegt, Tage berechnet }" parst
// ohne Fehler zu { description: "Antrag angelegt", "Tage berechnet": null }.
const WRITTEN_NULL = Symbol('null');
const SCHEMA = yaml.DEFAULT_SCHEMA.extend({
  implicit: [
    new yaml.Type('tag:yaml.org,2002:null', {
      kind: 'scalar',
      resolve: yaml.types.null.resolve,
      construct: () => WRITTEN_NULL,
    }),
  ],
});

// Steht hinter dem Komma ein ": ", wird der Rest zum Schlüssel MIT Wert
// ("{ description: Fehler, Hinweis: Feld fehlt }"). Deshalb dürfen neben
// einer description/summary als Text nur Schlüssel stehen, die OpenAPI 3.1
// an Objekten mit Beschreibung kennt (Operation, Pfad, Antwort, Parameter,
// Header, Request-Body, Beispiel, Info, Lizenz, Tag, Server, Link,
// Sicherheitsschema und Schema samt aller Schlüsselwörter von JSON Schema
// 2020-12), dazu x-*.
const OPENAPI_KEYS = new Set([
  '$ref', 'summary', 'description', 'operationId', 'tags', 'parameters', 'requestBody', 'responses',
  'callbacks', 'deprecated', 'security', 'servers', 'externalDocs',
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace',
  'headers', 'content', 'links',
  'name', 'in', 'required', 'allowEmptyValue', 'style', 'explode', 'allowReserved', 'schema', 'example', 'examples',
  'title', 'version', 'termsOfService', 'contact', 'license', 'identifier', 'url', 'variables', 'enum', 'default',
  'value', 'externalValue',
  'scheme', 'bearerFormat', 'flows', 'openIdConnectUrl',
  'operationRef', 'server',
  // Schema (OpenAPI-Zusätze und JSON Schema 2020-12: Core, Applicator, Validation, Meta-Data, Content)
  'discriminator', 'xml', 'nullable',
  '$id', '$schema', '$anchor', '$dynamicAnchor', '$dynamicRef', '$vocabulary', '$comment', '$defs',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentSchemas',
  'prefixItems', 'items', 'contains', 'properties', 'patternProperties', 'additionalProperties', 'propertyNames',
  'unevaluatedItems', 'unevaluatedProperties',
  'type', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains',
  'maxProperties', 'minProperties', 'dependentRequired',
  'format', 'readOnly', 'writeOnly',
  'contentEncoding', 'contentMediaType', 'contentSchema',
]);
// Unter diesen Schlüsseln stehen Daten (Beispiele, Vorgaben), keine OpenAPI-Objekte.
const DATA_KEYS = new Set(['example', 'default', 'const', 'enum']);

// Freie Daten: die Schlüssel oben, Werte von Erweiterungen (x-*), die
// Beispielliste eines Schemas (examples als Liste, JSON Schema) und der Wert
// eines Beispielobjekts (examples als Zuordnung, OpenAPI).
function isDataKey(key, value, trail) {
  return (
    DATA_KEYS.has(key) ||
    key.startsWith('x-') ||
    (key === 'examples' && Array.isArray(value)) ||
    (key === 'value' && trail.at(-2) === 'examples')
  );
}
const QUOTE_HINT = ' (Wert mit Komma oder ": " in Anführungszeichen setzen)';

function lint(node, trail, file, inData) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => lint(item, [...trail, `[${i}]`], file, inData));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const where = trail.join(' > ') || '(oberste Ebene)';
  const hasProse = !inData && (typeof node.description === 'string' || typeof node.summary === 'string');
  for (const [key, value] of Object.entries(node)) {
    // Ein leerer top-level-Block "paths:" ist kein Quoting-Problem; den meldet expectPaths.
    if (value === null && !(trail.length === 0 && key === 'paths')) {
      errors.push(`${file}: Schlüssel ${JSON.stringify(key)} ohne Wert unter ${where}${QUOTE_HINT}`);
    } else if (hasProse && !OPENAPI_KEYS.has(key) && !key.startsWith('x-')) {
      errors.push(`${file}: unbekannter Schlüssel ${JSON.stringify(key)} neben description/summary unter ${where}${QUOTE_HINT}`);
    }
    lint(value, [...trail, key], file, inData || isDataKey(key, value, trail));
  }
}

const UNPARSABLE = Symbol('unparsable');

function parse(text, file) {
  try {
    return yaml.load(text, { filename: file, schema: SCHEMA });
  } catch (e) {
    errors.push(e.mark ? `${file}:${e.mark.line + 1}:${e.mark.column + 1}: ${e.reason}` : `${file}: ${e.message}`);
    return UNPARSABLE;
  }
}

const isMapping = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const base = fs.readFileSync(path.join(dir, 'base.yaml'), 'utf8');
const baseDoc = parse(base, 'base.yaml');
lint(baseDoc, [], 'base.yaml', false);

// Was das Ergebnis enthalten muss: base.yaml mit den Pfaden aller Fragmente.
const expectedPaths = {};
const pathSource = {};
function expectPaths(paths, file) {
  if (!isMapping(paths)) {
    errors.push(`${file}: "paths:" enthält keine Pfade (ein leerer Block heißt "paths: {}")`);
    return;
  }
  for (const [route, item] of Object.entries(paths)) {
    if (Object.hasOwn(expectedPaths, route)) {
      errors.push(`${file}: Pfad ${route} steht schon in ${pathSource[route]}`);
      continue;
    }
    expectedPaths[route] = item;
    pathSource[route] = file;
  }
}
if (baseDoc !== UNPARSABLE) {
  if (isMapping(baseDoc) && Object.hasOwn(baseDoc, 'paths')) expectPaths(baseDoc.paths, 'base.yaml');
  else errors.push('base.yaml: kein top-level "paths:"-Block');
}

const fragments = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.paths.yaml'))
  .sort();

// Je Ausgabezeile die Quelle, damit Fehler im Ergebnis auf die Datei zeigen.
const out = [];
const origin = [];
function append(text, source, firstLine) {
  text.split('\n').forEach((line, i) => {
    out.push(line);
    origin.push(firstLine ? `${source}:${firstLine + i}` : source);
  });
}

append(base.trimEnd(), 'base.yaml', 1);
for (const fragment of fragments) {
  const content = fs.readFileSync(path.join(dir, fragment), 'utf8');
  const doc = parse(content, fragment);
  if (doc !== UNPARSABLE) {
    const keys = isMapping(doc) ? Object.keys(doc) : [];
    if (keys.length !== 1 || keys[0] !== 'paths') {
      errors.push(`${fragment}: erwartet genau einen top-level "paths:"-Block, gefunden: ${keys.join(', ') || 'nichts'}`);
    }
    if (isMapping(doc) && Object.hasOwn(doc, 'paths')) expectPaths(doc.paths, fragment);
    lint(doc, [], fragment, false);
  }
  // Nur die Zeile ganz links ist der top-level-Schlüssel; ein Kommentar dahinter
  // ist erlaubt, ebenso ein BOM davor, wenn sie die erste Zeile der Datei ist.
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^\uFEFF?paths:[ \t]*(#.*)?\r?$/.test(l));
  if (start === -1) continue;
  append('', `Trennzeile vor ${fragment}`);
  append(`  # --- aus ${fragment} ---`, `Trennzeile vor ${fragment}`);
  append(lines.slice(start + 1).join('\n').trimEnd(), fragment, start + 2);
}
const merged = out.join('\n') + '\n';

// Erst wenn alle Quellen einzeln stimmen, sonst meldete das Ergebnis dieselben Fehler noch einmal.
if (errors.length === 0) {
  let mergedDoc;
  try {
    mergedDoc = yaml.load(merged, { filename: 'openapi.generated.yaml', schema: SCHEMA });
  } catch (e) {
    const where = e.mark ? `Zeile aus ${origin[e.mark.line] ?? 'unbekannt'}` : 'ohne Position';
    errors.push(`openapi.generated.yaml (${where}): ${e.reason ?? e.message}`);
  }
  if (mergedDoc !== undefined) {
    // Das textuelle Zusammenfügen kann parsbar und trotzdem falsch sein (Fragment
    // übersprungen, anders eingerückt): deshalb gegen die Quellen vergleichen.
    const actualPaths = isMapping(mergedDoc?.paths) ? mergedDoc.paths : {};
    for (const [route, item] of Object.entries(expectedPaths)) {
      if (!Object.hasOwn(actualPaths, route)) {
        errors.push(`openapi.generated.yaml: Pfad ${route} aus ${pathSource[route]} fehlt`);
      } else if (!isDeepStrictEqual(actualPaths[route], item)) {
        errors.push(`openapi.generated.yaml: Pfad ${route} weicht von ${pathSource[route]} ab`);
      }
    }
    for (const route of Object.keys(actualPaths)) {
      if (!Object.hasOwn(expectedPaths, route)) errors.push(`openapi.generated.yaml: Pfad ${route} stammt aus keiner Quelle`);
    }
    const { paths: _actual, ...actualTop } = isMapping(mergedDoc) ? mergedDoc : {};
    const { paths: _expected, ...expectedTop } = baseDoc;
    if (!isDeepStrictEqual(actualTop, expectedTop)) {
      errors.push('openapi.generated.yaml: oberste Ebene weicht von base.yaml ab');
    }
  }
}

if (errors.length > 0) {
  console.error(`openapi.generated.yaml ${checkOnly ? 'fehlerhaft' : 'NICHT geschrieben'}, ${errors.length} Fehler:`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

const summary = `${fragments.length} Modul-Fragmente, ${Object.keys(expectedPaths).length} Pfade`;
if (checkOnly) {
  console.log(`OpenAPI geprüft, nichts geschrieben (${summary}).`);
} else {
  fs.writeFileSync(path.join(dir, 'openapi.generated.yaml'), merged);
  console.log(`openapi.generated.yaml erzeugt und mit js-yaml geprüft (${summary}).`);
}
