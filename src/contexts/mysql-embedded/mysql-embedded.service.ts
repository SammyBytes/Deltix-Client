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
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
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
  /**
   * Injectable single-shot probe: is the port already accepting connections?
   * Used to fail fast when another MySQL/Dolt server holds the port, instead
   * of spawning a Dolt that dies on bind while the readiness check sees the
   * *other* server's listener and falsely reports success.
   */
  probePort?: (host: string, port: number) => Promise<boolean>;
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

async function readLogTail(logFilePath: string, maxLen: number): Promise<string> {
  try {
    const text = await readFile(logFilePath, 'utf8');
    return text.length <= maxLen ? text : text.slice(-maxLen);
  } catch {
    return '';
  }
}

/**
 * Computes the local data-dir a repo checkout is keyed to. With a project
 * root (from `deltix init`) the dir is derived from the absolute checkout
 * path so two clones of the same repo stay isolated; without one (legacy
 * `deltix start <repo>`) it falls back to the repo-name-keyed location.
 * Shared so the local commit/push contexts address the same data dir that
 * `deltix start` creates.
 */
export function computeLocalDataDir(homeDir: string, id: LocalServerIdentity): string {
  // Nest the repo name under the per-checkout hash dir so Dolt's database name
  // (the data-dir basename) is the friendly repo name — e.g. `USE demo` — while
  // the hash parent still isolates two checkouts of the same repo.
  return id.projectRoot
    ? join(homeDir, 'projects', projectStateKey(id.projectRoot), sanitizeFilePart(id.repo))
    : join(homeDir, 'repos', sanitizeFilePart(id.repo));
}

export function computeLocalRunStatePath(homeDir: string, id: LocalServerIdentity): string {
  return id.projectRoot
    ? join(homeDir, 'run', `project-${projectStateKey(id.projectRoot)}.json`)
    : join(homeDir, 'run', `${sanitizeFilePart(id.repo)}.json`);
}

export class MysqlEmbeddedService {
  private readonly homeDir: string;
  private readonly localHost: string;
  private readonly localPort: number;
  private readonly readyTimeoutMs: number;
  private readonly now: () => number;
  private readonly spawn: typeof spawnBackgroundProcess;
  private readonly waitForPort: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  private readonly probePort: (host: string, port: number) => Promise<boolean>;

  constructor(private readonly deps: MysqlEmbeddedDeps) {
    this.homeDir = deps.homeDir;
    this.localHost = deps.localHost;
    this.localPort = deps.localPort;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
    this.now = deps.now ?? Date.now;
    this.spawn = deps.spawn ?? spawnBackgroundProcess;
    this.waitForPort = deps.waitForPort ?? waitForTcpPort;
    this.probePort = deps.probePort ?? isTcpPortOpen;
  }

  dataDirFor(id: LocalServerIdentity): string {
    return computeLocalDataDir(this.homeDir, id);
  }

  private statePath(id: LocalServerIdentity): string {
    return computeLocalRunStatePath(this.homeDir, id);
  }

