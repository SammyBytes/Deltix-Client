import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileBranch } from '../../../src/cli/commands/remote';
import { createLocalProjectService } from '../../../src/contexts/local-project';
import type { VersioningLocalService } from '../../../src/contexts/versioning-local';

/**
 * Regression test for the "branch config vs. actually-checked-out branch"
 * mismatch reported on issue #57 after upgrading to v0.8.8: a project bound
 * *before* the CLI started persisting the checked-out branch can have a
 * stale `.deltix/config.toml` (`branch: 'main'`, the schema default) even
 * though the working copy has genuinely been on another branch (e.g.
 * `sync-develop-base`) the whole time. `reconcileBranch()` must prefer what
 * is actually checked out on disk over the persisted-but-stale config value,
 * and fix the config so future runs don't need to reconcile again.
 */
describe('cli/commands/remote reconcileBranch (unit)', () => {
  it('prefers the actually-checked-out branch over a stale config value, and persists it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-reconcile-'));
    const originalCwd = process.cwd();
    try {
      const service = createLocalProjectService();
      await service.init(root, 'hmc-sync');
      // Simulate the pre-v0.8.8 world: config still says 'main' (the schema
      // default), even though the user has actually been on
      // 'sync-develop-base' the whole time (never persisted before v0.8.8).
      process.chdir(root);

      const fakeLocal = {
        getCurrentBranch: async () => 'sync-develop-base',
        renameSyncStateBranch: async () => {},
      } as unknown as VersioningLocalService;

      const branch = await reconcileBranch({ repo: 'hmc-sync', branch: 'main' }, fakeLocal);

      expect(branch).toBe('sync-develop-base');

      // Config should now be fixed for next time.
      const project = await service.resolve(root);
      expect(project.config.branch).toBe('sync-develop-base');
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates the persisted sync state to the corrected branch name so the next pull negotiates correctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-reconcile-'));
    const originalCwd = process.cwd();
    try {
      const service = createLocalProjectService();
      await service.init(root, 'hmc-sync');
      process.chdir(root);

      const calls: Array<{ oldBranch: string; newBranch: string }> = [];
      const fakeLocal = {
        getCurrentBranch: async () => 'sync-develop-base',
        renameSyncStateBranch: async (_id: unknown, oldBranch: string, newBranch: string) => {
          calls.push({ oldBranch, newBranch });
        },
      } as unknown as VersioningLocalService;

      await reconcileBranch({ repo: 'hmc-sync', branch: 'main' }, fakeLocal);

      // Regression guard for issue #57 "bug #5": renaming the branch in
      // config without also re-keying the sync state file made the very
      // next pull believe the client had never synced, causing the entire
      // commit history to be re-applied with brand-new hashes.
      expect(calls).toEqual([{ oldBranch: 'main', newBranch: 'sync-develop-base' }]);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the config branch when it already matches what is checked out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-reconcile-'));
    const originalCwd = process.cwd();
    try {
      const service = createLocalProjectService();
      await service.init(root, 'hmc-sync');
      await service.setBranch(root, 'sync-develop-base');
      process.chdir(root);

      const fakeLocal = {
        getCurrentBranch: async () => 'sync-develop-base',
      } as unknown as VersioningLocalService;

      const branch = await reconcileBranch(
        { repo: 'hmc-sync', branch: 'sync-develop-base' },
        fakeLocal,
      );

      expect(branch).toBe('sync-develop-base');
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the config branch when no local server is reachable (getCurrentBranch returns null)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-reconcile-'));
    const originalCwd = process.cwd();
    try {
      const service = createLocalProjectService();
      await service.init(root, 'hmc-sync');
      process.chdir(root);

      const fakeLocal = {
        getCurrentBranch: async () => null,
      } as unknown as VersioningLocalService;

      const branch = await reconcileBranch({ repo: 'hmc-sync', branch: 'main' }, fakeLocal);

      expect(branch).toBe('main');
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
