/**
 * The "mysql-embedded" bounded context.
 *
 * Manages a local `dolt sql-server` process bound to loopback, one per local
 * repo checkout, so a developer can work against a real MySQL-compatible
 * Deltix database engine locally with zero dependency on a pre-installed
 * MySQL service on the host.
 *
 * Lifecycle:
 *   - `start({ repo, projectRoot? })`  resolves a Dolt binary (via
 *                     binary-manager), spawns `dolt sql-server` on the repo's
 *                     data dir as a detached background process, waits for the
 *                     port to accept connections, and records a run-state file.
 *   - `stop(...)`     terminates the recorded PID and clears the run state.
 *   - `status(...)`   reports whether the recorded process is alive and its
 *                     port is accepting connections.
 *
 * State isolation: when a `projectRoot` is provided (from a `deltix init`ed
 * working tree), both the data dir and the run-state are keyed off the
 * absolute project path rather than the repo name. This mirrors git clones —
 * two checkouts of the same repo can each run their own server without
 * colliding, and switching between projects never clobbers a running one.
 * Without a `projectRoot` (legacy `deltix start <repo>`), state is keyed by
 * repo name under `~/.deltix/repos/<repo>`, preserving the earlier behaviour.
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
import { projectStateKey } from '../local-project';
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
  projectRoot?: string;
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

/**
 * Identifies which local server is being addressed. `repo` is the Deltix repo
 * name (for display); `projectRoot`, when present, is the absolute path of the
 * `deltix init`ed working tree that state/data-dir should be keyed off.
 */
export interface LocalServerIdentity {
  repo: string;
  projectRoot?: string;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
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

  dataDirFor(id: LocalServerIdentity): string {
    // Per-checkout isolation: key off the project path so two clones of the
    // same repo don't share a data dir or collide on the run state.
    return id.projectRoot
      ? join(this.homeDir, 'projects', projectStateKey(id.projectRoot))
      : join(this.homeDir, 'repos', sanitizeFilePart(id.repo));
  }

  private statePath(id: LocalServerIdentity): string {
    return id.projectRoot
      ? join(this.homeDir, 'run', `project-${projectStateKey(id.projectRoot)}.json`)
      : join(this.homeDir, 'run', `${sanitizeFilePart(id.repo)}.json`);
  }

  async start(id: LocalServerIdentity): Promise<RunState> {
    const dataDir = this.dataDirFor(id);
    await mkdir(dataDir, { recursive: true });

    const running = await this.status(id);
    if (running.running) {
      const existing = await this.readState(id);
      if (existing) return existing;
    }

    const existing = await this.readState(id);
    if (existing) {
      // A stale state file points at a dead process; remove it before starting
      // fresh so an orphaned PID never blocks a clean start.
      await rm(this.statePath(id), { force: true });
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
    ];

    let exited = false;
    let stderrTail = '';
    const spawned = this.spawn(binaryPath, args, {
      cwd: dataDir,
      onExit: () => {
        exited = true;
      },
    });
    // Capture the server's stderr so a failed start surfaces the real reason
    // (Dolt writes fatal config errors here), not a generic timeout.
    spawned.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    this.deps.onSpawned?.(spawned, args);

    const ready = await this.waitForPort(this.localHost, this.localPort, this.readyTimeoutMs);
    if (!ready) {
      // Never leave an orphaned server behind. Decide the failure by whether
      // the process we spawned already exited, rather than probing its PID.
      if (exited) {
        throw new LocalServerStartError(
          id.repo,
          `the Dolt server process exited before becoming ready${
            stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''
          }`,
        );
      }
      try {
        process.kill(spawned.pid, 'SIGTERM');
      } catch {
        // Already gone — nothing to clean up.
      }
      throw new LocalServerPortInUseError(this.localHost, this.localPort);
    }

    const state: RunState = {
      repo: id.repo,
      pid: spawned.pid,
      port: this.localPort,
      dataDir,
      startedAt: this.now(),
      projectRoot: id.projectRoot,
    };
    await this.writeState(state);
    return state;
  }

  async stop(id: LocalServerIdentity): Promise<{ repo: string; stopped: boolean }> {
    const state = await this.readState(id);
    if (!state) throw new LocalServerNotRunningError(id.repo);

    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // Process already gone — clean up the stale state and report stopped.
    }
    await rm(this.statePath(id), { force: true });
    return { repo: id.repo, stopped: true };
  }

  async status(id: LocalServerIdentity): Promise<LocalServerStatus> {
    const dataDir = this.dataDirFor(id);
    const state = await this.readState(id);
    if (!state) {
      return { repo: id.repo, running: false, dataDir };
    }

    let alive = true;
    try {
      process.kill(state.pid, 0);
    } catch {
      alive = false;
    }

    if (!alive) {
      await rm(this.statePath(id), { force: true }).catch(() => {});
      return { repo: id.repo, running: false, dataDir };
    }

    return {
      repo: id.repo,
      running: alive,
      pid: state.pid,
      port: state.port,
      dataDir,
    };
  }

  private async readState(id: LocalServerIdentity): Promise<RunState | null> {
    try {
      const raw = await readFile(this.statePath(id), 'utf8');
      return JSON.parse(raw) as RunState;
    } catch {
      return null;
    }
  }

  private async writeState(state: RunState): Promise<void> {
    await mkdir(join(this.homeDir, 'run'), { recursive: true });
    await writeFile(
      this.statePath({ repo: state.repo, projectRoot: state.projectRoot }),
      JSON.stringify(state, null, 2),
      { mode: 0o600 },
    );
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
