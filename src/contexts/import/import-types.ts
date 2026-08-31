/**
 * Shared types for the `import` context (ADR 0001). Adopting an existing
 * database is modelled as: read a set of tables from a pluggable
 * `SourceAdapter`, and hand each to the local Dolt as a
 * `{ name, schema (DDL), csv (data) }` triple — the same shape the commit
 * push/pull pipeline already speaks, so adopted data flows through it
 * unchanged.
 */

/** Binary/BLOB column policy during import. */
export type BlobPolicy = 'error' | 'base64' | 'skip';

/** One base table read from a source, ready to load into the local Dolt. */
export interface SourceTable {
  name: string;
  /** `CREATE TABLE` DDL (MySQL/Dolt-compatible), preserves PK + types. */
  schema: string;
  /** Column names in declaration order (the CSV header). */
  columns: string[];
  /** Names of columns holding binary data (BLOB/VARBINARY/...). */
  binaryColumns: string[];
  /** Rows as arrays aligned to `columns`; `null` for SQL NULL. */
  rows: unknown[][];
}

/** A source database the importer can read. Implementations: MySQL/MariaDB. */
export interface SourceAdapter {
  /** Open + begin a consistent read snapshot. */
  connect(): Promise<void>;
  /** Base table names in the connected database. */
  listTables(): Promise<string[]>;
  /**
   * Parent->child dependency edges (child depends on parent) used to order
   * imports so FK constraints are satisfied. Best-effort: may return [].
   */
  foreignKeyEdges(): Promise<{ child: string; parent: string }[]>;
  /** Read one table's schema + rows. */
  readTable(name: string): Promise<SourceTable>;
  close(): Promise<void>;
}

/** A table prepared for bulk load into the local Dolt. */
export interface TableLoad {
  name: string;
  schema: string;
  /** CSV text (header + rows). Empty header-only string means "no rows". */
  csv: string;
  /** Binary columns that were base64-encoded and need FROM_BASE64 post-fix. */
  base64Columns: string[];
}

export interface ImportOptions {
  /** Restrict to these tables (default: all base tables). */
  tables?: string[];
  /** Import DDL only, no rows. */
  schemaOnly?: boolean;
  /** Binary column policy (default `error`). */
  blobs?: BlobPolicy;
  /**
   * Forwarded to `dolt table import --continue`: when a row violates a
   * constraint (NOT NULL violated, type coercion, etc.) skip that row and
   * keep going instead of aborting the whole table. Use with care — the
   * summary at the end of `deltix import` reports how many rows were
   * skipped, but you should still inspect the source DB for the cause.
   */
  continueOnRowError?: boolean;
}
