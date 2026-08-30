export class ImportDsnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportDsnError';
  }
}

export class ImportUnsupportedSchemeError extends Error {
  constructor(scheme: string) {
    super(`Unsupported import source "${scheme}://". MVP supports mysql:// and mariadb://.`);
    this.name = 'ImportUnsupportedSchemeError';
  }
}

export class ImportError extends Error {
  constructor(
    readonly table: string,
    readonly detail: string,
  ) {
    super(`Import of "${table}" failed: ${detail}`);
    this.name = 'ImportError';
  }
}

/** Raised when a selected table has binary columns and the policy is `error`. */
export class ImportBlobError extends Error {
  constructor(readonly offenders: { table: string; columns: string[] }[]) {
    super(
      `Binary/BLOB columns found and --blobs=error: ${offenders
        .map((o) => `${o.table}(${o.columns.join(', ')})`)
        .join('; ')}. Re-run with --blobs base64 (round-trips via FROM_BASE64) or --blobs skip.`,
    );
    this.name = 'ImportBlobError';
  }
}
