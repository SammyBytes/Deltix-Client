import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runDoltCommand } from '../../acl/dolt-exec';
import type { BinaryManager } from '../binary-manager';
import type { LocalServerIdentity } from '../mysql-embedded';
import { computeLocalDataDir } from '../mysql-embedded';
import {
  CommitDataDirNotFoundError,
  CommitEmptyError,
  CommitError,
  LocalRepoInitError,
  PushEmptyError,
  PushError,
} from './versioning-local.errors';

export interface LocalCommitResult {
  commitHash: string;
  repo: string;
}

export interface LocalCommitWithData {
  message: string;
  author: string;
  tables: { name: string; data: string }[];
}

export interface VersioningLocalDeps {
  homeDir: string;
  binaryManager: Pick<BinaryManager, 'ensureInstalled'>;
}

interface DoltLogRow {
  commit_hash: string;
  message: string;
  author: string;
}

/**
 * Remote-tracking refs follow the Git convention: a local Dolt branch named
 * `origin/<branch>` mirrors the last-known server state of `<branch>`. It is
 * advanced only after a successful push/fetch, never committed to directly —
 * exactly how `git` treats `origin/main`.
 */
function remoteRefName(branch: string): string {
  return `origin/${branch}`;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export class VersioningLocalService {
  constructor(private readonly deps: VersioningLocalDeps) {}

  /**
   * Commits staged changes in the local Dolt data dir for the given repo
   * identity. When `tables` is provided, only those tables are staged
   * (`dolt add <tables...>`); otherwise everything is staged (`dolt add -A`).
   *
   * Self-heals an uninitialized repo: `deltix start` creates the data dir but
   * the first `commit` runs `dolt init` if there is no repo yet.
   */
  async commit(
    id: LocalServerIdentity,
    message: string,
    tables?: string[],
  ): Promise<LocalCommitResult> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);

    // Stage: allow-list (tables) or full working tree.
    const stageArgs = tables && tables.length > 0 ? ['add', ...tables] : ['add', '-A'];
    const addResult = await runDoltCommand(binaryPath, ['--data-dir', dataDir, ...stageArgs], {
      timeoutMs: 30_000,
    });
    if (addResult.exitCode !== 0) {
      throw new CommitError('add', addResult.stderr);
    }

    // Commit — may fail with exit code 1 if there are no staged changes.
    const commitResult = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'commit', '-m', message, '--author=deltix <deltix@deltix.local>'],
      { timeoutMs: 30_000 },
    );
    if (commitResult.exitCode !== 0) {
      const output = (commitResult.stdout + commitResult.stderr).trim();
      if (output.includes('no changes')) {
        throw new CommitEmptyError(id.repo);
      }
      throw new CommitError('commit', commitResult.stderr.trim() || commitResult.stdout.trim());
    }

    const commitHash = await this.readLatestHash(binaryPath, dataDir);
    if (!commitHash) {
      throw new CommitEmptyError(id.repo);
    }

    return { commitHash, repo: id.repo };
  }

  /**
   * Returns the commits on the current branch that are not yet present on its
   * remote-tracking ref `origin/<branch>`, each carrying the table data at
   * that commit's state. This is the data-collection step for `deltix push`.
   *
   * When there is no `origin/<branch>` yet (first push to a repo the server
   * has never seen), the full history is returned — mirroring how the first
   * `git push` sends every commit. The `dolt init` commit (no parents, no
   * tables) is skipped, so an empty repo reports "nothing to push".
   */
  async getUnpushedCommits(
    id: LocalServerIdentity,
    branch = 'main',
  ): Promise<LocalCommitWithData[]> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);

    const synced = await this.getRemoteRefHash(binaryPath, dataDir, branch);
    const where = synced
      ? `WHERE commit_hash NOT IN (SELECT commit_hash FROM dolt_log AS OF '${escapeSql(remoteRefName(branch))}')`
      : '';
    const rows = await this.queryLog(
      binaryPath,
      dataDir,
      `SELECT commit_hash, message, author FROM dolt_log ${where} ORDER BY commit_order ASC`,
    );

    const commits: LocalCommitWithData[] = [];
    for (const row of rows) {
      const tableNames = await this.getChangedTables(binaryPath, dataDir, row.commit_hash);
      // Skips the `dolt init` commit (no parent → empty diff) and any commit
      // that changed no tracked table — there is nothing to send for those.
      if (tableNames.length === 0) {
        continue;
      }
      const tableData: { name: string; data: string }[] = [];
      for (const table of tableNames) {
        const data = await this.exportTableAtCommit(binaryPath, dataDir, table, row.commit_hash);
        tableData.push({ name: table, data });
      }
      commits.push({ message: row.message, author: row.author, tables: tableData });
    }

    if (commits.length === 0) {
      throw new PushEmptyError(id.repo);
    }
    return commits;
  }

  /** Current head hash of a local branch (or `null` if it does not exist). */
  async getBranchHead(id: LocalServerIdentity, branch = 'main'): Promise<string | null> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    return this.readBranchHash(binaryPath, dataDir, branch);
  }

  /**
   * Advance the remote-tracking ref `origin/<branch>` to `hash` (create it if
   * missing). Called after a successful push/fetch so the next one only sends
   * new work. Never touches the local branch itself.
   */
  async advanceRemoteRef(id: LocalServerIdentity, branch: string, hash: string): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'branch', '-f', remoteRefName(branch), hash],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) {
      throw new PushError('branch', result.stderr.trim() || result.stdout.trim());
    }
  }

  /**
   * Create the local Dolt repo if it does not exist yet (idempotent). This is
   * the "git init" moment, invoked by `deltix init`, and also called
   * defensively by commit/push so a repo is always present before any
   * versioning command runs. `dolt init` returns exit 0 ("already
   * initialized") when the repo already exists, even while `deltix start`
   * holds it open.
   */
  async initLocalRepo(id: LocalServerIdentity): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    await mkdir(dataDir, { recursive: true });
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
  }

  /**
   * Idempotent `dolt init`: creates the repo + default `main` branch if absent.
   * `dolt init` requires an identity, so `--name/--email` are passed explicitly
   * (a fresh machine has no ambient Dolt/Git config to fall back on).
   */
  private async ensureLocalRepo(binaryPath: string, dataDir: string, repo: string): Promise<void> {
    if (existsSync(join(dataDir, '.dolt'))) {
      return;
    }
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'init', '--name', 'deltix', '--email', 'deltix@deltix.local'],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new LocalRepoInitError(repo, result.stderr.trim() || result.stdout.trim());
    }
  }

  private async getRemoteRefHash(
    binaryPath: string,
    dataDir: string,
    branch: string,
  ): Promise<string | null> {
    return this.readBranchHash(binaryPath, dataDir, remoteRefName(branch));
  }

  private async readBranchHash(
    binaryPath: string,
    dataDir: string,
    branch: string,
  ): Promise<string | null> {
    const result = await runDoltCommand(
      binaryPath,
      [
        '--data-dir',
        dataDir,
        'sql',
        '-q',
        `SELECT hash FROM dolt_branches WHERE name = '${escapeSql(branch)}'`,
        '-r',
        'csv',
      ],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) {
      return null;
    }
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const hash = lines[1]?.trim(); // [0] is the "hash" header
    return hash && hash.length > 0 ? hash : null;
  }

  private async readLatestHash(binaryPath: string, dataDir: string): Promise<string | null> {
    const rows = await this.queryLog(
      binaryPath,
      dataDir,
      'SELECT commit_hash FROM dolt_log ORDER BY commit_order DESC LIMIT 1',
    );
    return rows[0]?.commit_hash ?? null;
  }

  private async queryLog(
    binaryPath: string,
    dataDir: string,
    query: string,
  ): Promise<DoltLogRow[]> {
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'sql', '-q', query, '-r', 'json'],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new PushError('log', result.stderr.trim() || result.stdout.trim());
    }
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return [];
    }
    const parsed = JSON.parse(trimmed) as { rows?: DoltLogRow[] };
    return parsed.rows ?? [];
  }

  private async getChangedTables(
    binaryPath: string,
    dataDir: string,
    commitHash: string,
  ): Promise<string[]> {
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'diff', '--name-only', `${commitHash}^..${commitHash}`],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async exportTableAtCommit(
    binaryPath: string,
    dataDir: string,
    table: string,
    commitHash: string,
  ): Promise<string> {
    const result = await runDoltCommand(
      binaryPath,
      [
        '--data-dir',
        dataDir,
        'sql',
        '-q',
        `SELECT * FROM ${table} AS OF '${escapeSql(commitHash)}'`,
        '-r',
        'csv',
      ],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new PushError('sql export', result.stderr);
    }
    return result.stdout;
  }
}
