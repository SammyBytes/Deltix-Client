import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServerIdentity } from '../../../src/cli/helpers/repo';
import { createLocalProjectService } from '../../../src/contexts/local-project';
import { DEFAULT_BRANCH } from '../../../src/shared/constants';

/**
 * Regression test for the bug where `pull`/`push`/`fetch` always operated on
 * `main` regardless of the project's actual bound branch (e.g.
 * `sync-develop-base`), because `resolveServerIdentity()` never surfaced the
 * persisted `branch` from `.deltix/config.toml`. See issue #57.
 */
describe('cli/helpers/repo resolveServerIdentity (unit)', () => {
  it('returns the project-bound branch, not DEFAULT_BRANCH, once checked out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-identity-'));
    const originalCwd = process.cwd();
    try {
      const service = createLocalProjectService();
      await service.init(root, 'acme-widgets');
      await service.setBranch(root, 'sync-develop-base');

      process.chdir(root);
      const identity = await resolveServerIdentity(undefined);

      expect(identity).not.toBeNull();
      expect(identity?.repo).toBe('acme-widgets');
      expect(identity?.branch).toBe('sync-develop-base');
      expect(identity?.branch).not.toBe(DEFAULT_BRANCH);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to DEFAULT_BRANCH when a bare --repo is given with no bound project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deltix-identity-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      const identity = await resolveServerIdentity('some-other-repo');

      expect(identity).not.toBeNull();
      expect(identity?.repo).toBe('some-other-repo');
      expect(identity?.branch).toBe(DEFAULT_BRANCH);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
