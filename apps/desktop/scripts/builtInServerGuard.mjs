// Sperre gegen einen eingebauten Server ausserhalb einer Kundenausgabe.
//
// BUILT_IN_SERVER (packages/shared/src/builtInServer.ts) laesst die
// Desktop-App sich ohne Konfiguration von selbst mit einem Server verbinden.
// Das darf nur eine Kundenausgabe auf ihrem Branch. Die Vollversion und alles,
// was aus der Geschichte von main gebaut wird, verbindet sich nie von selbst
// mit einem Kundenserver. Drei Merkmale, die getrennt ausfallen koennen:
//   - die Ausgabe des Builds (Vollversion),
//   - der Branch (main),
//   - die Herkunft des Commits: liegt HEAD in der Geschichte von main, auch
//     bei einem Build von einem Tag (losgeloester HEAD, Branch "HEAD").
// Ein versehentlicher Merge eines Kundenbranches nach main braechte dessen
// Register mit; die Ausgabe allein fiele dann nicht auf.
//
// Aufgerufen von scripts/build.mjs vor jedem Desktop-Build; die Regel selbst
// (builtInServerProblem) prueft scripts/builtInServerGuardTest.mjs ohne git.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Steht in builtInServer.ts `BUILT_IN_SERVER ... = null`? Unabhaengig von Leerraum und Kommentar dahinter. */
export function builtInServerIsNull(source) {
  return /export\s+const\s+BUILT_IN_SERVER\b[^=]*=\s*null\s*;/.test(source);
}

/**
 * Die Regel ohne Dateisystem und git: null = in Ordnung, sonst die Meldung.
 * `onMainHistory` ist true, wenn HEAD in der Geschichte von main liegt.
 */
export function builtInServerProblem({ source, variantId, edition, branchName, onMainHistory }) {
  if (builtInServerIsNull(source)) return null;
  const where =
    edition === 'vollversion'
      ? `die Vollversion (${variantId})`
      : branchName === 'main'
        ? 'auf dem Branch main'
        : onMainHistory
          ? 'aus der Geschichte von main (etwa von einem Tag)'
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
  return { ok: res.status === 0, out: (res.stdout ?? '').trim() };
}

/** Liegt HEAD in der Geschichte von main (lokal oder origin/main)? Ohne git: false. */
function headOnMainHistory(repo) {
  for (const ref of ['main', 'origin/main']) {
    if (!git(repo, ['rev-parse', '--verify', '--quiet', ref]).ok) continue;
    if (git(repo, ['merge-base', '--is-ancestor', 'HEAD', ref]).ok) return true;
  }
  return false;
}

/** Sammelt die Merkmale im Repository `repo` und liefert builtInServerProblem. */
export function checkBuiltInServer(repo, variantId) {
  const source = fs.readFileSync(path.join(repo, 'packages/shared/src/builtInServer.ts'), 'utf8');
  if (builtInServerIsNull(source)) return null;
  const registry = JSON.parse(fs.readFileSync(path.join(repo, 'packages/shared/src/variants/registry.json'), 'utf8'));
  const edition = registry.variants.find((v) => v.id === variantId)?.edition ?? null;
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return builtInServerProblem({
    source,
    variantId,
    edition,
    branchName: branch.ok ? branch.out : null,
    onMainHistory: headOnMainHistory(repo),
  });
}
