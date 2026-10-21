// Installer bauen (electron-builder) fuer genau eine Variante.
//
// Reihenfolge: better-sqlite3/build entfernen (reset-native.mjs, sonst packt
// electron-builder die falsche ABI), Variante der gebauten Bundles pruefen
// (dist/VARIANTE.txt aus build.mjs), electron-builder mit OHRGANIZE_VARIANT
// in der Umgebung starten (Branch dronivo: Installername
// oHRganize-Setup-<land>-<version>.exe, siehe unten), zuletzt setup-workstation.ps1
// daneben legen (nur Windows).
//
// Aufruf: node scripts/dist.mjs --win | --mac | --linux   (npm run dist:win)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveVariantId } from '../../../scripts/variant-alias.mjs';
import { customerVariantProblem, customerVersionProblem, releaseLabel } from '../../../scripts/dronivo-guard.mjs';

const root = path.join(import.meta.dirname, '..');
const target = process.argv.find((a) => a === '--win' || a === '--mac' || a === '--linux') ?? '--win';

const variantId = resolveVariantId();
// Kundenbranch dronivo: nur die eigene Ausgabe und Versionen <x.y.z>-dronivo
// (scripts/dronivo-guard.mjs), auch fuer einen Installer ausserhalb von release.mjs.
// Der Installername traegt das Kennzeichen oHRganize-Setup-de-1.0.0-dronivo.exe
// (releaseLabel). Gesetzt per Kommandozeile, electron-builder.yml bleibt wie
// auf main: Ein Aufruf ohne dieses Skript baut weiter, nur mit dem Namen von
// main (Variante plus Version), statt an einer fehlenden Variable zu scheitern.
const repo = path.join(root, '../..');
const desktopVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
{
  const problem = customerVariantProblem(repo, variantId) ?? customerVersionProblem(repo, desktopVersion);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
const label = releaseLabel(repo, desktopVersion);
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
// ${ext} setzt electron-builder ein (kein Shell-String, das Dollarzeichen bleibt stehen).
run(electronBuilder, [target, `-c.artifactName=oHRganize-Setup-${label}.\${ext}`]);
if (target === '--win') run(path.join(root, 'scripts/copy-workstation-script.mjs'), []);
console.log(`Installer gebaut für Variante ${variantId}: apps/desktop/release/oHRganize-Setup-${label}.exe`);
