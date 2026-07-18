// Fügt openapi/base.yaml und alle openapi/*.paths.yaml zu einer Gesamtspezifikation
// zusammen (openapi/openapi.generated.yaml). Bewusst ohne YAML-Bibliothek:
// Fragmente enthalten ausschließlich einen top-level "paths:"-Block, dessen
// Inhalt eingerückt unter base.paths gehängt wird.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'openapi');
const base = fs.readFileSync(path.join(dir, 'base.yaml'), 'utf8');

const fragments = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.paths.yaml'))
  .sort();

let merged = base.trimEnd() + '\n';
for (const fragment of fragments) {
  const content = fs.readFileSync(path.join(dir, fragment), 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'paths:');
  if (start === -1) continue;
  merged += `\n  # --- aus ${fragment} ---\n`;
  merged += lines.slice(start + 1).join('\n').trimEnd() + '\n';
}

fs.writeFileSync(path.join(dir, 'openapi.generated.yaml'), merged);
console.log(`openapi.generated.yaml erzeugt (${fragments.length} Modul-Fragmente).`);
