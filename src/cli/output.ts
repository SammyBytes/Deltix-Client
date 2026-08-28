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
  const answer = await consola.prompt(message, { type: 'text', default: opts.default });
  return typeof answer === 'string' ? answer : (opts.default ?? '');
}

/** Prompts the user for a yes/no confirmation (e.g. trusting a fetched certificate). */
export async function promptConfirm(
  message: string,
  opts: { default?: boolean } = {},
): Promise<boolean> {
  const answer = await consola.prompt(message, { type: 'confirm', default: opts.default ?? false });
  return typeof answer === 'boolean' ? answer : (opts.default ?? false);
}

/** Prints the plain usage/help lines (no color coding needed here). */
export function printLines(lines: string[]): void {
  for (const line of lines) consola.log(line);
}
