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

export class LocalRepoInitError extends Error {
  constructor(
    readonly repo: string,
    readonly stderr: string,
  ) {
    super(`Failed to initialize the local Dolt repo for "${repo}": ${stderr || '(no stderr)'}`);
    this.name = 'LocalRepoInitError';
  }
}

export class PushEmptyError extends Error {
  constructor(repo: string) {
    super(`Nothing to push for "${repo}" — no unpushed commits.`);
    this.name = 'PushEmptyError';
  }
}

export class UncommittedChangesError extends Error {
  constructor(tables: string) {
    super(
      `Pull aborted: you have uncommitted changes in ${tables}. Commit or discard them first (e.g. \`deltix commit\`) so the pull can't overwrite your local work.`,
    );
    this.name = 'UncommittedChangesError';
  }
}
