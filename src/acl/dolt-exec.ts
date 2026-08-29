/**
 * Anti-Corruption Layer (ACL) adapter that shells out to the local `dolt`
 * binary (managed by the `binary-manager` context).
 *
 * This is the ONLY place in the codebase that spawns the Dolt CLI process
 * (per `copilot-instructions.md`: shelling to the binary-managed executable
 * belongs in an ACL adapter, and arguments must be passed as an argv array,
 * never as a concatenated shell string — OWASP A03 injection guard).
 *
 * The adapter stays intentionally thin and boring: it runs a `dolt`
 * subcommand with exact argv, captures stdout/stderr, and reports the exit
 * code. All Dolt-specific business decisions (which subcommand, valid ref
 * shapes, interpretation of output) live in the owning contexts.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

export interface DoltCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class DoltExecError extends Error {
  constructor(
    readonly args: string[],
    readonly result: DoltCommandResult,
  ) {
    super(
      `\`dolt ${args.join(' ')}\` exited with code ${result.exitCode}: ${
        result.stderr.trim() || '(no stderr)'
      }`,
    );
    this.name = 'DoltExecError';
  }
}

/**
 * Runs an external executable with the given binary path and argv array.
 * Resolves with the full result (stdout/stderr/exitCode) — callers decide
 * whether a non-zero exit is an error. Uses `spawn` with an argv array (never
 * `shell: true` / string concatenation) so no dynamic value can be
 * interpreted as a shell metacharacter.
 */
export function runCommand(
  binaryPath: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<DoltCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: options.cwd,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timeout = options.timeoutMs;
    const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : undefined;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}

/** Runs a `dolt` subcommand (thin alias of `runCommand`). */
export function runDoltCommand(
  binaryPath: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<DoltCommandResult> {
  return runCommand(binaryPath, args, options);
}

/**
 * Resolves the absolute path of `cmd` on `PATH`, or `null` when not found.
 * Never executes the command — this is only a lookup.
 */
export function whichBinary(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() || null : null));
  });
}

/**
 * Convenience wrapper that runs a `dolt` command and throws `DoltExecError`
 * on any non-zero exit code. Use this for commands where a non-zero exit
 * is always an error; use `runDoltCommand` directly when the caller handles
 * exit codes explicitly (e.g. "not found" style conditions).
 */
export async function runDoltOrThrow(
  binaryPath: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<string> {
  const result = await runDoltCommand(binaryPath, args, options);
  if (result.exitCode !== 0) {
    throw new DoltExecError(args, result);
  }
  return result.stdout;
}
