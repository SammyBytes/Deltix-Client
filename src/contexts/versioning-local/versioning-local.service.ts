import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

export interface LocalCommitTable {
  name: string;
  /** CREATE TABLE DDL (from `dolt schema export`) so the receiving side can
   * recreate the table — and its primary key — faithfully from a data-only CSV. */
  schema: string;
  data: string;
}

export interface LocalCommitWithData {
  message: string;
  author: string;
  tables: LocalCommitTable[];
}

export interface MergeConflictSummary {
  table: string;
  numConflicts: number;
}

export type PullMergeResult =
  | { status: 'merged' }
  | { status: 'conflicts'; conflicts: MergeConflictSummary[] };

export interface LocalBranchList {
  current: string | null;
  local: string[];
  remote: string[];
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

const SAFE_TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sanitizeAuthor(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Parse one CSV line (handles quoted fields and doubled quotes). */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
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
    options: { authorName?: string } = {},
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

    // `--author` must be a safe identifier-ish string; restrit the name to
    // letters/digits/dot/dash/underscore so it can't smuggle CLI flags or
    // extra args into the dolt invocation (OWASP A03). Falls back to the
    // historical `deltix` literal when no session username is available, so
    // pre-session callers (tests, scripts) keep working unchanged.
    const safeAuthor = (options.authorName ?? 'deltix').replace(/[^A-Za-z0-9_.-]/g, '_');
    const authorFlag = `${safeAuthor} <${safeAuthor}@deltix.local>`;

    // Commit — may fail with exit code 1 if there are no staged changes.
    const commitResult = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'commit', '-m', message, `--author=${authorFlag}`],
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
      const tableData: LocalCommitTable[] = [];
      for (const table of tableNames) {
        const data = await this.exportTableAtCommit(binaryPath, dataDir, table, row.commit_hash);
        const schema = await this.exportTableSchema(binaryPath, dataDir, table);
        tableData.push({ name: table, schema, data });
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

  /** Head of the remote-tracking ref `origin/<branch>` (null if never synced). */
  async getRemoteHead(id: LocalServerIdentity, branch = 'main'): Promise<string | null> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    return this.getRemoteRefHash(binaryPath, dataDir, branch);
  }

