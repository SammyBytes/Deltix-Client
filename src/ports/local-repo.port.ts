import type {
  LocalBranchList,
  LocalStatus,
} from '../contexts/versioning-local/versioning-local.service';

export interface LocalRepoIdentity {
  repo: string;
  projectRoot?: string;
}

/**
 * Puerto de repo local — lo que el CLI necesita, no cómo se hace.
 * Implementado por `VersioningLocalService` delegando a `DoltSqlPort`.
 */
export interface LocalRepoPort {
  getStatus(id: LocalRepoIdentity): Promise<LocalStatus>;
  listBranches(id: LocalRepoIdentity): Promise<LocalBranchList>;
  createBranch(id: LocalRepoIdentity, name: string): Promise<void>;
  deleteBranch(id: LocalRepoIdentity, name: string): Promise<void>;
  checkout(id: LocalRepoIdentity, branch: string): Promise<void>;
  mergeBranches(
    id: LocalRepoIdentity,
    source: string,
    target?: string,
  ): Promise<{ fastForward: boolean; conflicts: number }>;
  getWorkingDiffSummary(
    id: LocalRepoIdentity,
    table?: string,
  ): Promise<{ tables: string[]; raw: string }>;
  commit(
    id: LocalRepoIdentity,
    message: string,
    tables?: string[],
    opts?: { authorName?: string },
  ): Promise<{ commitHash: string; repo: string }>;
}
