// Installer bauen (electron-builder) fuer genau eine Variante.
//
// Reihenfolge: better-sqlite3/build entfernen (reset-native.mjs, sonst packt
// electron-builder die falsche ABI), Variante der gebauten Bundles pruefen
// (dist/VARIANTE.txt aus build.mjs), electron-builder mit OHRGANIZE_VARIANT
// in der Umgebung starten (electron-builder.yml nutzt sie im Installernamen:
// oHRganize-Setup-<version>-<variante>.exe), zuletzt setup-workstation.ps1
// daneben legen (nur Windows).
//
// Aufruf: node scripts/dist.mjs --win | --mac | --linux   (npm run dist:win)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveVariantId } from '../../../scripts/variant-alias.mjs';

const root = path.join(import.meta.dirname, '..');
const target = process.argv.find((a) => a === '--win' || a === '--mac' || a === '--linux') ?? '--win';

const variantId = resolveVariantId();
const builtFile = path.join(root, 'dist/VARIANTE.txt');
const built = fs.existsSync(builtFile) ? fs.readFileSync(builtFile, 'utf8').trim() : null;
if (built !== variantId) {
  console.error(
    `dist/ enthaelt ${built ? `die Variante ${built}` : 'keinen Variantenvermerk'}, gebaut werden soll ${variantId}.\n` +
      `Bitte zuerst "npm run build" mit OHRGANIZE_VARIANT=${variantId} ausfuehren.`,
  );
  process.exit(1);
}

function run(file, args) {
  console.log(`> ${path.basename(file)} ${args.join(' ')}`);
  const res = spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, OHRGANIZE_VARIANT: variantId },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

run(path.join(root, 'scripts/reset-native.mjs'), []);
// electron-builder ueber seine JS-Datei starten (kein .cmd-Shim, kein Shell-String).
const electronBuilder = path.join(root, '../../node_modules/electron-builder/cli.js');
if (!fs.existsSync(electronBuilder)) {
  console.error(`electron-builder nicht gefunden: ${electronBuilder}`);
  process.exit(1);
}
run(electronBuilder, [target]);
if (target === '--win') run(path.join(root, 'scripts/copy-workstation-script.mjs'), []);
console.log(`Installer gebaut fuer Variante ${variantId} (apps/desktop/release).`);
