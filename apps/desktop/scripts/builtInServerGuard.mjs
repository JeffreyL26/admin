// Sperre gegen einen eingebauten Server ausserhalb einer Kundenausgabe.
//
// BUILT_IN_SERVER (packages/shared/src/builtInServer.ts) laesst die
// Desktop-App sich ohne Konfiguration von selbst mit einem Server verbinden.
// Das darf nur eine Kundenausgabe auf ihrem Branch. Das Hauptprodukt und alles,
// was aus der Geschichte von main gebaut wird, verbindet sich nie von selbst
// mit einem Kundenserver. Drei Merkmale, die getrennt ausfallen koennen:
//   - die Version: Eine Kundenausgabe traegt ihre Edition als Kennung
//     (<x.y.z>-<edition>, etwa 1.1.3-dronivo mit Edition dronivo); das
//     Hauptprodukt hat keine solche Kennung, gleich wie seine Edition heisst,
//   - der Branch (main),
//   - die Herkunft des Commits: liegt HEAD in der Geschichte von main, auch
//     bei einem Build von einem Tag (losgeloester HEAD, Branch "HEAD").
//     Laesst sich das nicht pruefen (kein main, flacher Klon, kein git),
//     gilt es als nicht erfuellt: Die Sperre faellt nie still aus.
// Ein versehentlicher Merge eines Kundenbranches nach main braechte dessen
// Register und Version mit; Version und Ausgabe allein fielen dann nicht auf.
//
// Aufgerufen von scripts/build.mjs vor jedem Desktop-Build; Test
// scripts/builtInServerGuardTest.mjs (Regel ohne git, git-Teil in einem
// Wegwerf-Repository).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Kennung einer Kundenausgabe in der Version: 1.1.3-dronivo ergibt dronivo,
 * 1.1.0-kunde-nord ergibt kunde-nord, 1.1.0 und 1.1.0-beta.1 nichts (die
 * Kennung muss gleich der Edition sein, und eine Edition folgt
 * EDITION_PATTERN in packages/shared/src/country.ts, Bindestriche
 * eingeschlossen). Die einzige Fassung dieser Regel auf main; Test und
 * Release-Skript rufen sie hierueber. Ein Kundenbranch kennt zusaetzlich
 * customerTagOf (Release-Linie in conspectus, scripts/dronivo-guard.mjs), das
 * auch 1.1.3-dronivo.1 auf dronivo abbildet; dort erzwingt check-dronivo
 * ohnehin genau die Form <x.y.z>-<kennung>, beide Regeln sagen also dasselbe.
 */
const CUSTOMER_VERSION = /^\d+\.\d+\.\d+-([a-z][a-z0-9-]{0,31})$/;

/**
 * Steht in builtInServer.ts `export const BUILT_IN_SERVER ... = null;` als
 * Code? Blockkommentare zaehlen nicht, und die Zeile muss mit `export`
 * beginnen, also auch kein Zeilenkommentar: Sonst haette eine
 * auskommentierte null-Zeile neben einem gesetzten Server die Sperre
 * abgeschaltet.
 */
export function builtInServerIsNull(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return /^[ \t]*export\s+const\s+BUILT_IN_SERVER\b[^=\n]*=\s*null\s*;/m.test(code);
}

/**
 * Die Regel ohne Dateisystem und git: null = in Ordnung, sonst die Meldung.
 * `onMainHistory`: true, wenn HEAD in der Geschichte von main liegt; null,
 * wenn sich das nicht pruefen liess.
 */
export function builtInServerProblem({ source, variantId, edition, version, branchName, onMainHistory }) {
  if (builtInServerIsNull(source)) return null;
  const tag = CUSTOMER_VERSION.exec(version ?? '')?.[1] ?? null;
  const where =
    tag !== edition
      ? `die Ausgabe ${variantId} in Version ${version}; eine Kundenausgabe traegt ihre Edition als Kennung ` +
        `(<x.y.z>-${edition})`
      : branchName === 'main'
        ? 'auf dem Branch main'
        : onMainHistory === null
          ? 'ohne pruefbare Herkunft (weder main noch origin/main vorhanden, flacher Klon oder kein git); ' +
            'bitte `git fetch origin main` ausfuehren und erneut bauen'
          : onMainHistory
            ? 'von einem Commit aus der Geschichte von main (ein Tag von main, oder ein neuer Kundenbranch ' +
              'ohne eigenen Commit: die Aenderung zuerst committen)'
            : null;
  if (!where) return null;
  return (
    `Die Desktop-App traegt einen eingebauten Server (BUILT_IN_SERVER in packages/shared/src/builtInServer.ts), ` +
    `gebaut wird aber ${where}.\n` +
    `Nur eine Kundenausgabe auf ihrem Branch darf sich von selbst mit einem Server verbinden; ` +
    `auf main steht dort null.`
  );
}

function git(repo, args) {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { status: res.status, out: (res.stdout ?? '').trim() };
}

/**
 * Liegt HEAD in der Geschichte von main (lokal oder origin/main)? null, wenn
 * es sich nicht pruefen laesst: kein git oder kein Repository, flacher Klon
 * (die Geschichte ist abgeschnitten) oder keiner der beiden Refs vorhanden.
 */
export function headOnMainHistory(repo) {
  const shallow = git(repo, ['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0 || shallow.out !== 'false') return null;
  let checked = false;
  for (const ref of ['refs/heads/main', 'refs/remotes/origin/main']) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) continue;
    const ancestor = git(repo, ['merge-base', '--is-ancestor', 'HEAD', ref]).status;
    if (ancestor === 0) return true;
    if (ancestor !== 1) return null;
    checked = true;
  }
  return checked ? false : null;
}

/**
 * Sammelt die Merkmale im Repository `repo` und liefert builtInServerProblem.
 * `variant` ist der Registereintrag (variantById), `version` die Version der
 * Desktop-App.
 */
export function checkBuiltInServer(repo, variant, version) {
  const source = fs.readFileSync(path.join(repo, 'packages/shared/src/builtInServer.ts'), 'utf8');
  if (builtInServerIsNull(source)) return null;
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return builtInServerProblem({
    source,
    variantId: variant.id,
    edition: variant.edition,
    version,
    branchName: branch.status === 0 ? branch.out : null,
    onMainHistory: headOnMainHistory(repo),
  });
}
