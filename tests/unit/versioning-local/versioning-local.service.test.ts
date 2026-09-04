import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BinaryManager } from '../../../src/contexts/binary-manager';
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