  /** Switch the working tree to `branch` (public wrapper over the internal checkout). */
  async checkout(id: LocalServerIdentity, branch: string): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    await this.checkoutBranch(binaryPath, dataDir, branch);
  }

  /**
   * List local branches and remote-tracking (`origin/*`) branches, mirroring
   * `git branch -a`. The current branch is reported separately.
   */
  async listBranches(id: LocalServerIdentity): Promise<LocalBranchList> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    const result = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'branch', '-a'], {
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new PushError('branch', result.stderr.trim() || result.stdout.trim());
    }
    const local: string[] = [];
    const remote: string[] = [];
    let current: string | null = null;
    for (const raw of result.stdout.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        continue;
      }
      const isCurrent = line.startsWith('*');
      const name = line
        .replace(/^[*]\s+/, '')
        .replace(/^\s+/, '')
        .trim();
      if (!name) {
        continue;
      }
      if (name.startsWith('origin/')) {
        remote.push(name);
      } else {
        local.push(name);
        if (isCurrent) {
          current = name;
        }
      }
    }
    return { current, local, remote };
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
   * Applies commits pulled from the server onto the local `branch`, recreating
   * each table's schema from its DDL and reloading rows from the CSV — the
   * read-side mirror of `commit()`. Returns the resulting branch head hash.
   * Used by `deltix pull` for the fast-forward case.
   */
  async applyCommits(
    id: LocalServerIdentity,
    branch: string,
    commits: LocalCommitWithData[],
  ): Promise<string> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    await this.checkoutBranch(binaryPath, dataDir, branch);

    for (const commit of commits) {
      for (const table of commit.tables) {
        await this.importTable(binaryPath, dataDir, table);
      }
      const names = commit.tables.map((t) => t.name);
      if (names.length === 0) {
        continue;
      }
      const add = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'add', ...names], {
        timeoutMs: 30_000,
      });
      if (add.exitCode !== 0) {
        throw new PushError('add', add.stderr);
      }
      const safeAuthor = sanitizeAuthor(commit.author);
      const commitResult = await runDoltCommand(
        binaryPath,
        [
          '--data-dir',
          dataDir,
          'commit',
          '-m',
          commit.message,
          `--author=${safeAuthor} <${safeAuthor}@deltix.local>`,
        ],
        { timeoutMs: 30_000 },
      );
      if (commitResult.exitCode !== 0) {
        throw new PushError('commit', commitResult.stderr.trim() || commitResult.stdout.trim());
      }
    }

    const head = await this.readBranchHash(binaryPath, dataDir, branch);
    if (!head) {
      throw new PushError('log', 'could not resolve branch head after apply');
    }
    return head;
  }

  /**
   * Bulk-load tables into the local Dolt working set (used by `deltix import`).
   * For each table: create it from its DDL (or TRUNCATE if it already exists),
   * then load rows with `dolt table import -r` (fast, preserves PK/types/NULL).
   * base64-encoded binary columns are decoded in place with `FROM_BASE64`.
   * Leaves the changes staged-but-uncommitted for the caller to commit.
   */
  async bulkImportTables(
    id: LocalServerIdentity,
    tables: { name: string; schema: string; csv: string; base64Columns: string[] }[],
    options: { continueOnRowError?: boolean } = {},
  ): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    // Import is the "git init" moment: the local repo may not exist yet, so
    // create the data dir and initialize Dolt before loading.
    await mkdir(dataDir, { recursive: true });
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);

    for (const table of tables) {
      if (!SAFE_TABLE_RE.test(table.name)) {
        throw new PushError('import', `refusing to import table with unsafe name "${table.name}"`);
      }
      const create = await runDoltCommand(
        binaryPath,
        ['--data-dir', dataDir, 'sql', '-q', table.schema],
        { timeoutMs: 30_000 },
      );
      if (create.exitCode !== 0 && !create.stderr.toLowerCase().includes('already exists')) {
        throw new PushError(`create ${table.name}`, create.stderr.trim());
      }

      const bodyLines = table.csv.split('\n').filter((l) => l.length > 0);
      if (bodyLines.length > 1) {
        const tmp = join(
          tmpdir(),
          `deltix-import-${process.pid}-${Math.random().toString(36).slice(2)}.csv`,
        );
        await writeFile(tmp, table.csv);
        try {
          const importArgs: string[] = ['--data-dir', dataDir, 'table', 'import', '-r'];
          if (options.continueOnRowError) {
            importArgs.push('--continue');
          }
          importArgs.push(table.name, tmp);
          const imp = await runDoltCommand(binaryPath, importArgs, { timeoutMs: 120_000 });
          if (imp.exitCode !== 0) {
            throw new PushError(`import ${table.name}`, imp.stderr.trim() || imp.stdout.trim());
          }
        } finally {
          await rm(tmp, { force: true });
        }
      }

      for (const col of table.base64Columns) {
        const fix = await runDoltCommand(
          binaryPath,
          [
            '--data-dir',
            dataDir,
            'sql',
            '-q',
            `UPDATE ${table.name} SET \`${col}\` = FROM_BASE64(CAST(\`${col}\` AS CHAR))`,
          ],
          { timeoutMs: 60_000 },
        );
        if (fix.exitCode !== 0) {
          throw new PushError(`from_base64 ${table.name}.${col}`, fix.stderr.trim());
        }
      }
    }
  }

  private async checkoutBranch(binaryPath: string, dataDir: string, branch: string): Promise<void> {
    const current = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'sql', '-q', 'SELECT active_branch() AS b', '-r', 'csv'],
      { timeoutMs: 10_000 },
    );
    // Exact compare, not substring: 'origin/main' contains 'main', so a naive
    // includes() would wrongly conclude we are already on the target branch.
    const active = current.stdout.split('\n').slice(1).join('').trim();
    if (active === branch) {
      return;
    }
    const checkout = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'checkout', branch], {
      timeoutMs: 10_000,
    });
    if (checkout.exitCode === 0) {
      return;
    }
    // Branch does not exist yet (e.g. first `fetch` materializing origin/<branch>):
    // create it at the current head.
    const create = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'checkout', '-b', branch],
      { timeoutMs: 10_000 },
    );
    if (create.exitCode !== 0) {
      throw new PushError('checkout', create.stderr.trim() || create.stdout.trim());
    }
  }

  private async importTable(
    binaryPath: string,
    dataDir: string,
    table: LocalCommitTable,
  ): Promise<void> {
    if (!SAFE_TABLE_RE.test(table.name)) {
      throw new PushError('import', `refusing to import table with unsafe name "${table.name}"`);
    }
    const create = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'sql', '-q', table.schema],
      { timeoutMs: 30_000 },
    );
    if (create.exitCode !== 0) {
      if (!create.stderr.toLowerCase().includes('already exists')) {
        throw new PushError(`create ${table.name}`, create.stderr.trim());
      }
      const truncate = await runDoltCommand(
        binaryPath,
        ['--data-dir', dataDir, 'sql', '-q', `TRUNCATE TABLE ${table.name}`],
        { timeoutMs: 30_000 },
      );
      if (truncate.exitCode !== 0) {
        throw new PushError(`truncate ${table.name}`, truncate.stderr.trim());
      }
    }

    const lines = table.data
      .replace(/\r/g, '')
      .split('\n')
      .filter((l) => l.length > 0);
    if (lines.length <= 1) {
      return; // header only → table created/emptied, no rows
    }
    const columns = parseCsvLine(lines[0] ?? '');
    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i] ?? '');
      if (values.length !== columns.length) {
        throw new PushError(
          'import',
          `row ${i} of ${table.name} has ${values.length} cols, expected ${columns.length}`,
        );
      }
      const cols = columns.map((c) => `\`${c}\``).join(', ');
      const vals = values.map(sqlLiteral).join(', ');
      const insert = await runDoltCommand(
        binaryPath,
        [
          '--data-dir',
          dataDir,
          'sql',
          '-q',
          `INSERT INTO ${table.name} (${cols}) VALUES (${vals})`,
        ],
        { timeoutMs: 30_000 },
      );
      if (insert.exitCode !== 0) {
        throw new PushError(`insert ${table.name}`, insert.stderr.trim());
      }
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
    return this.queryRows(binaryPath, dataDir, query) as Promise<DoltLogRow[]>;
  }

  private async queryRows(
    binaryPath: string,
    dataDir: string,
    query: string,
  ): Promise<Record<string, string>[]> {
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'sql', '-q', query, '-r', 'json'],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new PushError('sql', result.stderr.trim() || result.stdout.trim());
    }
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return [];
    }
    return (JSON.parse(trimmed) as { rows?: Record<string, string>[] }).rows ?? [];
  }

  /**
   * Merge the remote-tracking ref `origin/<branch>` into the local `<branch>`
   * (assumed already updated by a preceding fetch). Returns `merged` on a
   * clean/fast-forward merge, or `conflicts` (leaving the repo mid-merge) when
   * Dolt reports content conflicts.
   */
  async mergeFromRemote(id: LocalServerIdentity, branch = 'main'): Promise<PullMergeResult> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    await this.checkoutBranch(binaryPath, dataDir, branch);

    const merge = await runDoltCommand(
      binaryPath,
      [
        '--data-dir',
        dataDir,
        'merge',
        remoteRefName(branch),
        '-m',
        `Merge ${remoteRefName(branch)} into ${branch}`,
      ],
      { timeoutMs: 60_000 },
    );
    if (merge.exitCode === 0) {
      return { status: 'merged' };
    }
    const conflicts = await this.readConflicts(binaryPath, dataDir);
    if (conflicts.length > 0) {
      return { status: 'conflicts', conflicts };
    }
    throw new PushError('merge', merge.stderr.trim() || merge.stdout.trim());
  }

  /** Abort an in-progress merge (e.g. after `deltix pull --abort`). */
  async mergeAbort(id: LocalServerIdentity, branch = 'main'): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    await this.checkoutBranch(binaryPath, dataDir, branch);
    const result = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'merge', '--abort'], {
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new PushError('merge --abort', result.stderr.trim() || result.stdout.trim());
    }
  }

  private async readConflicts(
    binaryPath: string,
    dataDir: string,
  ): Promise<MergeConflictSummary[]> {
    const rows = await this.queryRows(
      binaryPath,
      dataDir,
      'SELECT `table`, num_conflicts FROM dolt_conflicts',
    );
    return rows
      .filter((row) => row.table)
      .map((row) => ({ table: row.table as string, numConflicts: Number(row.num_conflicts ?? 0) }));
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

  private async exportTableSchema(
    binaryPath: string,
    dataDir: string,
    table: string,
  ): Promise<string> {
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'schema', 'export', table],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) {
      throw new PushError('schema export', result.stderr);
    }
    return result.stdout;
  }
}
