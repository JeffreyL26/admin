// Baut den Desktop-Hauptprozess (esbuild) und sammelt im Prod-Build die
// Artefakte der anderen Workspaces ein (Renderer-Build, Backend-Bundle).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const devOnly = process.argv.includes('--dev');

await build({
  entryPoints: [path.join(root, 'src/main.ts'), path.join(root, 'src/preload.ts')],
  outdir: path.join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outExtension: { '.js': '.cjs' },
  logLevel: 'warning',
});

if (!devOnly) {
  const rendererDist = path.join(root, '../renderer/dist');
  const backendBundle = path.join(root, '../backend/dist/server.cjs');
  if (!fs.existsSync(rendererDist)) {
    console.error('Renderer-Build fehlt — zuerst `npm run build -w apps/renderer` ausführen.');
    process.exit(1);
  }
  if (!fs.existsSync(backendBundle)) {
    console.error('Backend-Bundle fehlt — zuerst `npm run build -w apps/backend` ausführen.');
    process.exit(1);
  }
  fs.rmSync(path.join(root, 'dist/renderer'), { recursive: true, force: true });
  fs.cpSync(rendererDist, path.join(root, 'dist/renderer'), { recursive: true });
  fs.copyFileSync(backendBundle, path.join(root, 'dist/server.cjs'));
}

console.log(`Desktop-Build fertig (${devOnly ? 'dev' : 'prod'}).`);
