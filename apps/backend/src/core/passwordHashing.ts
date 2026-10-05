/**
 * bcrypt außerhalb des Event-Loops.
 *
 * bcryptjs rechnet in reinem JavaScript; ein Vergleich mit Kostenfaktor 10
 * dauert rund 65 ms. `compareSync` blockiert dabei den einzigen Node-Prozess,
 * und die asynchrone API hilft nicht: bcryptjs gibt erst nach 100 ms
 * Rechenzeit an den Event-Loop ab (MAX_EXECUTION_TIME in bcryptjs), ein
 * Vergleich läuft also auch dort am Stück. In der Desktop-App ist dieser
 * Prozess der Electron-Hauptprozess, das Fenster stand bei jeder Anmeldung
 * still; im Serverbetrieb warteten alle Arbeitsplätze samt Portal.
 *
 * Deshalb ein kleiner Pool aus worker_threads (ein oder zwei Threads, beim
 * ersten Bedarf gestartet, im Leerlauf ohne Einfluss auf das Prozessende).
 * Lässt sich ein Worker nicht starten, fällt er aus oder antwortet er nicht,
 * rechnet derselbe Aufruf synchron wie früher, ab dann bis zum nächsten
 * Start, mit einer einmaligen Warnung: Eine Anmeldung darf nie am Worker
 * scheitern.
 *
 * Kein Import von db.js oder config.ts: credentials.ts nutzt dieses Modul,
 * und die Betreiberwerkzeuge (scripts/toolkit.ts) laden credentials.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';
import { errorText } from './errorText.js';
import type { PasswordJobMessage, PasswordJobReply } from './passwordWorker.js';

/** Name des gebündelten Workers neben server.cjs/cli.cjs (scripts/build.mjs). */
const BUNDLED_WORKER = 'password-worker.cjs';

/**
 * Antwortet ein Worker so lange nicht, gilt er als ausgefallen. Ein Vergleich
 * dauert rund 65 ms; die Frist misst ab der Übergabe an den Worker, nicht ab
 * dem Einreihen, eine lange Warteschlange löst sie also nicht aus.
 */
const JOB_TIMEOUT_MS = 15_000;

type JobInput = Omit<PasswordJobMessage, 'id'>;

interface Job {
  input: JobInput;
  resolve: (result: boolean | string) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  jobId: number;
  timer: NodeJS.Timeout | null;
}

/** null: noch nicht gestartet. */
let slots: Slot[] | null = null;
/** true: synchroner Ersatzbetrieb bis zum nächsten Start. */
let disabled = false;
let nextJobId = 1;
const queue: Job[] = [];
let warn: (message: string) => void = (message) => console.warn(message);

/** Warnungen ins Fastify-Log statt auf stderr (core/auth.ts setzt ihn). */
export function setPasswordHashingLogger(log: { warn: (message: string) => void }): void {
  warn = (message) => log.warn(message);
}

/** Läuft der Pool (für die Smoke-Tests)? false vor dem ersten Aufruf und im Ersatzbetrieb. */
export function passwordWorkerActive(): boolean {
  return !disabled && slots !== null && slots.length > 0;
}

/** Passwort gegen einen bcrypt-Hash prüfen, im Worker. */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return (await submit({ op: 'compare', password, hash })) === true;
}

/** bcrypt-Hash eines Passworts erzeugen, im Worker. */
export async function hashPassword(password: string, rounds = 10): Promise<string> {
  const result = await submit({ op: 'hash', password, rounds });
  if (typeof result !== 'string') throw new Error('Passwort-Hash konnte nicht erzeugt werden');
  return result;
}

function submit(input: JobInput): Promise<boolean | string> {
  return new Promise((resolve, reject) => {
    const job: Job = { input, resolve, reject };
    if (!ensurePool()) {
      runSync(job);
      return;
    }
    queue.push(job);
    pump();
  });
}

