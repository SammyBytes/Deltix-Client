import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoltCommand } from '../../acl/dolt-exec';
import { escapeSql, SAFE_TABLE_RE, sanitizeAuthor } from '../../core/table-name';
import {
  DEFAULT_BRANCH,
  DEFAULT_COMMIT_AUTHOR,
  DEFAULT_DOLT_PORT,
  REMOTE_TRACKING_PREFIX,
  TIMEOUT,
} from '../../shared/constants';
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
  UncommittedChangesError,
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
  /** Server-assigned commit hash; present on pulled commits. */
  hash?: string;
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

export interface LocalStatusRow {
  table: string;
  status: string;
  staged: boolean;
}

export interface LocalStatus {
  branch: string | null;
  staged: LocalStatusRow[];
  unstaged: LocalStatusRow[];
  clean: boolean;
}

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
      timeoutMs: TIMEOUT.DOLT_COMMIT,
    });
    if (addResult.exitCode !== 0) {
      throw new CommitError('add', addResult.stderr);
    }

    // `--author` must be a safe identifier-ish string; restrit the name to
    // letters/digits/dot/dash/underscore so it can't smuggle CLI flags or
    // extra args into the dolt invocation (OWASP A03). Falls back to the
    // historical `deltix` literal when no session username is available, so
    // pre-session callers (tests, scripts) keep working unchanged.
    const safeAuthor = (options.authorName ?? DEFAULT_COMMIT_AUTHOR).replace(
      /[^A-Za-z0-9_.-]/g,
      '_',
    );
    const authorFlag = `${safeAuthor} <${safeAuthor}@deltix.local>`;

    // Commit — may fail with exit code 1 if there are no staged changes.
    const commitResult = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'commit', '-m', message, `--author=${authorFlag}`],
      { timeoutMs: TIMEOUT.DOLT_COMMIT },
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
    branch: string = DEFAULT_BRANCH,
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
  async getBranchHead(
    id: LocalServerIdentity,
    branch: string = DEFAULT_BRANCH,
  ): Promise<string | null> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    return this.readBranchHash(binaryPath, dataDir, branch);
  }

  /** Head of the remote-tracking ref `origin/<branch>` (null if never synced). */
  async getRemoteHead(
    id: LocalServerIdentity,
    branch: string = DEFAULT_BRANCH,
  ): Promise<string | null> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    // Prefer the persisted server-head (written by saveSyncState after every
    // successful pull/clone). The origin/<branch> Dolt branch stores a local
    // commit hash (created by dolt commit during applyCommits), which is
    // different from the server's hash and causes "target commit not found"
    // when sent back as the `from` parameter. Fall back to the Dolt branch
    // ref for repos that haven't been patched yet (e.g. pre-0.8.3 clients).
    return (
      (await this.readSyncState(id, branch)) ?? this.getRemoteRefHash(binaryPath, dataDir, branch)
    );
  }

  /**
   * Persists the server's commit hash after a successful pull/clone. The hash
   * is the server-side `serverHead` (from the X-Deltix-Server-Head header),
   * which is the value the next pull must send as `from` for delta negotiation.
   */
  async saveSyncState(id: LocalServerIdentity, branch: string, serverHead: string): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    const syncFile = join(dataDir, '.deltix-sync-state');
    await mkdir(join(dataDir), { recursive: true });
    await writeFile(syncFile, JSON.stringify({ serverHead, branch }), 'utf-8');
  }

  /** Reads the persisted server-head hash for `branch` (or `null` if never synced). */
  async readSyncState(id: LocalServerIdentity, branch: string): Promise<string | null> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    const syncFile = join(dataDir, '.deltix-sync-state');
    if (!existsSync(syncFile)) {
      return null;
    }
    try {
      const raw = await readFile(syncFile, 'utf-8');
      const state = JSON.parse(raw) as { serverHead?: string; branch?: string };
      if (state.branch === branch && typeof state.serverHead === 'string') {
        return state.serverHead;
      }
    } catch {
      // Corrupted file — treat as not synced.
    }
    return null;
  }

  /**
   * Git-like working-tree status for the local Dolt repo. Reads
   * `dolt_status` (table_name, staged, status) and splits into staged
   * vs unstaged. `dolt status` CLI semantics: staged=false => "Changes not
   * staged for commit", staged=true => "Changes to be committed".
   *
   * Fast path: when the local `dolt sql-server` is running (the common
   * case after `deltix start`), query via the MySQL wire protocol with
   * `mysql2` — ~50ms instead of spawning two `dolt` CLI processes
   * sequentially (~3s each on Windows). Falls back to the CLI path when
   * the server is not running.
   */
  async getStatus(
    id: LocalServerIdentity,
    opts: { host?: string; port?: number } = {},
  ): Promise<LocalStatus> {
    let dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      const fallback = await this.findDataDirForRepo(id.repo);
      if (fallback) dataDir = fallback;
      else throw new CommitDataDirNotFoundError(id.repo);
    }

    // Fast path: try MySQL wire protocol when we know where the server is.
    if (opts.port) {
      try {
        const fast = await this.getStatusViaMysql(id, opts.host ?? '127.0.0.1', opts.port);
        if (fast) return fast;
      } catch {
        // Fall through to CLI path
      }
    }

    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);

    // Parallelize the two spawns — was sequential (6s on Windows) before.
    const [branch, raw] = await Promise.all([
      this.readActiveBranch(binaryPath, dataDir).catch(() => null),
      this.queryRows(
        binaryPath,
        dataDir,
        'SELECT table_name, staged, status FROM dolt_status',
      ).catch(() => [] as Record<string, string>[]),
    ]);

    const rows: LocalStatusRow[] = (raw as Record<string, string>[]).map((r) => ({
      table: String(r.table_name ?? r.table ?? ''),
      staged: r.staged === true || (r.staged as unknown) === 1 || String(r.staged) === 'true',
      status: String(r.status ?? 'modified'),
    }));

    const staged = rows.filter((r) => r.staged);
    const unstaged = rows.filter((r) => !r.staged);
    return { branch, staged, unstaged, clean: rows.length === 0 };
  }

  private async getStatusViaMysql(
    id: LocalServerIdentity,
    host: string,
    port: number,
  ): Promise<LocalStatus | null> {
    let conn: Awaited<ReturnType<typeof import('mysql2/promise').createConnection>> | null = null;
    try {
      const mysql = await import('mysql2/promise');
      conn = await mysql.createConnection({
        host,
        port,
        user: 'root',
        database: id.repo,
        connectTimeout: 1500,
      });
      const [branchRows] = await conn.query('SELECT active_branch() AS b');
      const branch =
        (branchRows as Array<Record<string, string>>)[0]?.b ??
        (branchRows as Array<Record<string, string>>)[0]?.B ??
        null;

      let statusRows: Array<Record<string, unknown>> = [];
      try {
        const [rows] = await conn.query('SELECT table_name, staged, status FROM dolt_status');
        statusRows = rows as Array<Record<string, unknown>>;
      } catch {
        statusRows = [];
      }

      const rows: LocalStatusRow[] = statusRows.map((r) => ({
        table: String((r.table_name as string) ?? (r.table as string) ?? ''),
        staged: r.staged === true || r.staged === 1 || String(r.staged) === 'true',
        status: String((r.status as string) ?? 'modified'),
      }));
      const staged = rows.filter((r) => r.staged);
      const unstaged = rows.filter((r) => !r.staged);
      return { branch: branch ? String(branch) : null, staged, unstaged, clean: rows.length === 0 };
    } catch {
      return null;
    } finally {
      if (conn) {
        try {
          await conn.end();
        } catch {
          // ignore
        }
      }
    }
  }

  private async readActiveBranch(binaryPath: string, dataDir: string): Promise<string | null> {
    const result = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'sql', '-q', 'SELECT active_branch() AS b', '-r', 'csv'],
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    if (result.exitCode !== 0) return null;
    const active = result.stdout.split('\n').slice(1).join('').trim();
    return active.length > 0 ? active : null;
  }

  /** Switch the working tree to `branch` (public wrapper over the internal checkout). */
  async checkout(id: LocalServerIdentity, branch: string): Promise<void> {
    let dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      const fallback = await this.findDataDirForRepo(id.repo);
      if (fallback) dataDir = fallback;
      else throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);

    // `dolt checkout` via CLI is blocked when `dolt sql-server` is running.
    // In that case we must stop the server, do the checkout on the
    // filesystem, and restart it — otherwise `CALL DOLT_CHECKOUT` via MySQL
    // only affects the current session and is not visible to `dolt branch -a`
    // or to new app connections.
    const isRunning = await this.isServerRunning();
    if (isRunning) {
      const { MysqlEmbeddedService } = await import('../mysql-embedded');
      const { loadEnv } = await import('../../shared/env');
      const env = loadEnv();
      const svc = new MysqlEmbeddedService({
        homeDir: this.deps.homeDir,
        localHost: env.DELTIX_LOCAL_HOST ?? '127.0.0.1',
        localPort: Number(env.DELTIX_LOCAL_PORT ?? DEFAULT_DOLT_PORT),
        binaryManager: this.deps
          .binaryManager as unknown as import('../binary-manager').BinaryManager,
      });
      try {
        await svc.stop(id);
      } catch {}
      const result = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'checkout', branch], {
        timeoutMs: TIMEOUT.DOLT_BRANCH,
      });
      // Restart even if checkout failed, to not leave the DB down
      try {
        await svc.start(id);
      } catch {}
      if (result.exitCode !== 0)
        throw new PushError('checkout', result.stderr.trim() || result.stdout.trim());
      return;
    }

    await this.checkoutBranch(binaryPath, dataDir, branch);
  }

  private async isServerRunning(): Promise<boolean> {
    try {
      const { isTcpPortOpen } = await import('../mysql-embedded/mysql-embedded.service');
      const { loadEnv } = await import('../../shared/env');
      const env = loadEnv();
      const host = env.DELTIX_LOCAL_HOST ?? '127.0.0.1';
      const port = Number(env.DELTIX_LOCAL_PORT ?? DEFAULT_DOLT_PORT);
      return await isTcpPortOpen(host, port);
    } catch {
      return false;
    }
  }

  async createBranch(id: LocalServerIdentity, name: string): Promise<void> {
    if (!/^[A-Za-z0-9/_-]{1,64}$/.test(name))
      throw new PushError('branch', `invalid branch name "${name}"`);
    const branch = name.trim();
    // Try MySQL wire first
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: DEFAULT_DOLT_PORT,
        user: 'root',
        database: id.repo,
        connectTimeout: 1200,
      });
      await conn.query(`CALL DOLT_BRANCH('${branch.replace(/'/g, "''")}')`);
      await conn.end();
      return;
    } catch {}
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    let dir = dataDir;
    if (!existsSync(dir)) {
      const fb = await this.findDataDirForRepo(id.repo);
      if (fb) dir = fb;
      else throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    const result = await runDoltCommand(binaryPath, ['--data-dir', dir, 'branch', branch], {
      timeoutMs: TIMEOUT.DOLT_BRANCH,
    });
    if (result.exitCode !== 0)
      throw new PushError('branch', result.stderr.trim() || result.stdout.trim());
  }

  async deleteBranch(id: LocalServerIdentity, name: string): Promise<void> {
    const branch = name.trim();
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: DEFAULT_DOLT_PORT,
        user: 'root',
        database: id.repo,
        connectTimeout: 1200,
      });
      await conn.query(`CALL DOLT_BRANCH('-D', '${branch.replace(/'/g, "''")}')`);
      await conn.end();
      return;
    } catch {}
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    let dir = dataDir;
    if (!existsSync(dir)) {
      const fb = await this.findDataDirForRepo(id.repo);
      if (fb) dir = fb;
      else throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    const result = await runDoltCommand(binaryPath, ['--data-dir', dir, 'branch', '-d', branch], {
      timeoutMs: TIMEOUT.DOLT_BRANCH,
    });
    if (result.exitCode !== 0)
      throw new PushError('branch', result.stderr.trim() || result.stdout.trim());
  }

  async mergeBranches(
    id: LocalServerIdentity,
    source: string,
    target?: string,
  ): Promise<{ fastForward: boolean; conflicts: number }> {
    const tgt = target ?? (await this.getCurrentBranch(id)) ?? DEFAULT_BRANCH;
    // Try wire first
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: DEFAULT_DOLT_PORT,
        user: 'root',
        database: id.repo,
        connectTimeout: 1500,
      });
      await conn.query(`CALL DOLT_CHECKOUT('${tgt.replace(/'/g, "''")}')`);
      const [rows] = await conn.query(`CALL DOLT_MERGE('${source.replace(/'/g, "''")}')`);
      const r = (rows as unknown as Array<Record<string, unknown>>)[0] as
        | Record<string, unknown>
        | undefined;
      const arr = r ? [r] : (rows as Array<Record<string, unknown>>);
      const first = Array.isArray(arr)
        ? (arr[0] as Record<string, unknown>)
        : (arr as unknown as Record<string, unknown>);
      await conn.end();
      return {
        fastForward: Boolean(first?.fast_forward ?? first?.fastForward ?? 1),
        conflicts: Number(first?.conflicts ?? 0),
      };
    } catch {}
    // CLI fallback
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    let dir = dataDir;
    if (!existsSync(dir)) {
      const fb = await this.findDataDirForRepo(id.repo);
      if (fb) dir = fb;
      else throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.checkoutBranch(binaryPath, dir, tgt);
    const result = await runDoltCommand(binaryPath, ['--data-dir', dir, 'merge', source], {
      timeoutMs: TIMEOUT.DOLT_COMMIT,
    });
    if (result.exitCode !== 0) {
      const conflicts = await this.readConflicts(binaryPath, dir);
      if (conflicts.length > 0) return { fastForward: false, conflicts: conflicts.length };
      throw new PushError('merge', result.stderr.trim() || result.stdout.trim());
    }
    return { fastForward: true, conflicts: 0 };
  }

  async getCurrentBranch(id: LocalServerIdentity): Promise<string | null> {
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: DEFAULT_DOLT_PORT,
        user: 'root',
        database: id.repo,
        connectTimeout: 1000,
      });
      const [rows] = await conn.query('SELECT active_branch() AS b');
      await conn.end();
      const b = (rows as Array<Record<string, string>>)[0]?.b ?? null;
      return b ? String(b) : null;
    } catch {
      return null;
    }
  }

  /**
   * List local branches and remote-tracking (`origin/*`) branches, mirroring
   * `git branch -a`. The current branch is reported separately.
   */
  async listBranches(id: LocalServerIdentity): Promise<LocalBranchList> {
    // Fast path: when sql-server is running, query via MySQL wire so we see
    // the same current branch that `CALL DOLT_CHECKOUT` via MySQL just set.
    // `dolt branch -a` CLI reads the filesystem and is stale while the
    // server holds the DB in memory, and `dolt checkout` via CLI is blocked
    // when the server is running.
    try {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: DEFAULT_DOLT_PORT,
        user: 'root',
        database: id.repo,
        connectTimeout: 800,
      });
      const [bRows] = await conn.query('SELECT active_branch() AS b');
      const current =
        (bRows as Array<Record<string, string>>)[0]?.b ??
        (bRows as Array<Record<string, string>>)[0]?.B ??
        null;
      const [rows] = await conn.query('SELECT name FROM dolt_branches');
      await conn.end();
      const local = (rows as Array<Record<string, string>>)
        .map((r) => String(r.name ?? ''))
        .filter(Boolean)
        .filter((n) => !n.startsWith(REMOTE_TRACKING_PREFIX));
      const remote = (rows as Array<Record<string, string>>)
        .map((r) => String(r.name ?? ''))
        .filter((n) => n.startsWith(REMOTE_TRACKING_PREFIX));
      return { current: current ? String(current) : null, local, remote };
    } catch {}
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      const fb = await this.findDataDirForRepo(id.repo);
      if (fb) {
        // Retry via CLI with fallback dir
        const binaryPath = await this.deps.binaryManager.ensureInstalled();
        const result = await runDoltCommand(binaryPath, ['--data-dir', fb, 'branch', '-a'], {
          timeoutMs: TIMEOUT.DOLT_BRANCH,
        });
        if (result.exitCode !== 0)
          throw new PushError('branch', result.stderr.trim() || result.stdout.trim());
        const local: string[] = [];
        const remote: string[] = [];
        let current: string | null = null;
        for (const raw of result.stdout.split('\n')) {
          const line = raw.trimEnd();
          if (!line.trim()) continue;
          const isCurrent = line.startsWith('*');
          const name = line
            .replace(/^[*]\s+/, '')
            .replace(/^\s+/, '')
            .trim();
          if (!name) continue;
          if (name.startsWith(REMOTE_TRACKING_PREFIX)) remote.push(name);
          else {
            local.push(name);
            if (isCurrent) current = name;
          }
        }
        return { current, local, remote };
      }
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    const result = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'branch', '-a'], {
      timeoutMs: TIMEOUT.DOLT_BRANCH,
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
      if (name.startsWith(REMOTE_TRACKING_PREFIX)) {
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
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
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

    // Atomic pull: apply every commit on a throwaway branch, then advance the
    // real branch in one step only if the whole apply succeeded. If any commit
    // or table import fails mid-way we drop the temp branch and restore the
    // working tree, so a failed pull never leaves partially-applied data or a
    // corrupted working copy behind (previously a per-table TRUNCATE + reload
    // on the real branch could destroy uncommitted rows before discovering a
    // later commit was un-appliable).
    // Idempotent apply: skip commits we've already recreated locally for this
    // branch. This matters when the server degrades to a full-history re-sync
    // (its `from` negotiation hash was no longer reachable) and resends commits
    // we already applied — without this guard we'd recreate them as divergent
    // duplicates. We can't detect that by comparing against *local* Dolt commit
    // hashes (content-addressed, folds in the timestamp) so we persist the set
    // of server-assigned hashes already applied instead.
    const appliedPath = this.appliedCommitsPath(dataDir, branch);
    const applied = await this.readAppliedHashes(appliedPath);
    const pending = commits.filter((c) => !c.hash || !applied.has(c.hash));

    // Protect the working copy: the apply below starts from the branch head,
    // so it must not clobber uncommitted rows the user has in the very tables
    // it is about to recreate. If any of those tables has staged or unstaged
    // changes, fail before touching anything (git pull does the same rather
    // than silently discarding local work).
    const touched = [...new Set(pending.flatMap((c) => c.tables.map((t) => t.name)))];
    if (touched.length > 0) {
      await this.assertNoUncommittedChanges(binaryPath, dataDir, touched);
    }

    const baseHead = await this.readBranchHash(binaryPath, dataDir, branch);
    const tempBranch = `_deltix_pull_${Math.random().toString(36).slice(2)}`;

    const create = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'branch', tempBranch, baseHead ?? ''],
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    if (create.exitCode !== 0) {
      throw new PushError('branch', create.stderr.trim() || create.stdout.trim());
    }
    const checkout = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'checkout', tempBranch],
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    if (checkout.exitCode !== 0) {
      throw new PushError('checkout', checkout.stderr.trim() || checkout.stdout.trim());
    }

    // Dolt keeps the *uncommitted working set* when switching branches, so a
    // plain `checkout` cannot undo what importTable wrote into the working
    // tree on the throwaway branch — those TRUNCATE/INSERT changes ride along
    // back to the real branch. To truly restore, after returning to `branch`
    // we reset the touched tables from that branch's HEAD with
    // `dolt checkout <branch> -- <tables>` (the Dolt equivalent of
    // `git checkout -- <files>`).
    const restore = async (rollbackTables: string[] = []): Promise<void> => {
      const back = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'checkout', branch], {
        timeoutMs: TIMEOUT.DOLT_BRANCH,
      });
      if (back.exitCode !== 0) {
        throw new PushError('checkout', back.stderr.trim() || back.stdout.trim());
      }
      // Only tables that could actually have been imported are safe to reset
      // (their names passed SAFE_TABLE_RE). Unsafe names never got created, so
      // they wouldn't be valid Dolt identifiers to pass to `checkout --` anyway.
      const safeRollback = rollbackTables.filter((t) => SAFE_TABLE_RE.test(t));
      if (safeRollback.length > 0) {
        const reset = await runDoltCommand(
          binaryPath,
          ['--data-dir', dataDir, 'checkout', branch, '--', ...safeRollback],
          { timeoutMs: TIMEOUT.DOLT_BRANCH },
        );
        if (reset.exitCode !== 0) {
          throw new PushError(
            'checkout',
            `${reset.stderr.trim() || reset.stdout.trim()} (could not restore ${safeRollback.join(', ')})`,
          );
        }
      }
      // Best-effort cleanup of the throwaway branch. Runs last so a reset
      // failure above still removes the branch.
      await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'branch', '-D', tempBranch], {
        timeoutMs: TIMEOUT.DOLT_BRANCH,
      }).catch(() => {});
    };

    try {
      for (const commit of pending) {
        for (const table of commit.tables) {
          await this.importTable(binaryPath, dataDir, table);
        }
        const names = commit.tables.map((t) => t.name);
        if (names.length === 0) {
          if (commit.hash) applied.add(commit.hash);
          continue;
        }
        const add = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'add', ...names], {
          timeoutMs: TIMEOUT.DOLT_COMMIT,
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
          { timeoutMs: TIMEOUT.DOLT_COMMIT },
        );
        if (commitResult.exitCode !== 0) {
          throw new PushError('commit', commitResult.stderr.trim() || commitResult.stdout.trim());
        }
        if (commit.hash) applied.add(commit.hash);
      }

      if (pending.length > 0) {
        await this.writeAppliedHashes(appliedPath, applied);
      }

      const tempHead = await this.readBranchHash(binaryPath, dataDir, tempBranch);
      if (!tempHead) {
        throw new PushError('log', 'could not resolve temp branch head after apply');
      }
      // Advance the real branch to the fully-applied temp head in one step.
      const advance = await runDoltCommand(
        binaryPath,
        ['--data-dir', dataDir, 'branch', '-f', branch, tempHead],
        { timeoutMs: TIMEOUT.DOLT_BRANCH },
      );
      if (advance.exitCode !== 0) {
        throw new PushError('branch', advance.stderr.trim() || advance.stdout.trim());
      }
      await restore();
      return tempHead;
    } catch (err) {
      // Restore the real branch's working tree (checkout + reset the touched
      // tables from HEAD) and drop the temp branch, so the repo is exactly as
      // it was before the pull attempt.
      await restore(touched).catch(() => {});
      throw err;
    }
  }

  /** Sidecar file path tracking server-assigned commit hashes already applied to `branch`. */
  private appliedCommitsPath(dataDir: string, branch: string): string {
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(dataDir, '.deltix-applied-commits', `${safeBranch}.json`);
  }

  private async readAppliedHashes(path: string): Promise<Set<string>> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private async writeAppliedHashes(path: string, hashes: Set<string>): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify([...hashes]), 'utf8');
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
        { timeoutMs: TIMEOUT.DOLT_COMMIT },
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
          const imp = await runDoltCommand(binaryPath, importArgs, {
            timeoutMs: TIMEOUT.DOLT_IMPORT,
          });
          if (imp.exitCode !== 0) {
            throw new PushError(`import ${table.name}`, imp.stderr.trim() || imp.stdout.trim());
          }
        } finally {
          await rm(tmp, { force: true });
        }
      }

      // `dolt table import` does not carry the source's AUTO_INCREMENT counter
      // initializer. The CREATE TABLE (with e.g. `AUTO_INCREMENT=6`) sets it,
      // but the bulk import rewrites the table and the counter reverts — so the
      // next plain INSERT that omits the PK starts from 1 and collides with
      // rows imported with explicit PKs. Re-assert the source's declared
      // `AUTO_INCREMENT=N` after loading, matching the origin's next-PK value.
      const autoIncrement = /AUTO_INCREMENT=(\d+)/i.exec(table.schema)?.[1];
      if (autoIncrement) {
        const fixAi = await runDoltCommand(
          binaryPath,
          [
            '--data-dir',
            dataDir,
            'sql',
            '-q',
            `ALTER TABLE ${table.name} AUTO_INCREMENT = ${autoIncrement}`,
          ],
          { timeoutMs: TIMEOUT.DOLT_COMMIT },
        );
        if (fixAi.exitCode !== 0) {
          throw new PushError(`auto_increment ${table.name}`, fixAi.stderr.trim());
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
          { timeoutMs: TIMEOUT.DOLT_PULL_MERGE },
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
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    // Exact compare, not substring: 'origin/main' contains DEFAULT_BRANCH, so a naive
    // includes() would wrongly conclude we are already on the target branch.
    const active = current.stdout.split('\n').slice(1).join('').trim();
    if (active === branch) {
      return;
    }
    const checkout = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'checkout', branch], {
      timeoutMs: TIMEOUT.DOLT_BRANCH,
    });
    if (checkout.exitCode === 0) {
      return;
    }
    // Branch does not exist yet (e.g. first `fetch` materializing origin/<branch>):
    // create it at the current head.
    const create = await runDoltCommand(
      binaryPath,
      ['--data-dir', dataDir, 'checkout', '-b', branch],
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    if (create.exitCode !== 0) {
      throw new PushError('checkout', create.stderr.trim() || create.stdout.trim());
    }
  }

  private async assertNoUncommittedChanges(
    binaryPath: string,
    dataDir: string,
    tables?: string[],
  ): Promise<void> {
    const rows = await this.queryRows(
      binaryPath,
      dataDir,
      'SELECT table_name, staged, status FROM dolt_status',
    ).catch(() => [] as Record<string, string>[]);
    if (rows.length === 0) {
      return;
    }
    const dirty = new Set(
      (rows as Record<string, string>[]).map((r) => String(r.table_name ?? r.table ?? '')),
    );
    const affected = tables ? dirty.intersection(new Set(tables)) : dirty;
    if (affected.size === 0) {
      return;
    }
    const list = [...affected].sort().join(', ');
    throw new UncommittedChangesError(list);
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
      { timeoutMs: TIMEOUT.DOLT_COMMIT },
    );
    if (create.exitCode !== 0) {
      if (!create.stderr.toLowerCase().includes('already exists')) {
        throw new PushError(`create ${table.name}`, create.stderr.trim());
      }
      const truncate = await runDoltCommand(
        binaryPath,
        ['--data-dir', dataDir, 'sql', '-q', `TRUNCATE TABLE ${table.name}`],
        { timeoutMs: TIMEOUT.DOLT_COMMIT },
      );
      if (truncate.exitCode !== 0) {
        throw new PushError(`truncate ${table.name}`, truncate.stderr.trim());
      }
    }

    // Reload rows with `dolt table import -r` instead of per-row INSERT
    // statements. Import parses the CSV exactly as Dolt wrote it, so type
    // coercion is precise: an empty string lands as NULL in a DATETIME column,
    // which an INSERT statement would reject with "Incorrect datetime value:
    // ''" (the exact failure when a source row carries an empty datetime).
    // It also avoids O(rows) subprocess spawns for large tables.
    const bodyLines = table.data.split('\n').filter((l) => l.length > 0);
    if (bodyLines.length > 1) {
      const tmp = join(
        tmpdir(),
        `deltix-pull-${process.pid}-${Math.random().toString(36).slice(2)}.csv`,
      );
      await writeFile(tmp, table.data);
      try {
        const imp = await runDoltCommand(
          binaryPath,
          ['--data-dir', dataDir, 'table', 'import', '-r', table.name, tmp],
          { timeoutMs: TIMEOUT.DOLT_IMPORT },
        );
        if (imp.exitCode !== 0) {
          throw new PushError(`import ${table.name}`, imp.stderr.trim() || imp.stdout.trim());
        }
      } finally {
        await rm(tmp, { force: true });
      }
    }

    // `dolt table import` does not carry the source's AUTO_INCREMENT counter
    // (same as in bulkImportTables); re-assert it after loading so the next
    // omit-PK INSERT starts from the source's next-ID value.
    const autoIncrement = /AUTO_INCREMENT=(\d+)/i.exec(table.schema)?.[1];
    if (autoIncrement) {
      const fixAi = await runDoltCommand(
        binaryPath,
        [
          '--data-dir',
          dataDir,
          'sql',
          '-q',
          `ALTER TABLE ${table.name} AUTO_INCREMENT = ${autoIncrement}`,
        ],
        { timeoutMs: TIMEOUT.DOLT_COMMIT },
      );
      if (fixAi.exitCode !== 0) {
        throw new PushError(`auto_increment ${table.name}`, fixAi.stderr.trim());
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
      [
        '--data-dir',
        dataDir,
        'init',
        '--name',
        DEFAULT_COMMIT_AUTHOR,
        '--email',
        'deltix@deltix.local',
      ],
      { timeoutMs: TIMEOUT.DOLT_COMMIT },
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
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
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
      { timeoutMs: TIMEOUT.DOLT_COMMIT },
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
  async mergeFromRemote(
    id: LocalServerIdentity,
    branch: string = DEFAULT_BRANCH,
  ): Promise<PullMergeResult> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    await this.checkoutBranch(binaryPath, dataDir, branch);

    // Protect the working copy: `dolt merge` applies onto the live branch and
    // can fast-forward over / discard uncommitted rows. If the working tree is
    // not clean, abort before touching anything instead of silently losing
    // local work (same semantics as `git pull` refusing to overwrite local
    // changes).
    await this.assertNoUncommittedChanges(binaryPath, dataDir);

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
      { timeoutMs: TIMEOUT.DOLT_PULL_MERGE },
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
  async mergeAbort(id: LocalServerIdentity, branch: string = DEFAULT_BRANCH): Promise<void> {
    const dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    await this.checkoutBranch(binaryPath, dataDir, branch);
    const result = await runDoltCommand(binaryPath, ['--data-dir', dataDir, 'merge', '--abort'], {
      timeoutMs: TIMEOUT.DOLT_COMMIT,
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
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
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
      { timeoutMs: TIMEOUT.DOLT_COMMIT },
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
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    if (result.exitCode !== 0) {
      throw new PushError('schema export', result.stderr);
    }
    return result.stdout;
  }

  /**
   * Working-tree diff summary (unstaged changes). Wraps `dolt diff --stat`
   * so `deltix diff` without server refs shows what the app/ORM just did
   * to Dolt via the MySQL wire protocol.
   */
  async getWorkingDiffSummary(
    id: LocalServerIdentity,
    table?: string,
  ): Promise<{ tables: string[]; raw: string }> {
    let dataDir = computeLocalDataDir(this.deps.homeDir, id);
    if (!existsSync(dataDir)) {
      const fallback = await this.findDataDirForRepo(id.repo);
      if (fallback) dataDir = fallback;
      else throw new CommitDataDirNotFoundError(id.repo);
    }
    const binaryPath = await this.deps.binaryManager.ensureInstalled();
    await this.ensureLocalRepo(binaryPath, dataDir, id.repo);
    const args = ['--data-dir', dataDir, 'diff', '--stat'];
    if (table) {
      if (!SAFE_TABLE_RE.test(table)) {
        throw new PushError('diff', `refusing to diff table with unsafe name "${table}"`);
      }
      args.push(table);
    }
    const result = await runDoltCommand(binaryPath, args, { timeoutMs: TIMEOUT.DOLT_DIFF_STAT });
    // exit 0 with empty stdout => clean working tree
    const raw = result.stdout.trim();
    const tables = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0] ?? '')
      .filter(Boolean);
    return { tables, raw };
  }

  private async findDataDirForRepo(repo: string): Promise<string | null> {
    // Scan for any data dir keyed by this repo, regardless of project hash.
    const candidates: string[] = [];
    // Legacy: ~/.deltix/repos/<repo>
    candidates.push(join(this.deps.homeDir, 'repos', repo));
    try {
      const projects = await readdir(join(this.deps.homeDir, 'projects'));
      for (const hash of projects) {
        candidates.push(join(this.deps.homeDir, 'projects', hash, repo));
      }
    } catch {
      // no projects dir
    }
    for (const p of candidates) {
      if (existsSync(p) && existsSync(join(p, '.dolt'))) return p;
    }
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }
}
