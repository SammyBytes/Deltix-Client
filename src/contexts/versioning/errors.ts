export interface MergeConflictRow {
  fromRootIsh: string | null;
  base: Record<string, string | null>;
  ours: Record<string, string | null>;
  theirs: Record<string, string | null>;
  ourDiffType: string | null;
  theirDiffType: string | null;
  conflictId: string | null;
}

export interface MergeConflictTable {
  table: string;
  count: number;
  conflicts: MergeConflictRow[];
}

export class VersioningAuthenticationError extends Error {
  constructor() {
    super('Not authenticated. Run `deltix login` first.');
    this.name = 'VersioningAuthenticationError';
  }
}

export class InsufficientRoleError extends Error {
  constructor(message = 'Insufficient repo role for this action') {
    super(message);
    this.name = 'InsufficientRoleError';
  }
}

export class RepoNotFoundError extends Error {
  constructor(message = 'Repo not found') {
    super(message);
    this.name = 'RepoNotFoundError';
  }
}

export class BranchNotFoundError extends Error {
  constructor(message = 'Branch not found') {
    super(message);
    this.name = 'BranchNotFoundError';
  }
}

export class BranchAlreadyExistsError extends Error {
  constructor(message = 'Branch already exists') {
    super(message);
    this.name = 'BranchAlreadyExistsError';
  }
}

export class ProtectedBranchError extends Error {
  constructor(message = 'Protected branch cannot be modified') {
    super(message);
    this.name = 'ProtectedBranchError';
  }
}

export class RepoAlreadyExistsError extends Error {
  constructor(message = 'Repo already provisioned') {
    super(message);
    this.name = 'RepoAlreadyExistsError';
  }
}

export class RoleAssignmentNotFoundError extends Error {
  constructor(message = 'Repo role assignment not found') {
    super(message);
    this.name = 'RoleAssignmentNotFoundError';
  }
}

export class UserNotFoundError extends Error {
  constructor(message = 'User not found') {
    super(message);
    this.name = 'UserNotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class VersioningRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'VersioningRequestError';
  }
}

export class MergeConflictError extends Error {
  constructor(
    message: string,
    public readonly sourceBranch: string,
    public readonly targetBranch: string,
    public readonly conflicts: MergeConflictTable[],
  ) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

export class NonFastForwardError extends Error {
  constructor(message = 'Push rejected: the remote has advanced. Run `deltix pull` first.') {
    super(message);
    this.name = 'NonFastForwardError';
  }
}
