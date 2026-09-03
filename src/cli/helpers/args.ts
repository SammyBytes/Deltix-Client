/**
 * CLI arg helpers — pure, no I/O.
 * Kept here so commands stay thin and testable.
 */

export function splitPositionalsAndFlags(args: string[]): {
  positionals: string[];
  flags: string[];
} {
  const positionals: string[] = [];
  const flags: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('-')) {
      flags.push(args[i]);
      if (!args[i].includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.push(args[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      positionals.push(args[i]);
      i += 1;
    }
  }
  return { positionals, flags };
}

export function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

export function flagMulti(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith(`--${name}=`)) {
      out.push(a.slice(name.length + 3));
    } else if (a === `--${name}` && args[i + 1]) {
      out.push(args[i + 1] as string);
    }
  }
  return out;
}

/**
 * Reads a CLI flag value in three forms:
 *   `--limit=5`, `--limit 5`, `-n 5`
 */
export function parseFlagValue(args: string[], flagName: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${flagName}=`));
  if (eq) return eq.slice(flagName.length + 3);
  const li = args.indexOf(`--${flagName}`);
  if (li >= 0 && li + 1 < args.length) return args[li + 1];
  if (flagName.length === 1) {
    const si = args.indexOf(`-${flagName}`);
    if (si >= 0 && si + 1 < args.length) return args[si + 1];
  }
  return undefined;
}

export function normalizeTables(args: string[]): string[] | null {
  return args.length > 0 ? args : null;
}
