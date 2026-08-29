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
