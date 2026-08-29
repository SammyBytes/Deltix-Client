/**
 * Human-friendly CLI output layer, built on `consola`.
 *
 * The CLI previously piped every command result (success or failure)
 * through the Pino structured logger, so a normal `deltix repo list` printed
 * a raw JSON log line instead of readable text — fine for a server
 * ingesting logs, unusable for an interactive operator typing commands by
 * hand (see user feedback: "me devuelve JSONs y es incomodo de usar").
 *
 * This module is presentation-only and deliberately separate from
 * `shared/logger.ts` (Pino): Pino remains available for any future
 * structured/diagnostic logging need, while this module is the single
 * place responsible for what a human sees on the terminal after running a
 * `deltix` command.
 */
import { createInterface } from 'node:readline';
import { consola } from 'consola';

/** Prints a one-line success message, optionally followed by key/value details. */
export function printSuccess(message: string, details?: Record<string, unknown>): void {
  consola.success(message);
  if (details) printKeyValues(details);
}

/** Prints a one-line informational message (e.g. "Not logged in"). */
export function printInfo(message: string): void {
  consola.info(message);
}

/** Prints a user-facing error message. Never used for stack traces/internals. */
export function printError(message: string): void {
  consola.error(message);
}

/** Prints `key: value` lines for a flat object, skipping `undefined` fields. */
export function printKeyValues(data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    consola.log(`  ${key}: ${formatValue(value)}`);
  }
}

/**
 * Prints a simple aligned table for an array of flat records. Falls back to
 * a plain "(none)" line for empty input instead of printing an empty table.
 */
export function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    consola.log('  (none)');
    return;
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>()),
  );

  const cellText = (row: Record<string, unknown>, col: string) => formatValue(row[col] ?? '');

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cellText(row, col).length)),
  );

  const renderRow = (cells: string[]) =>
    `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')}`;

  consola.log(renderRow(columns));
  consola.log(renderRow(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) {
    consola.log(renderRow(columns.map((col) => cellText(row, col))));
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Prompts the user for free-text input (e.g. interactive `deltix configure`). */
export async function promptText(
  message: string,
  opts: { default?: string } = {},
): Promise<string> {
  const answer = await rawPrompt(
    `${message}${opts.default !== undefined ? ` (${opts.default})` : ''}: `,
  );
  const trimmed = answer.trim();
  return trimmed !== '' ? trimmed : (opts.default ?? '');
}

/** Prompts the user for a yes/no confirmation (e.g. trusting a fetched certificate). */
export async function promptConfirm(
  message: string,
  opts: { default?: boolean } = {},
): Promise<boolean> {
  const hint = opts.default === undefined || opts.default === false ? ' (y/N)' : ' (Y/n)';
  const answer = await rawPrompt(`${message}${hint}: `);
  const normalized = answer.trim().toLowerCase();
  if (normalized === '') return opts.default ?? false;
  return ['y', 'yes'].includes(normalized);
}

/**
 * Reads one line from the user via `node:readline` with a stable error
 * handler on both streams.
 *
 * `consola.prompt` (used previously) crashed with an unhandled
 * `EPIPE: broken pipe` on the compiled Windows binary — its prompt writes
 * through a layer that can have its output stream closed mid-prompt, which
 * surfaces as an EPIPE on Windows consoles / Bun single-file executables.
 * A raw `node:readline` interface over `process.stdin`/`process.stdout`,
 * with `error` listeners attached to both, is stable across Linux,
 * macOS and Windows terminals.
 */
function rawPrompt(query: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const onError = () => {}; // swallow EPIPE on Windows consoles
  input.on('error', onError);
  output.on('error', onError);
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    let settled = false;
    const done = (ans: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      input.off('error', onError);
      output.off('error', onError);
      resolve(ans);
    };
    // If stdin is not an interactive terminal (piped/closed, e.g. running
    // unattended in CI), readline never receives a line and the prompt would
    // hang forever. Resolve with an empty answer so callers fall back to their
    // default — matching the "press Enter to keep the default" behaviour.
    if (!input.isTTY) {
      done('');
      return;
    }
    rl.question(query, done);
    rl.on('close', () => done(''));
  });
}

/** Prints the plain usage/help lines (no color coding needed here). */
export function printLines(lines: string[]): void {
  for (const line of lines) consola.log(line);
}
