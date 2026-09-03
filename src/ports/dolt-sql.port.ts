/**
 * Puerto SQL contra Dolt — abstracción sobre la implementación.
 * Dos adapters: `DoltMysqlAdapter` (wire mysql2 a :3307, rápido) y
 * `DoltCliAdapter` (dolt sql -q, fallback). Los contexts no importan
 * mysql2 ni runDoltCommand directo.
 */
export interface DoltSqlPort {
  /** SELECT-like, devuelve filas tipadas */
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  /** DDL/DML sin retorno (`CREATE`, `CALL DOLT_*` que no devuelve) */
  exec(sql: string): Promise<void>;
  /** CALL proc(args) — para DOLT_BRANCH / CHECKOUT / COMMIT / MERGE */
  call(proc: string, args: string[]): Promise<unknown>;
  /** ¿Está disponible? (wire) */
  isAvailable(): Promise<boolean>;
}
