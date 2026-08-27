import { ServerUnreachableError } from '../contexts/session/errors';
import {
  BranchAlreadyExistsError,
  BranchNotFoundError,
  InsufficientRoleError,
  MergeConflictError,
  type MergeConflictTable,
  ProtectedBranchError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  RoleAssignmentNotFoundError,
  UserNotFoundError,
  ValidationError,
  VersioningAuthenticationError,
  VersioningRequestError,
} from '../contexts/versioning/errors';

export interface RepoSummary {
  repoId: string;
  doltPath: string;
  createdAt: number;
  createdBy: string;
  role?: 'reader' | 'writer' | 'admin';
}

export interface RepoRoleAssignment {
  username: string;
  repoId: string;
  role: 'reader' | 'writer' | 'admin';
  grantedBy?: string;
  grantedAt?: number;
}

export interface BranchSummary {
  name: string;
  isCurrent: boolean;
}

export interface LogCommitEntry {
  commitHash: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  message: string;
  parents: string[];
}

export interface DiffRowChange {
  diffType: 'added' | 'removed' | 'modified';
  oldValues: Record<string, string | null>;
  newValues: Record<string, string | null>;
}

export interface DiffTableSummary {
  table: string;
  diffType: string;
  dataChange: boolean;
  schemaChange: boolean;
  changes: DiffRowChange[];
}

export interface DiffResult {
  fromRef: string;
  toRef: string;
  tables: DiffTableSummary[];
}

export interface RepoSyncPreferenceSummary {
  mode: 'schema_only' | 'schema_and_data';
  requestedTables: string[] | null;
}

export interface SyncPreferenceDryRunPlan {
  mode: 'schema_only' | 'schema_and_data';
  requestedTables: string[] | null;
  resolvedTables?: string[] | null;
  autoIncludedTables?: string[];
}

export type MergeResult =
  | {
      status: 'merged';
      targetBranch: string;
      sourceBranch: string;
      commitHash: string;
      fastForward: boolean;
      message: string;
    }
  | {
      status: 'up_to_date';
      targetBranch: string;
      sourceBranch: string;
      message: string;
    };

export class VersioningApiAdapter {
  constructor(private readonly serverUrl: string) {}

  async createRepo(accessToken: string, repoId: string): Promise<RepoSummary> {
    const res = await this.request('/api/v1/versioning/repos', accessToken, {
      method: 'POST',
      body: { repoId },
    });
    if (res.status === 409) throw new RepoAlreadyExistsError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    if (res.status !== 201) throw new VersioningRequestError(await this.readError(res), res.status);
    return ((await res.json()) as { repo: RepoSummary }).repo;
  }

