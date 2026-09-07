import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { BinaryManager } from '../../../src/contexts/binary-manager';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import { VersioningLocalService } from '../../../src/contexts/versioning-local';

function makeDeps(homeDir: string) {
  return {
    homeDir,
    binaryManager: { ensureInstalled: async () => '/usr/bin/dolt' } as Pick<
      BinaryManager,
      'ensureInstalled'
    >,
  };
}

const hasDolt = await (async () => {
  try {
    const probe = await $`which dolt`.quiet().nothrow();
    return probe.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDolt)('versioning-local reset/clean working tree (real dolt)', () => {
  it('resetWorkingSet({hard}) discards tracked changes but not untracked tables', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-reset-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      // Baseline committed table + an uncommitted tracked change.
      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))'`
        .quiet()
        .nothrow();
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await $`dolt --data-dir ${dir} sql -q "INSERT INTO t VALUES (1, 'dirty')"`.quiet().nothrow();
      // Untracked table: reset --hard must NOT touch it (git semantics).
      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE runtime_only (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();

      const { tables } = await service.resetWorkingSet(identity, { hard: true });

      expect(tables).toContain('t');
      expect(tables).not.toContain('runtime_only');
      const rows = (
        await $`dolt --data-dir ${dir} sql -q 'SELECT COUNT(*) AS c FROM t' -r csv`
          .quiet()
          .nothrow()
      ).stdout.toString();
      expect(rows).toContain('0');
      const status = (await $`dolt --data-dir ${dir} status`.quiet().nothrow()).stdout.toString();
      // Tracked change discarded; untracked table survived for `clean`.
      expect(status).not.toContain('modified');
      expect(status).toContain('runtime_only');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('resetWorkingSet() (mixed) unstages but keeps working values', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-reset-mix-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE t (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await $`dolt --data-dir ${dir} sql -q 'INSERT INTO t VALUES (1)'`.quiet().nothrow();
      await $`dolt --data-dir ${dir} add t`.quiet().nothrow();

      const stagedBefore = (
        await $`dolt --data-dir ${dir} sql -q 'SELECT staged FROM dolt_status' -r csv`
          .quiet()
          .nothrow()
      ).stdout.toString();
      expect(stagedBefore).toContain('1');

      const { tables } = await service.resetWorkingSet(identity, { hard: false });
      expect(tables).toContain('t');

      const stagedAfter = (
        await $`dolt --data-dir ${dir} sql -q 'SELECT staged FROM dolt_status' -r csv`
          .quiet()
          .nothrow()
      ).stdout.toString();
      expect(stagedAfter).toContain('0');
      expect(stagedAfter).not.toContain('1');
      // Working value survives the mixed reset.
      const rows = (
        await $`dolt --data-dir ${dir} sql -q 'SELECT COUNT(*) AS c FROM t' -r csv`
          .quiet()
          .nothrow()
      ).stdout.toString();
      expect(rows).toContain('1');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('cleanWorkingSet() deletes untracked tables and keeps tracked working changes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-clean-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE t (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await $`dolt --data-dir ${dir} sql -q 'INSERT INTO t VALUES (1)'`.quiet().nothrow();
      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE runtime_a (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();
      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE runtime_b (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();

      const { tables, dryRun } = await service.cleanWorkingSet(identity, { dryRun: false });

      expect(dryRun).toBe(false);
      expect(tables.sort()).toEqual(['runtime_a', 'runtime_b']);
      const tablesAfter = (
        await $`dolt --data-dir ${dir} sql -q 'SHOW TABLES'`.quiet().nothrow()
      ).stdout.toString();
      expect(tablesAfter).not.toContain('runtime_a');
      expect(tablesAfter).not.toContain('runtime_b');
      // Tracked table with uncommitted work is untouched by clean.
      expect(tablesAfter).toContain('t');
      const rows = (
        await $`dolt --data-dir ${dir} sql -q 'SELECT COUNT(*) AS c FROM t' -r csv`
          .quiet()
          .nothrow()
      ).stdout.toString();
      expect(rows).toContain('1');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('cleanWorkingSet({dryRun:true}) lists untracked tables without deleting', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-clean-dry-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE t (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await $`dolt --data-dir ${dir} sql -q 'CREATE TABLE runtime_x (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();

      const { tables, dryRun } = await service.cleanWorkingSet(identity, { dryRun: true });

      expect(dryRun).toBe(true);
      expect(tables).toEqual(['runtime_x']);
      const tablesAfter = (
        await $`dolt --data-dir ${dir} sql -q 'SHOW TABLES'`.quiet().nothrow()
      ).stdout.toString();
      expect(tablesAfter).toContain('runtime_x');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('resetWorkingSet({hard}) on a clean repo reports no tables', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-reset-clean-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      await $`dolt --data-dir ${computeLocalDataDir(homeDir, identity)} sql -q 'CREATE TABLE t (id INT PRIMARY KEY)'`
        .quiet()
        .nothrow();
      const { tables } = await service.resetWorkingSet(identity, { hard: true });
      expect(tables).toEqual([]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);
});
