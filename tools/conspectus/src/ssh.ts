/**
 * ssh und scp mit ARGUMENT-ARRAYS, nie als Shell-String.
 *
 * Der Grund ist nicht Stil: In den Argumenten stehen Kundenschluessel,
 * Hostnamen und Dateipfade aus dem Register. Ein Schluessel mit einem
 * Semikolon oder Backtick darin waere in einem Shell-String ein zweiter
 * Befehl auf einem fremden Server. Mit einem Array gibt es keine Shell, die
 * etwas interpretieren koennte.
 *
 * BatchMode=yes: Kein interaktives Passwort und keine Frage nach einem
 * unbekannten Hostschluessel. Ein Rollout, der auf eine Eingabe wartet,
 * haengt sonst mitten in einer Schleife ueber zwanzig Instanzen.
 */
import { spawnSync } from 'node:child_process';

export interface HostTarget {
  id: string;
  adresse: string;
  ssh_benutzer: string;
  ssh_port: number;
  /** Privater Schluessel fuer diesen Host (-i); null = Standardschluessel des Aufrufers. */
  ssh_schluessel?: string | null;
}

export interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
}

function baseOptions(host: HostTarget): string[] {
  const options = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];
  if (host.ssh_schluessel) {
    // IdentitiesOnly: sonst probiert ssh zuerst die Standardschluessel und
    // laeuft bei vielen Schluesseln in "Too many authentication failures".
    options.push('-i', host.ssh_schluessel, '-o', 'IdentitiesOnly=yes');
  }
  return options;
}

/** Befehl auf dem Host ausfuehren. `command` ist ein Array, kein String. */
export function runRemote(host: HostTarget, command: string[]): RemoteResult {
  const args = [...baseOptions(host), '-p', String(host.ssh_port), `${host.ssh_benutzer}@${host.adresse}`, ...command];
  const res = spawnSync('ssh', args, { encoding: 'utf8' });
  if (res.error) {
    return { code: 127, stdout: '', stderr: `ssh liess sich nicht starten: ${res.error.message}` };
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Datei auf den Host kopieren. */
export function copyToRemote(host: HostTarget, localFile: string, remotePath: string): RemoteResult {
  const args = [
    ...baseOptions(host),
    '-P', String(host.ssh_port),
    localFile,
    `${host.ssh_benutzer}@${host.adresse}:${remotePath}`,
  ];
  const res = spawnSync('scp', args, { encoding: 'utf8' });
  if (res.error) {
    return { code: 127, stdout: '', stderr: `scp liess sich nicht starten: ${res.error.message}` };
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function sshAvailable(): boolean {
  const res = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  return !res.error;
}
