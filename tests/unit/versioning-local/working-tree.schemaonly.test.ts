import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import type { BinaryManager } from '../../../src/contexts/binary-manager';
import { computeLocalDataDir } from '../../../src/contexts/mysql-embedded';
import { CommitEmptyError, VersioningLocalService } from '../../../src/contexts/versioning-local';

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

async function sql(dir: string, query: string, format = '') {
  const args = ['--data-dir', dir, 'sql', '-q', query];
  if (format) args.push('-r', format);
  return (await $`dolt ${args}`.quiet().nothrow()).stdout.toString();
}

describe.skipIf(!hasDolt)('versioning-local commit --schema-only (real dolt)', () => {
  it('commits only DDL tables and leaves data-only tables uncommitted', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-schemaonly-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await sql(dir, 'CREATE TABLE seed (id INT PRIMARY KEY, v VARCHAR(20))');
      await sql(dir, 'CREATE TABLE audit (ts INT PRIMARY KEY, msg VARCHAR(50))');
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      // Seed: schema change (index). Audit: data-only noise.
      await sql(dir, 'ALTER TABLE seed ADD INDEX idx_v (v)');
      await sql(dir, "INSERT INTO audit VALUES (1, 'noise')");

      const result = await service.commitSchemaOnly(identity, 'schema-only: index on seed');

      expect(result.schemaTables).toEqual(['seed']);
      expect(result.dataOnlyTables).toEqual(['audit']);
      const schema = await sql(dir, 'SHOW CREATE TABLE seed');
      expect(schema).toContain('idx_v');
      // audit rows were NOT published.
      const status = await sql(dir, 'SELECT table_name, status, staged FROM dolt_status');
      expect(status).toContain('audit');
      expect(status).toContain('modified');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('publishes a NEW table with schema and rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-schemaonly-new-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await sql(dir, 'CREATE TABLE seed (id INT PRIMARY KEY)');
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await sql(dir, 'CREATE TABLE runtime_log (id INT PRIMARY KEY, msg VARCHAR(50))');
      await sql(dir, "INSERT INTO runtime_log VALUES (1, 'initial')");

      const result = await service.commitSchemaOnly(identity, 'schema-only: add runtime_log');

      expect(result.schemaTables).toContain('runtime_log');
      const schema = await sql(dir, 'SHOW CREATE TABLE runtime_log');
      expect(schema).toContain('msg');
      // Rows published with the new table (schema + rows decision).
      const count = await sql(dir, 'SELECT COUNT(*) AS c FROM runtime_log', 'csv');
      expect(count).toContain('1');
      const status = await sql(dir, 'SELECT table_name FROM dolt_status');
      expect(status.trim()).toBe('');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('fails with CommitEmptyError when only row changes are pending', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-schemaonly-empty-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await sql(dir, 'CREATE TABLE audit (ts INT PRIMARY KEY)');
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await sql(dir, 'INSERT INTO audit VALUES (1)');

      await expect(
        service.commitSchemaOnly(identity, 'schema-only: nothing schema'),
      ).rejects.toThrow(CommitEmptyError);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('dataOnlyChanges() reports the tables whose only change is rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-dataonly-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await sql(dir, 'CREATE TABLE seed (id INT PRIMARY KEY, v VARCHAR(20))');
      await sql(dir, 'CREATE TABLE audit (ts INT PRIMARY KEY)');
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await sql(dir, 'ALTER TABLE seed ADD INDEX idx_v (v)');
      await sql(dir, 'INSERT INTO audit VALUES (1)');

      expect(await service.dataOnlyChanges(identity)).toEqual(['audit']);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe.skipIf(!hasDolt)('versioning-local reset --data / keep-schema (real dolt)', () => {
  it('resets rows but keeps a pending schema change and resets data-only tables', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-resetdata-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await sql(dir, 'CREATE TABLE seed (id INT PRIMARY KEY, v VARCHAR(20))');
      await sql(dir, 'CREATE TABLE audit (ts INT PRIMARY KEY, msg VARCHAR(50))');
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      // Seed: schema + data change. Audit: data-only change.
      await sql(dir, 'ALTER TABLE seed ADD COLUMN c2 INT DEFAULT 42');
      await sql(dir, "INSERT INTO seed VALUES (2, 'tmp', 99)");
      await sql(dir, "INSERT INTO audit VALUES (1, 'noise')");

      const { tables } = await service.resetDataKeepSchema(identity);

      expect(tables.sort()).toEqual(['audit', 'seed']);
      // Schema change survives (uncommitted, still present).
      const schema = await sql(dir, 'SHOW CREATE TABLE seed');
      expect(schema).toContain('c2');
      // Rows reset to HEAD.
      const seedCount = await sql(dir, 'SELECT COUNT(*) AS c FROM seed', 'csv');
      expect(seedCount).toContain('0');
      const auditCount = await sql(dir, 'SELECT COUNT(*) AS c FROM audit', 'csv');
      expect(auditCount).toContain('0');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);

  it('leaves an added table untouched (no HEAD rows to regress)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'deltix-resetdata-added-'));
    const identity = { repo: 'demo', projectRoot: join(homeDir, 'work') };
    try {
      const service = new VersioningLocalService(makeDeps(homeDir));
      await service.initLocalRepo(identity);
      const dir = computeLocalDataDir(homeDir, identity);

      await sql(dir, 'CREATE TABLE seed (id INT PRIMARY KEY)');
      await $`dolt --data-dir ${dir} add .`.quiet().nothrow();
      await $`dolt --data-dir ${dir} commit -m 'baseline'`.quiet().nothrow();
      await sql(dir, 'CREATE TABLE extra (id INT PRIMARY KEY, v VARCHAR(20))');
      await sql(dir, "INSERT INTO extra VALUES (1, 'kept')");

      const { tables } = await service.resetDataKeepSchema(identity);

      expect(tables).not.toContain('extra');
      const count = await sql(dir, 'SELECT COUNT(*) AS c FROM extra', 'csv');
      expect(count).toContain('1');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30000);
});
