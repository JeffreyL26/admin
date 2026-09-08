// Baut den Desktop-Hauptprozess (esbuild) und sammelt im Prod-Build die
// Artefakte der anderen Workspaces ein (Renderer-Build, Backend-Bundle).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.join(import.meta.dirname, '..');
const devOnly = process.argv.includes('--dev');

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
});

if (!devOnly) {
  // Zuerst und fail fast: Ein Auseinanderlaufen der Electron-Version macht
  // alles Folgende wertlos, weil electron-builder danach die Fassung aus der
  // yml einpackt. Im Dev-Betrieb ist die Prüfung gegenstandslos — dort startet
  // `electron .` die installierte Fassung, die yml spielt keine Rolle.
  assertElectronVersionsMatch();

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
