/**
 * CLI adapter — talks to `dolt` binary via `runDoltCommand`.
 * Slow (~3s/spawn) but works even when sql-server is down.
 * Fallback for `DoltMysqlAdapter`.
 */
import { runDoltCommand } from '../acl/dolt-exec';
import type { DoltSqlPort } from '../ports/dolt-sql.port';
import { TIMEOUT } from '../shared/constants';

export class DoltCliAdapter implements DoltSqlPort {
  constructor(
    private readonly binaryPath: string,
    private readonly dataDir: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true; // CLI always available if binary exists
  }

  async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await runDoltCommand(
      this.binaryPath,
      ['--data-dir', this.dataDir, 'sql', '-q', sql, '-r', 'json'],
      { timeoutMs: TIMEOUT.DOLT_DIFF_STAT },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
    const trimmed = result.stdout.trim();
    if (!trimmed) return [];
    return (JSON.parse(trimmed) as { rows?: T[] }).rows ?? [];
  }

  async exec(sql: string): Promise<void> {
    const result = await runDoltCommand(
      this.binaryPath,
      ['--data-dir', this.dataDir, 'sql', '-q', sql],
      { timeoutMs: TIMEOUT.DOLT_BRANCH },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
  }

  async call(proc: string, args: string[]): Promise<unknown> {
    const esc = (s: string) => s.replace(/'/g, "''");
    const sql = `CALL ${proc}(${args.map((a) => `'${esc(a)}'`).join(', ')})`;
    return this.query(sql);
  }
}
