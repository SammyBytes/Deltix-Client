import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { BinaryManager } from '../../../src/contexts/binary-manager';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import {
  CommitDataDirNotFoundError,
  VersioningLocalService,
} from '../../../src/contexts/versioning-local';

function makeDeps(homeDir: string) {
  return {
    homeDir,
    binaryManager: { ensureInstalled: async () => '/usr/bin/dolt' } as Pick<
      BinaryManager,
      'ensureInstalled'
    >,
  };
}

describe('versioning-local/versioning-local.service (unit)', () => {
  it('commit() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.commit({ repo: 'ghost', projectRoot: '/work/ghost' }, 'msg'),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('getUnpushedCommits() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.getUnpushedCommits({ repo: 'ghost', projectRoot: '/work/ghost' }),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('getBranchHead() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.getBranchHead({ repo: 'ghost', projectRoot: '/work/ghost' }),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('advanceRemoteRef() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.advanceRemoteRef({ repo: 'ghost', projectRoot: '/work/ghost' }, 'main', 'abc123'),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('getRemoteHead() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.getRemoteHead({ repo: 'ghost', projectRoot: '/work/ghost' }),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('applyCommits() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.applyCommits({ repo: 'ghost', projectRoot: '/work/ghost' }, 'main', []),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('mergeFromRemote() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.mergeFromRemote({ repo: 'ghost', projectRoot: '/work/ghost' }),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  it('mergeAbort() throws CommitDataDirNotFoundError when data dir does not exist', async () => {
    const service = new VersioningLocalService(makeDeps('/nonexistent'));
    await expect(
      service.mergeAbort({ repo: 'ghost', projectRoot: '/work/ghost' }),
    ).rejects.toBeInstanceOf(CommitDataDirNotFoundError);
  });

  describe('saveSyncState / readSyncState', () => {
    it('round-trips serverHead for a given branch', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      // Initially null (no file).
      expect(await service.readSyncState(id, 'main')).toBeNull();

      // Write and read back.
      await service.saveSyncState(id, 'main', 'abc123');
      expect(await service.readSyncState(id, 'main')).toBe('abc123');

      // Different branch returns null.
      expect(await service.readSyncState(id, 'develop')).toBeNull();

      await rm(homeDir, { recursive: true, force: true });
    });

    it('overwrites previous state on second save', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      await service.saveSyncState(id, 'main', 'first');
      await service.saveSyncState(id, 'main', 'second');
      expect(await service.readSyncState(id, 'main')).toBe('second');

      await rm(homeDir, { recursive: true, force: true });
    });

    it('returns null for corrupted file', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      // Write garbage into the sync-state path.
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dataDir = join(homeDir, 'projects', 'somehash', 'testrepo');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, '.deltix-sync-state'), '{bad json', 'utf-8');

      expect(await service.readSyncState(id, 'main')).toBeNull();

      await rm(homeDir, { recursive: true, force: true });
    });
  });

  describe('renameSyncStateBranch', () => {
    it('re-keys existing state from oldBranch to newBranch, preserving serverHead', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      await service.saveSyncState(id, 'main', 'abc123');
      await service.renameSyncStateBranch(id, 'main', 'sync-develop-base');

      // Regression guard for issue #57 "bug #5": after reconcileBranch()
      // corrects a stale branch name, the next getRemoteHead() call must
      // still find the previously-recorded serverHead under the corrected
      // branch — otherwise the client looks never-synced and the server
      // re-applies the entire commit history with brand-new hashes.
      expect(await service.readSyncState(id, 'sync-develop-base')).toBe('abc123');
      expect(await service.readSyncState(id, 'main')).toBeNull();

      await rm(homeDir, { recursive: true, force: true });
    });

    it('is a no-op when there is no existing state file', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      await expect(
        service.renameSyncStateBranch(id, 'main', 'sync-develop-base'),
      ).resolves.toBeUndefined();
      expect(await service.readSyncState(id, 'sync-develop-base')).toBeNull();

      await rm(homeDir, { recursive: true, force: true });
    });

    it('is a no-op when the state is keyed under a different branch than oldBranch', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      await service.saveSyncState(id, 'other-branch', 'xyz789');
      await service.renameSyncStateBranch(id, 'main', 'sync-develop-base');

      expect(await service.readSyncState(id, 'other-branch')).toBe('xyz789');
      expect(await service.readSyncState(id, 'sync-develop-base')).toBeNull();

      await rm(homeDir, { recursive: true, force: true });
    });

    it('is a no-op when oldBranch and newBranch are the same', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'deltix-test-'));
      const service = new VersioningLocalService(makeDeps(homeDir));
      const id = { repo: 'testrepo', projectRoot: '/work/testrepo' };

      await service.saveSyncState(id, 'main', 'abc123');
      await service.renameSyncStateBranch(id, 'main', 'main');
      expect(await service.readSyncState(id, 'main')).toBe('abc123');

      await rm(homeDir, { recursive: true, force: true });
    });
  });
});