  async listRepos(accessToken: string): Promise<RepoSummary[]> {
    const res = await this.request('/api/v1/versioning/repos', accessToken, { method: 'GET' });
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { repos: RepoSummary[] }).repos;
  }

  async getRepo(accessToken: string, repoId: string): Promise<RepoSummary> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { repo: RepoSummary }).repo;
  }

  async listRoles(accessToken: string, repoId: string): Promise<RepoRoleAssignment[]> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/roles`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { roles: RepoRoleAssignment[] }).roles;
  }

  async grantRole(
    accessToken: string,
    repoId: string,
    username: string,
    role: 'reader' | 'writer' | 'admin',
  ): Promise<RepoRoleAssignment> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/roles`,
      accessToken,
      {
        method: 'POST',
        body: { username, role },
      },
    );
    if (res.status === 404) {
      const message = await this.readError(res);
      if (message.toLowerCase().includes('user')) throw new UserNotFoundError(message);
      throw new RepoNotFoundError(message);
    }
    if (res.status === 500) {
      const message = await this.readError(res);
      if (message.toLowerCase().includes('user')) throw new UserNotFoundError(message);
    }
    await this.throwIfCommonErrors(res);
    if (res.status !== 201) throw new VersioningRequestError(await this.readError(res), res.status);
    return ((await res.json()) as { role: RepoRoleAssignment }).role;
  }

  async revokeRole(accessToken: string, repoId: string, username: string): Promise<void> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/roles/${encodeURIComponent(username)}`,
      accessToken,
      { method: 'DELETE' },
    );
    if (res.status === 404) {
      const message = await this.readError(res);
      if (message.toLowerCase().includes('assignment'))
        throw new RoleAssignmentNotFoundError(message);
      throw new RepoNotFoundError(message);
    }
    await this.throwIfCommonErrors(res);
    if (res.status !== 204) throw new VersioningRequestError(await this.readError(res), res.status);
  }

  async listBranches(accessToken: string, repoId: string): Promise<BranchSummary[]> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/branches`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { branches: BranchSummary[] }).branches;
  }

  async createBranch(accessToken: string, repoId: string, name: string): Promise<BranchSummary> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/branches`,
      accessToken,
      {
        method: 'POST',
        body: { name },
      },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    if (res.status === 409) throw this.mapConflict(await this.readError(res));
    await this.throwIfCommonErrors(res);
    if (res.status !== 201) throw new VersioningRequestError(await this.readError(res), res.status);
    return ((await res.json()) as { branch: BranchSummary }).branch;
  }

  async getCurrentBranch(accessToken: string, repoId: string): Promise<string> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/branches/current`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { branch: { name: string } }).branch.name;
  }

  async checkoutBranch(accessToken: string, repoId: string, name: string): Promise<BranchSummary> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/branches/${encodeURIComponent(name)}/checkout`,
      accessToken,
      { method: 'POST' },
    );
    if (res.status === 404) throw new BranchNotFoundError(await this.readError(res));
    if (res.status === 409) throw this.mapConflict(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { branch: BranchSummary }).branch;
  }

  async deleteBranch(accessToken: string, repoId: string, name: string): Promise<void> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/branches/${encodeURIComponent(name)}`,
      accessToken,
      { method: 'DELETE' },
    );
    if (res.status === 404) throw new BranchNotFoundError(await this.readError(res));
    if (res.status === 409) throw this.mapConflict(await this.readError(res));
    await this.throwIfCommonErrors(res);
    if (res.status !== 204) throw new VersioningRequestError(await this.readError(res), res.status);
  }

  async merge(
    accessToken: string,
    repoId: string,
    sourceBranch: string,
    targetBranch?: string,
  ): Promise<MergeResult> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/merge`,
      accessToken,
      {
        method: 'POST',
        body: targetBranch ? { sourceBranch, targetBranch } : { sourceBranch },
      },
    );
    if (res.status === 404) throw new BranchNotFoundError(await this.readError(res));
    if (res.status === 409) {
      const payload = (await res.json()) as {
        error: string;
        merge?: { sourceBranch: string; targetBranch: string; conflicts: MergeConflictTable[] };
      };
      if (payload.merge?.conflicts) {
        throw new MergeConflictError(
          payload.error,
          payload.merge.sourceBranch,
          payload.merge.targetBranch,
          payload.merge.conflicts,
        );
      }
      throw this.mapConflict(payload.error);
    }
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { merge: MergeResult }).merge;
  }

  async getLog(
    accessToken: string,
    repoId: string,
    options: { branch?: string; limit?: number } = {},
  ): Promise<{ commits: LogCommitEntry[]; limit: number }> {
    const params = new URLSearchParams();
    if (options.branch) params.set('branch', options.branch);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/log${suffix}`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { log: { commits: LogCommitEntry[]; limit: number } }).log;
  }

  async getDiff(
    accessToken: string,
    repoId: string,
    from: string,
    to: string,
  ): Promise<DiffResult> {
    const params = new URLSearchParams({ from, to });
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/diff?${params.toString()}`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { diff: DiffResult }).diff;
  }

  async getSyncPreferences(
    accessToken: string,
    repoId: string,
  ): Promise<RepoSyncPreferenceSummary | null> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/sync-preferences`,
      accessToken,
      { method: 'GET' },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { preference: RepoSyncPreferenceSummary | null }).preference;
  }

  async setSyncPreferences(
    accessToken: string,
    repoId: string,
    mode: 'schema_only' | 'schema_and_data',
    tables: string[] | null,
  ): Promise<RepoSyncPreferenceSummary> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/sync-preferences`,
      accessToken,
      {
        method: 'PUT',
        body: { mode, tables },
      },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    if (res.status === 409) throw new ValidationError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { preference: RepoSyncPreferenceSummary }).preference;
  }

  async dryRunSyncPreferences(
    accessToken: string,
    repoId: string,
    mode: 'schema_only' | 'schema_and_data',
    tables: string[] | null,
  ): Promise<SyncPreferenceDryRunPlan> {
    const res = await this.request(
      `/api/v1/versioning/repos/${encodeURIComponent(repoId)}/sync-preferences/dry-run`,
      accessToken,
      {
        method: 'POST',
        body: { mode, tables },
      },
    );
    if (res.status === 404) throw new RepoNotFoundError(await this.readError(res));
    if (res.status === 409) throw new ValidationError(await this.readError(res));
    await this.throwIfCommonErrors(res);
    return ((await res.json()) as { plan: SyncPreferenceDryRunPlan }).plan;
  }

  private async throwIfCommonErrors(res: Response): Promise<void> {
    if (res.status === 401) throw new VersioningAuthenticationError();
    if (res.status === 403) throw new InsufficientRoleError(await this.readError(res));
    if (res.status === 400 || res.status === 422)
      throw new ValidationError(await this.readError(res));
    if (!res.ok) throw new VersioningRequestError(await this.readError(res), res.status);
  }

  private async readError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string };
      return body.error ?? `Unexpected server response: ${res.status}`;
    } catch {
      return `Unexpected server response: ${res.status}`;
    }
  }

  private mapConflict(message: string): Error {
    const lower = message.toLowerCase();
    if (lower.includes('already exists')) return new BranchAlreadyExistsError(message);
    if (
      lower.includes('protected') ||
      lower.includes('cannot delete') ||
      lower.includes('current checked-out') ||
      lower.includes('main')
    ) {
      return new ProtectedBranchError(message);
    }
    if (lower.includes('repo')) return new RepoAlreadyExistsError(message);
    return new ValidationError(message);
  }

  private async request(
    path: string,
    accessToken: string,
    options: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown },
  ): Promise<Response> {
    try {
      return await fetch(this.serverUrl + path, {
        method: options.method,
        headers: {
          authorization: 'Bearer ' + accessToken,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (err) {
      throw new ServerUnreachableError(err);
    }
  }
}
