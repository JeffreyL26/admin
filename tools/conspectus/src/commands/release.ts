/**
 * Releases erfassen: Was wurde gebaut, in welcher Ausgabe, welchem Kanal?
 *
 * Quelle ist das `release.json`, das `scripts/release.mjs` je Variante
 * schreibt. Es traegt Pruefsummen aller Artefakte; liegt eine `release.json.sig`
 * daneben, wird die Signatur geprueft, BEVOR das Release ins Register kommt.
 * Ein unsigniertes Release wird aufgenommen, aber ausdruecklich als
 * ungeprueft vermerkt: Sonst waere die Spalte wertlos.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '@ohrganize/shared';
import type { Args } from '../args.js';
import { ConspectusError, openRegister } from '../db.js';

/** Vertrauensanker im Repo, unabhaengig vom Arbeitsverzeichnis des Aufrufers. */
const REPO_SIGNERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../deploy/ohrganize-release.allowed_signers');

export interface ReleaseRow {
  id: string;
  version: string;
  kanal: string;
  variante: string;
  commit_hash: string | null;
  gebaut_am: string | null;
  signatur_geprueft: number;
  manifest: string | null;
  artefakte: string | null;
  erfasst_am: string;
}

interface Manifest {
  product?: string;
  version?: string;
  channel?: string;
  variant?: { id?: string };
  artifacts?: { file: string; sha256: string; bytes: number }[];
  commit?: string;
  built_at?: string;
}

const SIGNERS_HINT =
  'deploy/ohrganize-release.allowed_signers (Vertrauensanker, siehe deploy/README.md 9.6)';

function pruefeSignatur(manifestFile: string, signers: string | undefined): boolean {
  const sig = `${manifestFile}.sig`;
  if (!fs.existsSync(sig)) {
    console.warn(`Achtung: Keine ${path.basename(sig)} neben dem Manifest. Signatur NICHT geprueft.`);
    return false;
  }
  const anchor = signers ? path.resolve(signers) : REPO_SIGNERS;
  if (!fs.existsSync(anchor)) {
    console.warn(`Achtung: ${anchor} fehlt. Signatur NICHT geprueft (${SIGNERS_HINT}).`);
    return false;
  }
  const hatSchluessel = fs
    .readFileSync(anchor, 'utf8')
    .split('\n')
    .some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (!hatSchluessel) {
    console.warn(`Achtung: In ${anchor} steht noch kein Schluessel. Signatur NICHT geprueft.`);
    return false;
  }
  const res = spawnSync(
    'ssh-keygen',
    ['-Y', 'verify', '-f', anchor, '-I', 'release@ohrganize', '-n', 'ohrganize-release', '-s', sig],
    { input: fs.readFileSync(manifestFile), encoding: 'utf8' },
  );
  if (res.error) {
    console.warn('Achtung: ssh-keygen ist nicht verfuegbar. Signatur NICHT geprueft.');
    return false;
  }
  if (res.status !== 0) {
    throw new ConspectusError(
      `Die Signatur von ${manifestFile} ist ungueltig. Release NICHT erfassen und NICHT ausrollen.\n${res.stderr}`,
    );
  }
  return true;
}

export function releaseCommand(sub: string, args: Args): void {
  const { db } = openRegister();
  switch (sub) {
    case 'erfassen': {
      const raw = args.positional[0] ?? args.values.manifest;
      if (!raw) throw new ConspectusError('Aufruf: conspectus release erfassen <pfad/release.json>');
      const manifestFile = path.resolve(raw);
      if (!fs.existsSync(manifestFile)) throw new ConspectusError(`${manifestFile} existiert nicht.`);
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest;
      const variante = m.variant?.id;
      if (!m.version || !variante) {
        throw new ConspectusError('Das Manifest nennt keine version bzw. keine variant.id.');
      }
      const geprueft = pruefeSignatur(manifestFile, args.values.signers);
      const id = `${variante}-${m.version}`;
      db.prepare(
        `INSERT INTO releases (id, version, kanal, variante, commit_hash, gebaut_am, signatur_geprueft, manifest, artefakte)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kanal = excluded.kanal, commit_hash = excluded.commit_hash,
           gebaut_am = excluded.gebaut_am, signatur_geprueft = excluded.signatur_geprueft,
           manifest = excluded.manifest, artefakte = excluded.artefakte`,
      ).run(
        id,
        m.version,
        m.channel ?? (m.version.includes('-') ? 'beta' : 'stable'),
        variante,
        m.commit ?? null,
        m.built_at ?? null,
        geprueft ? 1 : 0,
        manifestFile,
        JSON.stringify(m.artifacts ?? []),
      );
      console.log(
        `Release ${id} erfasst (Kanal ${m.channel ?? '?'}, Signatur ${geprueft ? 'geprueft' : 'NICHT geprueft'}).`,
      );
      for (const a of m.artifacts ?? []) {
        console.log(`  ${a.file}  ${(a.bytes / 1024 / 1024).toFixed(1)} MB`);
      }
      return;
    }
    case 'liste':
    case undefined:
    case '': {
      const rows = db.prepare('SELECT * FROM releases ORDER BY variante, version').all() as ReleaseRow[];
      if (rows.length === 0) {
        console.log('Noch kein Release im Register.');
        return;
      }
      console.log(['RELEASE'.padEnd(30), 'KANAL'.padEnd(8), 'SIGNATUR'.padEnd(12), 'GEBAUT'].join(' '));
      for (const r of rows) {
        console.log(
          [
            r.id.padEnd(30),
            r.kanal.padEnd(8),
            (r.signatur_geprueft ? 'geprueft' : 'offen').padEnd(12),
            (r.gebaut_am ?? '').slice(0, 10),
          ].join(' '),
        );
      }
      return;
    }
    default:
      throw new ConspectusError(`Unbekannter Unterbefehl "release ${sub}". Bekannt: erfassen, liste.`);
  }
}

export function releaseMuss(id: string): ReleaseRow {
  const { db } = openRegister();
  const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow | undefined;
  if (!row) throw new ConspectusError(`Release "${id}" ist nicht im Register (conspectus release erfassen ...).`);
  return row;
}

/** Jüngstes Release je Variante und Kanal (zum Vergleich mit den Instanzen). */
export function neuestesRelease(variante: string, kanal: string): ReleaseRow | null {
  const { db } = openRegister();
  const rows = db
    .prepare('SELECT * FROM releases WHERE variante = ? AND kanal = ?')
    .all(variante, kanal) as ReleaseRow[];
  // Nicht in SQL sortieren: Als Text laege 1.9.0 hinter 1.10.0.
  rows.sort((a, b) => compareVersions(a.version, b.version));
  return rows.length > 0 ? rows[rows.length - 1] : null;
}
