import type {
  BranchSummary,
  DiffResult,
  ImportedCommit,
  LogCommitEntry,
  MergeResult,
  PullCommitsResult,
  PushCommitsResult,
  RepoRef,
  RepoRoleAssignment,
  RepoSummary,
  RepoSyncPreferenceSummary,
  SyncPreferenceDryRunPlan,
  VersioningApiAdapter,
} from '../../acl/versioning-api-adapter';
import type { SessionService } from '../session';

export class VersioningService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly versioningApi: VersioningApiAdapter,
  ) {}

  async createRepo(repoId: string): Promise<RepoSummary> {
    return this.versioningApi.createRepo(await this.sessionService.mintAccessToken(), repoId);
  }

  async listRepos(): Promise<RepoSummary[]> {
    return this.versioningApi.listRepos(await this.sessionService.mintAccessToken());
  }

  async getRepo(repoId: string): Promise<RepoSummary> {
    return this.versioningApi.getRepo(await this.sessionService.mintAccessToken(), repoId);
  }

  async listBranches(repoId: string): Promise<BranchSummary[]> {
    return this.versioningApi.listBranches(await this.sessionService.mintAccessToken(), repoId);
  }

  async createBranch(repoId: string, name: string): Promise<BranchSummary> {
    return this.versioningApi.createBranch(
      await this.sessionService.mintAccessToken(),
      repoId,
      name,
    );
  }

  async getCurrentBranch(repoId: string): Promise<string> {
    return this.versioningApi.getCurrentBranch(await this.sessionService.mintAccessToken(), repoId);
  }

  async checkoutBranch(repoId: string, name: string): Promise<BranchSummary> {
    return this.versioningApi.checkoutBranch(
      await this.sessionService.mintAccessToken(),
      repoId,
      name,
    );
  }

  async deleteBranch(repoId: string, name: string): Promise<void> {
    await this.versioningApi.deleteBranch(
      await this.sessionService.mintAccessToken(),
      repoId,
      name,
    );
  }

  async merge(repoId: string, sourceBranch: string, targetBranch?: string): Promise<MergeResult> {
    return this.versioningApi.merge(
      await this.sessionService.mintAccessToken(),
      repoId,
      sourceBranch,
      targetBranch,
    );
  }

  async getLog(
    repoId: string,
    options: { branch?: string; limit?: number } = {},
  ): Promise<{ commits: LogCommitEntry[]; limit: number }> {
    return this.versioningApi.getLog(await this.sessionService.mintAccessToken(), repoId, options);
  }

  async getDiff(repoId: string, from: string, to: string): Promise<DiffResult> {
    return this.versioningApi.getDiff(
      await this.sessionService.mintAccessToken(),
      repoId,
      from,
      to,
    );
  }

  async listRoles(repoId: string): Promise<RepoRoleAssignment[]> {
    return this.versioningApi.listRoles(await this.sessionService.mintAccessToken(), repoId);
  }

  async grantRole(
    repoId: string,
    username: string,
    role: 'reader' | 'writer' | 'admin',
  ): Promise<RepoRoleAssignment> {
    return this.versioningApi.grantRole(
      await this.sessionService.mintAccessToken(),
      repoId,
      username,
      role,
    );
  }

  async revokeRole(repoId: string, username: string): Promise<void> {
    await this.versioningApi.revokeRole(
      await this.sessionService.mintAccessToken(),
      repoId,
      username,
    );
  }

  async getSyncPreferences(repoId: string): Promise<RepoSyncPreferenceSummary | null> {
    return this.versioningApi.getSyncPreferences(
      await this.sessionService.mintAccessToken(),
      repoId,
    );
  }

  async setSyncPreferences(
    repoId: string,
    mode: 'schema_only' | 'schema_and_data',
    tables: string[] | null,
  ): Promise<RepoSyncPreferenceSummary> {
    return this.versioningApi.setSyncPreferences(
      await this.sessionService.mintAccessToken(),
      repoId,
      mode,
      tables,
    );
  }

  async dryRunSyncPreferences(
    repoId: string,
    mode: 'schema_only' | 'schema_and_data',
    tables: string[] | null,
  ): Promise<SyncPreferenceDryRunPlan> {
    return this.versioningApi.dryRunSyncPreferences(
      await this.sessionService.mintAccessToken(),
      repoId,
      mode,
      tables,
    );
  }

  async pushCommits(repoId: string, commits: ImportedCommit[]): Promise<PushCommitsResult> {
    return this.versioningApi.pushCommits(
      await this.sessionService.mintAccessToken(),
      repoId,
      commits,
    );
  }

  async fetchRefs(repoId: string): Promise<RepoRef[]> {
    return this.versioningApi.fetchRefs(await this.sessionService.mintAccessToken(), repoId);
  }

  async pullCommits(
    repoId: string,
    branch: string,
    fromHash: string | null,
  ): Promise<PullCommitsResult> {
    return this.versioningApi.pullCommits(
      await this.sessionService.mintAccessToken(),
      repoId,
      branch,
      fromHash,
    );
  }
}
