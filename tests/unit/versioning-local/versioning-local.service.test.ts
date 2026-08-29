import { describe, expect, it } from 'bun:test';
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
});