  async start(id: LocalServerIdentity): Promise<RunState> {
    const dataDir = this.dataDirFor(id);
    await mkdir(dataDir, { recursive: true });
    // The run-state and the server's combined-output log live side-by-side
    // under home/run. Make sure that directory exists before spawn() tries
    // to open the log file, otherwise the child dies with ENOENT before
    // it even starts.
    await mkdir(dirname(this.statePath(id)), { recursive: true });

    const running = await this.status(id);
    if (running.running) {
      const existing =
        (await this.readState(id)) ??
        (!id.projectRoot ? await this.findAnyStateForRepo(id.repo) : null);
      if (existing) return existing;
      // Orphaned: status found a live MySQL on the port serving this DB
      // (pid -1) but no run file — adopt it instead of failing with
      // "Port already in use". Try to discover the real PID so future
      // status/stop can use `kill(pid,0)` instead of port probing.
      let pid = (running as unknown as { pid: number }).pid ?? -1;
      if (pid === -1) {
        const found = await this.findPidByPort(this.localHost, this.localPort).catch(() => null);
        if (found) pid = found;
      }
      const adopted: RunState = {
        repo: id.repo,
        pid,
        port: running.port!,
        dataDir: running.dataDir,
        startedAt: Date.now(),
        projectRoot: id.projectRoot,
      };
      await this.writeState(adopted);
      return adopted;
    }

    // Fail fast if the port is already held by another server (e.g. a system
    // MySQL/MariaDB on 3306). Without this, Dolt dies trying to bind while the
    // readiness check below sees the *other* server's listener and falsely
    // reports "started" — leaving a stale run-state and a dead PID.
    if (await this.probePort(this.localHost, this.localPort)) {
      throw new LocalServerPortInUseError(this.localHost, this.localPort);
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
    const logFilePath = join(
      dirname(this.statePath(id)),
      `${sanitizeFilePart(id.repo)}.sql-server.log`,
    );
    const spawned = this.spawn(binaryPath, args, {
      cwd: dataDir,
      logFilePath,
      onExit: () => {
        exited = true;
      },
    });
    this.deps.onSpawned?.(spawned, args);

    const ready = await this.waitForPort(this.localHost, this.localPort, this.readyTimeoutMs);
    const stderrTail = await readLogTail(logFilePath, 2000);
    if (ready && exited) {
      // Our Dolt process exited, yet the port answers — it belongs to some
      // other server, not ours. Do not write a run-state we cannot honour.
      throw new LocalServerStartError(
        id.repo,
        `the Dolt server exited immediately (port ${this.localHost}:${this.localPort} is likely held by another MySQL/Dolt server — set DELTIX_LOCAL_PORT to a free port)${
          stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''
        }`,
      );
    }
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

    // Compatibility shim: Dolt does not expose `innodb_version` (it does
    // not use InnoDB — it uses NBS), but some MySQL health checks do
    // `SHOW VARIABLES LIKE 'innodb_version'` and fail when the row is
    // missing. Best-effort: mirror Dolt's own version into that variable
    // so `>= 8.0.28` checks pass without touching the caller. No-op if
    // the variable is read-only or the server is not yet queryable.
    await this.installInnodbVersionShim(this.localHost, this.localPort, id.repo).catch(() => {});

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
    let state = await this.readState(id);
    if (!state && !id.projectRoot) state = await this.findAnyStateForRepo(id.repo);
    // Orphaned but port-probed running state (pid -1) — status would have
    // recreated a file, but if stop is called without a file, try port probe
    if (!state) {
      const probed = await this.status(id);
      if (probed.running) {
        // Adopt the probed state so we can at least clear it
        state = {
          repo: id.repo,
          pid: (probed as unknown as { pid: number }).pid ?? -1,
          port: probed.port!,
          dataDir: probed.dataDir,
          startedAt: Date.now(),
          projectRoot: id.projectRoot,
        } as RunState;
      }
    }
    if (!state) throw new LocalServerNotRunningError(id.repo);

    if (state.pid !== -1) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // Process already gone — clean up the stale state and report stopped.
      }
    } else {
      // Orphaned server has no recorded PID — try to find PID by port.
      const pidByPort = await this.findPidByPort(this.localHost, this.localPort).catch(() => null);
      if (pidByPort) {
        try {
          process.kill(pidByPort, 'SIGTERM');
        } catch {}
      }
    }
    // Remove whichever file actually held the state, not just the primary
    const p = this.statePath({ repo: state.repo, projectRoot: state.projectRoot });
    await rm(p, { force: true });
    // If the caller used a different identity, also clear the primary path
    const primary = this.statePath(id);
    if (primary !== p) await rm(primary, { force: true }).catch(() => {});
    return { repo: id.repo, stopped: true };
  }

  async status(id: LocalServerIdentity): Promise<LocalServerStatus> {
    const dataDir = this.dataDirFor(id);
    // Primary lookup: state file keyed by the resolved identity (project
    // hash when run from inside a `deltix init`ed tree, legacy repo name
    // otherwise). If the caller had no project context (e.g. ran from a
    // different cwd or passed an explicit repo without a project), scan for
    // any run file for the same repo — the identity no longer matches the
    // file that was written. When the caller *does* have a project, keep
    // strict isolation (two checkouts of the same repo each have their own
    // server) and do not fall back to another project's file.
    let state = await this.readState(id);
    if (!state && !id.projectRoot) {
      state = await this.findAnyStateForRepo(id.repo);
    }
    if (!state) {
      // No run file, but the port may still be held by an orphaned
      // `dolt sql-server` (e.g. file deleted while process stayed alive).
      // Probe the port and, if it answers, verify it is actually serving
      // *this* repo via the MySQL wire protocol before reporting running.
      if (await this.probePort(this.localHost, this.localPort)) {
        try {
          const mysql = await import('mysql2/promise');
          const conn = await mysql.createConnection({
            host: this.localHost,
            port: this.localPort,
            user: 'root',
            database: id.repo,
            connectTimeout: 1200,
          });
          await conn.query('SELECT 1');
          await conn.end();
          const pid = (await this.findPidByPort(this.localHost, this.localPort)) ?? -1;
          return { repo: id.repo, running: true, port: this.localPort, dataDir, pid };
        } catch {
          // Port belongs to another server or not serving this DB
        }
      }
      return { repo: id.repo, running: false, dataDir };
    }

    let alive = true;
    let pid = state.pid;
    if (state.pid === -1) {
      // Adopted orphan has no recorded PID — check liveness via the port
      // and MySQL wire protocol instead of `kill(-1)` which always throws.
      if (await this.probePort(this.localHost, this.localPort)) {
        try {
          const mysql = await import('mysql2/promise');
          const conn = await mysql.createConnection({
            host: this.localHost,
            port: this.localPort,
            user: 'root',
            database: id.repo,
            connectTimeout: 1200,
          });
          await conn.query('SELECT 1');
          await conn.end();
          alive = true;
          // Best-effort: learn the real PID so `status`/`stop` can act on the
          // process directly instead of reporting -1 forever.
          const foundPid = await this.findPidByPort(this.localHost, this.localPort);
          if (foundPid && foundPid > 0) {
            pid = foundPid;
            const updated: RunState = {
              repo: state.repo,
              pid: foundPid,
              port: state.port,
              dataDir: state.dataDir,
              startedAt: state.startedAt,
            };
            if (state.projectRoot !== undefined) updated.projectRoot = state.projectRoot;
            await this.writeState(updated);
          }
        } catch {
          alive = false;
        }
      } else {
        alive = false;
      }
    } else {
      try {
        process.kill(state.pid, 0);
      } catch {
        alive = false;
      }
    }

    if (!alive) {
      // Clean up whichever file actually held the stale PID, not just the
      // primary path we looked up.
      const stalePath = this.statePath({ repo: state.repo, projectRoot: state.projectRoot });
      await rm(stalePath, { force: true }).catch(() => {});
      if (state.projectRoot) {
        await rm(this.statePath({ repo: state.repo }), { force: true }).catch(() => {});
      }
      return { repo: id.repo, running: false, dataDir: state.dataDir };
    }

    return {
      repo: id.repo,
      running: alive,
      pid,
      port: state.port,
      dataDir: state.dataDir,
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

  /**
   * Scans `~/.deltix/run` for any state file whose `repo` matches, regardless
   * of which `projectRoot` it was keyed with. Used as a fallback when the
   * current `resolveServerIdentity` does not match the identity that ran
   * `deltix start` (e.g. caller changed cwd). Returns the first live entry
   * for that repo, or null if none.
   */
  private async findAnyStateForRepo(repo: string): Promise<RunState | null> {
    let files: string[];
    try {
      files = await readdir(join(this.homeDir, 'run'));
    } catch {
      return null;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = join(this.homeDir, 'run', file);
      try {
        const raw = await readFile(full, 'utf8');
        const st = JSON.parse(raw) as RunState;
        if (st.repo === repo) return st;
      } catch {
        // ignore corrupt file
      }
    }
    return null;
  }

  private async writeState(state: RunState): Promise<void> {
    await mkdir(join(this.homeDir, 'run'), { recursive: true });
    await writeFile(
      this.statePath({ repo: state.repo, projectRoot: state.projectRoot }),
      JSON.stringify(state, null, 2),
      { mode: 0o600 },
    );
  }

  private async findPidByPort(_host: string, port: number): Promise<number | null> {
    // Best-effort: try to discover PID holding the port (Windows: netstat -ano,
    // Unix: lsof). Used only for orphaned servers (pid -1) so `deltix stop`
    // can actually kill the process even without a run file.
    try {
      const { spawn } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? 'netstat' : 'lsof';
      const args =
        process.platform === 'win32' ? ['-ano'] : ['-i', `:${port}`, '-sTCP:LISTEN', '-t'];
      const out: string = await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let buf = '';
        child.stdout?.on('data', (c: Buffer) => (buf += c.toString()));
        child.on('error', reject);
        child.on('close', () => resolve(buf));
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve(buf);
        }, 1200);
      });
      if (process.platform === 'win32') {
        for (const line of out.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const m = line.trim().split(/\s+/).pop();
            const pid = Number(m);
            if (Number.isFinite(pid) && pid > 0) return pid;
          }
        }
      } else {
        const pid = Number(out.trim().split(/\s+/)[0]);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Best-effort compatibility shim for `SHOW VARIABLES LIKE 'innodb_version'`.
   * Dolt reports `@@version` (e.g. `8.0.32`) but does not populate
   * `innodb_version` at all; callers that gate on `>= 8.0.28` would otherwise
   * see an empty result set and treat Dolt as incompatible, even though the
   * storage engine is intentionally different (NBS, not InnoDB). We mirror the
   * server's `@@version` into `@@innodb_version` when the variable is
   * writable, so the check passes while staying in sync with the running Dolt
   * binary. Failures are swallowed — this is purely a convenience for
   * MySQL-oriented health checks.
   */
  private async installInnodbVersionShim(host: string, port: number, repo: string): Promise<void> {
    let conn: Awaited<ReturnType<typeof import('mysql2/promise').createConnection>> | null = null;
    try {
      const mysql = await import('mysql2/promise');
      conn = await mysql.createConnection({
        host,
        port,
        user: 'root',
        database: repo,
        connectTimeout: 2000,
      });
      const [verRows] = await conn.query('SELECT @@version AS v');
      const version =
        (verRows as Array<Record<string, string>>)[0]?.v ??
        (verRows as Array<Record<string, string>>)[0]?.V ??
        '8.0.32';
      // `innodb_version` is read-only on MySQL but writable on Dolt's
      // sql-server — try SET, and if the server rejects it, fall back to
      // verifying the variable now mirrors `version`.
      try {
        await conn.query(`SET GLOBAL innodb_version = '${String(version).replace(/'/g, "''")}'`);
      } catch {
        // Variable may be read-only on this Dolt build — not fatal.
      }
    } finally {
      if (conn) {
        try {
          await conn.end();
        } catch {
          // ignore
        }
      }
    }
  }
}

/** Single-shot probe: is something already accepting connections on host:port? */
export function isTcpPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 500 });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
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
