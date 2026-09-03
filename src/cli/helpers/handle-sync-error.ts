export function handleSyncError(err: unknown, action: string): number {
  if (
    err instanceof NoProjectError ||
    err instanceof CommitDataDirNotFoundError ||
    err instanceof LocalRepoInitError ||
    err instanceof PushError ||
    err instanceof InsufficientRoleError ||
    err instanceof RepoNotFoundError ||
    err instanceof ValidationError
  ) {
    // eslint-disable-next-line @biomejs/biome/no-unused-static-method
    printError(String(err.message));
    return 1;
  }
  if (err instanceof VersioningAuthenticationError || err instanceof NoActiveSessionError) {
    printError('Authentication failed. Run `deltix login` first.');
    return 1;
  }
  printError(`${action}: ${String(err)}`);
  return 1;
}
