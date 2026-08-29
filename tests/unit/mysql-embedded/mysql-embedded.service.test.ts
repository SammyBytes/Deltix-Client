import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundProcess } from '../../../src/acl/dolt-exec';
import type { BinaryManager } from '../../../src/contexts/binary-manager';
import {
  LocalServerNotRunningError,
  LocalServerStartError,
  type MysqlEmbeddedDeps,
  MysqlEmbeddedService,
} from '../../../src/contexts/mysql-embedded';

const REAL_ALIVE_PID = process.pid;
const DEAD_PID = 2_147_000_000;

function ensureInstalled(): Pick<BinaryManager, 'ensureInstalled'> {
  return { ensureInstalled: async () => '/fake/dolt' };
}

interface SpawnBehavior {
  pid: number;
  /** When true, the fake process reports an immediate exit via onExit. */
  exitImmediately?: boolean;
}

function makeService(
  overrides: Partial<MysqlEmbeddedDeps> = {},
  behavior: SpawnBehavior = { pid: process.pid },
): {
  service: MysqlEmbeddedService;
  spawnCalls: string[][];
} {
  const spawnCalls: string[][] = [];
  const waitForCalls: number[] = [];
  const service = new MysqlEmbeddedService({
    homeDir: overrides.homeDir ?? '/tmp/mysql-embedded-test',
    localHost: '127.0.0.1',
    localPort: 3306,
    binaryManager: ensureInstalled(),
    readyTimeoutMs: 100,
    spawn: (_bin, args, opts) => {
      spawnCalls.push(args);
      if (behavior.exitImmediately) opts?.onExit?.(0, null);
      return {
        pid: behavior.pid,
        stderr: new EventEmitter() as unknown as BackgroundProcess['stderr'],
      };
    },
    waitForPort: async () => {
      waitForCalls.push(1);
      return overrides.ready ?? true;
    },
    ...overrides,
  });
  return { service, spawnCalls };
}

describe('mysql-embedded/mysql-embedded.service (unit, mocks)', () => {
  it('start() spawns dolt sql-server, waits for the port, and records run state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-me-start-'));
    const { service, spawnCalls } = makeService({ homeDir: home });

    const state = await service.start('acme/widgets');

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]).toContain('sql-server');
    expect(spawnCalls[0]).toContain('--port');
    expect(spawnCalls[0]).toContain('3306');
    expect(spawnCalls[0]).toContain('--data-dir');
    // Dolt 2.3.x removed --user/--password from sql-server; never pass them.
    expect(spawnCalls[0]).not.toContain('--user');
    expect(state.pid).toBe(REAL_ALIVE_PID);
    expect(state.port).toBe(3306);

    const persisted = JSON.parse(
      await readFile(join(home, 'run', 'acme_widgets.json'), 'utf8'),
    ) as { pid: number; port: number };
    expect(persisted.pid).toBe(REAL_ALIVE_PID);
    expect(persisted.port).toBe(3306);

    await rm(home, { recursive: true, force: true });
  });

  it('start() reuses an already-running server (single spawn)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-me-rerun-'));
    const { service, spawnCalls } = makeService({ homeDir: home });

    await service.start('repo');
    await service.start('repo');

    expect(spawnCalls.length).toBe(1);
    await rm(home, { recursive: true, force: true });
  });

  it('start() reports a port already in use when readiness fails but the process is alive', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-me-timeout-'));
    const { service } = makeService({ homeDir: home, ready: false }, { pid: 8_999_999 });

    await expect(service.start('repo')).rejects.toThrow(/already in use/);
    await rm(home, { recursive: true, force: true });
  });

  it('start() reports the server exited when readiness fails and the process died', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-me-crashed-'));
    const { service } = makeService(
      { homeDir: home, ready: false },
      { pid: 8_999_999, exitImmediately: true },
    );

    await expect(service.start('repo')).rejects.toBeInstanceOf(LocalServerStartError);
    await rm(home, { recursive: true, force: true });
  });

  it('status() reports not running when there is no run state', async () => {
    const { service } = makeService();
    const status = await service.status('ghost');
    expect(status.running).toBe(false);
  });

  it('status() reports running when the recorded PID is alive', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-me-statuslive-'));
    const { service } = makeService({ homeDir: home });
    await service.start('repo');

    const status = await service.status('repo');
    expect(status.running).toBe(true);
    expect(status.pid).toBe(REAL_ALIVE_PID);
    await rm(home, { recursive: true, force: true });
  });

  it('stop() throws LocalServerNotRunningError with no state', async () => {
    const { service } = makeService();
    await expect(service.stop('nope')).rejects.toBeInstanceOf(LocalServerNotRunningError);
  });

  it('status() treats a stale (dead-PID) state as not running and cleans it up', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deltix-me-stale-'));
    const { service } = makeService({ homeDir: home });
    const statePath = join(home, 'run', 'stale.json');
    await mkdir(join(home, 'run'), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        repo: 'stale',
        pid: DEAD_PID,
        port: 3306,
        dataDir: join(home, 'repos', 'stale'),
        startedAt: 0,
      }),
    );

    const status = await service.status('stale');
    expect(status.running).toBe(false);

    let removed = false;
    try {
      await readFile(statePath);
    } catch {
      removed = true;
    }
    expect(removed).toBe(true);
    await rm(home, { recursive: true, force: true });
  });
});
