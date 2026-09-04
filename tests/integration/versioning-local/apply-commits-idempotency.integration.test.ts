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

  it('leaves the branch untouched when a later commit in a batch fails to apply', async () => {
    const service = localService(homeDir);
    const countBefore = await commitCount(dataDir);

    const commits: LocalCommitWithData[] = [
      {
        hash: 'fakehash-ok',
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
        hash: 'fakehash-bad',
        message: 'add evil',
        author: 'deltix',
        tables: [
          {
            name: 'evil; DROP TABLE customers; --',
            schema: 'CREATE TABLE `x` (`id` int);',
            data: 'id\n1\n',
          },
        ],
      },
    ];

    // First table is valid, second has an unsafe name that importTable rejects.
    await expect(service.applyCommits(identity, BRANCH, commits)).rejects.toThrow();

    const countAfter = await commitCount(dataDir);
    expect(countAfter).toBe(countBefore);

    // The throwaway branch must be cleaned up.
    const branches = await $`${DOLT_BIN} --data-dir ${dataDir} branch -a`.quiet().nothrow();
    expect(branches.stdout.toString()).not.toContain('_deltix_pull_');
  });

  it('refuses to apply when the target table has uncommitted local changes (no data loss)', async () => {
    const service = localService(homeDir);
    const countBefore = await commitCount(dataDir);

    // Seed a fresh table with one committed row, then add an uncommitted row in
    // the same table the incoming commit will recreate.
    await service.applyCommits(identity, BRANCH, [
      {
        hash: 'fakehash-widgets-seed',
        message: 'seed widgets',
        author: 'deltix',
        tables: [
          {
            name: 'widgets',
            schema: 'CREATE TABLE `widgets` (`id` int NOT NULL, PRIMARY KEY (`id`));',
            data: 'id\n7\n',
          },
        ],
      },
    ]);
    const seeded =
      await $`${DOLT_BIN} --data-dir ${dataDir} sql -q "INSERT INTO widgets VALUES (99);"`
        .quiet()
        .nothrow();
    expect(seeded.exitCode).toBe(0);

    const commits: LocalCommitWithData[] = [
      {
        hash: 'fakehash-widgets-recreate',
        message: 'recreate widgets',
        author: 'deltix',
        tables: [
          {
            name: 'widgets',
            schema: 'CREATE TABLE `widgets` (`id` int NOT NULL, PRIMARY KEY (`id`));',
            data: 'id\n8\n',
          },
        ],
      },
    ];

    // Will touch `widgets`, which has an uncommitted row -> abort before touching.
    await expect(service.applyCommits(identity, BRANCH, commits)).rejects.toThrow();

    // Uncommitted row must survive untouched, and no commit should have happened.
    const rows = await $`${DOLT_BIN} --data-dir ${dataDir} sql -q "SELECT id FROM widgets" -r csv`
      .quiet()
      .nothrow();
    expect(rows.stdout.toString().trim().split('\n').slice(1)).toEqual(['7', '99']);
    expect(await commitCount(dataDir)).toBe(countBefore + 1);
  });
});