const hasDolt = await (async () => {
  try {
    const probe = await $`which dolt`.quiet().nothrow();
    return probe.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDolt)('versioning-local DWIM checkout (real dolt)', () => {
  // Each case spawns ~15-20 `dolt` processes; the default 5s test timeout is
  // too tight under load, so these get an explicit 30s budget.
  it('creates the local branch at origin/<branch> instead of the current head', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-dwim-checkout-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      // A remote branch exists only as a fetched origin ref (e.g. turned into
      // a branch that never materialized locally — issue #57 scenario).
      await $`dolt --data-dir ${dir} checkout -b feature`.quiet().nothrow();
      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE t (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'feat: the remote head'`.quiet().nothrow();
      const featureHead = (
        await $`dolt --data-dir ${dir} rev-parse feature`.quiet().nothrow()
      ).stdout
        .toString()
        .trim();
      await $`dolt --data-dir ${dir} checkout main`.quiet().nothrow();
      // The local branch is missing; only origin/<branch> is materialized.
      await $`dolt --data-dir ${dir} branch origin/dwim-target feature`.quiet().nothrow();

      await service.checkout(identity, 'dwim-target');

      const current = (
        await $`dolt --data-dir ${dir} branch --show-current`.quiet().nothrow()
      ).stdout
        .toString()
        .trim();
      const head = (await $`dolt --data-dir ${dir} rev-parse dwim-target`.quiet().nothrow()).stdout
        .toString()
        .trim();
      expect(current).toBe('dwim-target');
      // Regression: creating at the current (main) head would give a
      // divergent branch that then can never fast-forward on push.
      expect(head).toBe(featureHead);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('bootstraps an apply onto a never-materialized branch from the root commit', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-dwim-server-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      // Branch + origin ref do NOT exist locally (server-only branch, DWIM
      // checkout path): applyCommits must bootstrap from the repo root commit.
      await service.applyCommits(identity, 'origin/server-branch', [
        {
          message: 'feat: from the server',
          author: 'alice',
          tables: [{ name: 't', schema: 'CREATE TABLE t (id INT PRIMARY KEY)', data: 'id\n1' }],
        },
      ]);

      const log = (
        await $`dolt --data-dir ${dir} log origin/server-branch --oneline`.quiet().nothrow()
      ).stdout.toString();
      expect(log).toContain('feat: from the server');

      // DWIM-checking out the branch now creates the local branch at that ref.
      await service.checkout(identity, 'server-branch');
      const current = (
        await $`dolt --data-dir ${dir} branch --show-current`.quiet().nothrow()
      ).stdout
        .toString()
        .trim();
      expect(current).toBe('server-branch');
      const count = (
        await $`dolt --data-dir ${dir} sql -q 'SELECT COUNT(*) AS c FROM t' -r csv`
          .quiet()
          .nothrow()
      ).stdout.toString();
      expect(count).toContain('1');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);
});
