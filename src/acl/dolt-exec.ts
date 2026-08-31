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
import { openSync } from 'node:fs';

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

export interface BackgroundProcess {
  pid: number;
  /**
   * A live stream of the child's stderr, only available when no
   * `logFilePath` was supplied. When the output is redirected to a file
   * this is `null` and the caller should read the file instead.
   */
  stderr: import('node:stream').Readable | null;
  /**
   * Absolute path to the file that receives the child's combined output,
   * or `null` when output is exposed via the `stderr` stream.
   */
  logFilePath: string | null;
}

/**
 * Spawns an external executable as a detached background process (for a
 * long-running server like `dolt sql-server`) and returns its PID plus a way
 * to read its diagnostics. The child is `unref`'d so it keeps running after
 * this process exits; the caller owns lifecycle management (PID file,
 * `stop`), via `process.kill`.
 *
 * Why a log file? Capturing both stdout and stderr via pipes (`pipe`) looks
 * tidy, but Node pipes have a finite kernel buffer (~64 KiB) and the child
 * receives SIGPIPE the moment it overflows. Dolt writes heartbeats to
 * stdout during normal operation; the moment the buffer fills and the
 * parent process is no longer actively draining (very common for a one-shot
 * `start` CLI that exits after `waitForPort`), Dolt is killed and you see
 * a "lost connection at handshake" right where you expected the server to
 * stay up. Redirecting both streams to a regular file removes that pressure
 * entirely and gives operators a post-mortem log to inspect.
 *
 * Same argv-array-only contract as `runCommand` (no shell string).
 */
export function spawnBackgroundProcess(
  binaryPath: string,
  args: string[],
  options: {
    cwd?: string;
    onExit?: (code: number | null, signal: string | null) => void;
    logFilePath?: string;
  } = {},
): BackgroundProcess {
  const stdio: ['ignore', 'pipe' | number, 'pipe' | number] = options.logFilePath
    ? ['ignore', openSync(options.logFilePath, 'a'), openSync(options.logFilePath, 'a')]
    : ['ignore', 'pipe', 'pipe'];
  const child = spawn(binaryPath, args, {
    cwd: options.cwd,
    env: { ...process.env },
    detached: true,
    stdio,
    windowsHide: true,
  });
  child.unref();
  if (options.onExit) {
    child.on('exit', (code, signal) => {
      options.onExit?.(code, signal ? signal.toString() : null);
    });
  }
  return {
    pid: child.pid ?? -1,
    stderr: options.logFilePath ? null : (child.stderr as import('node:stream').Readable),
    logFilePath: options.logFilePath ?? null,
  };
}