/** Derselbe Vergleich wie im Worker, synchron im Hauptthread (Ersatzbetrieb). */
function runSync(job: Job): void {
  try {
    const { op, password, hash, rounds } = job.input;
    job.resolve(op === 'compare' ? bcrypt.compareSync(password, hash ?? '') : bcrypt.hashSync(password, rounds ?? 10));
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Wo der Worker liegt:
 * - gebündelt (server.cjs, cli.cjs): dist/password-worker.cjs neben dem
 *   Bundle. Der Inhalt wird hier gelesen und als Quelltext gestartet (eval),
 *   nicht über den Pfad: In der Desktop-App liegt dist/ im app.asar, und aus
 *   dem Archiv liest verlässlich nur fs im Hauptthread.
 * - Entwicklung und Tests unter tsx: passwordWorker.ts neben dieser Datei;
 *   der Worker erbt die Lader von tsx über execArgv.
 * Im Bundle ist import.meta leer, unter tsx (ESM) gibt es kein __dirname.
 */
function startWorker(): Worker {
  if (typeof __dirname === 'string') {
    const bundled = path.join(__dirname, BUNDLED_WORKER);
    if (fs.existsSync(bundled)) return new Worker(fs.readFileSync(bundled, 'utf8'), { eval: true });
  }
  const sourceDir = import.meta.dirname;
  const source = sourceDir ? path.join(sourceDir, 'passwordWorker.ts') : null;
  if (source && fs.existsSync(source)) return new Worker(source);
  throw new Error(`${BUNDLED_WORKER} liegt nicht neben dem Programm`);
}

function poolSize(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Ein Kern bleibt dem Hauptthread; mehr als zwei braucht keine Anmeldelast.
  return cores > 2 ? 2 : 1;
}

function ensurePool(): Slot[] | null {
  if (disabled) return null;
  if (slots) return slots;
  slots = [];
  try {
    for (let i = poolSize(); i > 0; i -= 1) slots.push(createSlot());
  } catch (err) {
    fallBack(`Worker lässt sich nicht starten (${errorText(err)})`);
    return null;
  }
  return slots;
}

function createSlot(): Slot {
  const worker = startWorker();
  const slot: Slot = { worker, job: null, jobId: 0, timer: null };
  worker.on('message', (reply: PasswordJobReply) => finish(slot, reply));
  worker.on('error', (err) => fallBack(`Worker ausgefallen (${errorText(err)})`));
  worker.on('exit', (code) => fallBack(`Worker beendet (Code ${code})`));
  // Im Leerlauf hält der Worker den Prozess nicht am Leben (Smoke-Tests,
  // Betreiberwerkzeuge); während eines Auftrags schon (pump). Erst NACH dem
  // Anmelden der Listener: Ein neuer 'message'-Listener hängt den Port
  // wieder ein (Node, setupPortReferencing), und der Prozess endete nie.
  worker.unref();
  return slot;
}

function pump(): void {
  for (const slot of slots ?? []) {
    if (slot.job) continue;
    const job = queue.shift();
    if (!job) return;
    slot.job = job;
    slot.jobId = nextJobId++;
    slot.worker.ref();
    slot.timer = setTimeout(
      () => fallBack(`Worker antwortet seit ${JOB_TIMEOUT_MS / 1000} s nicht`),
      JOB_TIMEOUT_MS,
    );
    slot.timer.unref();
    const message: PasswordJobMessage = { id: slot.jobId, ...job.input };
    slot.worker.postMessage(message);
  }
}

function finish(slot: Slot, reply: PasswordJobReply): void {
  const job = slot.job;
  if (!job || reply.id !== slot.jobId) return;
  if (slot.timer) clearTimeout(slot.timer);
  slot.job = null;
  slot.timer = null;
  slot.worker.unref();
  if (reply.ok) job.resolve(reply.result);
  else job.reject(new Error(reply.error));
  pump();
}

/**
 * Ersatzbetrieb: alle Worker beenden, laufende und wartende Aufträge
 * synchron rechnen. Einmalig; ein zweiter Ausfall (etwa `exit` nach `error`)
 * ändert nichts mehr.
 */
function fallBack(reason: string): void {
  if (disabled) return;
  disabled = true;
  warn(
    `Passwortprüfung: ${reason}. Sie läuft bis zum nächsten Start synchron im Hauptprozess; ` +
      'Anmeldungen funktionieren weiter, blockieren aber währenddessen den Prozess.',
  );
  const pending: Job[] = [];
  for (const slot of slots ?? []) {
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.job) pending.push(slot.job);
    slot.job = null;
    void slot.worker.terminate().catch(() => undefined);
  }
  slots = [];
  pending.push(...queue.splice(0));
  for (const job of pending) runSync(job);
}
