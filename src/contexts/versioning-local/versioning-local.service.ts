import { existsSync } from 'node:fs';
import { runDoltCommand } from '../../acl/dolt-exec';
import type { BinaryManager } from '../binary-manager';
import type { LocalServerIdentity } from '../mysql-embedded';
import { computeLocalDataDir } from '../mysql-embedded';
import {
  CommitDataDirNotFoundError,
  CommitEmptyError,
  CommitError,
  PushEmptyError,
  PushError,
  PushNoUpstreamError,
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

export class VersioningLocalService {
  constructor(private readonly deps: VersioningLocalDeps) {}

  /**
   * Commits staged changes in the local Dolt data dir for the given repo
   * identity. When `tables` is provided, only those tables are staged
   * (`dolt add <tables...>`); otherwise everything is staged (`dolt add -A`).
   *
   * The caller can omit `projectRoot` to fall back to the repo-name-keyed
   * path (legacy `deltix start <repo>`).
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

    // Stage: allow-list (tables) or full working tree.
    if (tables && tables.length > 0) {
      const addResult = await runDoltCommand(
        binaryPath,
        ['--data-dir', dataDir, 'add', ...tables],
        { timeoutMs: 30_000 },
      );
      if (addResult.exitCode !== 0) {
        throw new CommitError('add', addResult.stderr);
      }
    } else {
      const addResult = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'add', '-A'], {
        timeoutMs: 30_000,
      });
      if (addResult.exitCode !== 0) {
        throw new CommitError('add', addResult.stderr);
      }
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

    // Read the new commit hash via SQL (Dolt CLI doesn't support --format).
    const logResult = await runDoltCommand(
      binaryPath,
      [
        '--data-dir',
        dataDir,
        'sql',
        '-q',
        'SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1',
        '-r',
        'csv',
      ],
      { timeoutMs: 10_000 },
    );
    if (logResult.exitCode !== 0) {
      throw new CommitError('log', logResult.stderr);
    }
    const lines = logResult.stdout.trim().split('\n');
    const commitHash = lines[lines.length - 1]?.trim();
    if (!commitHash) {
      throw new CommitEmptyError(id.repo);
    }

    return { commitHash, repo: id.repo };
  }

  /**
   * Returns a list of commits on the current branch that are not present on
   * origin/main, each carrying the table data at that commit's state.
   *
   * This is the core data-collection step for `deltix push`.
   */
  async getUnpushedCommits(id: LocalServerIdentity): Promise<LocalCommitWithData[]> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }

    const binaryPath = await this.deps.binaryManager.ensureInstalled();

    // Verify origin/main exists as a reference
    const refResult = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'sql', '-q', "SELECT 1 FROM dolt_branches WHERE name = 'main'"],
      { timeoutMs: 10_000 },
    );
    if (refResult.exitCode !== 0) {
      throw new PushError('sql', refResult.stderr);
    }

    // List unpushed commits (oldest first) as hash|message|author
    const logResult = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'log', '--reverse', '--format=%H|%s|%an', 'origin/main..main'],
      { timeoutMs: 10_000 },
    );
    if (logResult.exitCode !== 0) {
      const output = (logResult.stdout + logResult.stderr).trim();
      if (output.includes('unknown ref') || output.includes('does not exist')) {
        throw new PushNoUpstreamError(id.repo);
      }
      throw new PushError('log', logResult.stderr.trim() || logResult.stdout.trim());
    }

    const rawLines = logResult.stdout.trim().split('\n').filter(Boolean);
    if (rawLines.length === 0) {
      throw new PushEmptyError(id.repo);
    }

    const commits: LocalCommitWithData[] = [];
    for (const line of rawLines) {
      const [hash, message, author] = parseLogLine(line);
      if (!hash) {
        continue;
      }

      const tables = await this.getChangedTables(binaryPath, dataDir, hash);
      const tableData: { name: string; data: string }[] = [];
      for (const table of tables) {
        const data = await this.exportTableAtCommit(binaryPath, dataDir, table, hash);
        tableData.push({ name: table, data });
      }

      commits.push({ message, author, tables: tableData });
    }

    return commits;
  }

  private async getChangedTables(
    binaryPath: string,
    dataDir: string,
    commitHash: string,
  ): Promise<string[]> {
    const diffResult = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'diff', '--name-only', `${commitHash}^..${commitHash}`],
      { timeoutMs: 10_000 },
    );
    if (diffResult.exitCode !== 0) {
      // First commit has no parent; fall back to all tables at that commit.
      const tablesResult = await runDoltCommand(
        binaryPath,
        [
          '--data-dir',
          dataDir,
          'sql',
          '-q',
          `SELECT table_name FROM dolt_diff WHERE to_commit = '${commitHash}'`,
          '-r',
          'csv',
        ],
        { timeoutMs: 10_000 },
      );
      if (tablesResult.exitCode !== 0) {
        throw new PushError('diff', tablesResult.stderr);
      }
      const lines = tablesResult.stdout.trim().split('\n').filter(Boolean);
      return lines.slice(1); // skip header
    }

    return diffResult.stdout
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
        `SELECT * FROM ${table} AS OF '${commitHash}'`,
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

/**
 * Parse a `dolt log --format=%H|%s|%an` line. The message may contain pipes,
 * so we split only on the first two pipes.
 */
function parseLogLine(line: string): [string, string, string] {
  const firstPipe = line.indexOf('|');
  if (firstPipe === -1) {
    return [line, '', ''];
  }
  const hash = line.slice(0, firstPipe);
  const rest = line.slice(firstPipe + 1);
  const secondPipe = rest.indexOf('|');
  if (secondPipe === -1) {
    return [hash, rest, ''];
  }
  return [hash, rest.slice(0, secondPipe), rest.slice(secondPipe + 1)];
}
