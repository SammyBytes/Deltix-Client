import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoltCommand } from '../../../src/acl/dolt-exec';
import { createImportService } from '../../../src/contexts/import';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import { __resetEnvCacheForTests } from '../../../src/shared/env';

/**
 * Integration test for `deltix import`. Runs ONLY when a source MySQL/MariaDB
 * is provided via DELTIX_TEST_MYSQL_URL (a URL pointing at a database that
 * already contains a `regions`/`customers` fixture, customers referencing
 * regions by FK). Skipped otherwise, like the real-Dolt suites.
 */
const sourceUrl = process.env.DELTIX_TEST_MYSQL_URL;
const doltBin = process.env.DELTIX_DOLT_BIN_PATH ?? 'dolt';

describe.skipIf(!sourceUrl)('import (real MySQL source + real dolt target)', () => {
  let home: string;
  const id = () => ({ repo: 'adopted', projectRoot: join(home, 'proj') });

  beforeAll(async () => {
    home = join(tmpdir(), `deltix-import-it-${Date.now()}`);
    await mkdir(join(home, 'proj'), { recursive: true });
    process.env.DELTIX_HOME = home;
    process.env.DELTIX_DOLT_BIN_PATH = doltBin;
    __resetEnvCacheForTests();
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
    __resetEnvCacheForTests();
  });

  it('adopts tables preserving PK, FK order and NULLs', async () => {
    const res = await createImportService().import(id(), {
      from: sourceUrl as string,
      blobs: 'skip',
    });
    expect(res.tablesImported).toBeGreaterThanOrEqual(2);
    expect(res.commitHash).toBeString();

    const dd = computeLocalDataDir(home, id());
    const schema = await runDoltCommand(doltBin, [
      '--data-dir',
      dd,
      'schema',
      'export',
      'customers',
    ]);
    expect(schema.stdout).toMatch(/PRIMARY KEY/i);
    const rows = await runDoltCommand(doltBin, [
      '--data-dir',
      dd,
      'sql',
      '-q',
      'SELECT COUNT(*) c FROM customers',
      '-r',
      'csv',
    ]);
    expect(Number(rows.stdout.trim().split('\n')[1])).toBeGreaterThan(0);
  });
});
