/**
 * Argumentleser, absichtlich derselbe schlichte Stil wie in
 * apps/backend/src/scripts/license-tool.ts: `--name wert` und `--flag`,
 * Mehrfachangaben sammeln sich (`--feature a --feature b`). Kein neues
 * npm-Paket fuer zwanzig Zeilen.
 */
export interface Args {
  positional: string[];
  values: Record<string, string>;
  many: Record<string, string[]>;
  flags: Set<string>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const many: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next;
      (many[name] ??= []).push(next);
      i++;
    } else {
      flags.add(name);
    }
  }
  return { positional, values, many, flags };
}

export function required(args: Args, name: string, hint: string): string {
  const value = args.values[name];
  if (value === undefined || value === '') {
    throw new Error(`--${name} fehlt. ${hint}`);
  }
  return value;
}
