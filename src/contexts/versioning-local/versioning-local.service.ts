import { existsSync } from 'node:fs';
import { runDoltCommand } from '../../acl/dolt-exec';
import type { BinaryManager } from '../binary-manager';
import type { LocalServerIdentity } from '../mysql-embedded';
import { computeLocalDataDir } from '../mysql-embedded';
import {
  CommitDataDirNotFoundError,
  CommitEmptyError,
  CommitError,
} from './versioning-local.errors';

export interface LocalCommitResult {
  commitHash: string;
  repo: string;
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
}
