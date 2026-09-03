import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import {
  type LocalCommitWithData,
  VersioningLocalService,
} from '../../../src/contexts/versioning-local';

const doltAvailable =
  (await $`which dolt`
    .quiet()
    .nothrow()
    .then((r) => r.exitCode === 0)) || Boolean(process.env.DELTIX_DOLT_BIN_PATH);

const DOLT_BIN = process.env.DELTIX_DOLT_BIN_PATH ?? 'dolt';
const REPO = 'idempotent-apply-repo';
const BRANCH = 'main';

function localService(homeDir: string): VersioningLocalService {
  return new VersioningLocalService({
    homeDir,
    binaryManager: { ensureInstalled: async () => DOLT_BIN },
  });
}

async function commitCount(dataDir: string): Promise<number> {
  const r =
    await $`${DOLT_BIN} --data-dir ${dataDir} sql -q ${`SELECT COUNT(*) AS n FROM dolt_log AS OF '${BRANCH}'`} -r csv`
      .quiet()
      .nothrow();
  const lines = r.stdout.toString().trim().split('\n');
  return Number(lines[lines.length - 1]);
}

describe.if(doltAvailable)('applyCommits() idempotency (real dolt binary)', () => {
  let homeDir: string;
  let dataDir: string;
  const identity = { repo: REPO, projectRoot: '/work/idempotent-apply-repo' };

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'deltix-idem-home-'));
    dataDir = computeLocalDataDir(homeDir, identity);
    await mkdir(dataDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('does not duplicate commits when the same server payload is applied twice', async () => {
    const service = localService(homeDir);

    const commits: LocalCommitWithData[] = [
      {
        hash: 'fakehash-1',
        message: 'add customers',
        author: 'deltix',
        tables: [
          {
            name: 'customers',
            schema: 'CREATE TABLE `customers` (`id` int NOT NULL, PRIMARY KEY (`id`));',
            data: 'id\n1\n',
          },
        ],
      },
    ];

    const firstHead = await service.applyCommits(identity, BRANCH, commits);
    expect(firstHead).toBeTruthy();
    const countAfterFirst = await commitCount(dataDir);

    // Simulate the server degrading to a full-history re-sync: it resends the
    // exact same commit(s) the client already applied. Without the idempotency
    // guard this would recreate the commit as a divergent duplicate.
    const secondHead = await service.applyCommits(identity, BRANCH, commits);
    const countAfterSecond = await commitCount(dataDir);

    expect(secondHead).toBe(firstHead);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('still applies genuinely new commits alongside already-known ones', async () => {
    const service = localService(homeDir);
    const countBefore = await commitCount(dataDir);

    const commits: LocalCommitWithData[] = [
      {
        hash: 'fakehash-1', // already applied above — must be skipped
        message: 'add customers',
        author: 'deltix',
        tables: [
          {
            name: 'customers',
            schema: 'CREATE TABLE `customers` (`id` int NOT NULL, PRIMARY KEY (`id`));',
            data: 'id\n1\n',
          },
        ],
      },
      {
        hash: 'fakehash-2', // new
        message: 'add orders',
        author: 'deltix',
        tables: [
          {
            name: 'orders',
            schema: 'CREATE TABLE `orders` (`id` int NOT NULL, PRIMARY KEY (`id`));',
            data: 'id\n1\n',
          },
        ],
      },
    ];

    await service.applyCommits(identity, BRANCH, commits);
    const countAfter = await commitCount(dataDir);

    expect(countAfter).toBe(countBefore + 1);
  });
});
