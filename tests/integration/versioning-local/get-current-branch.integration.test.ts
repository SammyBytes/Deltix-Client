import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import { VersioningLocalService } from '../../../src/contexts/versioning-local';

const doltAvailable =
  (await $`which dolt`
    .quiet()
    .nothrow()
    .then((r) => r.exitCode === 0)) || Boolean(process.env.DELTIX_DOLT_BIN_PATH);

const DOLT_BIN = process.env.DELTIX_DOLT_BIN_PATH ?? 'dolt';
const REPO = 'get-current-branch-repo';

function localService(homeDir: string): VersioningLocalService {
  return new VersioningLocalService({
    homeDir,
    binaryManager: { ensureInstalled: async () => DOLT_BIN },
  });
}

/**
 * Regression coverage for issue #57: `getCurrentBranch()` used to only try
 * the MySQL wire protocol against a running local `dolt sql-server`, and
 * returned `null` unconditionally if that connection failed — including
 * simply because no server happened to be running at the time. That meant
 * `reconcileBranch()` (the v0.8.9 fix for stale `.deltix/config.toml`
 * branch values) silently never fired for the common case of a client
 * running `pull`/`fetch` without an embedded server up, leaving a stale
 * `main` in the config trusted forever. `getCurrentBranch()` must fall
 * back to parsing `dolt branch -a` (like `listBranches()` already does)
 * when no server is reachable.
 */
describe.if(doltAvailable)('getCurrentBranch() CLI fallback (real dolt binary)', () => {
  let homeDir: string;
  let dataDir: string;
  const identity = { repo: REPO, projectRoot: '/work/get-current-branch-repo' };

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'deltix-current-branch-home-'));
    dataDir = computeLocalDataDir(homeDir, identity);
    await mkdir(dataDir, { recursive: true });
    await $`${DOLT_BIN} --data-dir ${dataDir} init --name deltix --email deltix@deltix.local`
      .quiet()
      .nothrow();
  });

  afterAll(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns the real checked-out branch via CLI when no sql-server is running', async () => {
    const service = localService(homeDir);

    // No sql-server is started in this test — getCurrentBranch() must not
    // just return null because the MySQL wire connection fails.
    const initial = await service.getCurrentBranch(identity);
    expect(initial).toBe('main');

    await $`${DOLT_BIN} --data-dir ${dataDir} branch sync-develop-base`.quiet().nothrow();
    await $`${DOLT_BIN} --data-dir ${dataDir} checkout sync-develop-base`.quiet().nothrow();

    const afterCheckout = await service.getCurrentBranch(identity);
    expect(afterCheckout).toBe('sync-develop-base');
  });

  it('returns null when the repo has no local data dir at all', async () => {
    const service = localService(homeDir);
    const ghost = await service.getCurrentBranch({
      repo: 'no-such-repo-anywhere',
      projectRoot: '/work/no-such-repo-anywhere',
    });
    expect(ghost).toBeNull();
  });
});
