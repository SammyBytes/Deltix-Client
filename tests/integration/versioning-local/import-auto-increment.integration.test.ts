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
const REPO = 'auto-inc-import-repo';

function localService(homeDir: string): VersioningLocalService {
  return new VersioningLocalService({
    homeDir,
    binaryManager: { ensureInstalled: async () => DOLT_BIN },
  });
}

async function lastInsertedId(dataDir: string): Promise<number> {
  const r =
    await $`${DOLT_BIN} --data-dir ${dataDir} sql -q "INSERT INTO gadgets (name) VALUES ('x'); SELECT LAST_INSERT_ID() AS id;" -r csv`
      .quiet()
      .nothrow();
  const lines = r.stdout.toString().trim().split('\n');
  return Number(lines[lines.length - 1]);
}

describe.if(doltAvailable)('bulkImportTables() preserves AUTO_INCREMENT (real dolt binary)', () => {
  let homeDir: string;
  let dataDir: string;
  const identity = { repo: REPO, projectRoot: '/work/auto-inc-import-repo' };

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'deltix-ai-home-'));
    dataDir = computeLocalDataDir(homeDir, identity);
    await mkdir(dataDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('after importing rows with explicit PKs, the next omit-PK INSERT gets id 6 (not 1)', async () => {
    const service = localService(homeDir);

    // Source DDL declares AUTO_INCREMENT=6 (one row has id=5, so 6 is next).
    // Mirrors the MySQL `SHOW CREATE TABLE` fetch in the import adapter.
    await service.bulkImportTables(identity, [
      {
        name: 'gadgets',
        schema:
          'CREATE TABLE `gadgets` (`id` int NOT NULL AUTO_INCREMENT, `name` varchar(50), PRIMARY KEY (`id`)) ENGINE=InnoDB AUTO_INCREMENT=6;',
        csv: 'id,name\n5,widget\n',
        base64Columns: [],
      },
    ]);

    const nextId = await lastInsertedId(dataDir);
    expect(nextId).toBe(6);
  });
});
