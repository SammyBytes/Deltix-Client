export class CommitError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(`dolt ${command} failed: ${stderr.trim() || '(no stderr)'}`);
    this.name = 'CommitError';
  }
}

export class CommitEmptyError extends Error {
  constructor(repo: string) {
    super(`Nothing to commit for "${repo}" — no staged changes.`);
    this.name = 'CommitEmptyError';
  }
}

export class CommitDataDirNotFoundError extends Error {
  constructor(repo: string) {
    super(
      `No local data directory found for "${repo}". Run \`deltix start\` first to create the local engine.`,
    );
    this.name = 'CommitDataDirNotFoundError';
  }
}

export class PushError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(`dolt ${command} failed during push: ${stderr.trim() || '(no stderr)'}`);
    this.name = 'PushError';
  }
}

export class PushNoUpstreamError extends Error {
  constructor(repo: string) {
    super(
      `No upstream configured for "${repo}". Make sure the project has been initialized and linked to a remote repo.`,
    );
    this.name = 'PushNoUpstreamError';
  }
}

export class PushEmptyError extends Error {
  constructor(repo: string) {
    super(`Nothing to push for "${repo}" — no unpushed commits.`);
    this.name = 'PushEmptyError';
  }
}
