/**
 * Worker der Passwortprüfung (Pool und Begründung: core/passwordHashing.ts).
 * Rechnet bcrypt in einem eigenen Thread, damit der einzige Node-Prozess (in
 * der Desktop-App der Electron-Hauptprozess samt Fenster) währenddessen
 * weiter antwortet.
 *
 * Bewusst ohne jeden Import aus dem Backend: Die Datei wird einzeln gebündelt
 * (scripts/build.mjs, dist/password-worker.cjs) und enthält nur bcryptjs.
 * Kein Variantencode, deshalb auch kein Variantenmarker; check-variant.mjs
 * prüft sie nicht.
 */
import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

/** Auftrag des Hauptthreads. Ein Worker bekommt immer nur einen zugleich. */
export interface PasswordJobMessage {
  id: number;
  op: 'compare' | 'hash';
  password: string;
  /** Nur bei `compare`: der gespeicherte Hash. */
  hash?: string;
  /** Nur bei `hash`: Kostenfaktor. */
  rounds?: number;
}

export type PasswordJobReply =
  | { id: number; ok: true; result: boolean | string }
  | { id: number; ok: false; error: string };

parentPort?.on('message', (job: PasswordJobMessage) => {
  let reply: PasswordJobReply;
  try {
    const result =
      job.op === 'compare'
        ? bcrypt.compareSync(job.password, job.hash ?? '')
        : bcrypt.hashSync(job.password, job.rounds ?? 10);
    reply = { id: job.id, ok: true, result };
  } catch (err) {
    reply = { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort?.postMessage(reply);
});
