/**
 * Typed errors for the mysql-embedded context (local `dolt sql-server`
 * lifecycle). Each error carries enough detail for the CLI to print an
 * actionable message without exposing internal state.
 */
export class LocalServerStartError extends Error {
  constructor(repo: string, message: string) {
    super(`Could not start the local Dolt SQL server for "${repo}": ${message}`);
    this.name = 'LocalServerStartError';
  }
}

export class LocalServerPortInUseError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super(`Port ${host}:${port} is already in use — pick another port (see DELTIX_LOCAL_PORT)`);
    this.name = 'LocalServerPortInUseError';
  }
}

export class LocalServerNotRunningError extends Error {
  constructor(
    readonly repo: string,
    extra?: string,
  ) {
    super(`No local Dolt SQL server is running for "${repo}"${extra ? ` (${extra})` : ''}`);
    this.name = 'LocalServerNotRunningError';
  }
}
