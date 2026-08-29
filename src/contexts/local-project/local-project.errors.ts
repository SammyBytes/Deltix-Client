/**
 * Typed errors for the local-project context (per-directory Deltix binding).
 * Each error carries enough detail for the CLI to print an actionable
 * message without exposing internal state.
 */

export class ProjectAlreadyInitializedError extends Error {
  constructor(readonly projectRoot: string) {
    super(`This directory is already bound to a Deltix repo (${projectRoot})`);
    this.name = 'ProjectAlreadyInitializedError';
  }
}

export class NoProjectError extends Error {
  constructor() {
    super('No Deltix project found. Run `deltix init <repo>` in the project directory first.');
    this.name = 'NoProjectError';
  }
}

export class InvalidRepoNameError extends Error {
  constructor() {
    super('Invalid repo name: must be 1-64 characters using letters, digits, `-` or `_`.');
    this.name = 'InvalidRepoNameError';
  }
}
