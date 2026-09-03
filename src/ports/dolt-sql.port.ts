/**
 * SQL port for Dolt — abstraction over the implementation.
 * Two adapters: `DoltMysqlAdapter` (wire mysql2 to :3307, fast) and
 * `DoltCliAdapter` (dolt sql -q, fallback). Contexts do not import
 * mysql2 or runDoltCommand directly.
 */
export interface DoltSqlPort {
  /** SELECT-like, returns typed rows */
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  /** DDL/DML with no return (`CREATE`, `CALL DOLT_*` that returns nothing) */
  exec(sql: string): Promise<void>;
  /** CALL proc(args) — for DOLT_BRANCH / CHECKOUT / COMMIT / MERGE */
  call(proc: string, args: string[]): Promise<unknown>;
  /** Is it available? (wire) */
  isAvailable(): Promise<boolean>;
}
