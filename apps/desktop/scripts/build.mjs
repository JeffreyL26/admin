// Baut den Desktop-Hauptprozess (esbuild) und sammelt im Prod-Build die
// Artefakte der anderen Workspaces ein (Renderer-Build, Backend-Bundle).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVariantId } from '../../../scripts/variant-alias.mjs';

const root = path.join(import.meta.dirname, '..');
const devOnly = process.argv.includes('--dev');

// Variante dieses Builds (OHRGANIZE_VARIANT, sonst Vorgabe aus dem Register).
// Der Hauptprozess bekommt sie als Literal einkompiliert (define), damit die
// installierte App ihre Ausgabe kennt, ohne eine Umgebungsvariable zu lesen.
const variantId = resolveVariantId();
const variantMarker = `OHRGANIZE_VARIANT:${variantId}`;

/**
 * Ein Installer darf nur Bundles EINER Variante enthalten. Backend-Bundle und
 * Renderer-Assets tragen ihren Marker; passt er nicht zur gewuenschten
 * Variante, bricht der Build ab, statt einen Installer mit gemischten
 * Ausgaben zu packen (etwa nach einem Wechsel von OHRGANIZE_VARIANT ohne
 * Neubau der anderen Workspaces).
 */
function assertMarker(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(variantMarker)) {
    const found = /OHRGANIZE_VARIANT:([a-z0-9-]+)/.exec(text);
    console.error(
      `${label} traegt ${found ? `die Variante ${found[1]}` : 'keinen Variantenmarker'}, erwartet wird ${variantId}.\n` +
        `Bitte alle Workspaces mit OHRGANIZE_VARIANT=${variantId} neu bauen (npm run build).`,
    );
    process.exit(1);
  }
}

/**
 * Die Electron-Version steht an ZWEI Stellen: als Range in package.json und
 * als feste Zahl in electron-builder.yml (electron-builder kann die Range
 * wegen des Workspace-Hoistings nicht selbst auflösen). Laufen sie
 * auseinander, packt electron-builder klaglos die Fassung aus der yml — die
 * Prüfung hier ist die einzige Stelle, an der das auffällt.
 *
 * Warum das mehr als Ordnungsliebe ist: Wird Electron wegen einer
 * Sicherheitslücke angehoben und bleibt die yml stehen, meldet `npm audit`
 * Entwarnung, während der ausgelieferte Installer die alte, verwundbare
 * Fassung enthält.
 *
 * Bewusst ohne YAML-Bibliothek (wie der OpenAPI-Merge): Gesucht wird genau
 * eine Zeile, dafür lohnt keine Abhängigkeit.
 */
function assertElectronVersionsMatch() {
  const ymlPath = path.join(root, 'electron-builder.yml');
  const treffer = /^electronVersion:\s*(\S+)\s*$/m.exec(fs.readFileSync(ymlPath, 'utf8'));
  if (!treffer) {
    console.error('electron-builder.yml enthält keine Zeile "electronVersion:" — bitte nachtragen.');
    process.exit(1);
  }
  const ausYml = treffer[1];
  const require = createRequire(import.meta.url);
  const installiert = JSON.parse(
    fs.readFileSync(require.resolve('electron/package.json'), 'utf8'),
  ).version;
  if (ausYml !== installiert) {
    console.error(
      `Electron-Version läuft auseinander:\n` +
        `  electron-builder.yml : ${ausYml}\n` +
        `  installiert          : ${installiert}\n` +
        `Der Installer würde mit ${ausYml} gebaut. Beide Angaben angleichen ` +
        `(apps/desktop/package.json und apps/desktop/electron-builder.yml).`,
    );
    process.exit(1);
  }
  console.log(`Electron ${installiert} — package.json und electron-builder.yml stimmen überein.`);
}

await build({
  entryPoints: [path.join(root, 'src/main.ts'), path.join(root, 'src/preload.ts')],
  outdir: path.join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outExtension: { '.js': '.cjs' },
  logLevel: 'warning',
  define: {
    'process.env.OHRGANIZE_VARIANT': JSON.stringify(variantId),
    __OHRGANIZE_VARIANT_MARKER__: JSON.stringify(variantMarker),
  },
});

if (!devOnly) {
  // Zuerst und fail fast: Ein Auseinanderlaufen der Electron-Version macht
  // alles Folgende wertlos, weil electron-builder danach die Fassung aus der
  // yml einpackt. Im Dev-Betrieb ist die Prüfung gegenstandslos — dort startet
  // `electron .` die installierte Fassung, die yml spielt keine Rolle.
  assertElectronVersionsMatch();

  const rendererDist = path.join(root, '../renderer/dist');
  const backendBundle = path.join(root, '../backend/dist/server.cjs');
  // bcrypt im Worker-Thread (backend core/passwordHashing.ts). server.cjs
  // liest die Datei aus seinem eigenen Verzeichnis; fehlt sie, rechnet das
  // eingebettete Backend wieder im Hauptprozess, und das Fenster steht bei
  // jeder Anmeldung still. Deshalb Pflicht statt stiller Ersatzbetrieb.
  const passwordWorker = path.join(root, '../backend/dist/password-worker.cjs');
  if (!fs.existsSync(rendererDist)) {
    console.error('Renderer-Build fehlt — zuerst `npm run build -w apps/renderer` ausführen.');
    process.exit(1);
  }
  if (!fs.existsSync(backendBundle) || !fs.existsSync(passwordWorker)) {
    console.error('Backend-Bundle fehlt oder ist unvollständig: zuerst `npm run build -w apps/backend` ausführen.');
    process.exit(1);
  }
  assertMarker(backendBundle, 'Backend-Bundle server.cjs');
  const assetsDir = path.join(rendererDist, 'assets');
  const rendererJs = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
  const rendererText = rendererJs.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
  if (!rendererText.includes(variantMarker)) {
    console.error(`Renderer-Build traegt nicht den Marker der Variante ${variantId}. Bitte mit OHRGANIZE_VARIANT=${variantId} neu bauen.`);
    process.exit(1);
  }
  fs.rmSync(path.join(root, 'dist/renderer'), { recursive: true, force: true });
  fs.cpSync(rendererDist, path.join(root, 'dist/renderer'), { recursive: true });
  fs.copyFileSync(backendBundle, path.join(root, 'dist/server.cjs'));
  fs.copyFileSync(passwordWorker, path.join(root, 'dist/password-worker.cjs'));
  fs.writeFileSync(path.join(root, 'dist/VARIANTE.txt'), `${variantId}\n`);
}

console.log(`Desktop-Build fertig (${devOnly ? 'dev' : 'prod'}, Variante ${variantId}).`);
