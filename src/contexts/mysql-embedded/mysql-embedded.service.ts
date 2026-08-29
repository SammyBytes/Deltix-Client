/**
 * The "mysql-embedded" bounded context.
 *
 * Manages a local `dolt sql-server` process bound to loopback, one per local
 * repo checkout, so a developer can work against a real MySQL-compatible
 * Deltix database engine locally with zero dependency on a pre-installed
 * MySQL service on the host.
 *
 * Lifecycle:
 *   - `start(repo)`   resolves a Dolt binary (via binary-manager), spawns
 *                     `dolt sql-server --data-dir <home>/repos/<repo>` as a
 *                     detached background process, waits for the port to
 *                     accept connections, and records a run-state file.
 *   - `stop(repo)`    terminates the recorded PID and clears the run state.
 *   - `status(repo)`  reports whether the recorded process is alive and its
 *                     port is accepting connections.
 *
 * All process spawning and the only place that shells out to external
 * executables is `src/acl/dolt-exec.ts`; this context holds no direct
 * `spawn` calls. The binary path is resolved through the binary-manager
 * context (never guessed), satisfying the black-box/integrity policy.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { BackgroundProcess } from '../../acl/dolt-exec';
import { spawnBackgroundProcess } from '../../acl/dolt-exec';
import type { BinaryManager } from '../binary-manager';
import {
  LocalServerNotRunningError,
  LocalServerPortInUseError,
  LocalServerStartError,
} from './mysql-embedded.errors';

export interface LocalServerStatus {
  repo: string;
  running: boolean;
  port?: number;
  pid?: number;
  dataDir: string;
}

export interface RunState {
  repo: string;
  pid: number;
  port: number;
  dataDir: string;
  startedAt: number;
}

export interface MysqlEmbeddedDeps {
  /** Root state dir (DELTIX_HOME / `~/.deltix`). */
  homeDir: string;
  localHost: string;
  localPort: number;
  binaryManager: Pick<BinaryManager, 'ensureInstalled'>;
  /** Readiness wait timeout. */
  readyTimeoutMs?: number;
  now?: () => number;
  /** Injectable so a unit test can capture the spawned process. */
  spawn?: typeof spawnBackgroundProcess;
  /** Injectable so a unit test can fake port readiness. */
  waitForPort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Injectable for tests to observe cleanup. */
  onSpawned?: (process: BackgroundProcess, args: string[]) => void;
}

function sanitizeRepoDir(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class MysqlEmbeddedService {
  private readonly homeDir: string;
  private readonly localHost: string;
  private readonly localPort: number;
  private readonly readyTimeoutMs: number;
  private readonly now: () => number;
  private readonly spawn: typeof spawnBackgroundProcess;
  private readonly waitForPort: (host: string, port: number, timeoutMs: number) => Promise<boolean>;

  constructor(private readonly deps: MysqlEmbeddedDeps) {
    this.homeDir = deps.homeDir;
    this.localHost = deps.localHost;
    this.localPort = deps.localPort;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
    this.now = deps.now ?? Date.now;
    this.spawn = deps.spawn ?? spawnBackgroundProcess;
    this.waitForPort = deps.waitForPort ?? waitForTcpPort;
  }

  dataDirFor(repo: string): string {
    return join(this.homeDir, 'repos', sanitizeRepoDir(repo));
  }

  private statePath(repo: string): string {
    return join(this.homeDir, 'run', `${sanitizeRepoDir(repo)}.json`);
  }

  async start(repo: string): Promise<RunState> {
    const dataDir = this.dataDirFor(repo);
    await mkdir(dataDir, { recursive: true });

    const running = await this.status(repo);
    if (running.running) {
      const existing = await this.readState(repo);
      if (existing) return existing;
    }

    const existing = await this.readState(repo);
    if (existing) {
      // A stale state file points at a dead process; remove it before starting
      // fresh so an orphaned PID never blocks a clean start.
      await rm(this.statePath(repo), { force: true });
    }

    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    const args = [
      'sql-server',
      '--host',
      this.localHost,
      '--port',
      String(this.localPort),
      '--data-dir',
      dataDir,
      '--user',
      'root',
    ];

    const spawned = this.spawn(binaryPath, args, { cwd: dataDir });
    this.deps.onSpawned?.(spawned, args);

    const ready = await this.waitForPort(this.localHost, this.localPort, this.readyTimeoutMs);
    if (!ready) {
      try {
        process.kill(spawned.pid, 0); // throws ESRCH if the process already died
      } catch {
        throw new LocalServerStartError(
          repo,
          'the Dolt server process exited before becoming ready (see the server stderr for details)',
        );
      }
      throw new LocalServerPortInUseError(this.localHost, this.localPort);
    }

    const state: RunState = {
      repo,
      pid: spawned.pid,
      port: this.localPort,
      dataDir,
      startedAt: this.now(),
    };
    await this.writeState(state);
    return state;
  }

  async stop(repo: string): Promise<{ repo: string; stopped: boolean }> {
    const state = await this.readState(repo);
    if (!state) throw new LocalServerNotRunningError(repo);

    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // Process already gone — clean up the stale state and report stopped.
    }
    await rm(this.statePath(repo), { force: true });
    return { repo, stopped: true };
  }

  async status(repo: string): Promise<LocalServerStatus> {
    const dataDir = this.dataDirFor(repo);
    const state = await this.readState(repo);
    if (!state) {
      return { repo, running: false, dataDir };
    }

    let alive = true;
    try {
      process.kill(state.pid, 0);
    } catch {
      alive = false;
    }

    if (!alive) {
      await rm(this.statePath(repo), { force: true }).catch(() => {});
      return { repo, running: false, dataDir };
    }

    return {
      repo,
      running: alive,
      pid: state.pid,
      port: state.port,
      dataDir,
    };
  }

  private async readState(repo: string): Promise<RunState | null> {
    try {
      const raw = await readFile(this.statePath(repo), 'utf8');
      return JSON.parse(raw) as RunState;
    } catch {
      return null;
    }
  }

  private async writeState(state: RunState): Promise<void> {
    await mkdir(join(this.homeDir, 'run'), { recursive: true });
    await writeFile(this.statePath(state.repo), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}

/** Polls a TCP port until it accepts a connection or `timeoutMs` elapses. */
export function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    function attempt(): void {
      if (Date.now() > deadline) {
        finish(false);
        return;
      }
      const socket = connect({ host, port, timeout: 500 });
      socket.once('connect', () => {
        socket.destroy();
        finish(true);
      });
      socket.once('error', () => {
        socket.destroy();
        setTimeout(attempt, 250);
      });
      socket.once('timeout', () => {
        socket.destroy();
        setTimeout(attempt, 250);
      });
    }

    const timer = setTimeout(() => finish(false), timeoutMs);
    attempt();
  });
}
