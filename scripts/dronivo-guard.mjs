/**
 * Kundenbranch dronivo: Regeln fuer Versionen und Ausgabe, die
 * scripts/release.mjs, scripts/release-server.mjs,
 * apps/desktop/scripts/dist.mjs und scripts/check-dronivo.mjs teilen.
 *
 * Quelle der Kennungen ist packages/shared/src/dronivo.ts (CUSTOMER_TAG,
 * CUSTOMER_VARIANT). Diese Skripte sind reines JavaScript und koennen die
 * TypeScript-Quelle nicht importieren; gelesen wird sie trotzdem, damit die
 * Werte an EINER Stelle stehen (wie minVersions in release-server.mjs).
 *
 * Warum: Ein Build dieses Branches ohne Kundenkennung saehe aus wie ein
 * Release des Hauptprodukts, einer fremder Variante ginge an deren Kunden.
 * Gebaut wird deshalb nur <x.y.z>-<Kennung> der eigenen Variante. Einen
 * Testkanal gibt es auf dem Branch nicht: `1.1.0-dronivo.beta.1` waere nach
 * Semver neuer als `1.1.0-dronivo` und gaelte als stable.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Versionsregeln fuer alle Skripte dieses Branches (release.mjs,
// release-server.mjs, check-dronivo.mjs). Die TypeScript-Quelle ist
// packages/shared/src/version.ts (CHANNEL_PRE_PATTERN, channelOf,
// customerTagOf, compareVersions); diese Datei ist ihr EINZIGES JavaScript-
// Gegenstueck. Wer die Regel aendert, aendert beide.
// ---------------------------------------------------------------------------

/** Testkanal-Kennung wie CHANNEL_PRE_PATTERN in packages/shared/src/version.ts. */
export const CHANNEL_PRE = /^(?:alpha|beta|rc)(?:[.\d-]|$)/i;

/** `1.2.3-beta.1` -> { core: [1, 2, 3], pre: 'beta.1' }; null bei fremder Form. */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

/** Kanal wie channelOf in shared/version.ts: alpha, beta und rc sind beta, sonst stable; null bei fremder Form. */
export function channelOf(version) {
  const v = parseVersion(version);
  if (!v) return null;
  return v.pre && CHANNEL_PRE.test(v.pre) ? 'beta' : 'stable';
}

/** Kundenkennung einer Version wie customerTagOf in shared/version.ts; null ohne. */
export function customerTagOf(version) {
  const pre = parseVersion(version)?.pre;
  return pre && !CHANNEL_PRE.test(pre) ? pre.split('.')[0].toLowerCase() : null;
}

function comparePre(a, b) {
  const l = a.split('.');
  const r = b.split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    const ln = /^\d+$/.test(l[i]);
    const rn = /^\d+$/.test(r[i]);
    if (ln && rn && Number(l[i]) !== Number(r[i])) return Number(l[i]) < Number(r[i]) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    if (!ln && l[i] !== r[i]) return l[i] < r[i] ? -1 : 1;
  }
  return 0;
}

/** Semver-Ordnung wie compareVersions in shared/version.ts (<0 aelter, 0 gleich, >0 neuer). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePre(x.pre, y.pre);
}

/** CUSTOMER_TAG und CUSTOMER_VARIANT aus packages/shared/src/dronivo.ts. */
export function customerEdition(root) {
  const src = fs.readFileSync(path.join(root, 'packages/shared/src/dronivo.ts'), 'utf8');
  const pick = (name) => {
    const m = new RegExp(`export const ${name} = '([^']+)'`).exec(src);
    if (!m) throw new Error(`${name} steht nicht in packages/shared/src/dronivo.ts.`);
    return m[1];
  };
  return { tag: pick('CUSTOMER_TAG'), variant: pick('CUSTOMER_VARIANT') };
}

/**
 * Kennzeichen der Release-Dateien, so wie der Info-Dialog die Version zeigt
 * (formatVersion mit Land): `de-1.0.0-dronivo`. Installer
 * `oHRganize-Setup-de-1.0.0-dronivo.exe` (apps/desktop/scripts/dist.mjs),
 * Server-Archiv `ohrganize-server-de-1.0.0-dronivo.zip`
 * (scripts/release-server.mjs), release.mjs sucht beide unter diesem Namen.
 * Variante plus Version (wie auf main) naennte die Kennung doppelt
 * (`de-dronivo-1.0.0-dronivo`); Land und Kennung bestimmen die Ausgabe
 * ebenso eindeutig.
 */
export function releaseLabel(root, version) {
  const { variant } = customerEdition(root);
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'packages/shared/src/variants/registry.json'), 'utf8'));
  const country = registry.variants.find((v) => v.id === variant)?.country;
  if (!country) throw new Error(`Variante ${variant} steht nicht im Register.`);
  return `${country.toLowerCase()}-${version}`;
}

/** Fehlertext, wenn die Version nicht genau <x.y.z>-<Kennung> ist; sonst null. */
export function customerVersionProblem(root, version) {
  const { tag } = customerEdition(root);
  if (new RegExp(`^\\d+\\.\\d+\\.\\d+-${tag}$`).test(String(version).trim())) return null;
  return (
    `Version "${version}" ist nicht <x.y.z>-${tag}. Auf dem Branch dronivo entsteht nur diese Form ` +
    `(z. B. 1.0.1-${tag}): ohne Kennung saehe ein Release aus wie das Hauptprodukt, ein Testkanal ` +
    `(${tag}.beta.1) waere nach Semver neuer als das fertige Release.`
  );
}

/** Fehlertext, wenn die Variante nicht die Ausgabe dieses Branches ist; sonst null. */
export function customerVariantProblem(root, variantId) {
  const { variant } = customerEdition(root);
  if (variantId === variant) return null;
  return (
    `Variante "${variantId}" ist nicht die Ausgabe dieses Branches ("${variant}"). Auf dem Branch dronivo ` +
    `entsteht nur ${variant}; Register und OHRGANIZE_VARIANT pruefen (node scripts/check-dronivo.mjs).`
  );
}

/**
 * scripts/check-dronivo.mjs ausfuehren (mit `version`: gegen diese Zielversion)
 * und den Befund liefern; null, wenn alles passt. Die Release-Skripte rufen es
 * vor jedem Schritt mit Wirkung auf, weil npm test fuer ein Release keine
 * Pflicht ist.
 */
export function branchCheckProblem(root, version) {
  const args = [path.join(root, 'scripts/check-dronivo.mjs')];
  if (version) args.push('--version', version);
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return null;
  return `scripts/check-dronivo.mjs meldet Befunde:\n${(r.stdout + r.stderr).trim()}`;
}
